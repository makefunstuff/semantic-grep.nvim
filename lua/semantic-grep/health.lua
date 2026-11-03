-- :checkhealth semantic-grep: Node and the server, git and ripgrep, the source, the embedding model (one word
-- embedded), the rerank models (a search's worth of pieces reranked) and the index of this project.
local M = {}

local function wait(source, method, params, timeout_ms)
  local done, err, result = false, nil, nil
  source.request(method, params, function(e, r) done, err, result = true, e, r end)
  if not vim.wait(timeout_ms, function() return done end, 20) then return ('no answer within %d ms'):format(timeout_ms) end
  return err, result
end

local function kb(bytes) return bytes and ('%.1f MB'):format(bytes / 1048576) or '?' end

function M.check()
  local health = vim.health
  local sg = require('semantic-grep')
  local config = sg.config
  health.start('semantic-grep')

  if vim.fn.has('nvim-0.10') == 1 then health.ok('Neovim ' .. tostring(vim.version())) else health.error('Neovim 0.10 or later is needed') end
  local registered = sg.source()
  local own = registered.running ~= nil and registered.name and registered.name:find('its own server', 1, true)
  if own then
    local node = vim.system({config.node or 'node', '--version'}, {text = true}):wait()
    local version = node.code == 0 and vim.trim(node.stdout) or nil
    local major, minor = (version or ''):match('^v(%d+)%.(%d+)')
    major, minor = tonumber(major), tonumber(minor)
    if not version then
      health.error(('cannot run %s'):format(config.node or 'node'), {'Install Node 22.16 or later, or set node = "/path/to/node" in setup()'})
    elseif not major or major < 22 or (major == 22 and minor < 16) then
      health.error(('Node %s: 22.16 or later is needed (node:sqlite with FTS5)'):format(version))
    else
      health.ok(('Node %s'):format(version))
    end
  else
    health.ok('source: ' .. (registered.name or 'one registered by another plugin'))
    if registered.health then for _, line in ipairs(registered.health() or {}) do health.info(line) end end
  end
  health.info(vim.fn.executable('git') == 1 and 'git: the files it lists are indexed' or 'no git: ripgrep lists the files')
  if vim.fn.executable('git') == 0 and vim.fn.executable('rg') == 0 then health.warn('neither git nor rg: no file is indexed') end

  local err, status = wait(registered, 'status', vim.empty_dict(), 10000)
  if err then
    health.error('the search does not answer: ' .. err)
    if registered.log and #registered.log > 0 then health.info('its log: ' .. table.concat(registered.log, ' | ')) end
    return
  end
  health.ok(('it answers: search by meaning is %s'):format(status.state))
  health.info(status.treeSitter == 'nvim' and 'pieces: functions and classes by tree-sitter (a headless Neovim), blocks between blank lines elsewhere' or 'pieces: no nvim to run headless: blocks between blank lines')

  health.start('semantic-grep: models')
  local checked
  err, checked = wait(registered, 'check', vim.empty_dict(), 150000) -- the local model's server may start for it
  if err then
    health.error('the models could not be checked: ' .. err)
  else
    local profile = checked.profile ~= vim.NIL and checked.profile or nil
    if profile then health.info(('profile: %s (docs/profiles.md says how to run its models)'):format(profile)) end
    local start_it = profile and ('Start it: docs/profiles.md, "%s"'):format(profile) or 'Start its server, or set its baseUrl in setup()'
    local e = checked.embedding
    local own = checked['local'] ~= vim.NIL and checked['local'] or nil
    if own then
      health.info(('the local model: %s at %s%s'):format(own.model, own.path, own.running and (', its llama-server at 127.0.0.1:%d'):format(own.port) or ''))
      if own.llamaServer and own.llamaServer ~= vim.NIL then health.ok('llama-server: ' .. own.llamaServer) end
    end
    local missing = e and e['local'] ~= vim.NIL and e['local'] or nil
    if missing then
      if missing.runtime and missing.runtime ~= vim.NIL then
        health.warn(('embedding: %s is not on PATH: the word search works alone'):format(missing.runtime), {
          'Install llama.cpp, which has llama-server: `brew install llama.cpp` (macOS, Linux), `winget install llama.cpp` (Windows), `nix profile install nixpkgs#llama-cpp`,',
          'or a build from https://github.com/ggml-org/llama.cpp/releases with llama-server on PATH',
          'or set local_model = {llama_server = "/path/to/llama-server"} in setup(); then restart Neovim',
        })
      end
      if missing.model then
        health.warn(('embedding: %s (%d MB) is not downloaded yet'):format(missing.name or 'the model', math.floor((missing.bytes or 0) / 1e6 + 0.5)), {':SemanticGrep download fetches it into ' .. (missing.path or 'the data folder')})
      end
    elseif not e then
      health.warn('embedding: none, the word search works alone', {'Set embedding = {api = "openai", baseUrl = ..., model = ...} in setup() for search by meaning, or leave it out for the local model'})
    elseif e.ok then
      health.ok(('embedding: %s answers in %d ms, %d numbers a piece'):format(e.model or '?', e.ms or 0, e.dimensions or 0))
    elseif e.unreachable then
      health.error(('embedding: %s is unreachable: %s'):format(e.model or '?', e.error or '?'), {start_it, 'The words still rank; meaning comes back once it answers'})
    else
      health.error(('embedding: %s fails: %s'):format(e.model or '?', e.error or '?'), {'The words still rank; meaning comes back once it answers'})
    end
    local r = checked.rerank
    if not r then
      health.info('rerank: off, searches keep the order of meaning and words')
    else
      local skipped = {}
      for _, skip in ipairs(r.skipped or {}) do
        skipped[#skipped + 1] = skip.unreachable and ('%s is unreachable (%s)'):format(skip.name or skip.model, skip.error or '') or ('%s %s (%s)'):format(skip.model, skip.why, skip.error or '')
      end
      local before = #skipped > 0 and ('; first ' .. table.concat(skipped, ', ')) or ''
      if r.ok then
        local took = (r.ms or 0) < 1000 and ('%d ms'):format(r.ms or 0) or ('%.1f s'):format(r.ms / 1000)
        local text = ('rerank: %s reranks %d pieces in %s (a search waits up to %.1f s)%s'):format(r.model or '?', r.pieces or 0, took, (r.timeoutMs or 0) / 1000, before)
        if r.right then health.ok(text) else health.warn(text .. ', but put the matching piece of the check below another') end
      elseif r.unreachable then
        health.error(('rerank: %s is unreachable: %s%s'):format(r.name or r.models or '?', r.error or '?', before), {start_it, 'Searches keep their own order; a model that fails is asked again a minute later'})
      else
        health.error(('rerank: %s fails: %s%s'):format(r.model or r.models or '?', r.error or '?', before), {'Searches keep their own order; a model that fails is asked again a minute later'})
      end
    end
  end

  health.start('semantic-grep: index')
  local root = sg.root()
  wait(registered, 'open', {root = root}, 10000)
  local mine
  vim.wait(5000, function() -- its file opens in the background
    err, status = wait(registered, 'status', vim.empty_dict(), 10000)
    for _, index in ipairs((status or {}).indexes or {}) do
      if index.root == root and (index.files > 0 or not index.reading and index.chunks > 0) then mine = index end
    end
    return mine ~= nil or err ~= nil
  end, 100)
  local found = false
  for _, index in ipairs(mine and {mine} or {}) do
    do
      found = true
      local built = index.chunks > 0 and math.floor(100 * index.embedded / index.chunks) or 100
      local text = ('%s: %d files, %d pieces, %d with vectors (%d%%), %s at %s'):format(root, index.files, index.chunks, index.embedded, built, kb(index.bytes), index.path)
      if index.capped then health.warn(text .. '; over the piece limit: some files are left out') else health.ok(text) end
      if index.reading then health.info(('reading files: %d of %d'):format(index.reading.done, index.reading.total)) end
    end
  end
  if not found then health.info(root .. ': not indexed yet; the first search indexes it') end
  if status and status.problem then health.warn('indexing stopped: ' .. status.problem) end
end

return M
