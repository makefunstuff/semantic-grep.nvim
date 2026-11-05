#!/usr/bin/env node
// The helper the semantic-grep-notes Claude Code skill runs. It finds the plugin's CLI, checks that the server and
// the project's index answer, gets the pieces without a note, splits large batches, and puts the notes back.
//
//   sg-notes.mjs check  [--root DIR] [--data-dir DIR] [--index data|project] [--project-dir NAME]
//   sg-notes.mjs pending [--root DIR] [--limit N] [--out FILE] [--data-dir ...] [--index ...] [--project-dir ...]
//   sg-notes.mjs put    [--root DIR] [--notes FILE|-] [--source NAME] [--data-dir ...] [...]
//   sg-notes.mjs split  --file FILE [--outdir DIR] [--size N]
//
// Every command exits 0 on success and says what happened in plain words. A missing server or an index that cannot be
// opened is explained with what to do, not left as a stack trace.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT), '../../..');
const MAX_NOTE_CHARS = 1000; // the index keeps this much of a note (src/index-store.mjs, NOTE_CHARS)

export const INDEX_HELP = [
  'semantic-grep could not open this project\'s index.',
  'Build it once: open the project in Neovim and run :SemanticGrep rebuild (or :SemanticGrep files, then search once).',
  'Then run this skill again. If the index lives elsewhere, pass --data-dir, --index or --project-dir.',
].join('\n');

export const SERVER_HELP = [
  'semantic-grep-server was not found.',
  'Install semantic-grep.nvim (for example with lazy.nvim), or set SEMANTIC_GREP_SERVER to its bin/semantic-grep-server.mjs.',
].join('\n');

const exists = path => { try { return existsSync(path); } catch { return false; } };

/** Where the plugin's CLI is: `SEMANTIC_GREP_SERVER`, this project, this checkout, lazy.nvim, then PATH. */
export function findServer({root = process.cwd(), env = process.env, exists: existsFn = exists, execPath = process.execPath, platform = process.platform} = {}) {
  const candidates = [];
  const explicit = env.SEMANTIC_GREP_SERVER?.trim();
  if (explicit) candidates.push({path: isAbsolute(explicit) ? explicit : resolve(explicit), source: 'SEMANTIC_GREP_SERVER'});
  candidates.push({path: join(root, 'bin', 'semantic-grep-server.mjs'), source: 'the project'});
  candidates.push({path: join(REPO_ROOT, 'bin', 'semantic-grep-server.mjs'), source: 'this skill\'s checkout'});
  const data = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  candidates.push({path: join(data, 'nvim', 'lazy', 'semantic-grep.nvim', 'bin', 'semantic-grep-server.mjs'), source: 'lazy.nvim'});
  const executable = platform === 'win32' ? 'semantic-grep-server.cmd' : 'semantic-grep-server';
  for (const dir of (env.PATH ?? '').split(platform === 'win32' ? ';' : ':')) {
    if (dir) candidates.push({path: join(dir, executable), source: 'PATH'});
  }
  for (const candidate of candidates) {
    if (!existsFn(candidate.path)) continue;
    const script = /\.(?:mjs|cjs|js)$/i.test(candidate.path);
    return script
      ? {command: execPath, args: [candidate.path], path: candidate.path, source: candidate.source}
      : {command: candidate.path, args: [], path: candidate.path, source: candidate.source};
  }
  return null;
}

/** What the server's stderr says: `{shown, pending, noted}` from `pending`, else null. */
export function parsePendingSummary(stderr) {
  const match = /(\d+) shown of (\d+) pieces without a note \((\d+) noted\)/.exec(String(stderr ?? ''));
  return match ? {shown: Number(match[1]), pending: Number(match[2]), noted: Number(match[3])} : null;
}

/** What the server's stderr says: `{added, unknown}` from `put`, else null. */
export function parsePutSummary(stderr) {
  const match = /(\d+) notes added(?:; (\d+) for pieces the index does not have \(changed since\?\))?/.exec(String(stderr ?? ''));
  return match ? {added: Number(match[1]), unknown: Number(match[2] ?? 0)} : null;
}

/** A plain explanation of a failure, or null when it is not one this helper knows. */
export function explainFailure(stderr, {root = process.cwd()} = {}) {
  const text = String(stderr ?? '');
  if (/Node 22\.16 or later|node:sqlite with FTS5/i.test(text)) {
    return `semantic-grep needs Node 22.16 or later (node:sqlite with FTS5); this is ${process.version}. Upgrade Node and run this skill again.`;
  }
  if (/index cannot be opened|unable to open database|not a database|no such table|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(text)) {
    return `${INDEX_HELP}\n(root: ${root})`;
  }
  if (/not a git repository/i.test(text)) {
    return `${root} is not a Git repository. Run this skill from a project Git lists files from, or pass --root DIR.`;
  }
  return null;
}

/** Calls the plugin's CLI with `args`, `stdin` as input; `{code, stdout, stderr}`. */
export function runServer(server, args, {input, cwd = process.cwd(), env = process.env, timeout = 10 * 60_000, spawn = spawnSync} = {}) {
  if (!server) return {code: 2, stdout: '', stderr: `${SERVER_HELP}\n`};
  const result = spawn(server.command, [...server.args, ...args], {encoding: 'utf8', input, cwd, env, timeout, maxBuffer: 128 * 1024 * 1024});
  if (result.error) {
    if (result.error.code === 'ENOENT') return {code: 2, stdout: '', stderr: `${SERVER_HELP}\n`};
    return {code: 1, stdout: result.stdout ?? '', stderr: `${result.error.message}\n`};
  }
  return {code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
}

/** The pieces from `pending`'s output, validated: `{hash, file, from, to, name, text}`, one per line. */
export function parsePending(text) {
  const pieces = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let piece;
    try {
      piece = JSON.parse(line);
    } catch {
      throw new Error(`pending line ${i + 1} is not JSON`);
    }
    if (typeof piece?.hash !== 'string' || !piece.hash) throw new Error(`pending line ${i + 1} has no hash`);
    if (typeof piece?.text !== 'string') throw new Error(`pending line ${i + 1} has no text`);
    pieces.push(piece);
  }
  return pieces;
}

/** Notes from JSON lines, validated and trimmed to one line: `[{hash, note}]`. `note` stops at MAX_NOTE_CHARS. */
export function parseNotes(text) {
  const notes = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`notes line ${i + 1} is not JSON`);
    }
    if (typeof entry?.hash !== 'string' || !entry.hash) throw new Error(`notes line ${i + 1} has no hash`);
    if (typeof entry?.note !== 'string') throw new Error(`notes line ${i + 1} has no note`);
    const note = entry.note.replace(/\s+/g, ' ').trim();
    if (!note) throw new Error(`notes line ${i + 1} has an empty note`);
    if (note.length > MAX_NOTE_CHARS) throw new Error(`notes line ${i + 1} is longer than ${MAX_NOTE_CHARS} characters`);
    notes.push({hash: entry.hash, note});
  }
  return notes;
}

export const notesJsonl = notes => notes.map(note => JSON.stringify(note)).join('\n') + (notes.length ? '\n' : '');

/** Splits pieces into chunks of at most `size`; `[{file, count}]` when `outdir` is given, else arrays. */
export function splitPieces(pieces, {size = 25, outdir = null} = {}) {
  if (!Number.isInteger(size) || size < 1) throw new Error('--size must be a whole number of at least 1');
  const chunks = [];
  for (let i = 0; i < pieces.length; i += size) chunks.push(pieces.slice(i, i + size));
  if (!outdir) return chunks;
  mkdirSync(outdir, {recursive: true});
  const written = chunks.map((chunk, index) => {
    const file = join(outdir, `chunk-${String(index + 1).padStart(3, '0')}.jsonl`);
    writeFileSync(file, chunk.map(piece => JSON.stringify(piece)).join('\n') + '\n');
    return {file, count: chunk.length};
  });
  writeFileSync(join(outdir, 'manifest.json'), `${JSON.stringify({total: pieces.length, chunks: written}, null, 2)}\n`);
  return written;
}

/** The flags the server understands and a person may name; passed through to both `pending` and `put`. */
export const PASSTHROUGH = ['data-dir', 'index', 'project-dir'];

export function parseArgs(argv) {
  const known = new Set(['root', 'limit', 'out', 'notes', 'source', 'file', 'outdir', 'size', 'help', ...PASSTHROUGH]);
  const args = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) { args._.push(raw); continue; }
    const [name, inline] = raw.slice(2).split(/=(.*)/s, 2);
    if (!known.has(name)) throw new Error(`unknown option --${name}`);
    if (inline !== undefined) { args[name] = inline; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[name] = next; i += 1; } else { args[name] = true; }
  }
  return args;
}

const whole = (value, name, fallback) => {
  if (value === undefined || value === true) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`--${name} must be a whole number`);
  return number;
};

/** The arguments both notes commands share: the root and the index's place. */
export function placeArgs({root = '.', args = {}}) {
  const flags = ['--root', root];
  for (const name of PASSTHROUGH) {
    if (args[name] !== undefined && args[name] !== true) flags.push(`--${name}`, args[name]);
  }
  return flags;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function serverProblem(result, {root}) {
  const explained = explainFailure(result.stderr, {root});
  process.stderr.write(`${explained || result.stderr.trim() || 'semantic-grep failed.'}\n`);
  process.exitCode = result.code || 1;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write([
      'usage: sg-notes.mjs check|pending|put|split [options]',
      '',
      '  check    the server, the index, and how many pieces have no note',
      '  pending  pieces without a note, as JSON lines: --limit N (default 200), --out FILE',
      '  put      notes from --notes FILE (or stdin), one {hash, note} JSON line each',
      '  split    a pending file into chunks: --file FILE --outdir DIR --size N (default 25)',
      '',
      '  all: --root DIR, --data-dir DIR, --index data|project, --project-dir NAME',
    ].join('\n') + '\n');
    return;
  }
  if (!['check', 'pending', 'put', 'split'].includes(command)) {
    fail(`unknown command ${command}; expected check, pending, put or split`);
    return;
  }
  const args = parseArgs(rest);
  if (args.help) return main(['help']);
  const root = args.root && args.root !== true ? resolve(args.root) : process.cwd();
  const server = findServer({root});

  if (command === 'split') {
    if (!args.file || args.file === true) return fail('split needs --file FILE (the output of pending --out)');
    const pieces = parsePending(readFileSync(args.file, 'utf8'));
    const outdir = args.outdir && args.outdir !== true ? resolve(args.outdir) : join(dirname(resolve(args.file)), 'chunks');
    const chunks = splitPieces(pieces, {size: whole(args.size, 'size', 25), outdir});
    process.stdout.write(`${JSON.stringify({total: pieces.length, outdir, chunks})}\n`);
    return;
  }

  if (!server) return fail(SERVER_HELP);
  if (command === 'check') {
    const result = runServer(server, ['notes', 'pending', ...placeArgs({root, args}), '--limit', '0']);
    if (result.code !== 0) return serverProblem(result, {root});
    const summary = parsePendingSummary(result.stderr);
    if (!summary) return fail(`semantic-grep answered unexpectedly:\n${result.stderr.trim()}`);
    process.stdout.write(`server: ${server.path} (${server.source})\n`);
    process.stdout.write(`index:  ${root}\n`);
    process.stdout.write(`notes:  ${summary.pending} pending, ${summary.noted} written\n`);
    if (!summary.pending && !summary.noted) process.stdout.write('        The index has no pieces yet; build it with :SemanticGrep rebuild in Neovim.\n');
    return;
  }

  if (command === 'pending') {
    const limit = whole(args.limit, 'limit', 200);
    const result = runServer(server, ['notes', 'pending', ...placeArgs({root, args}), '--limit', String(limit)]);
    if (result.code !== 0) return serverProblem(result, {root});
    const summary = parsePendingSummary(result.stderr);
    const pieces = parsePending(result.stdout);
    if (summary && summary.pending > 0 && !pieces.length) return fail('semantic-grep said pieces are pending but returned none; try again.');
    if (args.out && args.out !== true) {
      const out = resolve(args.out);
      mkdirSync(dirname(out), {recursive: true});
      writeFileSync(out, pieces.map(piece => JSON.stringify(piece)).join('\n') + (pieces.length ? '\n' : ''));
      process.stdout.write(`pending: ${summary?.pending ?? pieces.length} pieces without a note (${summary?.noted ?? '?'} written); wrote ${pieces.length} to ${out}\n`);
    } else {
      process.stdout.write(result.stdout);
      process.stderr.write(`${summary?.pending ?? pieces.length} pieces without a note (${summary?.noted ?? '?'} written)\n`);
    }
    return;
  }

  const file = args.notes && args.notes !== true ? resolve(args.notes) : null;
  const text = file === null || args.notes === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  let notes;
  try {
    notes = parseNotes(text);
  } catch (error) {
    return fail(error.message);
  }
  if (!notes.length) return fail('no notes to put; write one {hash, note} JSON line per pending piece');
  const source = args.source && args.source !== true ? args.source : 'agent';
  const result = runServer(server, ['notes', 'put', ...placeArgs({root, args}), '--source', source], {input: notesJsonl(notes)});
  if (result.code !== 0) return serverProblem(result, {root});
  const summary = parsePutSummary(result.stderr);
  const added = summary?.added ?? notes.length;
  const unknown = summary?.unknown ?? 0;
  process.stdout.write(`notes: ${added} added${unknown ? `; ${unknown} unknown (the pieces changed since pending; they will be listed again)` : ''}\n`);
  if (unknown) process.exitCode = 1; // ask the loop to fetch and note them again
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
}
