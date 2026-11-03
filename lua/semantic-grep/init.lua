-- semantic-grep: search a project's code by its words and by what they mean, in a live picker.
--
--   require('semantic-grep').setup({
--     embedding = {api = 'openai', baseUrl = 'http://127.0.0.1:8092/v1', model = 'embeddinggemma-2', dimensions = 768},
--     rerank = {api = 'system-one', baseUrl = 'http://127.0.0.1:8091/v1', model = 'd1-2B', top = 15, timeoutMs = 2000},
--     picker = 'auto', -- or 'telescope', 'snacks', 'fzf-lua', 'select'
--   })
--
-- Every field is optional: without `embedding` the word search works alone; without `rerank` nothing is reranked.
-- Other fields: `data_dir` (where the index files go, default stdpath('data')/semantic-grep), `index` ('data', or
-- 'project' for .semantic-grep/ in the repository), `node` (the Node 22+ to run the server with), `debounce_ms` (the
-- pause before meaning is asked, 150), `rerank_delay_ms` (how long meaning's list must stay before it is reranked, 0),
-- `index_on_start` (index the project as Neovim starts rather than at the first search, false), `source` (below).
--
-- Sources. The picker asks a source, which by default is a server this Neovim spawns (`node
-- bin/semantic-grep-server.mjs`, see src/server.mjs): one per Neovim, gone when Neovim goes. Another program that
-- already indexes the project (pairing-buddy's daemon, say) can be the source instead, so only one process writes a
-- project's index: pass it as `setup({source = source})`, or call `require('semantic-grep').register_source(source)`
-- at any time. A source is a table:
--
--   source.request(method, params, callback) -- callback(err, result); err is a message or nil
--   source.notify(method, params)            -- no answer
--
-- with the server's methods (src/server.mjs): 'words', 'meaning', 'rerank', 'search' (`{root, query}` each, answering
-- `{state, results = {{file, path, line, from, to, head, meaning, words, rerank}}, chunks, embedded, problem, ms,
-- reranker, rerank}`), 'saved' `{path}`, 'rebuild' `{root}`, 'chosen' `{root, query, results}`, 'status' `{}`,
-- 'check' `{}`, and the notification 'cancel' (a picker's rerank is no longer wanted). A source may tell how far a
-- build is by calling `require('semantic-grep').on_progress({root, phase, done, total, text})`, phase being
-- 'reading', 'embedding', 'done' or 'failed'. It may also define `source.name` (for :checkhealth) and
-- `source.health()` (lines of its own to report).
local M = {}

M.config = {
  embedding = nil,
  rerank = nil,
  picker = 'auto',
  data_dir = nil,
  index = 'data',
  node = 'node',
  debounce_ms = 150,
  rerank_delay_ms = 0,
  index_on_start = false,
  source = nil,
}

local source -- the source asked, once made
local configured = false

--- The project a search is in: the git worktree of Neovim's folder, else that folder, as its real path.
function M.root()
  local cwd = vim.fn.getcwd()
  local root = vim.fs.root(cwd, '.git') or cwd
  return vim.uv.fs_realpath(root) or root
end

function M.setup(opts)
  opts = opts or {}
  M.config = vim.tbl_deep_extend('force', M.config, opts)
  -- A list of rerank models stays a list: tbl_deep_extend would merge it with the one before by index.
  if opts.rerank ~= nil then M.config.rerank = opts.rerank end
  if opts.embedding ~= nil then M.config.embedding = opts.embedding end
  configured = true
  if source and source.stop then source.stop() end -- a new config: the server starts again with it at its next use
  source = opts.source
  local group = vim.api.nvim_create_augroup('semantic-grep', {clear = true})
  vim.api.nvim_create_autocmd('BufWritePost', {
    group = group,
    callback = function(args)
      if not source or (source.running and not source.running()) then return end -- nothing indexed yet: its first search reads the files
      local path = vim.uv.fs_realpath(args.file) or vim.fn.fnamemodify(args.file, ':p')
      source.notify('saved', {path = path})
    end,
  })
  vim.api.nvim_create_autocmd('VimLeavePre', {group = group, callback = function() if source and source.stop then source.stop() end end})
  if M.config.index_on_start then
    vim.api.nvim_create_autocmd('VimEnter', {group = group, once = true, callback = function()
      vim.defer_fn(function() M.source().request('open', {root = M.root()}, function() end) end, 500)
    end})
    if vim.v.vim_did_enter == 1 then M.source().request('open', {root = M.root()}, function() end) end
  end
end

--- Another program's search as the source (see above); its index is the one asked from then on.
function M.register_source(new)
  if source and source.stop and source ~= new then source.stop() end
  source = new
end

--- The source asked: the registered one, else this Neovim's own server, started now.
function M.source()
  if not configured then M.setup({}) end
  if not source then source = require('semantic-grep.server').new(M.config) end
  return source
end

--- Opens the live picker with `query` typed in it already.
function M.find(query)
  require('semantic-grep.picker').find(query or '', {picker = M.config.picker})
end

--- The words selected in Visual mode, on one line, as a search.
function M.selected()
  local ok, lines = pcall(vim.fn.getregion, vim.fn.getpos('v'), vim.fn.getpos('.'), {type = vim.fn.mode()})
  return ok and vim.trim(table.concat(lines, ' ')) or ''
end

--- :SemanticGrep rebuild: the project's index made again from its files, every vector too.
function M.rebuild()
  M.source().request('rebuild', {root = M.root()}, function(err)
    if err then return vim.notify('semantic-grep: ' .. err, vim.log.levels.ERROR) end
    vim.notify('semantic-grep: rebuilding the index from the files; the word search works again in a few seconds')
  end)
end

-- How far a project's index is: Neovim's own progress message (0.12), which a statusline or fidget may show.
local progress_id = nil
function M.on_progress(message)
  local percent = message.total and message.total > 0 and math.floor(100 * (message.done or 0) / message.total) or nil
  local text = message.phase == 'reading' and 'reading the project for the word search'
    or message.phase == 'embedding' and ('embedding pieces of code: %d of %d'):format(message.done or 0, message.total or 0)
    or message.phase == 'failed' and ('stopped: %s'):format(message.text or '')
    or ('%d pieces indexed'):format(message.total or 0)
  local status = message.phase == 'done' and 'success' or message.phase == 'failed' and 'failed' or 'running'
  local ok, id = pcall(vim.api.nvim_echo, {{text}}, false, {kind = 'progress', id = progress_id, title = 'semantic-grep', status = status, percent = percent, source = 'semantic-grep'})
  if ok then
    progress_id = status == 'running' and id or nil
  elseif message.phase == 'failed' then
    vim.notify('semantic-grep: ' .. text, vim.log.levels.WARN) -- an older Neovim: only a failure
  end
end

--- :SemanticGrep [words] | rebuild
function M.command(opts)
  local arg = vim.trim(opts.args or '')
  if arg == 'rebuild' then return M.rebuild() end
  if arg == '' and opts.range and opts.range > 0 then
    local lines = vim.api.nvim_buf_get_lines(0, opts.line1 - 1, opts.line2, false)
    arg = vim.trim(table.concat(lines, ' '))
  end
  M.find(arg)
end

return M
