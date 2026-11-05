// The helper behind the semantic-grep-notes Claude Code skill: it finds the plugin's CLI, checks the index, lists
// pieces without a note, splits a large batch, puts notes back, and explains a missing server or index instead of
// failing silently. The server here is the real one; the project is a scratch Git repository.
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  explainFailure, findServer, INDEX_HELP, notesJsonl, parseArgs, parseNotes, parsePending,
  parsePendingSummary, parsePutSummary, placeArgs, runServer, SERVER_HELP, splitPieces,
} from '../skills/semantic-grep-notes/scripts/sg-notes.mjs';
import {scratch} from './helpers.mjs';

const HELPER = fileURLToPath(new URL('../skills/semantic-grep-notes/scripts/sg-notes.mjs', import.meta.url));

/** A scratch Git project with two pieces, and the folder its index goes to. */
function project() {
  const root = scratch('skill-project-');
  writeFileSync(join(root, 'team.js'), 'export function dropMember(team, id) {\n  team.members = team.members.filter(member => member.id !== id);\n}\n');
  writeFileSync(join(root, 'cart.js'), 'export function total(cart) {\n  return cart.items.reduce((sum, item) => sum + item.cents, 0);\n}\n');
  execFileSync('git', ['init', '-q'], {cwd: root});
  return {root, dataDir: scratch('skill-data-')};
}

/** Runs the helper; resolves `{code, stdout, stderr}` whatever its exit code. */
function helper(args, {input = ''} = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HELPER, ...args], {timeout: 60_000}, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(new Error(`${error.message}\n${stderr}`));
      resolve({code: error?.code ?? 0, stdout, stderr});
    });
    child.stdin.end(input);
  });
}

test('findServer: SEMANTIC_GREP_SERVER, then the project, this skill\'s checkout, lazy.nvim, then PATH', () => {
  const env = {PATH: '/usr/bin', HOME: '/tmp/home'};
  const exists = (...paths) => path => paths.includes(path);
  const at = (path, source) => ({path, source});
  assert.deepEqual(
    findServer({root: '/p', env: {SEMANTIC_GREP_SERVER: '/srv/s.mjs'}, exists: exists('/srv/s.mjs', '/p/bin/semantic-grep-server.mjs'), execPath: '/node', platform: 'linux'}),
    {...at('/srv/s.mjs', 'SEMANTIC_GREP_SERVER'), command: '/node', args: ['/srv/s.mjs']},
  );
  assert.equal(findServer({root: '/p', env, exists: exists('/p/bin/semantic-grep-server.mjs'), execPath: '/node'}).source, 'the project');
  assert.equal(findServer({root: '/a', env, exists: exists('/usr/bin/semantic-grep-server'), execPath: '/node', platform: 'linux'}).source, 'PATH');
  assert.equal(findServer({root: '/a', env, exists: () => false, execPath: '/node'}), null, 'nothing found: null, not a guess');
});

test('the server\'s summaries and the failures it knows are read in plain words', () => {
  assert.deepEqual(parsePendingSummary('3 shown of 12 pieces without a note (7 noted)\n'), {shown: 3, pending: 12, noted: 7});
  assert.deepEqual(parsePutSummary('5 notes added; 2 for pieces the index does not have (changed since?)\n'), {added: 5, unknown: 2});
  assert.deepEqual(parsePutSummary('5 notes added\n'), {added: 5, unknown: 0});
  assert.equal(parsePendingSummary('nonsense'), null);
  assert.match(explainFailure('semantic-grep: the search index cannot be opened (see :checkhealth semantic-grep)'), /:SemanticGrep rebuild/);
  assert.equal(explainFailure('not a git repository', {root: '/tmp/p'}), '/tmp/p is not a Git repository. Run this skill from a project Git lists files from, or pass --root DIR.', 'the root is named');
  assert.match(explainFailure('semantic-grep needs Node 22.16 or later'), /Upgrade Node/);
  assert.equal(explainFailure('something else'), null, 'not one it knows: the caller shows the server\'s own words');
  assert.match(SERVER_HELP, /SEMANTIC_GREP_SERVER/);
  assert.match(INDEX_HELP, /--data-dir, --index or --project-dir/);
});

test('pending and notes JSON lines are checked; a bad line says which one', () => {
  const pieces = parsePending('{"hash":"a","file":"f","from":1,"to":2,"name":"n","text":"x"}\n');
  assert.equal(pieces.length, 1);
  assert.throws(() => parsePending('{bad}\n'), /pending line 1 is not JSON/);
  assert.throws(() => parsePending('{"text":"x"}\n'), /pending line 1 has no hash/);
  assert.throws(() => parsePending('{"hash":"a"}\n'), /pending line 1 has no text/);
  assert.deepEqual(parseNotes('{"hash":"a","note":"  One   note.\\n"}\n'), [{hash: 'a', note: 'One note.'}]);
  assert.throws(() => parseNotes('{"hash":"a","note":"  "}\n'), /empty note/);
  assert.throws(() => parseNotes(`{"hash":"a","note":"${'x'.repeat(1001)}"}\n`), /longer than 1000/);
  assert.equal(notesJsonl([{hash: 'a', note: 'n'}]), '{"hash":"a","note":"n"}\n');
  assert.equal(notesJsonl([]), '');
});

test('split: chunks of at most --size, numbered on disk, with a manifest; too small a size is refused', () => {
  const pieces = Array.from({length: 5}, (_, index) => ({hash: String(index), text: 'x'}));
  assert.deepEqual(splitPieces(pieces, {size: 2}).map(chunk => chunk.length), [2, 2, 1]);
  const outdir = scratch('skill-chunks-');
  const written = splitPieces(pieces, {size: 2, outdir});
  assert.deepEqual(written.map(chunk => chunk.count), [2, 2, 1]);
  assert.equal(readFileSync(written[0].file, 'utf8').trim().split('\n').length, 2);
  assert.equal(JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8')).total, 5);
  assert.throws(() => splitPieces(pieces, {size: 0}), /--size/);
  assert.deepEqual(parseArgs(['--root', '.', '--data-dir=/tmp/d', '--limit', '200']), {_: [], root: '.', 'data-dir': '/tmp/d', limit: '200'});
  assert.throws(() => parseArgs(['--nope', 'x']), /unknown option --nope/);
  assert.deepEqual(placeArgs({root: '/r', args: {index: 'project', 'data-dir': '/d', 'project-dir': 'p'}}), ['--root', '/r', '--data-dir', '/d', '--index', 'project', '--project-dir', 'p']);
});

test('check, pending, put, split, check: the loop on a real project; counts fall, unknown hashes are told', async () => {
  const {root, dataDir} = project();
  const before = await helper(['check', '--root', root, '--data-dir', dataDir]);
  assert.equal(before.code, 0, before.stderr);
  assert.match(before.stdout, /^server: .*semantic-grep-server\.mjs/m);
  assert.match(before.stdout, new RegExp(`index:  ${root}`));
  assert.match(before.stdout, /notes:  2 pending, 0 written/);

  const pendingFile = join(scratch('skill-pending-'), 'pending.jsonl');
  const listed = await helper(['pending', '--root', root, '--data-dir', dataDir, '--limit', '200', '--out', pendingFile]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /pending: 2 pieces without a note \(0 written\); wrote 2 to /);
  const pieces = parsePending(readFileSync(pendingFile, 'utf8'));
  assert.deepEqual(pieces.map(piece => piece.file).sort(), ['cart.js', 'team.js']);
  assert.ok(pieces.every(piece => piece.hash && piece.name && piece.text));

  const notes = pieces.map(piece => ({hash: piece.hash, note: piece.file === 'team.js'
    ? 'Removes one member from a team when they leave; someone changes who belongs to the team.'
    : 'Adds up what every item in a cart costs; someone shows the order total.'}));
  notes.push({hash: 'gone', note: 'A piece the index no longer has.'});
  const notesFile = join(scratch('skill-notes-'), 'notes.jsonl');
  writeFileSync(notesFile, notesJsonl(notes));
  const put = await helper(['put', '--root', root, '--data-dir', dataDir, '--notes', notesFile]);
  assert.equal(put.code, 1, 'unknown hash: told, and the loop asks again');
  assert.match(put.stdout, /notes: 2 added; 1 unknown/);

  const after = await helper(['check', '--root', root, '--data-dir', dataDir]);
  assert.match(after.stdout, /notes:  0 pending, 2 written/);

  const chunks = await helper(['split', '--file', pendingFile, '--outdir', join(scratch('skill-chunks-'), 'c'), '--size', '1']);
  assert.equal(chunks.code, 0, chunks.stderr);
  const answer = JSON.parse(chunks.stdout);
  assert.equal(answer.total, 2);
  assert.deepEqual(answer.chunks.map(chunk => chunk.count), [1, 1]);
});

test('put: bad notes are refused before the server sees them; an empty file says what to write', async () => {
  const {root, dataDir} = project();
  const bad = join(scratch('skill-bad-'), 'notes.jsonl');
  writeFileSync(bad, '{"hash":"a","note":"ok"}\n{"hash":"b","note":""}\n');
  const refused = await helper(['put', '--root', root, '--data-dir', dataDir, '--notes', bad]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /notes line 2 has an empty note/);
  const empty = await helper(['put', '--root', root, '--data-dir', dataDir], {input: ''});
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /no notes to put/);
});

test('no server, or an index that cannot be opened: plain words, not a stack trace', async () => {
  assert.equal(findServer({root: process.cwd(), env: {PATH: '/nonexistent'}, exists: () => false}), null);
  const missing = runServer(null, ['notes', 'pending']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /semantic-grep-server was not found/);
  assert.match(missing.stderr, /SEMANTIC_GREP_SERVER/);

  const notGit = scratch('skill-not-git-');
  writeFileSync(join(notGit, 'file.js'), 'export const one = 1;\n');
  const brokenDataDir = join(scratch('skill-data-file-'), 'not-a-folder');
  writeFileSync(brokenDataDir, 'not a folder\n');
  const result = await helper(['check', '--root', notGit, '--data-dir', brokenDataDir]);
  assert.notEqual(result.code, 0, 'fails, but explained');
  assert.match(result.stderr, /could not open this project's index/);
  assert.match(result.stderr, /:SemanticGrep rebuild/);
  assert.doesNotMatch(result.stderr, /\n\s+at .*\.mjs:\d+/, 'no stack trace');
});
