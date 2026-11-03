// The stdio server one Neovim spawns: JSON-RPC a line, its methods on a project (words on every key, meaning, the
// rerank, one fused list, a save, a rebuild, the status and the health check), progress told as notifications, a bad
// config named, and an exit once its stdin closes. Fakes stand in for the embedding model and the decision model.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fakeEmbeddingServer} from './fake-embedder.mjs';
import {fakeRerankServer} from './fake-reranker.mjs';
import {scratch, until} from './helpers.mjs';
import {startServer} from './rpc.mjs';

function project() {
  const root = realpathSync(scratch('server-project-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'deliver.js'), 'export function deliver(job) {\n  let tries = 0\n  while (tries < 5) {\n    tries += 1\n    if (send(job)) return true\n    sleep(backoff(tries))\n  }\n}\n');
  writeFileSync(join(root, 'src', 'cart.js'), '// The basket\'s sum.\nexport function total(cart) {\n  return cart.items.reduce((sum, item) => sum + item.cents * item.quantity, 0)\n}\n');
  writeFileSync(join(root, 'src', 'tip.js'), '// A tip on the price, for the waiter.\nexport function tip(cents) {\n  return Math.round(cents * 0.15)\n}\n');
  execFileSync('git', ['init', '-q'], {cwd: root});
  return root;
}

test('the server: words, meaning, the rerank and one fused list over JSON-RPC, a save, a rebuild, progress and the health check', async () => {
  const embeddings = await fakeEmbeddingServer();
  const decisions = await fakeRerankServer({favourite: 'waiter'});
  const root = project();
  const dataDir = scratch('server-data-');
  const server = startServer();
  try {
    await assert.rejects(server.call('words', {root, query: 'x'}), /not initialized/);
    await assert.rejects(server.call('initialize', {dataDir, embedding: {baseUrl: embeddings.baseUrl}}), /embedding\.model is missing/, 'a bad config is named');
    const hello = await server.call('initialize', {
      dataDir, parsers: [],
      embedding: {api: 'openai', baseUrl: embeddings.baseUrl, model: 'embeddinggemma-2', dimensions: 256, band: 0.1}, // the fake's vectors are not the model's
      rerank: {api: 'system-one', baseUrl: decisions.baseUrl, model: 'fake-d1', top: 5},
    });
    assert.deepEqual([hello.state, hello.model], ['on', `embeddinggemma-2 at ${embeddings.baseUrl}`]);
    assert.match(hello.version, /^\d+\.\d+\.\d+$/);
    await server.call('open', {root});
    await until(() => server.notifications.some(note => note.method === 'progress' && note.params.phase === 'done'), 'the build to end', 10_000);
    assert.equal(server.notifications.find(note => note.method === 'progress').params.root, root);

    const words = await server.call('words', {root, query: 'quant item'});
    assert.deepEqual(words.results.map(result => [result.file, result.path, result.line]), [['src/cart.js', join(root, 'src', 'cart.js'), 2]], 'the line after its doc comment, and its absolute path');
    assert.equal(words.results[0].head, 'export function total(cart) {');
    const meaning = await server.call('meaning', {root, query: 'try again when sending fails'});
    assert.equal(meaning.results[0].file, 'src/deliver.js');
    assert.equal(meaning.reranker, 'fake-d1', 'a rerank may follow');
    assert.equal(embeddings.requests.at(-1).input[0], 'task: search result | query: try again when sending fails', 'EmbeddingGemma\'s own prompt');
    assert.equal(embeddings.requests.at(-1).dimensions, 256);
    const reranked = await server.call('rerank', {root, query: 'price cents'});
    assert.equal(reranked.rerank.applied, true);
    assert.equal(reranked.results[0].file, 'src/tip.js');
    const fused = await server.call('search', {root, query: 'price cents'});
    assert.equal(fused.results[0].file, 'src/tip.js', 'one list, fused and reranked');
    assert.ok(server.notifications.some(note => note.method === 'booked' && note.params.kind === 'reranked'));

    writeFileSync(join(root, 'src', 'refund.js'), '// Money back for a returned item.\nexport function refund(item) {\n  return -item.cents\n}\n');
    await server.call('saved', {path: join(root, 'src', 'refund.js')});
    assert.equal((await server.call('words', {root, query: 'refund'})).results[0].file, 'src/refund.js', 'a save is read at once');
    await server.call('saved', {path: '/elsewhere/file.js'}); // outside the project: nothing

    const status = await server.call('status', {});
    assert.equal(status.indexes[0].root, root);
    assert.equal(status.indexes[0].files, 4, 'the three files and the one saved');
    assert.ok(status.indexes[0].embedded >= 4);
    const check = await server.call('check', {});
    assert.deepEqual([check.embedding.ok, check.embedding.dimensions], [true, 256]);
    assert.deepEqual([check.rerank.ok, check.rerank.model, check.rerank.pieces], [true, 'fake-d1', 5]);

    const pending = await server.call('notes', {root, limit: 1});
    assert.equal(pending.pieces.length, 1);
    assert.equal(pending.pending, 4);
    assert.deepEqual(await server.call('addNotes', {root, notes: [{hash: pending.pieces[0].hash, note: 'a note'}]}), {added: 1, unknown: []});
    assert.equal((await server.call('notes', {root})).pending, 3);

    const {path} = await server.call('rebuild', {root});
    assert.match(path, new RegExp(`^${dataDir}/index/server-project-\\w+-[0-9a-f]{8}\\.sqlite$`), 'pairing-buddy\'s place and name: one index for both');
    await until(async () => (await server.call('words', {root, query: 'quant'})).results.length === 1, 'the words again after the rebuild');
    await assert.rejects(server.call('nothing', {}), /no method nothing/);
    assert.equal(await server.close(), 0, 'it exits once Neovim goes');
    assert.equal(server.stderr, '');
  } finally {
    server.child.kill();
    await embeddings.stop();
    await decisions.close();
  }
});

test('without an embedding model the words still work, and meaning says so', async () => {
  const root = project();
  const server = startServer();
  try {
    assert.equal((await server.call('initialize', {dataDir: scratch('server-data-'), embedding: false})).state, 'off');
    const words = await server.call('words', {root, query: 'waiter'});
    await until(async () => (await server.call('words', {root, query: 'waiter'})).results.length === 1, 'the words');
    assert.equal(words.state, 'off');
    const meaning = await server.call('meaning', {root, query: 'waiter'});
    assert.deepEqual([meaning.state, meaning.results], ['off', []]);
    assert.deepEqual(await server.call('check', {}), {profile: null, embedding: null, rerank: null, notes: null, local: null});
  } finally {
    await server.close();
  }
});
