// What a small piece's title says of where it is: the head and doc of what encloses it (a method's class), and what
// its file is for (its own doc, else a note written from its pieces' notes); the notes writer starts near the file
// someone is in. A recording embedder shows the text each piece is embedded with.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {pieceTitle} from '../src/embedder.mjs';
import {contextFor, isSmall, Meaning, pieceKey, ProjectIndex} from '../src/meaning.mjs';
import {TUNING} from '../src/embedder.mjs';
import {contextOf, fileSummary, headOf, piecesOf, sentence, TreeSitter} from '../src/pieces.mjs';
import {fakeVector} from './fake-embedder.mjs';
import {hasNvim, scratch, until} from './helpers.mjs';

/** The fake embedder, its documents titled as the HTTP one titles them, every text it embedded kept. */
function recordingEmbedder() {
  const embedder = {
    id: 'fake', ready: true, msPerText: 1, texts: [],
    document: (file, text, name, context) => `title: ${pieceTitle(file, name, context)} | text: ${text}`,
    query: text => `task: search result | query: ${text}`,
    async embed(texts) { embedder.texts.push(...texts); return texts.map(fakeVector); },
    fail() {}, close() {},
  };
  return embedder;
}

async function settled(meaning, root) {
  meaning.open(root);
  const index = meaning.indexes.get(root);
  await index.ready;
  meaning.work();
  await until(() => !meaning.working && !index.pending().length && !index.learnedPending().length && !index.reread?.size, 'the vectors', 10_000);
  return index;
}

test('a definition\'s head and doc, a file\'s own summary, sentences', () => {
  const python = ['"""Helpers for the app."""', 'import os', '', 'class Flask(App):', '    """The flask object implements a WSGI application.', '', '    More."""', '    def route(self):', '        pass'];
  assert.equal(fileSummary(python, 'app.py'), 'Helpers for the app.');
  assert.equal(headOf(python, 4), 'class Flask(App): The flask object implements a WSGI application.', 'a docstring below');
  const go = ['// Copyright 2013 the authors. Licensed under Apache.', '', '// Package cobra makes command lines.', 'package cobra', '', '// Command is a command.', '// More.', 'type Command struct {'];
  assert.equal(fileSummary(go, 'command.go'), 'Package cobra makes command lines.', 'no licence');
  assert.equal(headOf(go, 6), 'type Command struct: Command is a command.', 'a comment above');
  const ts = ['/**', ' * @module', ' * The base of the app.', ' */', 'import x from "y"', '/**', ' * Routes requests.', ' * @param x', ' */', '@Injectable()', 'export class Hono extends Base {'];
  assert.equal(fileSummary(ts, 'hono.ts'), 'The base of the app.');
  assert.equal(headOf(ts, 6), 'export class Hono extends Base: Routes requests.', 'past a decorator, without its tags');
  assert.equal(fileSummary(['/** Not the file\'s. */', 'export function f() {}'], 'f.ts'), 'Not the file\'s.');
  assert.equal(fileSummary(['import x from "y"', '/** A function\'s. */', 'export function f() {}'], 'f.ts'), null, 'code before any comment: none of its own');
  assert.equal(fileSummary(['# Reactivity in depth', '', 'Text.'], 'guide.md'), 'Reactivity in depth');
  assert.equal(fileSummary(['Configuration', '=============', ''], 'config.rst'), 'Configuration');
  assert.equal(sentence('Create three windows: 1. results, 2. prompt. More'), 'Create three windows: 1. results, 2. prompt.');
  assert.equal(contextOf(go, [6]), 'type Command struct: Command is a command.');
  assert.equal(contextOf(python, [4, 4, 8]), `${headOf(python, 4)} > def route(self)`, 'the outermost and the innermost');
});

test('a small piece is titled by its file\'s summary and what encloses it; a big one by its own words', () => {
  const lines = ['// A shopping cart.', 'class Cart {', '  /** Prices what is in it. */', '  total() {', '    return 1;', '  }', '}'];
  const small = {text: lines.slice(3, 6).join('\n'), within: [2]};
  const context = contextFor(lines, 'cart.js', small);
  assert.equal(context, 'A shopping cart.\nclass Cart');
  assert.equal(pieceTitle('cart.js', 'total', context), 'cart.js (A shopping cart.): class Cart > total');
  assert.equal(pieceTitle('cart.js', 'total', ''), 'cart.js: total', 'no context: as before');
  assert.ok(!isSmall({text: 'x'.repeat(400)}));
  assert.equal(contextFor(lines, 'cart.js', {text: 'x'.repeat(400), within: [2]}), '', 'a big piece says enough itself');
  assert.equal(pieceKey('h', ''), 'h', 'no context: the hash is its key');
  assert.notEqual(pieceKey('h', context), 'h');
});

test('cut apart, a definition\'s inner ones know what encloses them', {skip: !hasNvim && 'nvim not installed'}, async () => {
  const root = scratch('context-pieces-');
  const body = Array.from({length: 30}, (_, i) => `    local v${i} = ${i}`);
  const text = ['--- Builds the layout.', 'local function layout(picker)', '  local function mount(self)', ...body, '  end', '  local function update(self)', ...body, '  end', '  return {mount = mount, update = update}', 'end', ''].join('\n');
  writeFileSync(join(root, 'layout.lua'), text);
  const found = (await new TreeSitter().definitions([join(root, 'layout.lua')])).get(join(root, 'layout.lua'));
  const pieces = piecesOf(text, found);
  const mount = pieces.find(piece => piece.name === 'mount');
  assert.deepEqual(mount.within, [1], 'its function\'s first line, its doc comment\'s');
  assert.equal(contextOf(text.split('\n'), mount.within), 'local function layout(picker): Builds the layout.');
});

/** A git repo whose one file has two small functions and no doc of its own, a second file elsewhere. */
function project() {
  const root = realpathSync(scratch('context-project-'));
  mkdirSync(join(root, 'src', 'billing'), {recursive: true});
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src', 'billing', 'cart.js'), 'export function total(cart) {\n  return cart.sum;\n}\n\nexport function count(cart) {\n  return cart.items.length;\n}\n');
  writeFileSync(join(root, 'docs', 'guide.js'), 'export function intro() {\n  return 1;\n}\n\nexport function outro() {\n  return 2;\n}\n');
  execFileSync('git', ['init', '-q'], {cwd: root});
  return root;
}

test('a file\'s note, written from its pieces\' notes, titles its small pieces; their notes stay', async () => {
  const root = project();
  const embedder = recordingEmbedder();
  const meaning = new Meaning({dataDir: scratch('context-data-'), embedder});
  try {
    const index = await settled(meaning, root);
    const cart = index.byFile.get('src/billing/cart.js');
    assert.ok(embedder.texts.includes('title: src/billing/cart.js: total | text: export function total(cart) {\n  return cart.sum;\n}'), 'no doc, no note: its file and name');
    const first = await meaning.pendingNotes(root);
    assert.equal(first.pending, 4, 'the pieces first');
    assert.ok(first.pieces.every(item => item.hash));
    await meaning.addNotes(root, cart.map(piece => ({hash: piece.hash, note: `Note on ${piece.name}.`})));
    const files = (await meaning.pendingNotes(root)).pieces.filter(item => item.kind === 'file');
    assert.deepEqual(files, [{kind: 'file', file: 'src/billing/cart.js', notes: ['Note on total.', 'Note on count.']}], 'its pieces noted: the file, from their notes');

    await meaning.addNotes(root, [{file: 'src/billing/cart.js', note: 'What a basket costs. More.'}, {file: 'gone.js', note: 'x'}]);
    await settled(meaning, root);
    assert.ok(embedder.texts.includes('title: src/billing/cart.js (What a basket costs.): total | text: export function total(cart) {\n  return cart.sum;\n}'), 'read again, embedded with it');
    assert.equal(index.notesByHash.size, 2, 'the pieces\' notes stay theirs');
    assert.ok(!(await meaning.pendingNotes(root)).pieces.some(item => item.kind === 'file'), 'noted: no longer pending');
    const total = index.byFile.get('src/billing/cart.js').find(piece => piece.name === 'total');
    assert.equal(total.key, pieceKey(total.hash, 'What a basket costs.\n'));
    assert.ok(index.vectors.has(total.key));
    assert.ok(embedder.texts.includes('title: src/billing/cart.js (What a basket costs.): total | text: Note on total.'), 'its note embedded again, titled with it');
    const before = index.learnedVectors.size;
    index.pruneLearned();
    assert.equal(index.learnedVectors.size, 2, `the notes' vectors titled before are gone (${before} before)`);
  } finally {
    await meaning.close();
  }
});

test('a file\'s note written by another process (the notes command) titles its pieces at the next session', async () => {
  const root = project();
  const dataDir = scratch('context-data-');
  const first = new Meaning({dataDir, embedder: recordingEmbedder()});
  await settled(first, root);
  await first.close();
  const command = new Meaning({dataDir}); // as the notes command runs: no embedding model
  const cart = (await command.pendingNotes(root, {quiet: true})).pieces.filter(item => item.file === 'src/billing/cart.js');
  await command.addNotes(root, [...cart.map(piece => ({hash: piece.hash, note: 'A note.'})), {file: 'src/billing/cart.js', note: 'What a basket costs.'}], {quiet: true});
  await command.close();
  const embedder = recordingEmbedder();
  const again = new Meaning({dataDir, embedder});
  try {
    const index = await settled(again, root);
    assert.ok(embedder.texts.some(text => text.startsWith('title: src/billing/cart.js (What a basket costs.): total')), 'read again with it, and embedded');
    assert.ok(index.byFile.get('src/billing/cart.js').every(piece => piece.context.startsWith('What a basket costs.')));
    assert.equal(index.files.get('src/billing/cart.js').note, 'What a basket costs.');
  } finally {
    await again.close();
  }
});

test('a file that needs no note of its own is not read again for one until it changes', async () => {
  const root = project();
  writeFileSync(join(root, 'docs', 'guide.js'), '// The guide\'s steps.\nexport function intro() {\n  return 1;\n}\n\nexport function outro() {\n  return 2;\n}\n');
  const meaning = new Meaning({dataDir: scratch('context-data-'), embedder: recordingEmbedder()});
  try {
    const index = await settled(meaning, root);
    const guide = index.byFile.get('docs/guide.js');
    await meaning.addNotes(root, guide.map(piece => ({hash: piece.hash, note: 'A note.'})));
    assert.ok(!(await meaning.pendingNotes(root)).pieces.some(item => item.file === 'docs/guide.js'), 'it says what it is for itself');
    assert.equal(index.noFileNote.get('docs/guide.js'), index.files.get('docs/guide.js').mtimeMs, 'remembered');
    let reads = 0;
    const get = index.lines.get.bind(index.lines);
    index.lines.get = file => { if (file === 'docs/guide.js') reads += 1; return get(file); };
    await meaning.pendingNotes(root);
    assert.equal(reads, 0, 'not read again');
  } finally {
    await meaning.close();
  }
});

test('a host embedder\'s own tuning goes over its model\'s, field by field', () => {
  const index = new ProjectIndex({root: '/project', store: null, embedder: {id: 'host-model', tuning: {band: undefined, pickNear: 0.9, files: {depth: 30}}}});
  assert.equal(index.tuning.band, TUNING.band, 'unset: the model\'s');
  assert.equal(index.tuning.pickNear, 0.9);
  assert.deepEqual(index.tuning.files, {...TUNING.files, depth: 30});
  assert.deepEqual(index.tuning.fusion, TUNING.fusion);
});

test('the notes writer starts near the file someone is in', async () => {
  const root = project();
  const meaning = new Meaning({dataDir: scratch('context-data-'), embedder: recordingEmbedder()});
  try {
    await settled(meaning, root);
    assert.equal((await meaning.pendingNotes(root, {limit: 1})).pieces[0].file, 'docs/guide.js', 'nowhere yet: the index\'s order');
    meaning.visited(join(root, 'src', 'billing', 'cart.js'));
    assert.equal((await meaning.pendingNotes(root, {limit: 1})).pieces[0].file, 'src/billing/cart.js');
    meaning.visited('relative/path.js'); // not a path: nothing
    meaning.visited(join(root, 'docs', 'other.js'));
    assert.equal((await meaning.pendingNotes(root, {limit: 1})).pieces[0].file, 'docs/guide.js', 'the folder of the one visited last');
  } finally {
    await meaning.close();
  }
});
