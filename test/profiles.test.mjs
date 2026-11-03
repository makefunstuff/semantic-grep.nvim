// The model profiles setup() fills its models from, and each model's own thresholds: its band of meaning and how near
// a kept search must be. The bench's profiles of the same names hold the same models.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {HttpEmbedder, TUNING, tuningOf} from '../src/embedder.mjs';
import {embeddingConfig} from '../src/config.mjs';
import {Meaning} from '../src/meaning.mjs';
import {PROFILES, profileConfig} from '../src/profiles.mjs';
import {fakeEmbeddingServer} from './fake-embedder.mjs';
import {scratch, until} from './helpers.mjs';

test('a profile fills the models; the config\'s own fields go over it, another model drops the profile\'s settings for its own, false turns one off', () => {
  assert.deepEqual(profileConfig({}), {embedding: null, rerank: null});
  const beefy = profileConfig({profile: 'beefy'});
  assert.equal(beefy.embedding.model, PROFILES.beefy.embedding.model);
  assert.equal(beefy.rerank[0].model, PROFILES.beefy.rerank.model);
  assert.equal(beefy.rerank[0].api, 'rerank');
  const moved = profileConfig({profile: 'beefy', embedding: {baseUrl: 'http://127.0.0.1:9000/v1'}, rerank: {timeoutMs: 5000}});
  assert.deepEqual([moved.embedding.baseUrl, moved.embedding.model], ['http://127.0.0.1:9000/v1', PROFILES.beefy.embedding.model]);
  assert.deepEqual([moved.rerank[0].timeoutMs, moved.rerank[0].model], [5000, PROFILES.beefy.rerank.model]);
  const other = profileConfig({profile: 'cloud', embedding: {model: 'voyage-3-large'}});
  assert.equal(other.embedding.queryPrefix, undefined, 'voyage-code-3\'s prompts are not another model\'s');
  assert.equal(other.embedding.apiKeyEnv, 'VOYAGE_API_KEY', 'where and with what key stay');
  assert.equal(profileConfig({profile: 'beefy', rerank: false}).rerank, null);
  const list = profileConfig({profile: 'beefy', rerank: [{api: 'system-one', baseUrl: 'http://h/v1', model: 'd1-2B'}]});
  assert.deepEqual(list.rerank.map(entry => entry.model), ['d1-2B'], 'a list is the config\'s own');
  assert.throws(() => profileConfig({profile: 'huge'}), /profile must be one of "laptop", "beefy", "cloud"/);
  assert.throws(() => profileConfig({profile: 'laptop', embedding: {band: 0}}), /embedding\.band must be a number above 0/);
});

test('each profile is a valid config, its cloud keys named by environment variable, and the bench\'s profile of its name measures the same models', () => {
  const bench = JSON.parse(readFileSync(new URL('../bench/profiles.json', import.meta.url), 'utf8'));
  for (const name of Object.keys(PROFILES)) {
    const {embedding, rerank} = profileConfig({profile: name});
    assert.ok(embedding, `${name} searches by meaning`);
    for (const entry of [embedding, ...(rerank ?? [])]) {
      assert.equal(entry.apiKey, undefined);
      if (/^https:/.test(entry.baseUrl)) assert.match(entry.apiKeyEnv, /^[A-Z_]+_API_KEY$/);
      else assert.match(entry.baseUrl, /^http:\/\/127\.0\.0\.1:1812[01]\/v1$/);
    }
    const measured = bench[name];
    assert.equal(measured.embedding.model, embedding.model, `${name}: the bench measures its embedding model`);
    for (const field of ['dimensions', 'queryPrefix', 'documentPrefix', 'band', 'pickNear']) assert.equal(measured.embedding[field], embedding[field], `${name}.embedding.${field}`);
    assert.equal(measured.rerank?.model ?? null, rerank?.[0].model ?? null, `${name}: the bench measures its reranker`);
    for (const field of ['api', 'top', 'chars']) assert.equal(measured.rerank?.[field], PROFILES[name].rerank?.[field], `${name}.rerank.${field}`);
  }
});

test('a model\'s band and pickNear: the config\'s, else the model\'s measured ones, else the defaults', () => {
  assert.deepEqual(tuningOf({model: 'some-new-model'}), TUNING);
  assert.deepEqual(tuningOf({model: 'some-new-model', band: 0.3, pickNear: 0.9}), {band: 0.3, pickNear: 0.9});
  for (const model of ['embeddinggemma-300M', 'qwen3-embedding-4b']) {
    const {band, pickNear} = tuningOf({model});
    assert.ok(band > 0 && band < 1 && pickNear > 0 && pickNear < 1, model);
  }
  assert.equal(new HttpEmbedder({entry: embeddingConfig({baseUrl: 'http://h/v1', model: 'm', band: 0.05})}).tuning.band, 0.05);
});

test('the band is the model\'s: a wide one lists every piece by meaning, a narrow one only those close to the best', async () => {
  const server = await fakeEmbeddingServer();
  const root = realpathSync(scratch('profiles-project-'));
  writeFileSync(join(root, 'deliver.js'), 'export function deliver(job) {\n  retry(job, {attempts: 5, backoff: 2})\n}\n');
  writeFileSync(join(root, 'cart.js'), 'export function total(cart) {\n  return cart.items.reduce((sum, item) => sum + item.cents, 0)\n}\n');
  writeFileSync(join(root, 'voice.js'), 'export function speak(text) {\n  return say(text, {voice: "quiet"})\n}\n');
  execFileSync('git', ['init', '-q'], {cwd: root});
  const listed = async band => {
    const meaning = new Meaning({dataDir: scratch('profiles-data-'), embedding: {api: 'openai', baseUrl: server.baseUrl, model: 'm', band}});
    try {
      meaning.open(root);
      await until(async () => (await meaning.meaningOnly(root, 'retry')).results.length > 0, 'meaning');
      return (await meaning.meaningOnly(root, 'try again with backoff')).results.map(result => result.file);
    } finally {
      await meaning.close();
    }
  };
  try {
    assert.deepEqual((await listed(2)).toSorted(), ['cart.js', 'deliver.js', 'voice.js']);
    assert.deepEqual(await listed(0.01), ['deliver.js']);
  } finally {
    await server.stop();
  }
});
