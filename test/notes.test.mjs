// The notes writer: a language model writes a note on each piece with none, while nothing is searched, through the
// same path an agent's notes take; its config keeps the code on this machine unless it says otherwise; the CLI writes
// them too. The models are fakes: an OpenAI-compatible /chat/completions, and Anthropic's /messages.
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {Meaning} from '../src/meaning.mjs';
import {cleanNote, notePrompt, notesConfig, NotesWriter} from '../src/notes.mjs';
import {profileConfig} from '../src/profiles.mjs';
import {fakeEmbedder} from './fake-embedder.mjs';
import {scratch, until} from './helpers.mjs';
import {startServer} from './rpc.mjs';

const BIN = fileURLToPath(new URL('../bin/semantic-grep-server.mjs', import.meta.url));

/** A fake writer's server: a note made of the piece's name, e.g. "Notes on total: what someone needs it for."; `mode` "down" answers 500, "empty" no text. */
async function fakeWriterServer({mode = 'ok', delayMs = 0} = {}) {
  const state = {mode, delayMs};
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', async () => {
      const parsed = JSON.parse(body || '{}');
      requests.push({url: request.url, headers: request.headers, body: parsed});
      if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
      if (response.destroyed) return;
      if (state.mode === 'down') { response.writeHead(500); return response.end('{"error":"loading"}'); }
      const prompt = request.url.endsWith('/messages') ? parsed.messages[0].content : parsed.messages.at(-1).content;
      const name = /Name: (.*)/.exec(prompt)?.[1] ?? 'it';
      const text = state.mode === 'empty' ? '' : `<think></think>Note: "It handles ${name} for the customer. Someone needs it to pay. A third sentence."`;
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify(request.url.endsWith('/messages')
        ? {content: [{type: 'text', text}], usage: {input_tokens: 50, output_tokens: 12}}
        : {choices: [{message: {content: text}}], usage: {prompt_tokens: 50, completion_tokens: 12}}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, set: changes => Object.assign(state, changes), close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })};
}

function project() {
  const root = realpathSync(scratch('notes-project-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'cart.js'), 'export function total(cart) {\n  return cart.items.reduce((sum, item) => sum + item.cents, 0);\n}\n');
  writeFileSync(join(root, 'src', 'team.js'), 'export function dropMember(team, id) {\n  team.members = team.members.filter(member => member.id !== id);\n}\n');
  execFileSync('git', ['init', '-q'], {cwd: root});
  return root;
}

async function settled(meaning, root) {
  meaning.open(root);
  await meaning.indexes.get(root).ready;
  meaning.indexes.get(root).refreshLearned();
  meaning.work();
  await until(() => !meaning.working && !meaning.indexes.get(root).pending().length && !meaning.indexes.get(root).learnedPending().length, 'the vectors', 10_000);
}

test('the notes entry: off unless asked; the profile\'s writer; never the code to another machine without sendCode', () => {
  assert.equal(profileConfig({}).notes, null, 'off by default');
  assert.equal(profileConfig({profile: 'beefy'}).notes, null, 'a profile alone writes none');
  const laptop = profileConfig({notes: true}).notes;
  assert.equal(laptop.baseUrl, 'http://127.0.0.1:18122/v1', 'without a profile, the laptop\'s writer');
  assert.equal(laptop.sendCode, false);
  assert.deepEqual(profileConfig({notes: []}).notes, laptop, 'Lua\'s empty table');
  assert.equal(profileConfig({profile: 'beefy', notes: {model: 'my-model'}}).notes.model, 'my-model');
  const cloud = profileConfig({profile: 'cloud', notes: true}).notes;
  assert.equal(cloud.api, 'anthropic');
  assert.equal(cloud.model, 'claude-haiku-5-5');
  assert.equal(cloud.sendCode, true, 'the cloud profile says so');
  assert.equal(profileConfig({profile: 'cloud', notes: {apiKeyFile: '/keys/anthropic'}}).notes.sendCode, true, 'a key of one\'s own, the same server');
  assert.throws(() => profileConfig({profile: 'cloud', notes: {baseUrl: 'https://proxy.example.com/v1'}}), /not this machine.*sendCode = true/, 'another server: the profile\'s leave goes');
  assert.equal(profileConfig({profile: 'cloud', notes: {baseUrl: 'https://proxy.example.com/v1', sendCode: true}}).notes.sendCode, true);
  assert.throws(() => notesConfig({api: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt'}), /sendCode/);
  assert.throws(() => notesConfig({api: 'openai', baseUrl: 'http://192.0.2.7:8080/v1', model: 'm'}), /sendCode/, 'another machine of the LAN too');
  assert.equal(notesConfig({baseUrl: 'http://localhost:9/v1', model: 'm'}).concurrency, 2);
  assert.throws(() => notesConfig({api: 'gemini', baseUrl: 'http://127.0.0.1:9/v1', model: 'm'}), /api must be/);
  assert.throws(() => notesConfig({baseUrl: 'http://127.0.0.1:9/v1', model: 'm', concurrency: 0}), /concurrency/);
});

test('a note from the answer: thinking, quotes and labels dropped, two sentences at most; the prompt cuts the code', () => {
  assert.equal(cleanNote('<think>hmm</think>\n"Sums the cart. Used at checkout. Also more."'), 'Sums the cart. Used at checkout.');
  assert.equal(cleanNote('Summary: **Reads `config.json` into memory.**'), 'Reads `config.json` into memory.');
  assert.equal(cleanNote('ok'), null);
  assert.equal(cleanNote('<think>never ends'), null);
  const prompt = notePrompt({file: 'a.js', name: 'add', text: 'x'.repeat(500)}, 200);
  assert.match(prompt, /^File: a\.js\nName: add\n\nx{200}\n…$/);
});

test('the writer asks an OpenAI-compatible server without thinking, and Anthropic\'s Messages API with its headers', async () => {
  const server = await fakeWriterServer();
  try {
    const piece = {hash: 'h1', file: 'src/cart.js', from: 1, name: 'total', text: 'export function total(cart) {}'};
    const local = new NotesWriter({entry: notesConfig({baseUrl: server.baseUrl, model: 'qwen3.5-2b'})});
    const {notes} = await local.write([piece]);
    assert.deepEqual(notes.map(note => note.note), ['It handles total for the customer. Someone needs it to pay.']);
    const asked = server.requests.at(-1);
    assert.equal(asked.url, '/v1/chat/completions');
    assert.equal(asked.body.model, 'qwen3.5-2b');
    assert.deepEqual(asked.body.chat_template_kwargs, {enable_thinking: false});
    assert.equal(asked.body.messages[0].role, 'system');
    assert.match(asked.body.messages[1].content, /^File: src\/cart\.js\nName: total/);
    assert.deepEqual(local.tokens, {input: 50, output: 12});

    process.env.SEMANTIC_GREP_TEST_KEY = 'test-key';
    const cloud = new NotesWriter({entry: notesConfig({api: 'anthropic', baseUrl: server.baseUrl, model: 'claude-haiku-5-5', apiKeyEnv: 'SEMANTIC_GREP_TEST_KEY'})});
    assert.equal((await cloud.write([piece])).notes.length, 1);
    const messages = server.requests.at(-1);
    assert.equal(messages.url, '/v1/messages');
    assert.equal(messages.headers['x-api-key'], 'test-key');
    assert.equal(messages.headers['anthropic-version'], '2026-10-21');
    assert.equal(messages.headers.authorization, undefined);
    assert.equal(messages.body.temperature, undefined, 'no sampling parameters on the Messages API');
    assert.deepEqual(messages.body.thinking, {type: 'disabled'});
    assert.equal(typeof messages.body.system, 'string');

    // Elsewhere than this machine: no llama.cpp field it may refuse; `request` adds fields of the entry's own.
    const remote = notesConfig({baseUrl: 'https://writer.example.com/v1', model: 'm', sendCode: true, request: {reasoning: {enabled: false}, max_tokens: 900}});
    const toRemote = new NotesWriter({entry: remote, fetch: (url, options) => fetch(url.replace('https://writer.example.com/v1', server.baseUrl), options)});
    assert.equal((await toRemote.write([piece])).notes.length, 1);
    const sent = server.requests.at(-1).body;
    assert.equal(sent.chat_template_kwargs, undefined);
    assert.deepEqual(sent.reasoning, {enabled: false});
    assert.equal(sent.max_tokens, 900);

    const before = server.requests.length;
    const keyless = new NotesWriter({entry: notesConfig({api: 'anthropic', baseUrl: server.baseUrl, model: 'claude-haiku-5-5', apiKeyEnv: 'SEMANTIC_GREP_TEST_NO_KEY'})});
    const none = await keyless.write([piece, {...piece, hash: 'h2'}]);
    assert.match(none.errors[0], /no key in \$SEMANTIC_GREP_TEST_NO_KEY/);
    assert.equal(server.requests.length, before, 'no code sent without the key');

    server.set({mode: 'down'});
    const failed = await local.write([piece, {...piece, hash: 'h2'}]);
    assert.equal(failed.notes.length, 0);
    assert.match(failed.errors[0], /500/);
  } finally {
    delete process.env.SEMANTIC_GREP_TEST_KEY;
    await server.close();
  }
});

test('notes written in the background while nothing is searched: found by their words and meaning; a search stops the writer; changed code is noted again', async () => {
  const root = project();
  const dataDir = scratch('notes-data-');
  const server = await fakeWriterServer();
  let now = 1_000_000;
  const booked = [];
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder(), notes: notesConfig({baseUrl: server.baseUrl, model: 'fake-writer', idleMs: 60_000}), now: () => now, book: (root, kind, text) => booked.push({kind, text})});
  try {
    await settled(meaning, root);
    await meaning.words(root, 'cart'); // a search: the writer waits
    assert.equal(await meaning.writeNotes(), 0, 'searched just now');
    assert.equal(server.requests.length, 0);
    now += 61_000;
    assert.equal(await meaning.writeNotes(), 2, 'idle: a note on each piece');
    assert.equal((await meaning.pendingNotes(root, {quiet: true})).pending, 0);
    assert.deepEqual(booked.map(each => each.kind), ['noted']);
    const row = meaning.indexes.get(root).notesByHash.values().next().value;
    assert.equal(row.source, 'writer:fake-writer');
    assert.equal((await meaning.words(root, 'customer pay')).results.length, 2, 'found by the notes\' words');
    await settled(meaning, root);
    assert.equal((await meaning.meaningOnly(root, 'handles dropMember for the customer')).results[0].file, 'src/team.js', 'and by their meaning');

    // A search while it writes: the piece in flight is dropped, and it waits again.
    writeFileSync(join(root, 'src', 'cart.js'), 'export function total(cart) {\n  return cart.items.length;\n}\n');
    await meaning.saved(root, join(root, 'src', 'cart.js'));
    assert.equal((await meaning.pendingNotes(root, {quiet: true})).pending, 1, 'changed code: no note until one is written');
    server.set({delayMs: 300});
    now += 61_000;
    const writing = meaning.writeNotes();
    await until(() => server.requests.length === 3, 'the writer asks');
    await meaning.words(root, 'total');
    assert.equal(await writing, 0, 'stopped by the search');
    assert.equal((await meaning.pendingNotes(root, {quiet: true})).pending, 1);
    server.set({delayMs: 0});
    now += 61_000;
    assert.equal(await meaning.writeNotes(), 1);

    // A model that does not answer rests the writer a few minutes; a piece it gave no note for is not asked again.
    writeFileSync(join(root, 'src', 'team.js'), 'export function dropMember(team) {\n  team.members = [];\n}\n');
    await meaning.saved(root, join(root, 'src', 'team.js'));
    await settled(meaning, root); // the writer waits while the index embeds
    server.set({mode: 'down'});
    now += 61_000;
    assert.equal(await meaning.writeNotes(), 0);
    assert.ok(meaning.snapshot().notes.resting);
    const asked = server.requests.length;
    now += 61_000;
    assert.equal(await meaning.writeNotes(), 0, 'resting');
    assert.equal(server.requests.length, asked);
    server.set({mode: 'empty'});
    now += 5 * 60_000;
    assert.equal(await meaning.writeNotes(), 0);
    now += 61_000;
    const after = server.requests.length;
    assert.equal(await meaning.writeNotes(), 0);
    assert.equal(server.requests.length, after, 'a piece with no note in the answer is left for this session');
  } finally {
    await meaning.close();
    await server.close();
  }
});

test('the notes command writes a note on each piece with none, and refuses a writer elsewhere without --send-code', async () => {
  const root = project();
  const dataDir = scratch('notes-data-');
  const server = await fakeWriterServer();
  const run = args => new Promise(resolve => {
    execFile(process.execPath, [BIN, 'notes', ...args, '--root', root, '--data-dir', dataDir], {timeout: 60_000}, (error, stdout, stderr) => resolve({code: error?.code ?? 0, stdout, stderr}));
  });
  try {
    const refused = await run(['write', '--base-url', 'https://api.example.com/v1', '--model', 'm']);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /not this machine/);
    assert.equal(server.requests.length, 0);
    const wrote = await run(['write', '--base-url', server.baseUrl, '--model', 'fake-writer', '--limit', '1']);
    assert.equal(wrote.code, 0, wrote.stderr);
    assert.match(wrote.stderr, /1 notes by fake-writer at http:\/\/127\.0\.0\.1:\d+\/v1/);
    const all = await run(['write', '--base-url', server.baseUrl, '--model', 'fake-writer']);
    assert.match(all.stderr, /1 notes by fake-writer/, 'the one left');
    const pending = await run(['pending']);
    assert.match(pending.stderr, /0 shown of 0 pieces without a note \(2 noted\)/);
  } finally {
    await server.close();
  }
});

test('the server takes a notes entry: the health check asks the writer for a note on a small piece of its own, and names a refused one', async () => {
  const server = await fakeWriterServer();
  const rpc = startServer();
  try {
    await assert.rejects(rpc.call('initialize', {dataDir: scratch('notes-data-'), embedding: false, notes: {baseUrl: 'https://api.example.com/v1', model: 'm'}}), /not this machine.*sendCode/);
    await rpc.call('initialize', {dataDir: scratch('notes-data-'), embedding: false, notes: {baseUrl: server.baseUrl, model: 'fake-writer', idleMs: 1000}});
    const {notes} = await rpc.call('check', {});
    assert.equal(notes.ok, true);
    assert.equal(notes.note, 'It handles add for the customer. Someone needs it to pay.');
    assert.equal(notes.sendCode, false);
    assert.equal(server.requests.length, 1);
    assert.doesNotMatch(server.requests[0].body.messages[1].content, /notes-project/, 'its own piece, not the project\'s');
  } finally {
    await rpc.close();
    await server.close();
  }
});

test('closed while the writer writes: its notes are dropped, and no index is opened again', async () => {
  const root = project();
  const server = await fakeWriterServer({delayMs: 200});
  let now = 1_000_000;
  const meaning = new Meaning({dataDir: scratch('notes-data-'), embedder: fakeEmbedder(), notes: notesConfig({baseUrl: server.baseUrl, model: 'fake-writer', concurrency: 1, idleMs: 0}), now: () => now});
  try {
    await settled(meaning, root);
    now += 1000;
    const writing = meaning.writeNotes();
    await until(() => server.requests.length === 2, 'the second piece asked', 5000);
    await meaning.close();
    await writing;
    assert.equal(meaning.indexes.size, 0, 'no index again');
    assert.equal(meaning.open(root), null);
  } finally {
    await server.close();
  }
});

test('a piece the writer keeps failing on alone is given up for the session after three tries', async () => {
  const root = project();
  const server = await fakeWriterServer({mode: 'down'});
  let now = 1_000_000;
  const meaning = new Meaning({dataDir: scratch('notes-data-'), embedder: fakeEmbedder(), notes: notesConfig({baseUrl: server.baseUrl, model: 'fake-writer', concurrency: 1, idleMs: 0}), now: () => now});
  try {
    await settled(meaning, root);
    for (let i = 0; i < 5; i++) {
      now += 6 * 60_000; // past each rest
      await meaning.writeNotes();
    }
    assert.equal(server.requests.length, 6, 'each of the two pieces asked three times, then no more');
  } finally {
    await meaning.close();
    await server.close();
  }
});
