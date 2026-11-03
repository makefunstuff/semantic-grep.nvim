// The plugin in a headless Neovim: it loads with its command and no keymaps, :checkhealth semantic-grep checks the
// models and the index, and the Telescope extension (the real Telescope) shows the words on a key, meaning below them
// once typing stops, the rerank in place with the selection kept, <C-q> to quickfix, and a quickfix list sent before
// the rerank came reordered when it comes. Fakes stand in for the embedding and decision models.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fakeEmbeddingServer} from '../fake-embedder.mjs';
import {fakeRerankServer} from '../fake-reranker.mjs';
import {hasNvim, scratch} from '../helpers.mjs';
import {hasTelescope, runNvim} from './harness.mjs';

function project() {
  const root = realpathSync(scratch('nvim-project-'));
  mkdirSync(join(root, 'src'));
  const files = {
    'src/cart.js': '// The basket\'s sum.\nexport function total(cart) {\n  return cart.items.reduce((sum, item) => sum + item.cents, 0)\n}\n',
    'src/invoice.js': '// The price on the invoice, taxes in.\nexport function invoicePrice(order) {\n  return order.cents * 1.2\n}\n',
    'src/refund.js': '// Money back for a returned item.\nexport function refund(item) {\n  return -item.cents\n}\n',
    'src/tip.js': '// A tip on the price, for the waiter.\nexport function tip(cents) {\n  return Math.round(cents * 0.15)\n}\n',
    'src/deliver.js': 'export function deliver(job) {\n  let tries = 0\n  while (tries < 5) {\n    tries += 1\n    if (send(job)) return true\n    sleep(backoff(tries))\n  }\n}\n',
  };
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
  execFileSync('git', ['init', '-q'], {cwd: root});
  return root;
}

const setup = (embedding, rerank, dataDir) => `require('semantic-grep').setup({
  data_dir = ${JSON.stringify(dataDir)},
  embedding = {api = 'openai', baseUrl = ${JSON.stringify(embedding)}, model = 'embeddinggemma-2', dimensions = 256, band = 0.1}, -- the fake's vectors are not the model's
  ${rerank ? `rerank = {api = 'system-one', baseUrl = ${JSON.stringify(rerank)}, model = 'fake-d1', top = 5, timeoutMs = 3000},` : ''}
})`;

test('the plugin loads: :SemanticGrep, no keymaps, the Telescope extension listed, and setup checks nothing until used', {skip: !hasNvim && 'nvim not installed'}, async () => {
  const dir = scratch('nvim-');
  const {lines} = await runNvim(`
    local before = #vim.api.nvim_get_keymap('n') + #vim.api.nvim_get_keymap('i') + #vim.api.nvim_get_keymap('x')
    require('semantic-grep').setup({})
    emit({command = vim.fn.exists(':SemanticGrep'), keymaps = #vim.api.nvim_get_keymap('n') + #vim.api.nvim_get_keymap('i') + #vim.api.nvim_get_keymap('x') - before,
      extension = #vim.api.nvim_get_runtime_file('lua/telescope/_extensions/semantic_grep.lua', false), running = require('semantic-grep').source().running(),
      health = #vim.api.nvim_get_runtime_file('lua/semantic-grep/health.lua', false), complete = vim.fn.getcompletion('SemanticGrep re', 'cmdline')})
  `, {cwd: dir, dir});
  assert.deepEqual(lines[0], {command: 2, keymaps: 0, extension: 1, running: false, health: 1, complete: ['rebuild']});
});

test('on_progress takes a source\'s JSON nulls (vim.NIL) without an error', {skip: !hasNvim && 'nvim not installed'}, async () => {
  const dir = scratch('nvim-');
  const {lines} = await runNvim(`
    require('semantic-grep').setup({})
    local ok, err = pcall(require('semantic-grep').on_progress, {root = vim.NIL, phase = 'embedding', done = vim.NIL, total = vim.NIL, text = vim.NIL})
    local ok2 = pcall(require('semantic-grep').on_progress, {phase = 'done', total = 12})
    emit({ok = ok, ok2 = ok2, err = err and tostring(err) or ''})
  `, {cwd: dir, dir});
  assert.deepEqual(lines[0], {ok: true, ok2: true, err: ''});
});

test(':checkhealth semantic-grep: Node, the embedding model, the rerank model and this project\'s index', {skip: !hasNvim && 'nvim not installed'}, async () => {
  const embeddings = await fakeEmbeddingServer();
  const decisions = await fakeRerankServer({favourite: 'The sum of a and b'});
  const root = project();
  const dir = scratch('nvim-');
  try {
    const {lines} = await runNvim(`
      ${setup(embeddings.baseUrl, decisions.baseUrl, join(dir, 'data'))}
      vim.cmd('checkhealth semantic-grep')
      emit({text = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\\n')})
    `, {cwd: root, dir});
    const {text} = lines[0];
    assert.match(text, /OK.*Node v\d+/);
    assert.match(text, /OK.*it answers: search by meaning is on/);
    assert.match(text, /OK.*embedding: embeddinggemma-2 at http:\S+ answers in \d+ ms, 256 numbers a piece/);
    assert.match(text, /OK.*rerank: fake-d1 reranks 5 pieces in \d\.\d s \(a search waits up to 3\.0 s\)/);
    assert.match(text, new RegExp(`OK.*${root}: \\d+ files, \\d+ pieces`));
    assert.doesNotMatch(text, /ERROR/);

    await decisions.close();
    const down = await runNvim(`
      require('semantic-grep').setup({data_dir = ${JSON.stringify(join(dir, 'data'))}, profile = 'beefy', embedding = {baseUrl = 'http://127.0.0.1:1/v1', model = 'gone'}, rerank = {api = 'system-one', baseUrl = 'http://127.0.0.1:1/v1', model = 'gone-d1'}})
      vim.cmd('checkhealth semantic-grep')
      emit({text = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\\n')})
    `, {cwd: root, dir});
    assert.match(down.lines[0].text, /profile: beefy/);
    assert.match(down.lines[0].text, /ERROR.*embedding: gone at http:\/\/127\.0\.0\.1:1\/v1 is unreachable: the embedding model at http:\/\/127\.0\.0\.1:1\/v1 did not answer/);
    assert.match(down.lines[0].text, /ERROR.*rerank: gone-d1 at http:\/\/127\.0\.0\.1:1\/v1 is unreachable/);
    assert.match(down.lines[0].text, /Start it: docs\/profiles\.md, "beefy"/);
  } finally {
    await embeddings.stop();
    await decisions.close().catch(() => {});
  }
});

test('Telescope: words on a key, meaning below them, the rerank in place keeping the selection, <C-q> and a late rerank reordering quickfix', {skip: (!hasNvim && 'nvim not installed') || (!hasTelescope && 'telescope.nvim and plenary.nvim not found')}, async () => {
  const embeddings = await fakeEmbeddingServer();
  const decisions = await fakeRerankServer({favourite: 'waiter', mode: 'slow', delayMs: 600});
  const root = project();
  const dir = scratch('nvim-');
  try {
    const {lines} = await runNvim(`
      ${setup(embeddings.baseUrl, decisions.baseUrl, join(dir, 'data'))}
      local telescope = require('telescope')
      telescope.setup({})
      telescope.load_extension('semantic_grep')
      local state = require('telescope.actions.state')
      local keyof = function(entry) return entry.value.file .. ':' .. entry.value.from end
      local function shown(p)
        local out = {}
        for i = 1, p.manager:num_results() do out[#out + 1] = keyof(p.manager:get_entry(i)) end
        return out
      end

      -- The words first: what has "cents", then meaning's pieces below once typing stops.
      telescope.extensions.semantic_grep.semantic_grep({default_text = 'cents'})
      local prompt = vim.api.nvim_get_current_buf()
      local picker = state.get_current_picker(prompt)
      local live = require('semantic-grep.picker').last
      until_(function() return live.words ~= nil and picker.manager and picker.manager:num_results() > 0 end, 'the words')
      local words = shown(picker)
      until_(function() return live.meaning_info ~= nil and picker.manager:num_results() >= #words end, 'meaning')
      local merged = shown(picker)
      emit({step = 'words', words = words, merged = merged, title = live:title(), filetype = vim.bo[prompt].filetype})

      -- Another word typed: the list starts over. Meaning comes, the rerank runs; the selection moves meanwhile.
      picker:set_prompt('price cents')
      until_(function() return live.query == 'price cents' and live.meaning_info ~= nil and live.reranking end, 'the rerank to start')
      local before = shown(picker)
      picker:move_selection(1)
      local chosen = keyof(state.get_selected_entry())
      until_(function() return live.rerank_info ~= nil end, 'the rerank', 15000)
      vim.wait(200)
      local after = shown(picker)
      emit({step = 'rerank', before = before, after = after, chosen = chosen, selected = keyof(state.get_selected_entry()), applied = live.rerank_info.applied, title = live:title(),
        preview = state.get_selected_entry().lnend ~= nil})

      -- <C-q>: the list as shown, to quickfix.
      vim.api.nvim_feedkeys(vim.keycode('<C-q>'), 'x', false)
      until_(function() return #vim.fn.getqflist() > 0 end, 'the quickfix list')
      local qf = vim.fn.getqflist({title = 0, items = 0})
      local items = {}
      for _, item in ipairs(qf.items) do items[#items + 1] = vim.fn.fnamemodify(vim.fn.bufname(item.bufnr), ':.') .. ':' .. item.lnum end
      emit({step = 'quickfix', title = qf.title, items = items})

      -- <C-q> before the rerank came: the quickfix list now, in the order shown, and reordered in place when it comes.
      vim.cmd('cclose')
      telescope.extensions.semantic_grep.semantic_grep({default_text = 'cents'})
      prompt = vim.api.nvim_get_current_buf()
      picker = state.get_current_picker(prompt)
      live = require('semantic-grep.picker').last
      until_(function() return live.reranking end, 'the second rerank to start')
      local sent = shown(picker)
      vim.api.nvim_feedkeys(vim.keycode('<C-q>'), 'x', false)
      until_(function() return vim.fn.getqflist({title = 0}).title:find('cents') ~= nil end, 'the second quickfix list')
      local early = vim.fn.getqflist({title = 0, id = 0, nr = '$'})
      until_(function() return vim.fn.getqflist({title = 0}).title:find('reranked') ~= nil end, 'the quickfix list reranked', 15000)
      local late = vim.fn.getqflist({title = 0, id = 0, nr = '$', items = 0})
      local first = vim.fn.fnamemodify(vim.fn.bufname(late.items[1].bufnr), ':.')
      local order, reranked = {}, {}
      for _, item in ipairs(late.items) do order[#order + 1] = vim.fn.fnamemodify(vim.fn.bufname(item.bufnr), ':.') end
      for _, item in ipairs(live.items) do reranked[#reranked + 1] = item.file end
      emit({step = 'late', sent = sent, early = early.title, late = late.title, same = early.id == late.id and early.nr == late.nr, first = first, order = order, reranked = reranked})

      -- :Telescope semantic_grep, the command.
      vim.cmd('cclose')
      vim.cmd('Telescope semantic_grep default_text=tries')
      picker = state.get_current_picker(vim.api.nvim_get_current_buf())
      live = require('semantic-grep.picker').last
      until_(function() return live.words ~= nil and picker.manager and picker.manager:num_results() > 0 end, ':Telescope semantic_grep')
      emit({step = 'command', first = keyof(picker.manager:get_entry(1)), prompt = picker:_get_prompt()})
    `, {cwd: root, dir, telescope: true, timeoutMs: 90_000});
    const step = name => lines.find(line => line.step === name);

    const words = step('words');
    assert.deepEqual(words.words.slice().sort(), ['src/cart.js:1', 'src/invoice.js:1', 'src/refund.js:1', 'src/tip.js:1'], 'the pieces that have the word');
    assert.deepEqual(words.merged.slice(0, words.words.length), words.words, 'meaning goes below: nothing shown moves');
    assert.equal(words.filetype, 'TelescopePrompt');

    const rerank = step('rerank');
    assert.equal(rerank.applied, true);
    assert.equal(rerank.after[0], 'src/tip.js:1', 'the piece the model favours goes first');
    assert.deepEqual(rerank.after.slice().sort(), rerank.before.slice().sort(), 'the same pieces, reordered');
    assert.equal(rerank.selected, rerank.chosen, 'the piece you were on is still the one you are on');
    assert.match(rerank.title, /reranked by fake-d1 \(\d\.\d s\)/);
    assert.ok(rerank.preview, 'the entry has the piece\'s lines for the preview');

    const quickfix = step('quickfix');
    assert.match(quickfix.title, /^SemanticGrep: price cents \(reranked by fake-d1\)$/);
    assert.deepEqual(quickfix.items.map(item => item.replace(/:\d+$/, '')), rerank.after.map(item => item.replace(/:\d+$/, '')), 'in the order shown');
    assert.equal(quickfix.items[0], 'src/tip.js:2', 'at the piece\'s line after its doc comment');

    const late = step('late');
    assert.equal(late.early, 'SemanticGrep: cents', 'sent at once, in the order shown');
    assert.equal(late.late, 'SemanticGrep: cents (reranked by fake-d1)');
    assert.ok(late.same, 'the same list, reordered in place');
    assert.equal(late.first, 'src/tip.js');
    assert.deepEqual(late.order, late.reranked, 'in the reranked order, as the picker shows it');
    assert.deepEqual(step('command'), {step: 'command', first: 'src/deliver.js:1', prompt: 'tries'});
  } finally {
    await embeddings.stop();
    await decisions.close();
  }
});

test('a registered source (another program\'s index) is asked instead of a server of its own', {skip: (!hasNvim && 'nvim not installed') || (!hasTelescope && 'telescope.nvim and plenary.nvim not found')}, async () => {
  const root = project();
  const dir = scratch('nvim-');
  const {lines} = await runNvim(`
    local asked = {}
    local source = {name = 'a test source'}
    function source.request(method, params, callback)
      asked[#asked + 1] = method
      local item = {file = 'src/tip.js', path = params.root .. '/src/tip.js', line = 2, from = 1, to = 4, head = 'export function tip(cents) {'}
      vim.schedule(function()
        if method == 'words' then callback(nil, {state = 'on', results = {item}})
        elseif method == 'meaning' then callback(nil, {state = 'on', results = {}, ms = 1})
        else callback(nil, {results = {}}) end
      end)
    end
    function source.notify(method) asked[#asked + 1] = method end
    local sg = require('semantic-grep')
    sg.setup({})
    sg.register_source(source)
    require('telescope').setup({})
    require('telescope').load_extension('semantic_grep')
    require('telescope').extensions.semantic_grep.semantic_grep({default_text = 'waiter'})
    local live = require('semantic-grep.picker').last
    local picker = require('telescope.actions.state').get_current_picker(vim.api.nvim_get_current_buf())
    until_(function() return live.meaning_info ~= nil and picker.manager and picker.manager:num_results() == 1 end, 'the source to answer')
    emit({asked = asked, first = picker.manager:get_entry(1).value.file, own = #vim.fn.systemlist('pgrep -f semantic-grep-server.mjs -P ' .. vim.fn.getpid())})
  `, {cwd: root, dir, telescope: true});
  assert.deepEqual(lines[0], {asked: ['words', 'meaning'], first: 'src/tip.js', own: 0});
});
