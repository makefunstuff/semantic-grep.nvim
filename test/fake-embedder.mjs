// A fake embedder for the tests: words that mean the same land on the same numbers, so a search worded unlike the code
// still finds it, as a real model does. As an embedder in-process, as a /v1/embeddings server, and a `provider` that
// stands in for a host's own local model (one it downloads and turns on and off).
import {createServer} from 'node:http';
import {documentText, queryText} from '../src/embedder.mjs';
import {words} from '../src/meaning.mjs';

export const DIMENSIONS = 256;
// Each group is one meaning: any of its words counts as the first.
const MEANINGS = [
  ['retry', 'again', 'attempt', 'attempts', 'backoff', 'retries', 'redo'],
  ['fail', 'fails', 'failure', 'error', 'errors', 'broken', 'crash', 'throw'],
  ['money', 'price', 'prices', 'cost', 'invoice', 'total', 'cents', 'pay'],
  ['speak', 'say', 'talk', 'remark', 'quiet', 'voice'],
];
const meaningOf = new Map(MEANINGS.flatMap(group => group.map(word => [word, group[0]])));

const slot = word => {
  let hash = 0;
  for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % DIMENSIONS;
};

/** The fake's vector of `text`: its words' meanings, and a little of the words themselves, normalized. */
export function fakeVector(text) {
  const body = text.replace(/^title: (.*?) \| text: /, '').replace(/^task: search result \| query: /, '').replace(/^Represent this query for searching relevant code: /, '');
  const vector = new Float32Array(DIMENSIONS);
  for (const word of words(body)) {
    const meaning = meaningOf.get(word);
    vector[slot(meaning ?? word)] += meaning ? 1 : 0.2; // a word of its own counts a little: real models see words too
  }
  vector[DIMENSIONS - 1] += 0.1; // nothing in common is still a little similar, as with a real model
  const norm = Math.hypot(...vector);
  return vector.map(value => value / norm);
}

/** An embedder as Meaning uses one; `calls` lists every batch it got, `failWith` makes the next calls fail. */
export function fakeEmbedder() {
  const embedder = {
    msPerText: 1, calls: [], failWith: null, id: 'fake', ready: true,
    document: documentText, query: queryText,
    async embed(texts, {urgent = false} = {}) {
      embedder.calls.push({texts, urgent});
      if (embedder.failWith) throw new Error(embedder.failWith);
      return texts.map(fakeVector);
    },
    fail() {},
    close() {},
  };
  return embedder;
}

/** A host's local model, off until turned on (`on` sets it at once); `turned` lists what was asked of it. */
export function fakeProvider() {
  const provider = {
    on: false, turned: [], name: 'fake local model',
    state: () => (provider.on ? 'on' : 'off'),
    needs: async () => ({runtime: null, model: !provider.on}),
    async turnOn() { provider.turned.push('on'); const fetched = !provider.on; provider.on = true; return {runtime: null, model: fetched}; },
    async turnOff() { provider.turned.push('off'); provider.on = false; return {venv: true}; },
    snapshot: () => ({python: 'fake-python'}),
  };
  return provider;
}

/**
 * An OpenAI-compatible /v1/embeddings for the tests, on a free local port, with the fake's vectors: `requests` lists
 * the bodies it got and their authorization, `failWith` makes it answer that status.
 */
export async function fakeEmbeddingServer() {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const asked = JSON.parse(body || '{}');
      server.requests.push({url: request.url, authorization: request.headers.authorization ?? null, ...asked});
      if (server.failWith) {
        response.writeHead(server.failWith, {'content-type': 'application/json'});
        return response.end(JSON.stringify({error: {message: 'model not loaded'}}));
      }
      response.writeHead(200, {'content-type': 'application/json'});
      // Three times the fake's numbers, not of unit length, and out of order.
      response.end(JSON.stringify({data: asked.input.map((text, index) => ({index, embedding: [...fakeVector(text)].map(value => value * 3)})).reverse()}));
    });
  });
  server.requests = [];
  server.failWith = null;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  server.stop = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  return server;
}
