#!/usr/bin/env node
// The searches you made in a project and the piece you opened for each (what the plugin learns, see README "It
// learns"), as a private questions file for the bench: the same JSON lines as questions.jsonl, `repo` the project's
// path. It stays on this machine, outside this repository and the project, by default in the bench's cache:
//
//   npm run bench:export -- --root ~/code/app [--data-dir DIR] [--index data|project] [--project-dir NAME] [--out FILE]
//   npm run bench -- --profile laptop --questions ~/.cache/semantic-grep-bench/private/app-picks.jsonl
//
// The bench indexes the project afresh in its own data folder, so what was learned there does not answer for it.
// These are searches whose piece was found (or you would not have opened it): a check that what works keeps working,
// not a measure of what is missed.
import {existsSync, mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cacheDir, options} from './common.mjs';

const {flags} = options(process.argv.slice(2));
const log = line => process.stderr.write(`${line}\n`);
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (/SQLite/.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(this, warning, ...rest);
};
const {DatabaseSync} = await import('node:sqlite');
const {indexPlace, learnedPath} = await import('../src/index-store.mjs');

if (!flags.root) {
  log('usage: npm run bench:export -- --root DIR [--data-dir DIR] [--index data|project] [--project-dir NAME] [--out FILE]');
  process.exit(2);
}
const root = realpathSync(resolve(flags.root));
const dataDir = resolve(flags['data-dir'] ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'nvim', 'semantic-grep'));
const place = await indexPlace({dataDir, root, where: flags.index ?? 'data', ...(flags['project-dir'] ? {projectDir: flags['project-dir']} : {})});
const learned = learnedPath(place.path);
if (!existsSync(learned)) throw new Error(`nothing learned for ${root} (no ${learned}): pick some results in the picker first`);

const out = resolve(flags.out ?? join(cacheDir(flags.cache), 'private', `${basename(root)}-picks.jsonl`));
const inside = dir => !relative(dir, out).startsWith('..');
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (inside(here) || inside(root)) throw new Error(`${out} is inside ${inside(here) ? 'semantic-grep' : 'the project'}: a private questions file goes elsewhere`);

const db = new DatabaseSync(learned, {readOnly: true});
const picks = db.prepare("SELECT hash, file, line, text FROM extras WHERE kind = 'pick' ORDER BY at").all();
db.close();
// Each pick's piece as the index has it (its lines), else the line it was opened at.
const index = existsSync(place.path) ? new DatabaseSync(place.path, {readOnly: true}) : null;
const pieceOf = index?.prepare('SELECT line, last FROM pieces WHERE hash = ? AND tree = ? LIMIT 1');
const lines = [];
const seen = new Set();
for (const pick of picks) {
  if (!existsSync(join(root, pick.file))) continue; // gone since
  const piece = pick.hash ? pieceOf?.get(pick.hash, place.tree) : null;
  const question = {repo: root, query: pick.text, file: pick.file, from: piece?.line ?? pick.line, to: piece?.last ?? pick.line, style: 'pick', split: 'private'};
  const key = `${question.query}\n${question.file}\n${question.from}`;
  if (seen.has(key)) continue;
  seen.add(key);
  lines.push(JSON.stringify({id: `pick-${String(lines.length + 1).padStart(4, '0')}`, ...question}));
}
index?.close();
mkdirSync(dirname(out), {recursive: true, mode: 0o700});
writeFileSync(out, lines.length ? `${lines.join('\n')}\n` : '', {mode: 0o600});
log(`${lines.length} searches with the piece opened for each (of ${picks.length} kept) in ${out}`);
