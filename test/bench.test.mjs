// The retrieval benchmark end to end on a small project: its four ways of asking scored and timed, saved as JSON and
// compared with an earlier run; and the picks the plugin learned exported as a private questions file it runs on.
// Fakes stand in for the embedding model and the decision model; the questions file checked in is checked too.
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {settled} from '../bench/common.mjs';
import {Meaning} from '../src/meaning.mjs';
import {fakeEmbeddingServer} from './fake-embedder.mjs';
import {fakeRerankServer} from './fake-reranker.mjs';
import {scratch, until} from './helpers.mjs';

const BENCH = fileURLToPath(new URL('../bench/', import.meta.url));

function project() {
  const root = realpathSync(scratch('bench-project-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'deliver.js'), 'export function deliver(job) {\n  let tries = 0\n  while (tries < 5) {\n    tries += 1\n    if (send(job)) return true\n    sleep(backoff(tries))\n  }\n}\n');
  writeFileSync(join(root, 'src', 'cart.js'), '// The basket\'s sum.\nexport function total(cart) {\n  return cart.items.reduce((sum, item) => sum + item.cents * item.quantity, 0)\n}\n');
  writeFileSync(join(root, 'src', 'tip.js'), '// A tip on the price, for the waiter.\nexport function tip(cents) {\n  return Math.round(cents * 0.15)\n}\n');
  execFileSync('git', ['init', '-q'], {cwd: root});
  return root;
}

const node = (script, args) => new Promise((resolve, reject) => {
  execFile(process.execPath, [join(BENCH, script), ...args], {timeout: 60_000}, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve({stdout, stderr})));
});

test('the bench: words, meaning, fused and reranked, each scored by recall, MRR and latency, saved and compared', async () => {
  const embeddings = await fakeEmbeddingServer();
  const decisions = await fakeRerankServer({favourite: 'waiter'});
  const root = project();
  const dir = scratch('bench-run-');
  try {
    const profiles = join(dir, 'profiles.json');
    writeFileSync(profiles, JSON.stringify({fake: {
      embedding: {api: 'openai', baseUrl: embeddings.baseUrl, model: 'embeddinggemma-fake', dimensions: 256},
      rerank: {api: 'system-one', baseUrl: decisions.baseUrl, model: 'fake-d1', top: 3},
    }}));
    const questions = join(dir, 'questions.jsonl');
    writeFileSync(questions, [
      {id: 'q1', repo: root, query: 'try again after a failure', file: 'src/deliver.js', from: 1, to: 8, style: 'vague'},
      {id: 'q2', repo: root, query: 'the cents of the basket', file: 'src/cart.js', from: 2, to: 4, style: 'plain'},
      {id: 'q3', repo: root, query: 'what goes to the waiter', file: 'src/tip.js', from: 1, to: 4, style: 'plain', also: [{file: 'src/nothing.js', from: 1, to: 1}]},
    ].map(question => JSON.stringify(question)).join('\n'));
    const out = join(dir, 'run.json');
    const args = ['--profile', 'fake', '--profiles', profiles, '--questions', questions, '--cache', join(dir, 'cache'), '--parsers', 'none'];
    const {stdout} = await node('run.mjs', [...args, '--out', out]);
    const run = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(Object.keys(run.overall), ['words', 'meaning', 'fused', 'rerank']);
    assert.equal(run.questions.file, 'private', 'a questions file outside the repository is not named');
    assert.equal(run.repos[root].pieces, 3);
    const ranks = Object.fromEntries(run.perQuestion.map(row => [row.id, row.rank]));
    assert.deepEqual(ranks.q1, {words: 0, meaning: 1, fused: 1, rerank: 1}, 'its words are not in the code; their meaning is');
    assert.equal(ranks.q2.words, 1);
    assert.equal(ranks.q3.rerank, 1, 'the decision model puts the waiter first');
    assert.equal(run.overall.words.recall1, 0.333, 'one question has all its words in its piece');
    assert.equal(run.overall.meaning.n, 3);
    assert.ok(run.overall.fused.p50 > 0 && run.overall.fused.p95 >= run.overall.fused.p50);
    assert.deepEqual(Object.keys(run.styles), ['vague', 'plain']);
    assert.match(stdout, /all \(3\)\s+words\s+0\.333/);
    assert.equal(JSON.stringify(run).includes(embeddings.baseUrl.replace('/v1', '')), true, 'the models are recorded');

    const again = await node('run.mjs', [...args, '--modes', 'words', '--out', join(dir, 'again.json'), '--compare', out]);
    assert.match(again.stdout, /against fake of .* the same\):\n.*words\s+0\s+0\s+0\s+0/);
  } finally {
    await embeddings.stop();
    await decisions.close();
  }
});

test('picks exported: the searches made in a project and the piece opened, a private questions file the bench runs', async () => {
  const root = project();
  const dataDir = scratch('bench-data-');
  const meaning = new Meaning({dataDir});
  try {
    await settled(meaning, root);
    const answer = await meaning.search(root, 'basket sum', {book: false});
    assert.equal(answer.results[0]?.file, 'src/cart.js');
    meaning.booked(root, 'what the basket costs', answer.results.slice(0, 1), ' in the picker');
    await until(() => meaning.indexes.get(root).store.extras().length === 1, 'the pick kept');
  } finally {
    await meaning.close();
  }
  const out = join(scratch('bench-private-'), 'picks.jsonl');
  const {stderr} = await node('export-picks.mjs', ['--root', root, '--data-dir', dataDir, '--out', out]);
  assert.match(stderr, /1 searches with the piece opened/);
  const [question] = readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(question, {id: 'pick-0001', repo: root, query: 'what the basket costs', file: 'src/cart.js', from: 1, to: 4, style: 'pick', split: 'private'});
  await assert.rejects(node('export-picks.mjs', ['--root', root, '--data-dir', dataDir, '--out', join(root, 'picks.jsonl')]), /inside the project/);
  assert.ok(!existsSync(join(root, 'picks.jsonl')));

  const result = join(scratch('bench-private-run-'), 'run.json');
  await node('run.mjs', ['--profile', 'words', '--questions', out, '--cache', scratch('bench-cache-'), '--parsers', 'none', '--out', result]);
  assert.equal(JSON.parse(readFileSync(result, 'utf8')).perQuestion[0].rank.words, 0, 'its words are not all in the piece: words alone miss it');
});

test('the questions file: each question in a pinned repository, labelled with lines, with a style and a split', () => {
  const corpus = JSON.parse(readFileSync(join(BENCH, 'corpus.json'), 'utf8')).repos.map(repo => repo.name);
  const questions = readFileSync(join(BENCH, 'questions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(questions.length >= 300 && questions.length <= 500, `${questions.length} questions`);
  assert.equal(new Set(questions.map(question => question.id)).size, questions.length, 'ids are unique');
  for (const question of questions) {
    assert.ok(corpus.includes(question.repo), question.id);
    assert.ok(question.query.trim() && Number.isInteger(question.from) && question.from <= question.to && question.to - question.from < 80, question.id);
    assert.ok(['vague', 'plain', 'multi-hop'].includes(question.style) && ['dev', 'test'].includes(question.split), question.id);
  }
  assert.deepEqual(new Set(questions.map(question => question.repo)), new Set(corpus), 'every repository is asked about');
});
