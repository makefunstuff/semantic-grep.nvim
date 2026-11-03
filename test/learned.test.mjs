// What the index learns of a repository: the piece someone opened for a search (found first by the same search, or one
// worded close to it, by its words and their meaning), and notes a coding agent writes on pieces (searched with them,
// read by the reranker), kept beside the index across rebuilds and through the notes command; turned off, they go.
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {existsSync, realpathSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {learnedPath} from '../src/index-store.mjs';
import {Meaning} from '../src/meaning.mjs';
import {fakeEmbedder} from './fake-embedder.mjs';
import {fakeReranker, fakeRerankServer} from './fake-reranker.mjs';
import {scratch, until} from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/semantic-grep-server.mjs', import.meta.url));

function project() {
  const root = realpathSync(scratch('learned-project-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'team.js'), 'export function dropMember(team, id) {\n  team.members = team.members.filter(member => member.id !== id);\n}\n');
  writeFileSync(join(root, 'src', 'cart.js'), 'export function total(cart) {\n  return cart.items.reduce((sum, item) => sum + item.cents, 0);\n}\n');
  writeFileSync(join(root, 'src', 'deliver.js'), 'export function deliver(job) {\n  return send(job) || retry(job);\n}\n');
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

test('a search and the piece opened for it: the same search, or one worded close to it, finds that piece first, after a rebuild too', async () => {
  const root = project();
  const dataDir = scratch('learned-data-');
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder()});
  try {
    await settled(meaning, root);
    const before = await meaning.search(root, 'kick someone out', {book: false, rerank: false});
    const target = ['src/team.js', 'src/deliver.js'].find(file => before.results[0]?.file !== file); // not first yet
    assert.equal((await meaning.words(root, 'kick someone out')).results.length, 0, 'nothing in the code says so');
    meaning.booked(root, 'kick someone out', [{file: target, line: 1}], ' in the picker');
    await settled(meaning, root);
    const again = await meaning.search(root, 'kick someone out', {book: false, rerank: false});
    assert.equal(again.results[0].file, target, 'the same search: first');
    assert.equal((await meaning.words(root, 'kick someone out')).results[0].file, target, 'by its words alone too');
    assert.equal((await meaning.meaningOnly(root, 'please kick someone out')).results[0].file, target, 'worded close to it: first by meaning');
    assert.equal((await meaning.meaningOnly(root, 'price of the cart')).results[0].file, 'src/cart.js', 'another search is not moved');
    meaning.booked(root, 'total price', [{file: 'src/cart.js', line: 1}]); // a search booked, not a pick: nothing learned
    assert.equal(meaning.indexes.get(root).picks.length, 1);

    await meaning.rebuild(root);
    await settled(meaning, root);
    assert.equal((await meaning.search(root, 'kick someone out', {book: false, rerank: false})).results[0].file, target, 'kept across a rebuild');
  } finally {
    await meaning.close();
  }
});

test('notes on pieces: listed for an agent, searched by their words and meaning, shown and read by the reranker; off removes them', async () => {
  const root = project();
  const dataDir = scratch('learned-data-');
  const server = await fakeRerankServer({favourite: 'customer'});
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder(), reranker: fakeReranker(server.baseUrl)});
  try {
    await settled(meaning, root);
    const pending = await meaning.pendingNotes(root, {limit: 2});
    assert.equal(pending.pending, 3);
    assert.equal(pending.pieces.length, 2);
    const cart = (await meaning.pendingNotes(root)).pieces.find(piece => piece.file === 'src/cart.js');
    assert.match(cart.text, /cart\.items/);
    assert.equal(cart.name, 'total');
    const added = await meaning.addNotes(root, [{hash: cart.hash, note: 'What the customer owes for everything in the basket.'}, {hash: 'gone', note: 'x'}]);
    assert.deepEqual(added, {added: 1, unknown: ['gone']});
    await settled(meaning, root);
    assert.equal((await meaning.pendingNotes(root)).pending, 2, 'noted: no longer pending');
    assert.equal((await meaning.words(root, 'customer owes')).results[0].file, 'src/cart.js', 'found by the note\'s words');
    const found = await meaning.meaningOnly(root, 'customer basket');
    assert.equal(found.results[0].file, 'src/cart.js', 'and by its meaning');
    assert.equal(found.results[0].note, 'What the customer owes for everything in the basket.');
    const list = [...(await meaning.words(root, 'deliver')).results, found.results[0]];
    const reranked = await meaning.reranked(meaning.indexes.get(root), 'customer basket', list);
    assert.ok(Object.values(server.requests.at(-1).questions.best.criteria).some(text => text.includes('(total)  What the customer owes')), 'the reranker reads the note first');
    assert.equal(reranked.results[0].file, 'src/cart.js', 'and puts it first');
    await meaning.addNotes(root, [{hash: cart.hash, note: ''}]);
    assert.equal((await meaning.pendingNotes(root)).pending, 3, 'an empty note removes it');
    await meaning.addNotes(root, [{hash: cart.hash, note: 'What the customer owes.'}]);

    const path = meaning.indexes.get(root).store.path;
    assert.ok(existsSync(learnedPath(path)));
    await meaning.turnOff();
    assert.ok(!existsSync(learnedPath(path)), 'turned off: what was learned goes with the index');
  } finally {
    await meaning.close();
    await server.close();
  }
});

test('the notes command: pending pieces as JSON lines, notes from stdin; a running index picks them up', async () => {
  const root = project();
  const dataDir = scratch('learned-data-');
  const run = (args, input = '') => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [BIN, 'notes', ...args, '--root', root, '--data-dir', dataDir], {timeout: 60_000}, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve({stdout, stderr})));
    child.stdin.end(input);
  });
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder()});
  try {
    await settled(meaning, root);
    const listed = await run(['pending']);
    const pieces = listed.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(pieces.length, 3);
    assert.match(listed.stderr, /3 shown of 3 pieces without a note/);
    const team = pieces.find(piece => piece.file === 'src/team.js');
    const put = await run(['put'], `${JSON.stringify({hash: team.hash, note: 'Removes a person from the team when they leave the company.'})}\n`);
    assert.match(put.stderr, /^1 notes added/);
    assert.equal((await meaning.words(root, 'leave company')).results[0]?.file, 'src/team.js', 'the running index sees the note');
    assert.equal(meaning.indexes.get(root).store.db.prepare('SELECT count(*) AS n FROM vectors').get().n, 3, 'the command, words only, left the vectors alone');
    await settled(meaning, root);
    assert.equal((await meaning.meaningOnly(root, 'person leave company')).results[0].file, 'src/team.js', 'and embeds it');
  } finally {
    await meaning.close();
  }
});
