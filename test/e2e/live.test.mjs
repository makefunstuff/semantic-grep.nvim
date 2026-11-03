// End to end against real models: the stdio server, spawned as Neovim spawns it, indexes a small project
// (test/fixtures/shop) with an OpenAI-compatible embedding server and reranks with a System One decision model, and is
// asked questions worded unlike the code. By default the models this machine serves: EmbeddingGemma 2 at
// 127.0.0.1:8092 and d1-2B at 127.0.0.1:8091; set SEMANTIC_GREP_EMBEDDING_URL, SEMANTIC_GREP_EMBEDDING_MODEL,
// SEMANTIC_GREP_RERANK_URL and SEMANTIC_GREP_RERANK_MODEL for others. Skipped when they do not answer.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {hasNvim, scratch, until} from '../helpers.mjs';
import {hasTelescope, runNvim} from '../nvim/harness.mjs';
import {startServer} from '../rpc.mjs';

const EMBEDDING = {api: 'openai', baseUrl: process.env.SEMANTIC_GREP_EMBEDDING_URL ?? 'http://127.0.0.1:8092/v1', model: process.env.SEMANTIC_GREP_EMBEDDING_MODEL ?? 'embeddinggemma-2', dimensions: 768};
const RERANK = {api: 'system-one', baseUrl: process.env.SEMANTIC_GREP_RERANK_URL ?? 'http://127.0.0.1:8091/v1', model: process.env.SEMANTIC_GREP_RERANK_MODEL ?? 'd1-2B', top: 15, timeoutMs: 2000};
const FIXTURE = fileURLToPath(new URL('../fixtures/shop', import.meta.url));
const QUESTIONS = [
  ['how long to wait before trying the request again', 'src/backoff.js'],
  ['what does the customer owe for everything in the basket', 'src/cart.js'],
  ['log the user out when they have been away too long', 'src/session.js'],
  ['turn a blog post heading into something safe for a URL', 'src/slug.js'],
  ['read a spreadsheet export into a table', 'src/csv.js'],
  ['two letters to show when someone has no profile picture', 'src/avatar.js'],
  ['kick someone out of a group', 'src/teams.lua'],
];

async function answers(url, body) {
  try {
    const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(5000)});
    return response.ok;
  } catch {
    return false;
  }
}
const up = await answers(`${EMBEDDING.baseUrl}/embeddings`, {model: EMBEDDING.model, input: ['up?']});
const rerankUp = await answers(`${RERANK.baseUrl}/systemone`, {model: RERANK.model, state: 'x', questions: {q: {type: 'choice', instructions: 'which', criteria: {1: 'a', 2: 'b'}}}});
const skip = up ? false : `no embedding model at ${EMBEDDING.baseUrl}`;

test('live: the server indexes a project with the real embedding model and finds code from questions worded unlike it', {skip, timeout: 300_000}, async () => {
  const root = realpathSync(scratch('live-shop-'));
  cpSync(FIXTURE, root, {recursive: true});
  execFileSync('git', ['init', '-q'], {cwd: root});
  const server = startServer();
  try {
    const hello = await server.call('initialize', {dataDir: scratch('live-data-'), embedding: EMBEDDING, rerank: rerankUp ? RERANK : null});
    assert.equal(hello.state, 'on');
    const started = Date.now();
    await server.call('open', {root});
    await until(() => server.notifications.some(note => note.method === 'progress' && ['done', 'failed'].includes(note.params.phase)), 'the build', 120_000);
    const status = await server.call('status', {});
    const index = status.indexes[0];
    console.log(`indexed ${index.files} files, ${index.chunks} pieces, ${index.embedded} with vectors in ${Date.now() - started} ms (${Math.round(status.msPerChunk)} ms a piece)`);
    assert.equal(index.embedded, index.chunks, status.problem ?? '');
    assert.ok(index.chunks >= QUESTIONS.length);

    const check = await server.call('check', {});
    console.log(`check: embedding ${check.embedding.ok ? `${check.embedding.dimensions} numbers in ${check.embedding.ms} ms` : check.embedding.error}; rerank ${check.rerank ? (check.rerank.ok ? `${check.rerank.model}, ${check.rerank.pieces} pieces in ${check.rerank.ms} ms, matching piece first: ${check.rerank.right}` : check.rerank.error) : 'off'}`);
    assert.equal(check.embedding.dimensions, 768);

    let first = 0;
    for (const [question, file] of QUESTIONS) {
      const meaning = await server.call('meaning', {root, query: question});
      const rank = meaning.results.findIndex(result => result.file === file) + 1;
      const words = await server.call('words', {root, query: question});
      console.log(`meaning ${rank ? `#${rank}` : 'missed'} in ${meaning.ms} ms, words ${words.results.length} hits: "${question}" -> ${meaning.results[0]?.file}:${meaning.results[0]?.line} (${meaning.results[0]?.meaning})`);
      assert.ok(rank >= 1 && rank <= 3, `${file} in meaning's first three for "${question}"`);
      if (rank === 1) first += 1;
    }
    console.log(`meaning put the right file first for ${first} of ${QUESTIONS.length}`);
    assert.ok(first >= QUESTIONS.length - 2);

    // The picker's settled rerank and the one fused list, with the model of the config (top 15, 2 s).
    if (rerankUp) {
      let applied = 0;
      for (const [question, file] of QUESTIONS) {
        const reranked = await server.call('rerank', {root, query: question});
        const {rerank} = reranked;
        const rank = reranked.results.findIndex(result => result.file === file) + 1;
        console.log(`rerank ${rerank.applied ? `applied by ${rerank.model} in ${rerank.ms} ms, ${rerank.moved} of ${rerank.top} moved, right file #${rank}` : `kept the order: ${rerank.why} (${rerank.problem})`}: "${question}"`);
        if (rerank.applied) applied += 1;
        if (rerank.why === 'timeout' || rerank.why === 'down') break; // it rests a minute: the next would not be asked
      }
      console.log(`rerank applied to ${applied} of the questions asked`);
      const fused = await server.call('search', {root, query: QUESTIONS[1][0]});
      console.log(`fused list: first ${fused.results[0]?.file}, rerank ${fused.rerank ? (fused.rerank.applied ? 'applied' : fused.rerank.why) : 'not asked (resting)'}`);
      assert.ok(fused.results.some(result => result.file === QUESTIONS[1][1]));
    } else {
      console.log(`no rerank model at ${RERANK.baseUrl}: rerank not checked`);
    }

    // A save: the changed piece is embedded again, and found.
    const {writeFileSync} = await import('node:fs');
    writeFileSync(join(root, 'src', 'refund.js'), 'export function refund(order, item) {\n  order.balance -= item.cents\n  return order\n}\n');
    await server.call('saved', {path: join(root, 'src', 'refund.js')});
    await until(async () => (await server.call('status', {})).indexes[0].embedded === (await server.call('status', {})).indexes[0].chunks, 'the save embedded', 30_000);
    const back = await server.call('meaning', {root, query: 'give the customer their money back'});
    console.log(`after a save: "give the customer their money back" -> ${back.results[0]?.file}`);
    assert.equal(back.results[0]?.file, 'src/refund.js');
  } finally {
    await server.close();
  }
});

test('live: Telescope in a headless Neovim, :Telescope semantic_grep, meaning and the rerank with the real models', {skip: skip || (!hasTelescope && 'telescope.nvim and plenary.nvim not found') || (!hasNvim && 'no nvim'), timeout: 120_000}, async () => {
  const root = realpathSync(scratch('live-nvim-'));
  cpSync(FIXTURE, root, {recursive: true});
  execFileSync('git', ['init', '-q'], {cwd: root});
  const dir = scratch('live-nvim-run-');
  const {lines} = await runNvim(`
    require('semantic-grep').setup({
      data_dir = ${JSON.stringify(join(dir, 'data'))},
      embedding = ${luaTable(EMBEDDING)},
      ${rerankUp ? `rerank = ${luaTable(RERANK)},` : ''}
    })
    require('telescope').setup({})
    require('telescope').load_extension('semantic_grep')
    vim.cmd('Telescope semantic_grep default_text=kick')
    local live = require('semantic-grep.picker').last
    local picker = require('telescope.actions.state').get_current_picker(vim.api.nvim_get_current_buf())
    until_(function() return live.meaning_info ~= nil end, 'meaning', 60000)
    picker:set_prompt('kick someone out of a group')
    until_(function() return live.query == 'kick someone out of a group' and live.meaning_info ~= nil and not live.reranking end, 'meaning and the rerank', 60000)
    vim.wait(300)
    local shown = {}
    for i = 1, picker.manager:num_results() do shown[#shown + 1] = picker.manager:get_entry(i).value.file end
    emit({shown = shown, title = live:title(), rerank = live.rerank_info})
  `, {cwd: root, dir, telescope: true, timeoutMs: 110_000});
  const [{shown, title, rerank}] = lines;
  console.log(`Telescope shows ${shown.join(', ')}; title: ${title}`);
  assert.equal(shown[0], 'src/teams.lua');
  if (rerankUp && rerank) assert.ok(rerank.applied || rerank.why, 'the rerank answered or said why not');
});

function luaTable(value) {
  return `{${Object.entries(value).map(([key, item]) => `${key} = ${typeof item === 'string' ? JSON.stringify(item) : item}`).join(', ')}}`;
}
