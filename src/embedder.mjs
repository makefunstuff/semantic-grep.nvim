// The embedding model: an OpenAI-compatible `/v1/embeddings` (llama.cpp's `llama-server --embeddings`, Ollama,
// LM Studio, vLLM, a cloud API). Each text becomes a vector of unit length, so similarity is a dot product. One request
// at a time; a search goes before the index's batches waiting, so it waits for one batch at most.
import {apiKeyOf} from './config.mjs';
import {PIECE} from './pieces.mjs';

// The prompts EmbeddingGemma was trained with: a piece of the project (titled by its file, or none), and a search.
export const documentText = (title, text) => `title: ${title || 'none'} | text: ${text}`;
/** A piece's title: its file and what names it (its definition, or what encloses it): "src/users.ts: _users: anna". */
export const pieceTitle = (file, name) => [file, name].filter(Boolean).join(': ');
export const queryText = query => `task: search result | query: ${query}`;

// What some embedding models want, by their name: the prompts they were trained with (a search, and a piece of code;
// `{title}` is the piece's, see pieceTitle; a model whose prompt has no place for one reads it as the first line of the
// piece), and how their similarities spread (see TUNING), each measured on the bench (bench/calibrate.mjs).
const GEMMA = {query: 'task: search result | query: ', document: 'title: {title} | text: '};
const JINA_CODE = {query: 'Find the most relevant code snippet given the following query:\n', document: 'Candidate code snippet:\n'};
const QWEN3 = {query: 'Instruct: Given a question, find the code that answers it\nQuery: ', document: ''};
const MODELS = [
  [/nomic-embed-code/i, {query: 'Represent this query for searching relevant code: ', document: ''}],
  [/nomic-embed-text/i, {query: 'search_query: ', document: 'search_document: '}],
  [/embedding-?gemma-?2(?!\d)/i, {...GEMMA, band: 0.06, pickNear: 0.85}],
  [/embedding-?gemma/i, {...GEMMA, band: 0.12, pickNear: 0.71}],
  [/qwen3-embedding-0\.6b/i, {...QWEN3, band: 0.14, pickNear: 0.79}],
  [/qwen3-embedding-4b/i, {...QWEN3, band: 0.12, pickNear: 0.78}],
  [/qwen3-embedding/i, {...QWEN3, band: 0.12, pickNear: 0.79}], // 8B
  [/jina-code-embeddings-1\.5b/i, {...JINA_CODE, band: 0.15, pickNear: 0.71}],
  [/jina-code-embeddings/i, {...JINA_CODE, band: 0.16, pickNear: 0.74}], // 0.5b
  [/jina-embeddings-v2-base-code/i, {band: 0.15, pickNear: 0.79}],
  [/snowflake-arctic-embed-l-v2/i, {query: 'query: ', document: '', band: 0.15, pickNear: 0.66}],
];
// A model's similarities, unknown models' first: `band`, how far below the best a piece may mean and still be listed
// (unrelated code scores close, too); `pickNear`, how close a kept search's words must mean to a new one's for the
// piece opened for it to go first (rewordings of one question against unrelated ones).
export const TUNING = {band: 0.1, pickNear: 0.75};
const HTTP_BATCH = 16;
const HTTP_MS = 60_000;

const knownOf = model => MODELS.find(([pattern]) => pattern.test(model ?? ''))?.[1] ?? {};

/** The prompts for `entry.model`: the config's, else those it was trained with, else none. */
export function promptsOf(entry) {
  const known = knownOf(entry.model);
  return {query: entry.queryPrefix ?? known.query ?? '', document: entry.documentPrefix ?? known.document ?? ''};
}

/** `{band, pickNear}` for `entry.model`: the config's, else the model's measured ones, else TUNING's. */
export function tuningOf(entry) {
  const known = knownOf(entry.model);
  return {band: entry.band ?? known.band ?? TUNING.band, pickNear: entry.pickNear ?? known.pickNear ?? TUNING.pickNear};
}

/** `vector` at unit length. */
const unit = vector => {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  return Float32Array.from(vector, value => value / norm);
};

/**
 * The config's `embedding` entry, `{baseUrl, model, dimensions?, queryPrefix?, documentPrefix?, band?, pickNear?,
 * ...key}`, as an embedder: `id` names its vectors in the index, `query(text)` and `document(file, text, name)` add the
 * model's prompts, `embed(texts, {urgent})` resolves their vectors, `tuning` is its band and pickNear (tuningOf).
 */
export class HttpEmbedder {
  constructor({entry, apiKey = () => apiKeyOf(entry), fetch = globalThis.fetch, log = () => {}, batch = HTTP_BATCH, timeoutMs = entry.timeoutMs ?? HTTP_MS}) {
    Object.assign(this, {entry, apiKey, fetch, log, batch, timeoutMs});
    this.prompts = promptsOf(entry);
    this.tuning = tuningOf(entry);
    this.queue = [];
    this.running = false;
    this.embedded = 0;
    this.embedMs = 0;
  }

  get id() { return `${this.entry.model}${this.entry.dimensions ? `/${this.entry.dimensions}` : ''}`; }

  get name() { return `${this.entry.model} at ${this.entry.baseUrl}`; }

  get msPerText() { return this.embedded ? this.embedMs / this.embedded : null; }

  // A piece is at most PIECE.chars, but a single longer line (minified code, a lockfile) is a piece of its own: its
  // head is what the model reads, so a server's batch or the model's context is never overrun. Its title (its file,
  // and the name of its definition or of what encloses it) goes where the model's prompt has room for one, else first.
  document(file, text, name = null) {
    const title = pieceTitle(file, name);
    const prompt = this.prompts.document;
    return prompt.includes('{title}')
      ? `${prompt.replaceAll('{title}', title || 'none')}${text.slice(0, PIECE.chars)}`
      : `${prompt}${title ? `${title}\n` : ''}${text.slice(0, PIECE.chars)}`;
  }

  query(text) { return `${this.prompts.query}${text}`; }

  embed(texts, {urgent = false} = {}) {
    if (!texts.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const batch = {texts, resolve, reject};
      if (urgent) this.queue.unshift(batch);
      else this.queue.push(batch);
      this.next();
    });
  }

  async next() {
    if (this.running || !this.queue.length) return;
    this.running = true;
    const batch = this.queue.shift();
    try {
      const vectors = [];
      for (let i = 0; i < batch.texts.length; i += this.batch) vectors.push(...await this.request(batch.texts.slice(i, i + this.batch)));
      batch.resolve(vectors);
    } catch (error) {
      batch.reject(error);
    } finally {
      this.running = false;
      this.next();
    }
  }

  async request(input) {
    const started = Date.now();
    const key = this.apiKey();
    const url = `${this.entry.baseUrl.replace(/\/+$/, '')}/embeddings`;
    let response;
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/json', ...(key ? {authorization: `Bearer ${key}`} : {})},
        body: JSON.stringify({model: this.entry.model, input, ...(this.entry.dimensions ? {dimensions: this.entry.dimensions} : {})}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error.name === 'TimeoutError') throw new Error(`the embedding model at ${this.entry.baseUrl} took longer than ${this.timeoutMs} ms`);
      throw new Error(`the embedding model at ${this.entry.baseUrl} did not answer: ${error.cause?.code ?? error.message}`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`the embedding model at ${this.entry.baseUrl} answered ${response.status}: ${text.slice(0, 200).trim()}`);
    let data;
    try { data = JSON.parse(text).data; } catch {}
    if (!Array.isArray(data) || data.length !== input.length || data.some(item => !Array.isArray(item?.embedding))) {
      throw new Error(`the embedding model at ${this.entry.baseUrl} answered no embeddings for ${input.length} text${input.length === 1 ? '' : 's'}`);
    }
    this.embedded += input.length;
    this.embedMs += Date.now() - started;
    return data.toSorted((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(item => unit(item.embedding));
  }

  /** Every batch waiting fails with `error`; one under way finishes. */
  fail(error) {
    const batches = this.queue;
    this.queue = [];
    for (const batch of batches) batch.reject(error);
  }

  close() { this.fail(new Error('the backend stops')); }
}
