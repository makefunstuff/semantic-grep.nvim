#!/usr/bin/env node
// The retrieval benchmark: indexes the repositories a questions file names with a profile's models, asks each question
// four ways (words only, meaning only, both fused, fused and reranked) and prints recall@1/5/10, MRR and the p50/p95
// latency of each, per repository and overall. The run is saved as JSON, which a later run compares itself with.
//
//   npm run bench -- --profile laptop [--questions FILE] [--repos hono,flask] [--split dev|test] [--modes words,fused]
//                    [--out FILE] [--compare FILE] [--fresh] [--profiles FILE] [--cache DIR] [--models DIR]
//                    [--llama-server PATH] [--parsers none] [--notes WRITER] [--writers FILE]
//
// With --notes, every piece first gets a note from that writer of writers.json (src/notes.mjs; its llama-server started
// like a profile's), as the plugin's notes = {...} writes them, and the questions are asked with them. The notes are
// cached by piece (<cache>/notes/<writer>/<repo>.jsonl): a run again asks the writer only for pieces it has none for,
// and the run saves what the writing took (time and tokens a thousand pieces, and with a price, the cost).
//
// A question is a JSON line, {id, repo, query, file, from, to, style?, split?, also?: [{file, from, to}]}: `repo` a
// name in corpus.json (fetched by `npm run bench:fetch`) or a folder's absolute path (a private questions file, see
// export-picks.mjs). A result answers it when it is in that file and its lines overlap the range (or one in `also`).
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cacheDir, neovimParsers, options, settled} from './common.mjs';
import {serveProfile} from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MODES = ['words', 'meaning', 'fused', 'rerank'];
const LIMIT = 30; // results asked of each search: past this a question counts as not found (reciprocal rank 0)

const {flags} = options(process.argv.slice(2));
const log = line => process.stderr.write(`${line}\n`);
if (!flags.profile || flags.help) {
  log('usage: npm run bench -- --profile NAME [--questions FILE] [--repos a,b] [--split dev|test] [--modes words,meaning,fused,rerank] [--out FILE] [--compare FILE] [--fresh] [--cache DIR] [--models DIR] [--llama-server PATH]');
  process.exit(2);
}

// node:sqlite says it is experimental on every run: not news here.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && /SQLite/.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(this, warning, ...rest);
};
const {Meaning} = await import('../src/meaning.mjs');
const {Reranker} = await import('../src/rerank.mjs');
const {embeddingConfig, rerankConfig} = await import('../src/config.mjs');
const {notesConfig, NotesWriter, SYSTEM: NOTES_SYSTEM} = await import('../src/notes.mjs');

const profiles = JSON.parse(readFileSync(resolve(flags.profiles ?? join(HERE, 'profiles.json')), 'utf8'));
const profile = profiles[flags.profile];
if (!profile) throw new Error(`no profile "${flags.profile}" in ${flags.profiles ?? 'bench/profiles.json'} (${Object.keys(profiles).join(', ')})`);
const embedding = embeddingConfig(profile.embedding ?? null);
const writers = flags.notes ? JSON.parse(readFileSync(resolve(flags.writers ?? join(HERE, 'writers.json')), 'utf8')) : null;
const writerSpec = flags.notes ? writers[flags.notes] : null;
if (flags.notes && !writerSpec) throw new Error(`no writer "${flags.notes}" in ${flags.writers ?? 'bench/writers.json'} (${Object.keys(writers).join(', ')})`);
const notesEntry = writerSpec ? notesConfig(writerSpec.notes) : null;
// What makes a note (the model, how much of the piece it reads, the prompt): its cache and data folder are named by it.
const notesMade = notesEntry ? createHash('sha1').update(JSON.stringify([notesEntry.model, notesEntry.chars, NOTES_SYSTEM])).digest('hex').slice(0, 8) : null;
const rerank = rerankConfig(profile.rerank ?? null);
const unknown = flags.modes ? String(flags.modes).split(',').filter(mode => !MODES.includes(mode)) : [];
if (unknown.length) throw new Error(`no mode ${unknown.join(', ')}: the modes are ${MODES.join(', ')}`);
const modes = (flags.modes ? String(flags.modes).split(',') : MODES).filter(mode => MODES.includes(mode)
  && (embedding || !['meaning', 'fused'].includes(mode)) && (rerank || mode !== 'rerank'));
if (!modes.length) throw new Error(`no mode to run: ${flags.modes ? `--modes ${flags.modes} with` : ''} profile ${flags.profile} (${MODES.join(', ')}; meaning and fused need an embedding model, rerank a reranker)`);
const cache = cacheDir(flags.cache);
// Read now: the run may be saved where it was.
const before = flags.compare ? JSON.parse(readFileSync(resolve(flags.compare), 'utf8')) : null;

// The questions, and the folder each repository is in.
const questionsPath = resolve(flags.questions ?? join(HERE, 'questions.jsonl'));
const questionsText = readFileSync(questionsPath, 'utf8');
if (flags.out && relative(ROOT, questionsPath).startsWith('..') && !relative(ROOT, resolve(flags.out)).startsWith('..')) {
  throw new Error(`${flags.out}: a run of private questions names your project's path; it is not saved in this repository`);
}
const wantedRepos = flags.repos ? new Set(String(flags.repos).split(',')) : null;
const questions = questionsText.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
  .filter(question => (!wantedRepos || wantedRepos.has(question.repo)) && (!flags.split || question.split === flags.split));
if (!questions.length) throw new Error(`no questions in ${questionsPath}${wantedRepos || flags.split ? ' for those repositories and split' : ''}`);
const corpus = JSON.parse(readFileSync(join(HERE, 'corpus.json'), 'utf8')).repos;
const repos = [...new Set(questions.map(question => question.repo))].map(name => {
  const pinned = corpus.find(repo => repo.name === name);
  const root = isAbsolute(name) ? name : join(cache, 'repos', name);
  if (!existsSync(root)) throw new Error(`${root} is missing: ${pinned ? 'npm run bench:fetch' : 'a repository is a corpus.json name or an absolute path'}`);
  const commit = gitHead(root, true);
  if (pinned && commit !== pinned.commit) throw new Error(`${name} is at ${commit?.slice(0, 12)}, not the pinned ${pinned.commit.slice(0, 12)}: npm run bench:fetch`);
  return {name, root, commit};
});

// The code that runs, read now: a commit made during a long run is not it.
const code = {commit: gitHead(ROOT), changed: changedFiles(ROOT)};
const served = await serveProfile(profile, {models: flags.models ?? process.env.SEMANTIC_GREP_BENCH_MODELS, llamaServer: flags['llama-server'] ?? process.env.LLAMA_SERVER ?? 'llama-server', log});
let meaning;
let writerServed = null;
try {
  // One data folder per embedding model: its vectors stay for the next run, and another model's never mix in.
  // Pieces cut by indentation are another index than tree-sitter's.
  let dataDir = join(cache, 'data', `${embedding ? `${embedding.model}${embedding.dimensions ? `-${embedding.dimensions}` : ''}`.replace(/[^\w.-]+/g, '_') : 'words'}${flags.parsers === 'none' ? '-indent' : ''}`);
  // With notes, a data folder of their own, begun as a copy of the one without (its pieces' vectors are the same).
  const notedDir = flags.notes ? `${dataDir}-notes-${flags.notes.replace(/[^\w.-]+/g, '_')}-${notesMade}` : null;
  if (flags.fresh) for (const dir of [dataDir, notedDir].filter(Boolean)) rmSync(dir, {recursive: true, force: true});
  if (notedDir && !existsSync(notedDir) && existsSync(dataDir)) cpSync(dataDir, notedDir, {recursive: true});
  if (notedDir) dataDir = notedDir;
  const parsers = flags.parsers === 'none' ? [] : neovimParsers();
  meaning = new Meaning({dataDir, embedding, reranker: rerank ? new Reranker({entries: rerank, log}) : null, log});
  meaning.useParsers(parsers);
  log(`profile ${flags.profile}: ${embedding ? meaning.modelName : 'no embedding model'}${rerank ? `, rerank ${meaning.reranker.name}` : ''}; ${questions.length} questions, ${repos.length} repositories; ${parsers.length} tree-sitter parsers`);

  const perQuestion = [];
  const repoResults = {};
  const notesResults = {};
  for (const repo of repos) {
    const started = Date.now();
    const opened = meaning.open(repo.root);
    await opened.loaded;
    const cached = opened.progress().embedded; // vectors from an earlier run
    const index = await settled(meaning, repo.root, ({chunks, embedded}) => log(`${repo.name}: ${embedded} of ${chunks} pieces embedded`));
    const {files, chunks, embedded} = index.progress();
    const indexMs = Date.now() - started;
    if (notesEntry) notesResults[repo.name] = await noted(repo);
    log(`${repo.name}: ${files} files, ${chunks} pieces, ready in ${(indexMs / 1000).toFixed(1)} s`);
    const asked = questions.filter(question => question.repo === repo.name);
    // One search of each kind first, none of the questions, not timed: the models load, the matrix is made.
    for (const mode of modes) { await ask(mode, repo.root, 'where does it start'); await meaning.files(repo.root, 'where does it start', {mode, limit: LIMIT}); }
    const rows = [];
    for (const question of asked) {
      const row = {id: question.id, repo: repo.name, style: question.style ?? null, split: question.split ?? null, rank: {}, ms: {}, fileRank: {}, fileMs: {}};
      for (const mode of modes) {
        const t = performance.now();
        const answer = await ask(mode, repo.root, question.query);
        row.ms[mode] = Math.round((performance.now() - t) * 10) / 10;
        if (answer.problem) throw new Error(`${mode} "${question.query}": ${answer.problem}`);
        row.rank[mode] = rankOf(answer.results, question);
        // How close in meaning the best piece and the first right one are: what calibrate.mjs sets a model's band by.
        if (mode === 'meaning' && answer.results.length) row.similarity = {best: answer.results[0].meaning, answer: answer.results[row.rank[mode] - 1]?.meaning ?? null};
        if (mode === 'rerank') row.reranked = answer.rerank ? (answer.rerank.applied ? 'applied' : answer.rerank.why) : 'none';
        // The files view of the same search: answered by the labelled file, anywhere in it.
        const f = performance.now();
        const files = await meaning.files(repo.root, question.query, {mode, limit: LIMIT});
        row.fileMs[mode] = Math.round((performance.now() - f) * 10) / 10;
        if (files.problem) throw new Error(`files ${mode} "${question.query}": ${files.problem}`);
        row.fileRank[mode] = fileRankOf(files.results, question);
      }
      rows.push(row);
    }
    perQuestion.push(...rows);
    // A build's time a thousand pieces, when this run embedded most of them (not when it reused an earlier run's vectors).
    const msPer1k = embedded - cached > chunks / 2 ? Math.round(indexMs / (embedded - cached) * 1000) : null;
    repoResults[repo.name] = {commit: repo.commit, files, pieces: chunks, embedded: embedded - cached, indexMs, msPer1k, questions: rows.length, modes: summary(rows), fileModes: summary(rows, true)};
  }

  const styles = [...new Set(perQuestion.map(row => row.style).filter(Boolean))];
  const result = {
    bench: 1,
    profile: flags.profile,
    models: {embedding: redact(embedding), rerank: rerank?.map(redact) ?? null}, // as the plugin would take them, defaults filled
    servers: served.measured(), // the local models: started here from which GGUF (and the memory each took), or found answering
    when: new Date().toISOString(),
    node: process.version,
    semanticGrep: code.commit, changed: code.changed,
    questions: {file: relative(ROOT, questionsPath).startsWith('..') ? 'private' : relative(ROOT, questionsPath), sha1: createHash('sha1').update(JSON.stringify(questions)).digest('hex').slice(0, 12), count: perQuestion.length, split: flags.split ?? 'all'},
    parsers: parsers.length,
    limit: LIMIT,
    overall: summary(perQuestion),
    files: summary(perQuestion, true), // the files view: a question answered by its labelled file
    repos: repoResults,
    styles: Object.fromEntries(styles.map(style => [style, summary(perQuestion.filter(row => row.style === style))])),
    reranked: modes.includes('rerank') ? count(perQuestion.map(row => row.reranked)) : null,
    build: buildOf(repoResults),
    notes: notesEntry ? notesOf(notesResults) : null,
    perQuestion,
  };
  print(result);
  const isPrivate = result.questions.file === 'private';
  // Named by what it ran, and never over an earlier run: profile, day, split, repositories and modes when not all.
  const name = [flags.profile, result.when.slice(0, 10), flags.split, flags.repos && repos.map(repo => basename(repo.name)).join('+'), flags.modes && modes.join('+'), flags.notes && `notes-${flags.notes}`].filter(Boolean).join('-');
  let out = flags.out && resolve(flags.out);
  for (let n = 1; !out || (!flags.out && existsSync(out)); n++) out = join(isPrivate ? join(cache, 'results') : join(HERE, 'results'), `${name}${n > 1 ? `-${n}` : ''}.json`);
  mkdirSync(dirname(out), {recursive: true});
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  log(`saved ${out}`);
  if (before) compare(result, before);
} finally {
  await meaning?.close();
  await writerServed?.stop();
  await served.stop();
}

/**
 * Every piece of `repo` with a note of the writer's: those cached from an earlier run put as they are, the others
 * written now (its server started at the first) and cached; then their vectors embedded. What the writing took.
 */
async function noted(repo) {
  const file = join(cache, 'notes', `${flags.notes.replace(/[^\w.-]+/g, '_')}-${notesMade}`, `${basename(repo.name).replace(/[^\w.-]+/g, '_')}.jsonl`);
  const tookFile = file.replace(/\.jsonl$/, '.took.json'); // what writing them took, the first time
  mkdirSync(dirname(file), {recursive: true});
  const cached = new Map((existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []).map(row => [row.hash, row]));
  const {pieces, noted: had} = await meaning.pendingNotes(repo.root, {limit: Infinity});
  const put = pieces.filter(piece => cached.has(piece.hash)).map(piece => cached.get(piece.hash));
  if (put.length) await meaning.addNotes(repo.root, put, {source: `writer:${notesEntry.model}`});
  const todo = pieces.filter(piece => !cached.has(piece.hash));
  const took = {pieces: pieces.length + had, cached: put.length + had, written: 0, failed: 0, ms: 0, input: 0, output: 0, cost: 0};
  if (todo.length) {
    writerServed ??= await serveProfile({notes: notesEntry, serve: writerSpec.serve}, {models: flags.models ?? process.env.SEMANTIC_GREP_BENCH_MODELS, llamaServer: flags['llama-server'] ?? process.env.LLAMA_SERVER ?? 'llama-server', log});
    const writer = new NotesWriter({entry: notesEntry, log});
    const started = Date.now();
    for (let i = 0; i < todo.length; i += notesEntry.concurrency * 8) {
      const batch = todo.slice(i, i + notesEntry.concurrency * 8);
      const {notes, errors} = await writer.write(batch);
      if (!notes.length && errors.some(error => !error.endsWith('no note in the answer'))) throw new Error(`notes: ${errors[0]}`);
      for (const note of notes) appendFileSync(file, `${JSON.stringify(note)}\n`);
      await meaning.addNotes(repo.root, notes, {source: writer.name});
      Object.assign(took, {written: took.written + notes.length, failed: took.failed + batch.length - notes.length});
      log(`${repo.name}: ${took.written + took.cached} of ${pieces.length} pieces noted`);
    }
    Object.assign(took, {ms: Date.now() - started, ...writer.tokens, cost: writer.cost});
  }
  // What writing every cached note took, over the runs that wrote them: what the cost a thousand pieces is of.
  const before = existsSync(tookFile) ? JSON.parse(readFileSync(tookFile, 'utf8')) : {};
  took.total = Object.fromEntries(['written', 'ms', 'input', 'output', 'cost'].map(key => [key, (before.total?.[key] ?? before[key] ?? 0) + took[key]]));
  if (took.written) writeFileSync(tookFile, `${JSON.stringify(took)}\n`);
  await settled(meaning, repo.root, ({chunks}) => log(`${repo.name}: the notes of ${chunks} pieces embedded`));
  return took;
}

/** The notes' cost: time and tokens a thousand pieces written here (not cached), and with the writer's price, dollars. */
function notesOf(byRepo) {
  const rows = Object.values(byRepo);
  const count = key => rows.reduce((total, row) => total + row[key], 0);
  // Over every run that wrote the notes (took.total), not only this one.
  const sum = key => rows.reduce((total, row) => total + row.total[key], 0);
  const written = sum('written');
  const per1k = value => (written ? Math.round(value / written * 1000) : null);
  const price = writerSpec.price; // dollars a million tokens, {input, output}
  return {
    writer: flags.notes, model: notesEntry.model, about: writerSpec.about ?? null, served: writerServed?.measured() ?? null,
    pieces: count('pieces'), written: count('written'), cached: count('cached'), failed: count('failed'), measuredOn: written,
    msPer1k: per1k(sum('ms')), inputPer1k: per1k(sum('input')), outputPer1k: per1k(sum('output')),
    // What the API said the requests cost, else the tokens at the writer's price.
    dollarsPer1k: !written ? null : sum('cost') ? Math.round(sum('cost') / written * 1000 * 1000) / 1000
      : price ? Math.round((sum('input') * price.input + sum('output') * price.output) / written * 1000 / 1e6 * 1000) / 1000 : null,
    repos: byRepo,
  };
}

/** One search of `mode`, as the plugin asks it. */
function ask(mode, root, query) {
  if (mode === 'words') return meaning.words(root, query, {limit: LIMIT});
  if (mode === 'meaning') return meaning.meaningOnly(root, query, {limit: LIMIT});
  return meaning.search(root, query, {limit: LIMIT, book: false, rerank: mode === 'rerank'});
}

/** The 1-based rank of the first file that answers `question` (its file, or one in `also`), or 0. */
function fileRankOf(results, question) {
  const files = new Set([question.file, ...(question.also ?? []).map(answer => answer.file)]);
  return results.findIndex(result => files.has(result.file)) + 1;
}

/** The 1-based rank of the first result that answers `question`, or 0. */
function rankOf(results, question) {
  const answers = [question, ...(question.also ?? [])];
  const at = results.findIndex(result => answers.some(answer => result.file === answer.file && result.from <= answer.to && answer.from <= result.to));
  return at + 1;
}

function percentile(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null; }
function round(value) { return Math.round(value * 1000) / 1000; }

/** Recall@1/5/10, MRR and the p50/p95 milliseconds of each mode over `rows`: of the pieces, or of the files view (`files`). */
function summary(rows, files = false) {
  const out = {};
  for (const mode of modes) {
    const ranks = rows.map(row => (files ? row.fileRank : row.rank)[mode]);
    const ms = rows.map(row => (files ? row.fileMs : row.ms)[mode]).sort((a, b) => a - b);
    const recall = k => round(ranks.filter(rank => rank && rank <= k).length / ranks.length);
    out[mode] = {n: ranks.length, recall1: recall(1), recall5: recall(5), recall10: recall(10), mrr: round(ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length), p50: percentile(ms, 0.5), p95: percentile(ms, 0.95)};
  }
  return out;
}

/** The build of the repositories this run embedded afresh: pieces, time, and the time a thousand pieces. */
function buildOf(repoResults) {
  const built = Object.values(repoResults).filter(repo => repo.msPer1k !== null);
  const pieces = built.reduce((sum, repo) => sum + repo.embedded, 0);
  const ms = built.reduce((sum, repo) => sum + repo.indexMs, 0);
  return pieces ? {pieces, ms, msPer1k: Math.round(ms / pieces * 1000)} : null;
}

function count(values) { return values.reduce((counts, value) => ({...counts, [value]: (counts[value] ?? 0) + 1}), {}); }

/** An entry without its key, for the saved run. */
function redact(entry) {
  if (!entry) return null;
  const {apiKey, apiKeyFile, ...rest} = entry;
  return rest;
}

/** The files changed and not committed at `cwd` (what the commit alone does not say), or null without git. */
function changedFiles(cwd) {
  try { return execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).split('\n').filter(Boolean).map(line => line.slice(3)); } catch { return null; }
}

/** The commit checked out at `cwd` (its short form unless `full`), or null. */
function gitHead(cwd, full = false) {
  try { return execFileSync('git', ['rev-parse', ...(full ? [] : ['--short']), 'HEAD'], {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(); } catch { return null; }
}

function pad(text, width) { return String(text).padEnd(width); }

/** The table: a row per repository and mode, then overall and by style. */
function print(result) {
  const lines = [`\n${pad('', 12)}${pad('mode', 9)}${['R@1', 'R@5', 'R@10', 'MRR', 'p50 ms', 'p95 ms'].map(head => head.padStart(8)).join('')}`];
  const rowsOf = (label, byMode) => {
    for (const [mode, stats] of Object.entries(byMode)) {
      lines.push(`${pad(label, 12)}${pad(mode, 9)}${[...[stats.recall1, stats.recall5, stats.recall10, stats.mrr].map(value => value.toFixed(3)), ...[stats.p50, stats.p95].map(ms => (ms < 10 ? ms.toFixed(1) : String(Math.round(ms))))].map(text => text.padStart(8)).join('')}`);
      label = '';
    }
  };
  for (const [name, repo] of Object.entries(result.repos)) rowsOf(basename(name).slice(0, 11), repo.modes);
  lines.push('');
  rowsOf(`all (${result.overall[modes[0]].n})`, result.overall);
  for (const [style, byMode] of Object.entries(result.styles)) rowsOf(style.slice(0, 11), byMode);
  lines.push('\nfiles (the labelled file):');
  for (const [name, repo] of Object.entries(result.repos)) rowsOf(basename(name).slice(0, 11), repo.fileModes);
  rowsOf(`all (${result.files[modes[0]].n})`, result.files);
  if (result.build) lines.push(`\nbuilt ${result.build.pieces} pieces in ${(result.build.ms / 1000).toFixed(1)} s: ${(result.build.msPer1k / 1000).toFixed(1)} s a thousand`);
  for (const [role, server] of Object.entries(result.servers ?? {})) if (server.rssMB !== undefined) lines.push(`${role}: ${server.gguf}, ${server.rssMB} MB of RAM${server.vramMB ? `, ${server.vramMB} MB of GPU memory` : ''} at most`);
  if (result.notes) lines.push(`\nnotes by ${result.notes.writer} (${result.notes.model}): ${result.notes.written} written, ${result.notes.cached} cached, ${result.notes.failed} without${result.notes.msPer1k ? `; ${(result.notes.msPer1k / 1000).toFixed(0)} s, ${result.notes.inputPer1k} tokens read and ${result.notes.outputPer1k} written a thousand pieces` : ''}${result.notes.dollarsPer1k !== null ? `, $${result.notes.dollarsPer1k}` : ''}`);
  if (result.reranked) lines.push(`\nreranks: ${Object.entries(result.reranked).map(([why, n]) => `${n} ${why}`).join(', ')}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** This run against an earlier one: the change of each overall and per-repository number. */
function compare(now, before) {
  const sign = value => (value > 0 ? `+${value}` : String(value));
  const lines = [`\nagainst ${before.profile} of ${before.when.slice(0, 10)} (questions ${before.questions.sha1}${before.questions.sha1 === now.questions.sha1 ? ', the same' : ', other questions'}):`];
  const diff = (label, a, b) => {
    for (const mode of Object.keys(a)) {
      if (!b?.[mode]) continue;
      lines.push(`${pad(label, 12)}${pad(mode, 9)}${['recall1', 'recall5', 'recall10', 'mrr'].map(key => sign(round(a[mode][key] - b[mode][key])).padStart(8)).join('')}${['p50', 'p95'].map(key => sign(Math.round(a[mode][key] - b[mode][key])).padStart(8)).join('')}`);
      label = '';
    }
  };
  for (const [name, repo] of Object.entries(now.repos)) diff(basename(name).slice(0, 11), repo.modes, before.repos[name]?.modes);
  diff('all', now.overall, before.overall);
  if (before.files) diff('all files', now.files, before.files);
  process.stdout.write(`${lines.join('\n')}\n`);
}
