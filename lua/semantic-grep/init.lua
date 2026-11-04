-- semantic-grep: search a project's code by its words and by what they mean, in a live picker.
--
--   require('semantic-grep').setup({
--     profile = 'laptop', -- or 'beefy', 'cloud': the embedding and rerank models measured for it (docs/profiles.md)
--     embedding = {baseUrl = 'http://127.0.0.1:8092/v1'}, -- over the profile's; or a whole entry of your own
--     rerank = false,     -- the profile's reranker off
--     picker = 'auto',    -- or 'telescope', 'snacks', 'fzf-lua', 'select'
--   })
--
-- Every field is optional. Without `embedding` or a profile, a small model runs on this machine (EmbeddingGemma 2, 310
-- MB, on the CPU): asked for once, downloaded into the data folder, served by the `llama-server` on PATH, which the
-- plugin starts on a free port and stops (`local_model = {gguf = path, llama_server = path, threads = n}` changes
-- what it runs, `false` or `embedding = false` keeps to the words alone). Without `rerank` nothing is reranked. A profile's models are those of src/profiles.mjs; what `embedding` and `rerank` set goes over them.
-- `notes = true` (or an entry over the profile's writer, the laptop's without a profile) writes a note on each piece of
-- code while nothing is searched, with a language model (src/notes.mjs, docs/notes.md); off by default. A writer not on
-- this machine gets the code only with `sendCode = true`.
-- Other fields: `data_dir` (where the index files go, default stdpath('data')/semantic-grep), `index` ('data', or
-- 'project' for .semantic-grep/ in the repository), `node` (the Node 22.16+ to run the server with), `debounce_ms` (the
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
  profile = nil,
  embedding = nil,
  rerank = nil,
  notes = nil,
  local_model = nil,
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
local asked = false -- the local model looked at (asked for, or said missing) since setup
local external = false -- another program's (setup's `source`, or register_source): its models are its own
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
  if opts.notes ~= nil then M.config.notes = opts.notes end
  configured = true
  asked = false -- a new config: the local model is looked at again at the next search
  if source and source.stop then source.stop() end -- a new config: the server starts again with it at its next use
  source = opts.source
  external = opts.source ~= nil
  local group = vim.api.nvim_create_augroup('semantic-grep', {clear = true})
  vim.api.nvim_create_autocmd('BufWritePost', {
    group = group,
    callback = function(args)
      if not source or (source.running and not source.running()) then return end -- nothing indexed yet: its first search reads the files
      local path = vim.uv.fs_realpath(args.file) or vim.fn.fnamemodify(args.file, ':p')
      source.notify('saved', {path = path})
    end,
  })
  -- The file one is in: the notes written in the background start near it.
  vim.api.nvim_create_autocmd('BufEnter', {
    group = group,
    callback = function(args)
      if not source or (source.running and not source.running()) or vim.bo[args.buf].buftype ~= '' or args.file == '' then return end
      local path = vim.uv.fs_realpath(args.file)
      if path then source.notify('visited', {path = path}) end
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
  external = true
end

--- The source asked: the registered one, else this Neovim's own server, started now.
function M.source()
  if not configured then M.setup({}) end
  if not source then source = require('semantic-grep.server').new(M.config) end
  return source
end

-- The local model (no `embedding`, no profile): asked for once, before the first search that would use it.
local function declined_path() return require('semantic-grep.server').data_dir(M.config) .. '/no-local-model' end
local function told_path() return require('semantic-grep.server').data_dir(M.config) .. '/told-no-llama-server' end
local function mark(path, text)
  vim.fn.mkdir(vim.fn.fnamemodify(path, ':h'), 'p')
  vim.fn.writefile({text}, path)
end

--- `then_()` once the local model is there or not wanted: the first time, the person is asked to download it (the search
--- opens meanwhile, by its words), or told what is missing for it.
function M.with_model(then_)
  if asked or M.config.embedding ~= nil or M.config.profile or M.config.local_model == false or external then return then_() end
  asked = true
  M.source().request('needs', vim.empty_dict(), function(err, needs)
    vim.schedule(function()
      if err or not needs or needs.state == 'on' or needs.state == 'downloading' then return then_() end
      if needs.runtime and needs.runtime ~= vim.NIL then
        if vim.uv.fs_stat(told_path()) then return then_() end -- said once; :checkhealth says it again
        mark(told_path(), 'semantic-grep: told that llama-server is missing; :checkhealth semantic-grep says how to get it')
        vim.notify(('semantic-grep: search by words only: %s is not on PATH, and search by meaning needs it (:checkhealth semantic-grep says how to get it)'):format(needs.runtime), vim.log.levels.WARN)
        return then_()
      end
      if needs.model and needs.own then
        vim.notify(('semantic-grep: search by words only: local_model.gguf, %s, is missing'):format(needs.path), vim.log.levels.WARN)
        return then_()
      end
      if not needs.model or vim.uv.fs_stat(declined_path()) then return then_() end
      local yes = ('Download %s (%d MB) for search by meaning'):format(needs.name or 'the model', math.floor((needs.bytes or 0) / 1e6 + 0.5))
      local never = 'No, words only (:SemanticGrep download fetches it later)'
      vim.ui.select({yes, 'Not now', never}, {prompt = 'semantic-grep: search by meaning needs a small model on this machine'}, function(choice)
        if choice == yes then M.download()
        elseif choice == never then
          mark(declined_path(), 'semantic-grep: the local model was declined; :SemanticGrep download fetches it')
        end
        then_()
      end)
    end)
  end)
end

--- :SemanticGrep download: the local model fetched now (its progress as Neovim's progress messages).
function M.download()
  vim.fn.delete(declined_path())
  M.source().request('download', vim.empty_dict(), function(err, result)
    vim.schedule(function()
      if err then
        M.on_progress({phase = 'failed', text = err}) -- the progress message ends (on 0.12; older ones notify)
        return
      end
      if result and result.state == 'on' then vim.notify('semantic-grep: search by meaning is on; the project is being embedded') end
    end)
  end)
end

--- Opens the live picker with `query` typed in it already.
function M.find(query)
  M.with_model(function() require('semantic-grep.picker').find(query or '', {picker = M.config.picker}) end)
end

--- Opens the files view: the files a sentence is about, best first, each at its best piece.
function M.files(query)
  M.with_model(function() require('semantic-grep.picker').files(query or '', {picker = M.config.picker}) end)
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
local told_quarter = -1 -- a download's quarters said on a Neovim without progress messages
function M.on_progress(message)
  -- A source's JSON nulls arrive as vim.NIL.
  local function num(value) return type(value) == 'number' and value or nil end
  local function str(value) return type(value) == 'string' and value or nil end
  message = {root = str(message.root), phase = str(message.phase), done = num(message.done), total = num(message.total), text = str(message.text)}
  local percent = message.total and message.total > 0 and math.floor(100 * (message.done or 0) / message.total) or nil
  local text = message.phase == 'reading' and 'reading the project for the word search'
    or message.phase == 'downloading' and ('downloading the model: %d of %d MB'):format(math.floor((message.done or 0) / 1e6 + 0.5), math.floor((message.total or 0) / 1e6 + 0.5))
    or message.phase == 'embedding' and ('embedding pieces of code: %d of %d'):format(message.done or 0, message.total or 0)
    or message.phase == 'failed' and ('stopped: %s'):format(message.text or '')
    or ('%d pieces indexed'):format(message.total or 0)
  local finished = message.phase == 'downloading' and message.total and message.done == message.total
  local status = (message.phase == 'done' or finished) and 'success' or message.phase == 'failed' and 'failed' or 'running'
  local ok, id = pcall(vim.api.nvim_echo, {{text}}, false, {kind = 'progress', id = progress_id, title = 'semantic-grep', status = status, percent = percent, source = 'semantic-grep'})
  if ok then
    progress_id = status == 'running' and id or nil
  elseif message.phase == 'downloading' then -- an older Neovim: each quarter of a download, and its end
    local quarter = math.floor((percent or 0) / 25)
    if quarter ~= told_quarter or finished then
      told_quarter = finished and -1 or quarter
      vim.notify('semantic-grep: ' .. text)
    end
  elseif message.phase == 'failed' then
    told_quarter = -1
    vim.notify('semantic-grep: ' .. text, vim.log.levels.WARN) -- an older Neovim: only a failure
  end
end

--- :SemanticGrep [words] | files [words] | rebuild | download
function M.command(opts)
  local arg = vim.trim(opts.args or '')
  if arg == 'rebuild' then return M.rebuild() end
  if arg == 'download' then return M.download() end
  local files = arg == 'files' or vim.startswith(arg, 'files ')
  if files then arg = vim.trim(arg:sub(6)) end
  if arg == '' and opts.range and opts.range > 0 then
    local lines = vim.api.nvim_buf_get_lines(0, opts.line1 - 1, opts.line2, false)
    arg = vim.trim(table.concat(lines, ' '))
  end
  if files then M.files(arg) else M.find(arg) end
end

return M
