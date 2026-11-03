// The model a setup without one uses (local.mjs): downloaded once, checked by its hash, served by a llama-server it
// starts on a free port and stops when idle or done; the words alone while it has no llama-server or no model. A fake
// llama-server stands in (fake-llama-server.mjs).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {LOCAL_MODEL, LocalModel, onPath} from '../src/local.mjs';
import {Meaning} from '../src/meaning.mjs';
import {scratch, until} from './helpers.mjs';
import {startServer} from './rpc.mjs';

const FAKE = fileURLToPath(new URL('./fake-llama-server.mjs', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const starts = log => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);

function project() {
  const root = realpathSync(scratch('local-project-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'deliver.js'), 'export function deliver(job) {\n  let tries = 0\n  while (tries < 5) {\n    tries += 1\n    if (send(job)) return true\n    sleep(backoff(tries))\n  }\n}\n');
  writeFileSync(join(root, 'src', 'cart.js'), '// The basket\'s sum.\nexport function total(cart) {\n  return cart.items.reduce((sum, item) => sum + item.cents * item.quantity, 0)\n}\n');
  execFileSync('git', ['init', '-q'], {cwd: root});
  return root;
}

/** A fake download of `bytes`, in chunks, as fetch answers. */
const downloadOf = bytes => async () => new Response(new ReadableStream({
  start(controller) {
    for (let at = 0; at < bytes.length; at += 1000) controller.enqueue(bytes.subarray(at, at + 1000));
    controller.close();
  },
}));

test('the download: once, its progress told, checked by size and hash, nothing left of a bad one', async () => {
  const bytes = new Uint8Array(4500).map((_, i) => i % 251);
  const spec = {...LOCAL_MODEL, file: 'tiny.gguf', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
  const dataDir = scratch('local-data-');
  const told = [];
  const model = new LocalModel({dataDir, spec, llamaServer: FAKE, fetch: downloadOf(bytes)});
  mkdirSync(join(dataDir, 'models'), {recursive: true});
  writeFileSync(join(dataDir, 'models', 'tiny.gguf.999999999.part'), 'left by a download Neovim quit');
  try {
    assert.equal(model.state(), 'off');
    assert.deepEqual(await model.needs(), {runtime: null, model: true, own: false, bytes: 4500, path: join(dataDir, 'models', 'tiny.gguf'), name: 'EmbeddingGemma 2'});
    assert.deepEqual(await model.turnOn({progress: how => told.push(how)}), {runtime: false, model: true});
    assert.deepEqual(readFileSync(model.path), Buffer.from(bytes));
    assert.deepEqual(told.at(-1), {phase: 'downloading', done: 4500, total: 4500});
    assert.equal(existsSync(join(dataDir, 'models', 'tiny.gguf.999999999.part')), false, 'what a stopped one left is gone');
    assert.equal(model.state(), 'on');
    assert.deepEqual(await model.turnOn(), {runtime: false, model: false}, 'not again');
  } finally {
    model.close();
  }
  // Two Neovims at once, on one data folder: each its own part, the same file in the end.
  const shared = scratch('local-data-');
  const both = [0, 1].map(() => new LocalModel({dataDir: shared, spec, llamaServer: FAKE, fetch: downloadOf(bytes)}));
  try {
    await Promise.all(both.map(each => each.turnOn()));
    assert.deepEqual(readFileSync(both[0].path), Buffer.from(bytes));
  } finally {
    for (const each of both) each.close();
  }
  const bad = new LocalModel({dataDir: scratch('local-data-'), spec: {...spec, sha256: '0'.repeat(64)}, llamaServer: FAKE, fetch: downloadOf(bytes)});
  try {
    await assert.rejects(bad.turnOn(), /sha256 .* expected/);
    assert.equal(existsSync(bad.path) || existsSync(`${bad.path}.part`), false, 'nothing kept of it');
    assert.equal(bad.state(), 'off');
  } finally {
    bad.close();
  }
});

test('the server it starts: on a free port at the first text, at idle stopped and started again, gone with it', async () => {
  const dir = scratch('local-data-');
  const gguf = join(dir, 'model.gguf');
  writeFileSync(gguf, 'gguf');
  const log = join(dir, 'starts.jsonl');
  process.env.FAKE_LLAMA_LOG = log;
  const model = new LocalModel({dataDir: dir, gguf, llamaServer: FAKE, idleMs: 300});
  try {
    assert.equal(model.state(), 'on');
    assert.equal(model.ready, false, 'nothing runs before the first text');
    const [vector] = await model.embed([model.query('try again')], {urgent: true});
    assert.equal(vector.length, 256);
    const [first] = starts(log);
    assert.equal(first.cuda, '', 'on the CPU');
    assert.deepEqual(first.args.slice(first.args.indexOf('--alias'), first.args.indexOf('--alias') + 2), ['--alias', 'embeddinggemma-2']);
    assert.ok(first.args.includes('--embedding') && first.args.includes('--threads'));
    assert.notEqual(first.args[first.args.indexOf('--port') + 1], '0');
    await until(() => !alive(first.pid), 'the idle server to stop', 5000);
    await model.embed([model.query('again')]);
    assert.equal(starts(log).length, 2, 'started again at the next text');
    const second = starts(log)[1].pid;
    model.close();
    await until(() => !alive(second), 'the server to stop with it', 5000);
  } finally {
    delete process.env.FAKE_LLAMA_LOG;
    model.close();
  }
});

test('no llama-server, or no model: the words alone, and what is missing said', async () => {
  assert.equal(onPath('llama-server-that-is-not-there'), null);
  const dataDir = scratch('local-data-');
  const model = new LocalModel({dataDir, llamaServer: 'llama-server-that-is-not-there'});
  const meaning = new Meaning({dataDir, embedder: model, provider: model});
  const root = project();
  try {
    assert.equal(meaning.state, 'off');
    assert.deepEqual(await meaning.needs(), {runtime: 'llama-server-that-is-not-there', model: true, own: false, bytes: LOCAL_MODEL.bytes, path: join(dataDir, 'models', LOCAL_MODEL.file), name: 'EmbeddingGemma 2'});
    await until(async () => (await meaning.words(root, 'quantity')).results.length === 1, 'the words');
    const files = await meaning.files(root, 'quantity cart');
    assert.deepEqual([files.state, files.results.map(result => result.file)], ['off', ['src/cart.js']]);
    await assert.rejects(model.embed(['x']), /llama-server-that-is-not-there is not on PATH/);
  } finally {
    await meaning.close();
  }
});

test('a setup with no model: the stdio server uses the local one, with the llama-server and model it is given', async () => {
  const root = project();
  const dataDir = scratch('local-data-');
  const gguf = join(dataDir, 'mine.gguf');
  writeFileSync(gguf, 'gguf');
  const log = join(dataDir, 'starts.jsonl');
  const server = startServer({env: {...process.env, FAKE_LLAMA_LOG: log}});
  try {
    await assert.rejects(server.call('initialize', {dataDir, local: {gguf: 'relative.gguf'}}), /local_model.gguf must be an absolute path/);
    const hello = await server.call('initialize', {dataDir, parsers: [], local: {gguf, llamaServer: FAKE, threads: 2}});
    assert.deepEqual([hello.state, hello.model], ['on', 'embeddinggemma-2 (its own llama-server)']);
    assert.equal((await server.call('needs', {})).model, false);
    await server.call('open', {root});
    await until(() => server.notifications.some(note => note.method === 'progress' && note.params.phase === 'done'), 'the build', 10_000);
    const files = await server.call('files', {root, query: 'try again when sending fails'});
    assert.equal(files.results[0].file, 'src/deliver.js');
    assert.equal(files.results[0].path, join(root, 'src', 'deliver.js'));
    assert.ok(files.results[0].score > 0 && files.results[0].hits >= 1);
    const [started] = starts(log);
    assert.equal(started.args[started.args.indexOf('--threads') + 1], '2');
    assert.equal((await server.call('status', {})).local.running, true);
    server.child.kill('SIGTERM');
    await server.exited;
    await until(() => !alive(started.pid), 'its llama-server to stop with it, killed by a signal too', 5000);
  } finally {
    server.child.kill();
  }
});
