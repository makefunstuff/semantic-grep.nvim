// The embedding model: an OpenAI-compatible `/v1/embeddings` (llama.cpp's `llama-server --embeddings`, Ollama,
// LM Studio, vLLM, a cloud API). Each text becomes a vector of unit length, so similarity is a dot product. One request
// at a time; a search goes before the index's batches waiting, so it waits for one batch at most.
import {apiKeyOf} from './config.mjs';

// The prompts EmbeddingGemma was trained with: a piece of the project (titled by its file, or none), and a search.
export const documentText = (title, text) => `title: ${title || 'none'} | text: ${text}`;
export const queryText = query => `task: search result | query: ${query}`;

// The prompts some embedding models were trained with, by their name: a search, and a piece of code.
const PROMPTS = [
  [/nomic-embed-code/i, {query: 'Represent this query for searching relevant code: ', document: ''}],
  [/nomic-embed-text/i, {query: 'search_query: ', document: 'search_document: '}],
  [/embedding-?gemma/i, {query: 'task: search result | query: ', document: 'title: none | text: '}],
  [/qwen3-embedding/i, {query: 'Instruct: Given a question, find the code that answers it\nQuery: ', document: ''}],
];
const HTTP_BATCH = 16;
const HTTP_MS = 60_000;

/** The prompts for `entry.model`: the config's, else those it was trained with, else none. */
export function promptsOf(entry) {
  const known = PROMPTS.find(([pattern]) => pattern.test(entry.model))?.[1] ?? {query: '', document: ''};
  return {query: entry.queryPrefix ?? known.query, document: entry.documentPrefix ?? known.document};
}

/** `vector` at unit length. */
const unit = vector => {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  return Float32Array.from(vector, value => value / norm);
};

/**
 * The config's `embedding` entry, `{baseUrl, model, dimensions?, queryPrefix?, documentPrefix?, ...key}`, as an
 * embedder: `id` names its vectors in the index, `query(text)` and `document(file, text)` add the model's prompts,
 * `embed(texts, {urgent})` resolves their vectors.
 */
export class HttpEmbedder {
  constructor({entry, apiKey = () => apiKeyOf(entry), fetch = globalThis.fetch, log = () => {}, batch = HTTP_BATCH, timeoutMs = entry.timeoutMs ?? HTTP_MS}) {
    Object.assign(this, {entry, apiKey, fetch, log, batch, timeoutMs});
    this.prompts = promptsOf(entry);
    this.queue = [];
    this.running = false;
    this.embedded = 0;
    this.embedMs = 0;
  }

  get id() { return `${this.entry.model}${this.entry.dimensions ? `/${this.entry.dimensions}` : ''}`; }

  get name() { return `${this.entry.model} at ${this.entry.baseUrl}`; }

  get msPerText() { return this.embedded ? this.embedMs / this.embedded : null; }

  document(file, text) { return `${this.prompts.document}${text}`; }

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
