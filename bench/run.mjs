#!/usr/bin/env node
// The retrieval benchmark: indexes the repositories a questions file names with a profile's models, asks each question
// four ways (words only, meaning only, both fused, fused and reranked) and prints recall@1/5/10, MRR and the p50/p95
// latency of each, per repository and overall. The run is saved as JSON, which a later run compares itself with.
//
//   npm run bench -- --profile laptop [--questions FILE] [--repos hono,flask] [--split dev|test] [--modes words,fused]
//                    [--out FILE] [--compare FILE] [--fresh] [--profiles FILE] [--cache DIR] [--models DIR]
//                    [--llama-server PATH] [--parsers none]
//
// A question is a JSON line, {id, repo, query, file, from, to, style?, split?, also?: [{file, from, to}]}: `repo` a
// name in corpus.json (fetched by `npm run bench:fetch`) or a folder's absolute path (a private questions file, see
// export-picks.mjs). A result answers it when it is in that file and its lines overlap the range (or one in `also`).
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
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

const profiles = JSON.parse(readFileSync(resolve(flags.profiles ?? join(HERE, 'profiles.json')), 'utf8'));
const profile = profiles[flags.profile];
if (!profile) throw new Error(`no profile "${flags.profile}" in ${flags.profiles ?? 'bench/profiles.json'} (${Object.keys(profiles).join(', ')})`);
const embedding = embeddingConfig(profile.embedding ?? null);
const rerank = rerankConfig(profile.rerank ?? null);
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
try {
  // One data folder per embedding model: its vectors stay for the next run, and another model's never mix in.
  // Pieces cut by indentation are another index than tree-sitter's.
  const dataDir = join(cache, 'data', `${embedding ? `${embedding.model}${embedding.dimensions ? `-${embedding.dimensions}` : ''}`.replace(/[^\w.-]+/g, '_') : 'words'}${flags.parsers === 'none' ? '-indent' : ''}`);
  if (flags.fresh) rmSync(dataDir, {recursive: true, force: true});
  const parsers = flags.parsers === 'none' ? [] : neovimParsers();
  meaning = new Meaning({dataDir, embedding, reranker: rerank ? new Reranker({entries: rerank, log}) : null, log});
  meaning.useParsers(parsers);
  log(`profile ${flags.profile}: ${embedding ? meaning.modelName : 'no embedding model'}${rerank ? `, rerank ${meaning.reranker.name}` : ''}; ${questions.length} questions, ${repos.length} repositories; ${parsers.length} tree-sitter parsers`);

  const perQuestion = [];
  const repoResults = {};
  for (const repo of repos) {
    const started = Date.now();
    const opened = meaning.open(repo.root);
    await opened.loaded;
    const cached = opened.progress().embedded; // vectors from an earlier run
    const index = await settled(meaning, repo.root, ({chunks, embedded}) => log(`${repo.name}: ${embedded} of ${chunks} pieces embedded`));
    const {files, chunks, embedded} = index.progress();
    const indexMs = Date.now() - started;
    log(`${repo.name}: ${files} files, ${chunks} pieces, ready in ${(indexMs / 1000).toFixed(1)} s`);
    const asked = questions.filter(question => question.repo === repo.name);
    // One search of each kind first, none of the questions, not timed: the models load, the matrix is made.
    for (const mode of modes) await ask(mode, repo.root, 'where does it start');
    const rows = [];
    for (const question of asked) {
      const row = {id: question.id, repo: repo.name, style: question.style ?? null, split: question.split ?? null, rank: {}, ms: {}};
      for (const mode of modes) {
        const t = performance.now();
        const answer = await ask(mode, repo.root, question.query);
        row.ms[mode] = Math.round((performance.now() - t) * 10) / 10;
        if (answer.problem) throw new Error(`${mode} "${question.query}": ${answer.problem}`);
        row.rank[mode] = rankOf(answer.results, question);
        if (mode === 'rerank') row.reranked = answer.rerank ? (answer.rerank.applied ? 'applied' : answer.rerank.why) : 'none';
      }
      rows.push(row);
    }
    perQuestion.push(...rows);
    repoResults[repo.name] = {commit: repo.commit, files, pieces: chunks, embedded: embedded - cached, indexMs, questions: rows.length, modes: summary(rows)};
  }

  const styles = [...new Set(perQuestion.map(row => row.style).filter(Boolean))];
  const result = {
    bench: 1,
    profile: flags.profile,
    models: {embedding: redact(embedding), rerank: rerank?.map(redact) ?? null}, // as the plugin would take them, defaults filled
    when: new Date().toISOString(),
    node: process.version,
    semanticGrep: code.commit, changed: code.changed,
    questions: {file: relative(ROOT, questionsPath).startsWith('..') ? 'private' : relative(ROOT, questionsPath), sha1: createHash('sha1').update(JSON.stringify(questions)).digest('hex').slice(0, 12), count: perQuestion.length, split: flags.split ?? 'all'},
    parsers: parsers.length,
    limit: LIMIT,
    overall: summary(perQuestion),
    repos: repoResults,
    styles: Object.fromEntries(styles.map(style => [style, summary(perQuestion.filter(row => row.style === style))])),
    reranked: modes.includes('rerank') ? count(perQuestion.map(row => row.reranked)) : null,
    perQuestion,
  };
  print(result);
  const isPrivate = result.questions.file === 'private';
  // Named by what it ran, and never over an earlier run: profile, day, split, repositories and modes when not all.
  const name = [flags.profile, result.when.slice(0, 10), flags.split, flags.repos && repos.map(repo => basename(repo.name)).join('+'), flags.modes && modes.join('+')].filter(Boolean).join('-');
  let out = flags.out && resolve(flags.out);
  for (let n = 1; !out || (!flags.out && existsSync(out)); n++) out = join(isPrivate ? join(cache, 'results') : join(HERE, 'results'), `${name}${n > 1 ? `-${n}` : ''}.json`);
  mkdirSync(dirname(out), {recursive: true});
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  log(`saved ${out}`);
  if (before) compare(result, before);
} finally {
  await meaning?.close();
  await served.stop();
}

/** One search of `mode`, as the plugin asks it. */
function ask(mode, root, query) {
  if (mode === 'words') return meaning.words(root, query, {limit: LIMIT});
  if (mode === 'meaning') return meaning.meaningOnly(root, query, {limit: LIMIT});
  return meaning.search(root, query, {limit: LIMIT, book: false, rerank: mode === 'rerank'});
}

/** The 1-based rank of the first result that answers `question`, or 0. */
function rankOf(results, question) {
  const answers = [question, ...(question.also ?? [])];
  const at = results.findIndex(result => answers.some(answer => result.file === answer.file && result.from <= answer.to && answer.from <= result.to));
  return at + 1;
}

function percentile(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null; }
function round(value) { return Math.round(value * 1000) / 1000; }

/** Recall@1/5/10, MRR and the p50/p95 milliseconds of each mode over `rows`. */
function summary(rows) {
  const out = {};
  for (const mode of modes) {
    const ranks = rows.map(row => row.rank[mode]);
    const ms = rows.map(row => row.ms[mode]).sort((a, b) => a - b);
    const recall = k => round(ranks.filter(rank => rank && rank <= k).length / ranks.length);
    out[mode] = {n: ranks.length, recall1: recall(1), recall5: recall(5), recall10: recall(10), mrr: round(ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length), p50: percentile(ms, 0.5), p95: percentile(ms, 0.95)};
  }
  return out;
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
  process.stdout.write(`${lines.join('\n')}\n`);
}
