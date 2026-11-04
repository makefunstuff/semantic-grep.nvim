#!/usr/bin/env node
// The fusion's settings, tuned on the bench: each question's lists (meaning's every piece by similarity, the pieces
// with every word, the pieces with any word) are made once with a profile's embedding model, then every setting of a
// grid is scored on them without the model: reciprocal rank fusion's k and the weight of the words, how many of each
// list are fused, meaning's band, the files view's depth, k and decay, and what a search learned does (a piece opened
// for a search worded close to a new one: its threshold, and first or fused). Prints the best of each on the split
// tuned on (`--split dev` by default) and the same settings on the other, so a gain can be told from noise.
//
//   npm run bench:tune -- --profile laptop [--profiles FILE] [--repos a,b] [--split dev] [--cache DIR] [--models DIR]
//                         [--llama-server PATH] [--parsers none] [--weigh vague=2,plain=1.5] [--out FILE]
//
// The index and vectors are the bench's (bench/run.mjs builds them; this builds what is missing the same way).
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cacheDir, neovimParsers, options, settled} from './common.mjs';
import {serveProfile} from './serve.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LIMIT = 30; // as the bench: past this a question counts as not found
const DEPTH = 300; // of each list, how much is kept to fuse from
const {flags} = options(process.argv.slice(2));
const log = line => process.stderr.write(`${line}\n`);
if (!flags.profile) {
  log('usage: npm run bench:tune -- --profile NAME [--profiles FILE] [--repos a,b] [--split dev] [--cache DIR] [--models DIR] [--llama-server PATH] [--out FILE]');
  process.exit(2);
}
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && /SQLite/.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(this, warning, ...rest);
};
const {Meaning, fuse, filesOf} = await import('../src/meaning.mjs');
const {embeddingConfig} = await import('../src/config.mjs');

const profile = JSON.parse(readFileSync(resolve(flags.profiles ?? join(HERE, 'profiles.json')), 'utf8'))[flags.profile];
if (!profile?.embedding) throw new Error(`profile "${flags.profile}" has no embedding model to tune`);
const embedding = embeddingConfig(profile.embedding);
const tuneOn = flags.split ?? 'dev';
const cache = cacheDir(flags.cache);
const wanted = flags.repos ? new Set(String(flags.repos).split(',')) : null;
const questions = readFileSync(resolve(flags.questions ?? join(HERE, 'questions.jsonl')), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  .filter(question => !wanted || wanted.has(question.repo));

const served = await serveProfile({...profile, rerank: undefined, serve: profile.serve && {...profile.serve, rerank: undefined}}, {models: flags.models ?? process.env.SEMANTIC_GREP_BENCH_MODELS, llamaServer: flags['llama-server'] ?? process.env.LLAMA_SERVER ?? 'llama-server', log});
const dataDir = join(cache, 'data', `${`${embedding.model}${embedding.dimensions ? `-${embedding.dimensions}` : ''}`.replace(/[^\w.-]+/g, '_')}${flags.parsers === 'none' ? '-indent' : ''}`);
const meaning = new Meaning({dataDir, embedding, log});
meaning.useParsers(flags.parsers === 'none' ? [] : neovimParsers());
const rows = []; // a question with its lists
try {
  for (const repo of [...new Set(questions.map(question => question.repo))]) {
    const root = join(cache, 'repos', repo);
    if (!existsSync(root)) throw new Error(`${root} is missing: npm run bench:fetch`);
    const index = await settled(meaning, root, ({chunks, embedded}) => log(`${repo}: ${embedded} of ${chunks} pieces embedded`));
    const asked = questions.filter(question => question.repo === repo);
    const vectors = await index.embed(asked.map(question => index.embedder.query(question.query)), {urgent: true});
    const {pieces, size, data, notes} = index.matrixOf();
    const byPiece = new Map(pieces.map((piece, i) => [piece, i]));
    asked.forEach((question, n) => {
      const q = vectors[n];
      const scores = new Float32Array(pieces.length);
      for (let i = 0; i < pieces.length; i++) {
        let sum = 0;
        for (let j = 0, at = i * size; j < size; j++) sum += q[j] * data[at + j];
        scores[i] = sum;
      }
      for (const [i, vector] of notes) {
        let sum = 0;
        for (let j = 0; j < size; j++) sum += q[j] * vector[j];
        if (sum > scores[i]) scores[i] = sum;
      }
      const order = [...scores.keys()].sort((a, b) => scores[b] - scores[a]).slice(0, DEPTH);
      const answers = [question, ...(question.also ?? [])];
      const right = piece => answers.some(answer => piece.file === answer.file && piece.from <= answer.to && answer.from <= piece.to);
      const files = new Set(answers.map(answer => answer.file));
      // The piece someone would have opened for it: the first that answers it.
      const target = (index.byFile.get(question.file) ?? []).find(piece => piece.from <= question.to && question.from <= piece.to) ?? null;
      rows.push({
        question, repo, q, target, right, files,
        meaning: order.map(i => [pieces[i], scores[i]]),
        every: index.wordRanking(question.query, DEPTH),
        any: index.wordRanking(question.query, DEPTH, {any: true}),
        pieceIndex: byPiece,
      });
    });
    log(`${repo}: ${asked.length} questions`);
  }
} finally {
  await meaning.close();
  await served.stop();
}

const band0 = meaning.embedder.tuning.band;
const pickNear0 = meaning.embedder.tuning.pickNear;

/** Weighted reciprocal rank fusion: each list `[keys, weight]`. */
function weighted(lists, k) {
  const scores = new Map();
  for (const [list, weight] of lists) list.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + weight / (k + rank + 1)));
  return [...scores].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

const meaningList = (row, band, depth) => {
  const best = row.meaning[0]?.[1] ?? 0;
  return row.meaning.filter(([, score]) => score >= best - band).slice(0, depth).map(([piece]) => piece);
};

/** The pieces' list a setting makes for `row`: picks (searches kept, see below) first or fused, then the fusion. */
function piecesFor(row, s, picked = []) {
  let meaningPart = meaningList(row, s.band, s.list);
  if (picked.length && s.pick === 'meaning') meaningPart = [...new Set([...picked, ...meaningPart])].slice(0, s.list); // as before: first in meaning's list
  const words = row.every.slice(0, s.list);
  const lists = [[meaningPart, 1], [words, s.words]];
  if (picked.length && s.pick === 'fused') lists.push([picked, s.pickWeight]);
  const fused = weighted(lists, s.k);
  if (picked.length && s.pick === 'first') return [...new Set([...picked, ...fused])];
  return fused;
}

function filesFor(row, s) {
  const meaningPart = meaningList(row, s.band, s.depth); // as the plugin: each list as deep as the files view reads
  const words = (s.anyWords ? row.any : row.every).slice(0, s.depth);
  const ranked = weighted([[meaningPart, 1], [words, s.words]], s.k).slice(0, s.depth);
  return filesOf(ranked.map(piece => ({file: piece.file})), {k: s.fileK, decay: s.decay}).map(file => file.file);
}

const reciprocal = (list, ok) => { const at = list.slice(0, LIMIT).findIndex(ok); return at < 0 ? 0 : 1 / (at + 1); };
const mean = values => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const split = name => rows.filter(row => row.question.split === name);
const tuned = split(tuneOn);
const other = rows.filter(row => row.question.split !== tuneOn);
const styles = ['vague', 'plain', 'multi-hop'];

// What a style of question weighs in the score (--weigh vague=2,plain=1.5): those the searches you make most look like.
const weigh = Object.fromEntries(String(flags.weigh ?? '').split(',').filter(Boolean).map(pair => pair.split('=')).map(([style, value]) => [style, Number(value)]));
const weighted_ = (set, value) => {
  let sum = 0, total = 0;
  for (const row of set) { const w = weigh[row.question.style] ?? 1; sum += w * value(row); total += w; }
  return total ? sum / total : 0;
};
function scorePieces(set, s, picks = null) {
  return weighted_(set, row => reciprocal(piecesFor(row, s, picks ? picks(row, s) : []), piece => row.right(piece)));
}
function scoreFiles(set, s) { return weighted_(set, row => reciprocal(filesFor(row, s), file => row.files.has(file))); }
const byStyle = (score, set, s) => Object.fromEntries(styles.map(style => [style, round(score(set.filter(row => row.question.style === style), s))]));
const round = value => Math.round(value * 1000) / 1000;

// The settings now: the model's (src/embedder.mjs, TUNING and its own `fusion` and `files`); the files view's meaning
// without a band.
const {fusion, files} = meaning.embedder.tuning;
const PIECES_NOW = {k: fusion.k, list: fusion.list, band: band0, words: fusion.words};
const FILES_NOW = {k: files.k, band: 2, words: files.words, depth: files.depth, fileK: files.rank, decay: files.decay, anyWords: files.any};

function sweep(name, now, grid, score) {
  const keys = Object.keys(grid);
  const settings = [{}];
  for (const key of keys) settings.splice(0, settings.length, ...settings.flatMap(s => grid[key].map(value => ({...s, [key]: value}))));
  const scored = settings.map(s => ({...now, ...s})).map(s => ({s, tuned: score(tuned, s)})).sort((a, b) => b.tuned - a.tuned);
  const best = scored[0];
  const result = {
    now: {settings: now, [tuneOn]: round(score(tuned, now)), other: round(score(other, now)), styles: byStyle(score, rows, now)},
    best: {settings: best.s, [tuneOn]: round(best.tuned), other: round(score(other, best.s)), styles: byStyle(score, rows, best.s)},
    top: scored.slice(0, 8).map(({s, tuned: value}) => ({settings: Object.fromEntries(keys.map(key => [key, s[key]])), [tuneOn]: round(value), other: round(score(other, s))})),
  };
  log(`\n${name}: now ${result.now[tuneOn]} on ${tuneOn} (${result.now.other} on the rest); best ${result.best[tuneOn]} (${result.best.other}) with ${JSON.stringify(Object.fromEntries(keys.map(key => [key, best.s[key]])))}`);
  for (const each of result.top) log(`  ${each[tuneOn].toFixed(3)} ${each.other.toFixed(3)}  ${JSON.stringify(each.settings)}`);
  return result;
}

const out = {profile: flags.profile, model: embedding.model, tunedOn: tuneOn, weigh, questions: {[tuneOn]: tuned.length, other: other.length}, band: band0, pickNear: pickNear0};
out.pieces = sweep('pieces (fused)', PIECES_NOW, {k: [5, 10, 20, 30, 60, 100], list: [20, 30, 50, 100], band: [band0, 0.1, 0.15, 2], words: [0.5, 0.75, 1, 1.5]}, scorePieces);
out.files = sweep('files (fused)', FILES_NOW, {k: [10, 30, 60, 100], words: [0.5, 1, 1.5], depth: [30, 60, 100], fileK: [2, 5, 10], decay: [0.3, 0.5, 0.7], anyWords: [false, true]}, scoreFiles);

// What a search learned. Every other question of the repository is a search kept with the piece that answers it
// opened (its rewordings among them, as a person's history of searches would have them); a kept search whose words
// mean at least `near` close to the question's has its piece fused as a list of its own (as now), put first in
// meaning's list (as before: then fused with the words), or first in the list shown. (Its words, which also find it, are not simulated.)
const PICKED_PER_SEARCH = 3;
function picksOf(row, s) {
  const best = new Map();
  for (const kept of rows) {
    if (kept === row || kept.repo !== row.repo || !kept.target) continue;
    let sum = 0;
    for (let j = 0; j < row.q.length; j++) sum += row.q[j] * kept.q[j];
    if (sum >= s.near && sum > (best.get(kept.target) ?? -Infinity)) best.set(kept.target, sum);
  }
  return [...best].sort((a, b) => b[1] - a[1]).slice(0, PICKED_PER_SEARCH).map(([piece]) => piece);
}
const piecesBest = {...PIECES_NOW, ...out.pieces.best.settings};
const withPicks = (set, s) => scorePieces(set, s, picksOf);
const noPicks = round(scorePieces(tuned, piecesBest));
out.picks = sweep(`learned picks (no picks: ${noPicks})`, {...piecesBest, pick: 'fused', near: pickNear0, pickWeight: 1}, {pick: ['meaning', 'first', 'fused'], near: [pickNear0 - 0.1, pickNear0 - 0.05, pickNear0, pickNear0 + 0.05], pickWeight: [1, 2, 4]}, withPicks);
out.picks.none = {[tuneOn]: noPicks, other: round(scorePieces(other, piecesBest))};
// How often a kept search's piece goes first and does not answer the question: what a kept search costs another.
const wrongFirst = s => round(mean(rows.map(row => {
  const picked = picksOf(row, s);
  const first = piecesFor(row, s, picked)[0];
  return first && picked.includes(first) && !row.right(first) ? 1 : 0;
})));
out.picks.wrongFirst = {now: wrongFirst({...piecesBest, pick: 'fused', near: pickNear0, pickWeight: 1}), best: wrongFirst({...piecesBest, ...out.picks.best.settings})};
log(`  a wrong piece first because of a pick: ${out.picks.wrongFirst.now} now, ${out.picks.wrongFirst.best} with the best`);
// Each way at each threshold: what it gains, against how often it puts a wrong piece first.
out.picks.table = [];
for (const pick of ['meaning', 'first', 'fused']) {
  for (const near of [pickNear0 - 0.1, pickNear0 - 0.05, pickNear0, pickNear0 + 0.05]) {
    const s = {...piecesBest, pick, near, pickWeight: 1};
    const row = {pick, near: round(near), [tuneOn]: round(withPicks(tuned, s)), other: round(withPicks(other, s)), wrongFirst: wrongFirst(s)};
    out.picks.table.push(row);
    log(`  ${pick.padEnd(8)} near ${row.near.toFixed(2)}: ${row[tuneOn].toFixed(3)} ${row.other.toFixed(3)}, a wrong piece first ${row.wrongFirst}`);
  }
}
if (flags.out) writeFileSync(resolve(flags.out), `${JSON.stringify(out, null, 1)}\n`);
