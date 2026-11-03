// The stdio server a Neovim spawns (bin/semantic-grep-server.mjs): one per Neovim, no daemon. It speaks JSON-RPC 2.0,
// one message a line: Neovim asks, the server answers each `id`, and tells Neovim of its own accord with notifications.
//
// Requests (params):
//   initialize {dataDir, profile?, embedding?, rerank?, index?, projectDir?, parsers?}  -> {state, model, version}
//   open {root}                                   -> {state}           the project is indexed in the background
//   words {root, query, limit?}                   -> found             on every key
//   meaning {root, query, limit?}                 -> found             once typing stops
//   rerank {root, query}                          -> found + {rerank}  once meaning came
//   search {root, query, limit?}                  -> found + {rerank}  meaning and words fused, then reranked
//   saved {path}                                  -> {}                a file written in Neovim
//   rebuild {root}                                -> {path}
//   chosen {root, query, results}                 -> {}                the piece opened: booked, and learned
//   notes {root, limit?}                          -> {pieces, pending, noted} pieces without a note, for an agent
//   addNotes {root, notes: [{hash, note}]}        -> {added, unknown}
//   status {}                                     -> the Meaning's snapshot
//   check {}                                      -> {profile, embedding, rerank} the models asked once each, for :checkhealth
// Notifications: cancel {} (to the server: a picker's rerank is no longer wanted); progress {root, phase, done,
// total, text}, log {text} and booked {root, kind, text} (to Neovim). `found` is `{phase, query, state, results:
// [{file, path, line, from, to, head, kind, name, meaning, words, rerank?}], chunks, embedded, problem?, ms?, ...}`.
// The server exits when its stdin closes: when Neovim goes.
import {readFileSync} from 'node:fs';
import {isAbsolute, join, relative} from 'node:path';
import {indexConfig} from './config.mjs';
import {profileConfig} from './profiles.mjs';
import {readLines, writeLine} from './jsonl.mjs';
import {Meaning} from './meaning.mjs';
import {Reranker} from './rerank.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const WHO = 'nvim'; // one Neovim per server: the asker of every picker rerank
// A model's failure that says nothing answers where it is: not started, or another address.
const UNREACHABLE = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ECONNRESET|UND_ERR_CONNECT|did not answer|fetch failed/i;

/** Serves JSON-RPC on `input` and `output` until `input` ends. Resolves once it closed. */
export function serve({input = process.stdin, output = process.stdout, meaningWith = {}} = {}) {
  let meaning = null;
  let profile = null;
  const notify = (method, params) => writeLine(output, {jsonrpc: '2.0', method, params});
  const log = text => notify('log', {text});

  const withPaths = (root, answer) => ({...answer, root, results: (answer.results ?? []).map(result => ({...result, path: join(root, result.file)}))});
  const needed = () => {
    if (!meaning) throw new Error('not initialized');
    return meaning;
  };
  const rootOf = params => {
    if (typeof params?.root !== 'string' || !isAbsolute(params.root)) throw new Error('root must be an absolute path');
    return params.root;
  };
  const queryOf = params => {
    if (typeof params?.query !== 'string') throw new Error('query must be text');
    return params.query.trim();
  };

  const methods = {
    async initialize(params = {}) {
      if (meaning) await meaning.close();
      if (typeof params.dataDir !== 'string' || !isAbsolute(params.dataDir)) throw new Error('dataDir must be an absolute path');
      const {embedding, rerank} = profileConfig(params);
      profile = params.profile ?? null;
      const index = indexConfig(params.index);
      meaning = new Meaning({
        dataDir: params.dataDir, config: {index, ...(params.projectDir ? {projectDir: params.projectDir} : {})}, embedding,
        reranker: rerank ? new Reranker({entries: rerank, log}) : null,
        log, progress: (root, how) => notify('progress', {root, ...how}), book: (root, kind, text) => notify('booked', {root, kind, text}),
        ...meaningWith,
      });
      meaning.useParsers(params.parsers);
      return {state: meaning.state, model: meaning.modelName, version: VERSION};
    },
    async open(params) {
      const root = rootOf(params);
      needed().open(root);
      return {state: meaning.state};
    },
    async words(params) {
      const root = rootOf(params);
      needed().dropRerank(WHO);
      return withPaths(root, await meaning.words(root, queryOf(params), {limit: params.limit ?? 30}));
    },
    async meaning(params) {
      const root = rootOf(params);
      return withPaths(root, await needed().meaningOnly(root, queryOf(params), {limit: params.limit ?? 30}));
    },
    async rerank(params) {
      const root = rootOf(params);
      return withPaths(root, await needed().rerank(root, queryOf(params), {who: WHO}));
    },
    async search(params) {
      const root = rootOf(params);
      return withPaths(root, await needed().search(root, queryOf(params), {limit: params.limit ?? 30, book: false}));
    },
    async saved(params) {
      if (typeof params?.path !== 'string' || !isAbsolute(params.path)) throw new Error('path must be an absolute path');
      const m = needed();
      for (const root of [...m.indexes.keys()]) {
        const file = relative(root, params.path);
        if (!file.startsWith('..') && !isAbsolute(file)) await m.saved(root, params.path);
      }
      return {};
    },
    async rebuild(params) {
      return {path: await needed().rebuild(rootOf(params))};
    },
    async chosen(params) {
      needed().booked(rootOf(params), queryOf(params), Array.isArray(params.results) ? params.results : [], ' in the picker');
      return {};
    },
    async notes(params) {
      return needed().pendingNotes(rootOf(params), {limit: Number.isInteger(params.limit) ? params.limit : 50});
    },
    async addNotes(params) {
      return needed().addNotes(rootOf(params), params.notes, {source: typeof params.source === 'string' ? params.source : 'agent'});
    },
    async status() {
      return needed().snapshot();
    },
    async check() {
      const m = needed();
      const embedding = m.embedder ? await (async () => {
        const started = Date.now();
        try {
          const [vector] = await m.embedder.embed([m.embedder.query('add two numbers')], {urgent: true});
          return {ok: true, ms: Date.now() - started, dimensions: vector.length, model: m.modelName};
        } catch (error) {
          return {ok: false, ms: Date.now() - started, error: error.message, model: m.modelName, unreachable: UNREACHABLE.test(error.message)};
        }
      })() : null;
      const rerank = m.reranker ? await m.reranker.probe() : null;
      if (rerank) {
        Object.assign(rerank, {timeoutMs: m.reranker.timeoutMs, models: m.reranker.name, unreachable: !rerank.ok && UNREACHABLE.test(rerank.error ?? '')});
        for (const skip of rerank.skipped ?? []) skip.unreachable = UNREACHABLE.test(skip.error ?? '');
      }
      return {profile, embedding, rerank};
    },
  };

  const lines = readLines(input, async message => {
    if (message?.method === 'cancel') return meaning?.dropRerank(WHO);
    const {id, method, params} = message ?? {};
    if (id === undefined || id === null) return;
    const handler = Object.hasOwn(methods, method) ? methods[method] : null;
    if (!handler) return writeLine(output, {jsonrpc: '2.0', id, error: {code: -32601, message: `no method ${method}`}});
    try {
      writeLine(output, {jsonrpc: '2.0', id, result: await handler(params)});
    } catch (error) {
      writeLine(output, {jsonrpc: '2.0', id, error: {code: -32000, message: error.message}});
    }
  });
  return new Promise(resolve => {
    lines.on('close', async () => {
      await meaning?.close().catch(() => {});
      resolve();
    });
  });
}
