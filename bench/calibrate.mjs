#!/usr/bin/env node
// A model's own thresholds (see src/embedder.mjs, tuningOf), measured on the bench's questions:
//
//   npm run bench:calibrate -- --profile NAME --run FILE [--profiles FILE] [--questions FILE] [--models DIR] [--llama-server PATH]
//
// - band: how far below the best piece the first right one means, as a search by meaning finds it. FILE is a run of the
//   profile with a band wide enough to leave nothing out (`"band": 2` in its embedding entry): the band is the 95th
//   percentile of that gap over the questions it answered within its 30 results.
// - pickNear: how close in meaning two searches must be for a piece opened for one to go first for the other. The
//   questions are embedded (the profile's model, started as the bench starts it): rewordings (questions about the same
//   lines) against unrelated questions (of the same repository, other files). pickNear is the 99.9th percentile of the
//   unrelated: a project keeps up to thousands of searches, and each one a new search comes near puts its piece first,
//   so a wrong match must be rare indeed (the very top of the unrelated are mostly not unrelated: a page of the docs
//   and the code it is about). The share of rewordings it lets through is said: these are other searches for the same
//   lines, further apart than the same search typed again.
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {options} from './common.mjs';
import {serveProfile} from './serve.mjs';
import {embeddingConfig} from '../src/config.mjs';
import {HttpEmbedder, tuningOf} from '../src/embedder.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const {flags} = options(process.argv.slice(2));
const log = line => process.stderr.write(`${line}\n`);
if (!flags.profile || !flags.run) {
  log('usage: npm run bench:calibrate -- --profile NAME --run FILE [--profiles FILE] [--questions FILE] [--models DIR] [--llama-server PATH]');
  process.exit(2);
}

const percentile = (values, p) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};
const up = (value, step = 0.01) => Math.ceil(value / step - 1e-9) * step;
const fixed = value => Number(value.toFixed(2));

const profiles = JSON.parse(readFileSync(resolve(flags.profiles ?? join(HERE, 'profiles.json')), 'utf8'));
const profile = profiles[flags.profile];
if (!profile?.embedding) throw new Error(`no profile "${flags.profile}" with an embedding model`);
const embedding = embeddingConfig(profile.embedding);

// The band, from the run.
const run = JSON.parse(readFileSync(resolve(flags.run), 'utf8'));
if (run.models?.embedding?.model !== embedding.model) throw new Error(`${flags.run} is a run of ${run.models?.embedding?.model}, not ${embedding.model}`);
const gaps = run.perQuestion.filter(row => row.similarity?.answer !== null && row.similarity?.answer !== undefined).map(row => row.similarity.best - row.similarity.answer);
const widest = run.models.embedding.band ?? tuningOf(run.models.embedding).band;
if (!gaps.length) throw new Error(`${flags.run} has no similarities: a run of meaning made by this bench`);
const band = fixed(up(percentile(gaps, 0.95)));
if (band >= widest) log(`warning: the run's own band (${widest}) may have cut its list short; run it with "band": 2`);

// pickNear, from the questions' own vectors.
const questions = readFileSync(resolve(flags.questions ?? join(HERE, 'questions.jsonl')), 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
const served = await serveProfile({embedding: profile.embedding, serve: profile.serve && {env: profile.serve.env, embedding: profile.serve.embedding}}, {models: flags.models ?? process.env.SEMANTIC_GREP_BENCH_MODELS, llamaServer: flags['llama-server'] ?? process.env.LLAMA_SERVER ?? 'llama-server', log});
let vectors;
try {
  const embedder = new HttpEmbedder({entry: embedding});
  vectors = await embedder.embed(questions.map(question => embedder.query(question.query)));
} finally {
  await served.stop();
}
const same = (a, b) => a.repo === b.repo && a.file === b.file && a.from <= b.to && b.from <= a.to;
const rewordings = [];
const unrelated = [];
for (let i = 0; i < questions.length; i++) {
  for (let j = i + 1; j < questions.length; j++) {
    const [a, b] = [questions[i], questions[j]];
    if (a.repo !== b.repo) continue;
    let sum = 0;
    for (let k = 0; k < vectors[i].length; k++) sum += vectors[i][k] * vectors[j][k];
    if (same(a, b)) rewordings.push(sum);
    else if (a.file !== b.file) unrelated.push(sum);
  }
}
const pickNear = fixed(up(percentile(unrelated, 0.999)));
const through = rewordings.filter(value => value >= pickNear).length / rewordings.length;

const result = {
  model: embedding.model,
  band, gaps: {n: gaps.length, p50: fixed(percentile(gaps, 0.5)), p90: fixed(percentile(gaps, 0.9)), p95: fixed(percentile(gaps, 0.95))},
  pickNear,
  rewordings: {n: rewordings.length, p10: fixed(percentile(rewordings, 0.1)), p50: fixed(percentile(rewordings, 0.5)), through: fixed(through)},
  unrelated: {n: unrelated.length, p50: fixed(percentile(unrelated, 0.5)), p95: fixed(percentile(unrelated, 0.95)), p99: fixed(percentile(unrelated, 0.99)), p999: fixed(percentile(unrelated, 0.999)), max: fixed(Math.max(...unrelated))},
};
process.stdout.write(`${JSON.stringify(result)}\n`);
log(`${embedding.model}: band ${band} (the right piece within it for 95% of the questions found), pickNear ${pickNear} (${Math.round(through * 100)}% of rewordings reach it, 0.1% of unrelated searches)`);
