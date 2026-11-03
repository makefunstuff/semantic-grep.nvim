// Search by meaning: the pieces (tree-sitter's functions with their doc comments, else blocks at blank lines), the
// words, the fusion, which files go in (what .gitignore leaves out does not), the SQLite index in the data folder or
// the project, shared by worktrees, a save embedding only what changed, the word search without a model, the hybrid
// search, what is booked, a host's own model turned on and off, an embedding model at a /v1/embeddings and the config.
// A fake embedder stands in for the model, and a fake server for the /v1/embeddings (see fake-embedder.mjs).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {embeddingConfig, indexConfig} from '../src/config.mjs';
import {HttpEmbedder, promptsOf} from '../src/embedder.mjs';
import {indexPlace} from '../src/index-store.mjs';
import {fuse, indexable, Meaning, ProjectIndex, projectFiles, searchTerms, words} from '../src/meaning.mjs';
import {blocks, cut, PIECE, piecesOf, TreeSitter} from '../src/pieces.mjs';
import {fakeEmbedder, fakeEmbeddingServer, fakeProvider, fakeVector} from './fake-embedder.mjs';
import {hasNvim, scratch, until} from './helpers.mjs';

const RETRY = `export function deliver(job) {
  let tries = 0;
  while (tries < 5) {
    tries += 1;
    if (send(job)) return true;
    sleep(backoff(tries));
  }
  return false;
}
`;
const PRICES = `export function total(cart) {
  return cart.items.reduce((sum, item) => sum + item.cents * item.quantity, 0);
}
`;

/** A git repo with a retry loop, a price total, an ignored file and an untracked one. */
function project() {
  const root = realpathSync(scratch('meaning-project-'));
  const git = (...args) => execFileSync('git', args, {cwd: root, stdio: 'ignore'});
  git('init', '-q');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'deliver.js'), RETRY);
  writeFileSync(join(root, 'src', 'cart.js'), PRICES);
  writeFileSync(join(root, '.gitignore'), 'secret.txt\nbuild/\n');
  writeFileSync(join(root, 'secret.txt'), 'retry the payment again with the saved card\n');
  mkdirSync(join(root, 'build'));
  writeFileSync(join(root, 'build', 'out.js'), RETRY);
  writeFileSync(join(root, 'logo.png'), 'not text');
  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  git('add', 'src', '.gitignore');
  writeFileSync(join(root, 'NOTES.md'), '# Notes\n\nThe cart shows prices in cents.\n'); // untracked, not ignored
  return root;
}

test('a file is cut at a piece\'s size, at a blank line where it can; blocks between blank lines go together', () => {
  const lines = Array.from({length: 130}, (_, i) => (i % 20 === 19 ? '' : `line ${i + 1}`));
  const chunks = cut(lines);
  assert.ok(chunks.every(chunk => chunk.to - chunk.from + 1 <= PIECE.lines));
  assert.deepEqual(chunks[0], {from: 1, to: 60}, 'the blank line 60 ends the first');
  assert.ok(chunks.slice(1).every((chunk, i) => chunk.from === chunks[i].to + 1), 'no line left out or counted twice');
  assert.deepEqual(cut([`${'x'.repeat(PIECE.chars * 2)}`, 'short']), [{from: 1, to: 1}, {from: 2, to: 2}], 'a line longer than a piece is one of its own');
  const prose = ['# Title', '', 'one', 'two', '', '}', '', 'three'];
  assert.deepEqual(blocks(prose), [{from: 1, to: 8}], 'small blocks go together, up to a piece');
  assert.deepEqual(blocks(['}', '', ')']), [], 'nothing but punctuation is no piece');
});

test('pieces: tree-sitter\'s definitions where it found them, blocks between them, and a long one cut', () => {
  const text = ['import x from "y";', '', '// Adds.', 'function add(a, b) {', '  return a + b;', '}', '', 'const z = 1;', ''].join('\n');
  const found = [{from: 3, to: 6, kind: 'function_declaration', name: 'add'}];
  assert.deepEqual(piecesOf(text, found).map(piece => [piece.from, piece.to, piece.kind, piece.name]), [
    [1, 1, 'block', null], [3, 6, 'function_declaration', 'add'], [8, 8, 'block', null],
  ]);
  assert.deepEqual(piecesOf(text).map(piece => [piece.from, piece.to]), [[1, 8]], 'no parser: blocks at blank lines');
  const long = Array.from({length: 150}, (_, i) => `  step${i}();`).join('\n');
  const parts = piecesOf(long, [{from: 1, to: 150, kind: 'function_declaration', name: 'big'}]);
  assert.ok(parts.length === 3 && parts.every(piece => piece.name === 'big' && piece.to - piece.from < PIECE.lines), 'each part keeps its name');
});

test('tree-sitter in a headless Neovim finds functions with their doc comments; a file it has no parser for goes by blank lines', {skip: !hasNvim && 'nvim not installed'}, async () => {
  const root = scratch('meaning-pieces-');
  // Lua and C: parsers every Neovim has.
  writeFileSync(join(root, 'team.lua'), [
    'local M = {}', '', '--- Takes a user off a team.', '--- Their tasks stay.', 'function M.remove_user(team, user)', '  team.users[user] = nil', 'end', '',
    'local function helper()', '  return 1', 'end', '', 'return M', ''].join('\n'));
  writeFileSync(join(root, 'arena.c'), ['#include <stdlib.h>', '', '/* Gives memory back to the arena. */', 'void arena_free(void *p) {', '  free(p);', '}', ''].join('\n'));
  writeFileSync(join(root, 'notes.unknownext'), 'plain words\n');
  const sitter = new TreeSitter();
  const found = await sitter.definitions(['team.lua', 'arena.c', 'notes.unknownext'].map(file => join(root, file)));
  assert.deepEqual(found.get(join(root, 'team.lua')).map(piece => [piece.from, piece.to, piece.name]), [[3, 7, 'M.remove_user'], [9, 11, 'helper']], 'the doc comment above goes with its function');
  assert.deepEqual(found.get(join(root, 'arena.c')).map(piece => [piece.from, piece.to]), [[3, 6]]);
  assert.equal(found.get(join(root, 'notes.unknownext')), null);
  const missing = new TreeSitter({nvim: join(root, 'no-nvim')});
  assert.equal((await missing.definitions([join(root, 'team.lua')])).get(join(root, 'team.lua')), null);
  assert.ok(missing.missing, 'no Neovim: blank lines from then on');
});

test('the words of code: lower case, with identifiers split as well; a search\'s small words are left out', () => {
  assert.deepEqual(words('retryCount = max_tries; HTTPServer'), ['retrycount', 'retry', 'count', 'max_tries', 'max', 'tries', 'httpserver', 'http', 'server']);
  assert.deepEqual(searchTerms('the method that removes a user'), ['method', 'removes', 'user']);
});

test('rankings fuse by reciprocal rank: what both rank high goes first', () => {
  assert.deepEqual(fuse([['a', 'b', 'c'], ['b', 'c']]), ['b', 'c', 'a']);
  assert.deepEqual(fuse([[], ['x']]), ['x']);
});

test('the files indexed are git\'s, without what .gitignore leaves out, pictures or lockfiles', async () => {
  const root = project();
  assert.deepEqual(await projectFiles(root), ['.gitignore', 'NOTES.md', 'src/cart.js', 'src/deliver.js']);
  assert.ok(!indexable('assets/logo.png') && !indexable('web/app.min.js') && !indexable('Cargo.lock') && indexable('src/main.rs') && !indexable('.semantic-grep/index.sqlite') && !indexable('.pair/index.sqlite', '.pair'));
});

/** Waits until every piece of `root` has its vector. */
const embedded = (meaning, root) => until(() => {
  const index = meaning.indexes.get(root);
  return index && index.files.size && !meaning.working && !index.pending().length;
}, 'the index to be built');

test('the index: SQLite in the data folder, words without a model, meaning once on, a changed piece embedded again only', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const booked = [];
  const told = [];
  const embedder = fakeEmbedder();
  const provider = fakeProvider();
  const meaning = new Meaning({dataDir, embedder, provider, book: (where, kind, text, options) => booked.push({where, kind, text, options}), progress: (where, how) => told.push(how)});
  try {
    assert.equal(meaning.state, 'off');
    const words = await meaning.words(root, 'quant item');
    assert.equal(words.state, 'off');
    await meaning.indexes.get(root).ready;
    assert.deepEqual((await meaning.words(root, 'quant item')).results.map(result => result.file), ['src/cart.js'], 'the words work without a model, each the start of one of the code\'s');
    assert.equal(embedder.calls.length, 0, 'nothing is embedded while it is off');
    assert.equal(told[0].phase, 'reading', 'a first build says it reads');
    const [{path}] = meaning.snapshot().indexes;
    assert.match(path, new RegExp(`^${dataDir}/index/meaning-project-\\w+-[0-9a-f]{8}\\.sqlite$`), 'in the data folder, named after the repository');
    assert.ok(!readdirSync(root).includes('.semantic-grep'));
    const db = readFileSync(path).toString('latin1');
    assert.ok(!db.includes('item.cents * item.quantity'), 'no copy of the code: positions, hashes and words');

    for (let i = 0; i < 10; i++) writeFileSync(join(root, `note${i}.md`), `Note ${i} about the release.\n`);
    await meaning.rescan(); // the notes, read for their words
    assert.deepEqual(await meaning.needs(), {runtime: null, model: true}, 'what turning it on fetches is the provider\'s to say');
    assert.deepEqual(await meaning.turnOn(), {runtime: null, model: true});
    await embedded(meaning, root);
    const build = booked.find(entry => entry.kind === 'indexed');
    assert.match(build.text, /^indexed 14 pieces by meaning in \d+ s: 14 files, 14 pieces, \d+ KB$/);
    assert.ok(embedder.calls.every(call => !call.urgent), 'the build\'s batches are not urgent');
    assert.equal(told.at(-1).phase, 'done');

    const answer = await meaning.search(root, 'try again when sending fails');
    assert.equal(answer.results[0].file, 'src/deliver.js', 'no word of the search is in the code, but its meaning is');
    assert.equal(answer.results[0].line, 1);
    assert.equal(answer.results[0].head, 'export function deliver(job) {');
    assert.equal(answer.results[0].words, false);
    assert.equal(embedder.calls.at(-1).urgent, true, 'a search goes before the index\'s batches');
    assert.deepEqual([answer.chunks, answer.embedded], [14, 14]);
    const searched = booked.find(entry => entry.kind === 'searched');
    assert.match(searched.text, /^by meaning "try again when sending fails": \d+ results?, first src\/deliver\.js:1$/);
    const alone = await meaning.meaningOnly(root, 'what does the cart cost');
    assert.equal(alone.phase, 'meaning');
    assert.ok(alone.results.slice(0, 2).some(result => result.file === 'src/cart.js'));
    assert.ok(alone.results.every(result => result.meaning !== null && result.words === false));
    assert.deepEqual((await meaning.words(root, 'quantity tries')).results, [], 'every word, or none: the meaning ranks a question in other words');
    assert.deepEqual((await meaning.words(root, 'how is it')).results, [], 'the small words of a question are no words to search');

    assert.deepEqual((await meaning.trailHits(root, 'retry')).map(hit => hit.file), ['src/deliver.js'], 'the closest pieces, for a host\'s own use');
    embedder.failWith = 'the model is not loaded';
    const fallback = await meaning.search(root, 'quantity');
    assert.equal(fallback.problem, 'the model is not loaded', 'the answer says why meaning is missing');
    assert.equal(fallback.results[0].file, 'src/cart.js', 'and the words still rank');
    assert.equal(await meaning.trailHits(root, 'retry'), null, 'the trail leaves meaning out while the embedder fails');
    embedder.failWith = null;
    await meaning.search(root, 'cart');
    assert.equal(meaning.problem, null, 'the embedder answers again: the problem is gone');

    const calls = embedder.calls.length;
    await meaning.close();
    const again = new Meaning({dataDir, embedder, provider});
    again.open(root);
    await again.indexes.get(root).ready;
    assert.equal(again.indexes.get(root).pending().length, 0, 'a restart embeds nothing again');
    writeFileSync(join(root, 'src', 'cart.js'), `${PRICES}\nexport const free = cart => total(cart) === 0;\n`);
    await again.saved(root, join(root, 'src', 'cart.js'));
    await embedded(again, root);
    assert.deepEqual(embedder.calls.slice(calls).flatMap(call => call.texts).map(text => text.replace(/^title: (\S+) .*$/s, '$1')), ['src/cart.js'], 'only the changed file\'s piece is embedded');
    await again.saved(root, join(root, 'secret.txt'));
    assert.ok(!again.indexes.get(root).files.has('secret.txt'), 'a file git ignores is not indexed when saved');
    assert.deepEqual(await again.turnOn(), {runtime: null, model: false}, 'on again downloads nothing');
    await again.turnOff();
    assert.equal(again.state, 'off');
    assert.deepEqual(provider.turned, ['on', 'on', 'off'], 'the provider deletes its own model');
    assert.ok(!existsSync(path), 'off deletes the indexes');
    await again.close();
  } finally {
    await meaning.close();
  }
});

test('worktrees of one repository share one index file and each piece\'s vector', async () => {
  const root = project();
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one'], {cwd: root});
  const tree = join(realpathSync(scratch('meaning-tree-')), 'feature');
  execFileSync('git', ['worktree', 'add', '-q', tree], {cwd: root});
  const dataDir = scratch('meaning-data-');
  const embedder = fakeEmbedder();
  const meaning = new Meaning({dataDir, embedder});
  try {
    meaning.open(root);
    await meaning.indexes.get(root).ready;
    await embedded(meaning, root);
    const first = embedder.calls.flatMap(call => call.texts).length;
    writeFileSync(join(tree, 'src', 'cart.js'), `${PRICES}// on the branch\n`);
    meaning.open(tree);
    await meaning.indexes.get(tree).ready;
    await embedded(meaning, tree);
    const [one, two] = meaning.snapshot().indexes;
    assert.equal(one.path, two.path, 'one file for both');
    assert.deepEqual(embedder.calls.flatMap(call => call.texts).slice(first).map(text => text.replace(/^title: (\S+) .*$/s, '$1')), ['src/cart.js'], 'the second embeds only what it changed');
    assert.equal((await meaning.search(tree, 'quantity')).results[0].file, 'src/cart.js');
    assert.equal((await meaning.words(root, 'branch')).results.length, 0, 'each worktree finds its own pieces');
    assert.equal((await meaning.words(tree, 'branch')).results.length, 1);
    await meaning.rebuild(tree);
    await meaning.indexes.get(tree).ready;
    await embedded(meaning, tree);
    assert.ok(meaning.indexes.get(root) && meaning.indexes.get(tree), 'a rebuild makes both again');
    assert.equal((await meaning.words(root, 'quantity')).results.length, 1);
  } finally {
    await meaning.close();
  }
});

test('index = "project" keeps it in .semantic-grep/ of the repository, listed in .git/info/exclude and not in .gitignore', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const place = await indexPlace({dataDir, root, where: 'project'});
  assert.equal(place.path, join(root, '.semantic-grep', 'index.sqlite'));
  const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\.semantic-grep\/$/m);
  await indexPlace({dataDir, root, where: 'project'});
  assert.equal(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), exclude, 'listed once');
  assert.doesNotMatch(readFileSync(join(root, '.gitignore'), 'utf8'), /\.semantic-grep/);
  assert.equal((await indexPlace({dataDir, root, where: 'project', projectDir: '.pair'})).path, join(root, '.pair', 'index.sqlite'), 'a host keeps its own folder');
  const meaning = new Meaning({dataDir, config: {index: 'project'}, embedder: fakeEmbedder()});
  try {
    meaning.open(root);
    await meaning.indexes.get(root).ready;
    assert.ok(existsSync(place.path));
    assert.equal(execFileSync('git', ['status', '--porcelain', '--', '.semantic-grep'], {cwd: root}).toString(), '', 'git does not see it');
    assert.ok(!(await projectFiles(root)).some(file => file.startsWith('.semantic-grep/')));
  } finally {
    await meaning.close();
  }
});

test('an index file that cannot be opened: the words say so, the rescan goes on, and a rebuild makes it again', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const {path} = await indexPlace({dataDir, root});
  mkdirSync(join(dataDir, 'index'), {recursive: true});
  writeFileSync(path, 'not a database, not at all, but long enough to be read as one '.repeat(100));
  const logged = [];
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder(), log: line => logged.push(line)});
  try {
    const answer = await meaning.words(root, 'quantity');
    assert.match(answer.problem, /cannot be opened .*:SemanticGrep rebuild/);
    await meaning.rescan(); // once crashed the host
    assert.ok(logged.some(line => line.includes(root)));
    await meaning.rebuild(root);
    await meaning.indexes.get(root).ready;
    assert.equal((await meaning.words(root, 'quantity')).results[0].file, 'src/cart.js');
  } finally {
    await meaning.close();
  }
});

test('a project left while its batch embeds: the batch is dropped, and the other projects build on', async () => {
  const one = project();
  const two = project();
  const dataDir = scratch('meaning-data-');
  const embedder = fakeEmbedder();
  const embed = embedder.embed;
  embedder.embed = async (texts, options) => { await new Promise(resolve => setTimeout(resolve, 20)); return embed(texts, options); };
  const meaning = new Meaning({dataDir, embedder});
  try {
    meaning.open(one);
    await until(() => embedder.calls.length > 0, 'a batch under way');
    await meaning.leave(one);
    meaning.open(two);
    await embedded(meaning, two);
    assert.equal(meaning.problem, null);
  } finally {
    await meaning.close();
  }
});

test('a save during a scan: one read at a time, and the newer text is the one kept', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder()});
  try {
    meaning.open(root);
    const index = meaning.indexes.get(root);
    await index.ready;
    const sitter = index.treeSitter;
    const definitions = sitter.definitions.bind(sitter);
    let slow = true;
    sitter.definitions = async paths => { if (slow) { slow = false; await new Promise(resolve => setTimeout(resolve, 100)); } return definitions(paths); };
    writeFileSync(join(root, 'src', 'cart.js'), 'export const middleName = 1;\n');
    const scanning = index.scan();
    await new Promise(resolve => setTimeout(resolve, 20));
    writeFileSync(join(root, 'src', 'cart.js'), '\n\nexport const newestName = 2;\n');
    await Promise.all([scanning, meaning.saved(root, join(root, 'src', 'cart.js'))]);
    const [hit] = (await meaning.words(root, 'newestName')).results;
    assert.deepEqual([hit?.file, hit?.line], ['src/cart.js', 3]);
    assert.deepEqual((await meaning.words(root, 'middleName')).results, []);
  } finally {
    await meaning.close();
  }
});

test('a file changed without a new size or time is read again once, never in a loop', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const provider = fakeProvider();
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder(), provider});
  try {
    meaning.open(root);
    const index = meaning.indexes.get(root);
    await index.ready;
    const path = join(root, 'src', 'cart.js');
    const {atime, mtime} = statSync(path);
    writeFileSync(path, PRICES.replace('cents', 'pence'));
    utimesSync(path, atime, mtime);
    await meaning.turnOn();
    await embedded(meaning, root);
    assert.equal((await meaning.words(root, 'pence')).results[0].file, 'src/cart.js', 'read again: its new words');
  } finally {
    await meaning.close();
  }
});

test('turned off with an embedding model, it stays off until turned on', async () => {
  const server = await fakeEmbeddingServer();
  const root = project();
  const dataDir = scratch('meaning-data-');
  const meaning = new Meaning({dataDir, embedding: {api: 'openai', baseUrl: server.baseUrl, model: 'jina-embeddings-v2-base-code'}});
  try {
    meaning.open(root);
    await embedded(meaning, root);
    await meaning.turnOff();
    assert.equal(meaning.state, 'off');
    const asked = server.requests.length;
    meaning.open(root); // the word index, made again from the files
    await meaning.indexes.get(root).ready;
    const answer = await meaning.search(root, 'quantity');
    assert.equal(answer.state, 'off');
    assert.equal(answer.results[0].file, 'src/cart.js', 'the words still work');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(server.requests.length, asked, 'nothing is embedded');
    await meaning.turnOn();
    assert.equal(meaning.state, 'on');
  } finally {
    await meaning.close();
    await server.stop();
  }
});

test('the brute-force search over every vector stays quick for many pieces', () => {
  const pieces = Array.from({length: 20_000}, (_, i) => ({id: i, file: 'f.js', from: i + 1, to: i + 1, hash: `h${i}`}));
  const index = new ProjectIndex({root: '/project', store: null, embedder: {id: 'fake'}});
  index.byFile = new Map([['f.js', pieces]]);
  index.vectors = new Map(pieces.map(piece => [piece.hash, fakeVector(`piece ${piece.id} retry ${piece.id % 7}`)]));
  const q = fakeVector('try again');
  index.meaningRanking(q); // the vectors go in one array once
  const started = performance.now();
  const ranked = index.meaningRanking(q);
  const ms = performance.now() - started;
  assert.ok(ranked.length > 0 && ranked[0][1] >= ranked.at(-1)[1]);
  assert.ok(ms < 250, `20,000 pieces in ${ms.toFixed(1)} ms`);
});

test('an embedder that cannot run from the start: the search still says why meaning is missing', async () => {
  const root = project();
  const dataDir = scratch('meaning-data-');
  const embedder = fakeEmbedder();
  embedder.failWith = 'the model is not loaded';
  const meaning = new Meaning({dataDir, embedder});
  try {
    meaning.open(root);
    await meaning.indexes.get(root).ready;
    await until(() => meaning.problem, 'the build to stop at the embedder');
    for (let i = 0; i < 2; i++) {
      const answer = await meaning.search(root, 'quantity');
      assert.equal(answer.problem, 'the model is not loaded');
      assert.equal(answer.results[0].file, 'src/cart.js');
    }
    const alone = await meaning.meaningOnly(root, 'quantity');
    assert.equal(alone.problem, 'the model is not loaded');
  } finally {
    await meaning.close();
  }
});

test('an "embedding" model at a /v1/embeddings: on at once, its prompts, its key, vectors made unit length, and its failure said', async () => {
  const server = await fakeEmbeddingServer();
  const root = project();
  const dataDir = scratch('meaning-data-');
  const entry = {api: 'openai', baseUrl: server.baseUrl, model: 'nomic-embed-code', apiKey: 'test-key'};
  const meaning = new Meaning({dataDir, embedding: entry});
  try {
    assert.equal(meaning.state, 'on', 'no download: the model is there');
    meaning.open(root);
    await meaning.indexes.get(root).ready;
    await embedded(meaning, root);
    assert.equal(server.requests[0].url, '/v1/embeddings');
    assert.equal(server.requests[0].model, 'nomic-embed-code');
    assert.equal(server.requests[0].authorization, 'Bearer test-key');
    const answer = await meaning.search(root, 'try again when sending fails');
    assert.equal(answer.results[0].file, 'src/deliver.js');
    assert.ok(answer.results[0].meaning > 0.4 && answer.results[0].meaning <= 1, 'unit length, though the server sent longer');
    assert.equal(server.requests.at(-1).input[0], 'Represent this query for searching relevant code: try again when sending fails', 'the prompt the model was trained with');
    assert.equal(meaning.snapshot().indexes[0].embedded, 4);
    server.failWith = 503;
    const failing = await meaning.search(root, 'quantity');
    assert.match(failing.problem, /answered 503: .*model not loaded/);
    assert.equal(failing.results[0].file, 'src/cart.js');
    const http = new HttpEmbedder({entry: {...entry, baseUrl: 'http://127.0.0.1:1/v1'}});
    await assert.rejects(http.embed(['x']), /did not answer/);
    server.failWith = null;
    const sized = new HttpEmbedder({entry: {...entry, model: 'embeddinggemma-2', dimensions: 128}});
    await sized.embed([sized.query('x')]);
    assert.equal(server.requests.at(-1).dimensions, 128, 'dimensions are asked for');
    assert.equal(server.requests.at(-1).input[0], 'task: search result | query: x');
    assert.equal(sized.id, 'embeddinggemma-2/128', 'vectors are kept per model and size');
    assert.equal(sized.document('min.js', 'x'.repeat(50_000)), `title: none | text: ${'x'.repeat(PIECE.chars)}`, 'a piece of one long line is cut to what the model reads');
  } finally {
    await meaning.close();
    await server.stop();
  }
});


test('the prompts each model was trained with, the config\'s own first; the embedding entry and index are checked', () => {
  assert.deepEqual(promptsOf({model: 'nomic-embed-text-v1.5'}), {query: 'search_query: ', document: 'search_document: '});
  assert.deepEqual(promptsOf({model: 'EmbeddingGemma-300m'}), {query: 'task: search result | query: ', document: 'title: none | text: '});
  assert.match(promptsOf({model: 'Qwen3-Embedding-0.6B'}).query, /^Instruct: .*\nQuery: $/);
  assert.deepEqual(promptsOf({model: 'jina-code', queryPrefix: 'q: '}), {query: 'q: ', document: ''});
  assert.equal(embeddingConfig(undefined), null);
  assert.deepEqual(embeddingConfig({baseUrl: 'http://h/v1', model: 'm', dimensions: 768}), {api: 'openai', baseUrl: 'http://h/v1', model: 'm', dimensions: 768});
  assert.throws(() => embeddingConfig({api: 'ollama', baseUrl: 'http://h/v1', model: 'm'}), /embedding\.api must be "openai"/);
  assert.throws(() => embeddingConfig({baseUrl: 'http://h/v1'}), /embedding\.model is missing/);
  assert.throws(() => embeddingConfig({baseUrl: 'http://h/v1', model: 'm', dimensions: 1.5}), /dimensions must be a whole number/);
  assert.throws(() => embeddingConfig({baseUrl: 'http://h/v1', model: 'm', apiKey: 'a', apiKeyEnv: 'B'}), /takes one of apiKey, apiKeyEnv/);
  assert.equal(indexConfig(undefined), 'data');
  assert.throws(() => indexConfig('elsewhere'), /index must be "data" or "project"/);
});
