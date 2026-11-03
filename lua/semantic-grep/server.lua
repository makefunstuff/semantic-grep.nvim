-- The default source (see init.lua): the stdio JSON-RPC server this Neovim spawns, `node bin/semantic-grep-server.mjs`,
-- started at its first request and stopped when Neovim goes (its stdin closes). It is told the config and this
-- Neovim's tree-sitter parsers once, then asked; its progress notifications go to init.lua's on_progress.
local M = {}

local plugin_root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h:h:h')
M.script = plugin_root .. '/bin/semantic-grep-server.mjs'

local function data_dir(config)
  return vim.fn.fnamemodify(config.data_dir or (vim.fn.stdpath('data') .. '/semantic-grep'), ':p'):gsub('/$', '')
end

--- A source on a server started with `config` (init.lua's).
function M.new(config)
  local self = {name = 'its own server (' .. M.script .. ')', log = {}}
  local job, ready, failed = nil, false, nil
  local next_id, waiting, queue, partial = 0, {}, {}, ''

  local function send(message) vim.fn.chansend(job, vim.json.encode(message) .. '\n') end

  local function answer(message)
    if message.id ~= nil and waiting[message.id] then
      local callback = waiting[message.id]
      waiting[message.id] = nil
      if message.error then callback(message.error.message or 'failed') else callback(nil, message.result) end
    elseif message.method == 'progress' then
      require('semantic-grep').on_progress(message.params or {})
    elseif message.method == 'log' then
      table.insert(self.log, (message.params or {}).text)
      if #self.log > 50 then table.remove(self.log, 1) end
    end
  end

  local function on_stdout(_, data)
    data[1] = partial .. data[1]
    partial = table.remove(data) -- the last element is a line not ended yet (or '')
    for _, line in ipairs(data) do
      if line ~= '' then
        local ok, message = pcall(vim.json.decode, line, {luanil = {object = true, array = true}})
        if ok and type(message) == 'table' then answer(message) end
      end
    end
  end

  local function fail_all(why)
    failed = why
    local callbacks = waiting
    waiting = {}
    for _, callback in pairs(callbacks) do callback(why) end
    for _, item in ipairs(queue) do if item.callback then item.callback(why) end end
    queue = {}
  end

  local function start()
    if job then return end
    failed, ready, partial = nil, false, ''
    local stderr = {}
    local ok, id = pcall(vim.fn.jobstart, {config.node or 'node', M.script}, {
      on_stdout = on_stdout,
      on_stderr = function(_, data) for _, line in ipairs(data) do if line ~= '' then stderr[#stderr + 1] = line end end end,
      on_exit = function(_, code)
        job = nil
        ready = false
        if code ~= 0 then
          local why = ('the server stopped (%d): %s'):format(code, table.concat(stderr, ' '):sub(1, 300))
          table.insert(self.log, why)
          fail_all(why)
        else
          fail_all('the server stopped')
        end
      end,
    })
    if not ok or id <= 0 then
      fail_all(('cannot run %s: is Node 22 or later installed?'):format(config.node or 'node'))
      return
    end
    job = id
    next_id = next_id + 1
    local hello = next_id
    waiting[hello] = function(err, result)
      if err then
        fail_all('setup: ' .. err)
        table.insert(self.log, 'setup: ' .. err)
        vim.schedule(function() vim.notify('semantic-grep: ' .. err, vim.log.levels.ERROR) end)
        return
      end
      ready = true
      self.hello = result
      local pending = queue
      queue = {}
      for _, item in ipairs(pending) do
        if item.callback then
          next_id = next_id + 1
          waiting[next_id] = item.callback
          send({jsonrpc = '2.0', id = next_id, method = item.method, params = item.params})
        else
          send({jsonrpc = '2.0', method = item.method, params = item.params})
        end
      end
    end
    send({jsonrpc = '2.0', id = hello, method = 'initialize', params = {
      dataDir = data_dir(config), embedding = config.embedding, rerank = config.rerank, index = config.index,
      parsers = vim.api.nvim_get_runtime_file('parser/*', true),
    }})
  end

  function self.request(method, params, callback)
    start()
    if not job then return callback(failed or 'the server is not running') end
    if not ready then
      queue[#queue + 1] = {method = method, params = params or vim.empty_dict(), callback = callback}
      return
    end
    next_id = next_id + 1
    waiting[next_id] = callback
    send({jsonrpc = '2.0', id = next_id, method = method, params = params or vim.empty_dict()})
  end

  function self.notify(method, params)
    if not job then return end -- nothing to tell a server that is not running
    if not ready then
      queue[#queue + 1] = {method = method, params = params or vim.empty_dict()}
      return
    end
    send({jsonrpc = '2.0', method = method, params = params or vim.empty_dict()})
  end

  --- 'saved' goes as a request: its answer is not waited for.
  local notify = self.notify
  function self.notify(method, params)
    if method == 'saved' and job then return self.request(method, params, function() end) end
    return notify(method, params)
  end

  function self.running() return job ~= nil end

  function self.stop()
    if job then
      pcall(vim.fn.chanclose, job, 'stdin')
      job = nil
    end
  end

  --- A request answered before `timeout_ms`, for :checkhealth: `err, result`.
  function self.wait(method, params, timeout_ms)
    local done, err, result = false, nil, nil
    self.request(method, params, function(e, r) done, err, result = true, e, r end)
    if not vim.wait(timeout_ms or 10000, function() return done end, 20) then return 'no answer within ' .. (timeout_ms or 10000) .. ' ms' end
    return err, result
  end

  return self
end

return M
