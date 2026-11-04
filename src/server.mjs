// The stdio server a Neovim spawns (bin/semantic-grep-server.mjs): one per Neovim, no daemon. It speaks JSON-RPC 2.0,
// one message a line: Neovim asks, the server answers each `id`, and tells Neovim of its own accord with notifications.
//
// Requests (params):
//   initialize {dataDir, profile?, embedding?, rerank?, notes?, index?, projectDir?, parsers?, local?}  -> {state, model, version}
//                                                 without embedding (or false) and profile: the small local model
//                                                 (local.mjs; local = {gguf?, llamaServer?, threads?}, or false);
//                                                 notes (true, or an entry over the profile's writer): notes written
//                                                 while nothing is searched (notes.mjs)
//   needs {}                                      -> {state, runtime, model, bytes, name, path} what the local model lacks
//   download {}                                   -> {state}           the local model fetched (progress as it comes)
//   open {root}                                   -> {state}           the project is indexed in the background
//   words {root, query, limit?}                   -> found             on every key
//   meaning {root, query, limit?}                 -> found             once typing stops
//   rerank {root, query}                          -> found + {rerank}  once meaning came
//   search {root, query, limit?}                  -> found + {rerank}  meaning and words fused, then reranked
//   files {root, query, limit?}                   -> files             the files that answer it, best first
//   saved {path}                                  -> {}                a file written in Neovim
//   rebuild {root}                                -> {path}
//   chosen {root, query, results}                 -> {}                the piece opened: booked, and learned
//   notes {root, limit?}                          -> {pieces, pending, noted} pieces without a note, for an agent
//   addNotes {root, notes: [{hash, note}]}        -> {added, unknown}
//   status {}                                     -> the Meaning's snapshot
//   check {}                                      -> {profile, embedding, rerank, notes} the models asked once each, for :checkhealth
// Notifications: cancel {} (to the server: a picker's rerank is no longer wanted); visited {path} (to the server: the
// file someone is in, which the notes written in the background start near); progress {root, phase, done,
// total, text}, log {text} and booked {root, kind, text} (to Neovim). `found` is `{phase, query, state, results:
// [{file, path, line, from, to, head, kind, name, meaning, words, rerank?}], chunks, embedded, problem?, ms?, ...}`;
// `files` is the same with a result per file, its best piece's, with `score` and `hits` (its pieces in the ranking).
// The server exits when its stdin closes: when Neovim goes.
import {readFileSync} from 'node:fs';
import {isAbsolute, join, relative} from 'node:path';
import {indexConfig} from './config.mjs';
import {profileConfig} from './profiles.mjs';
import {readLines, writeLine} from './jsonl.mjs';
import {Meaning} from './meaning.mjs';
import {Reranker} from './rerank.mjs';
import {LocalModel} from './local.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const WHO = 'nvim'; // one Neovim per server: the asker of every picker rerank
// A model's failure that says nothing answers where it is: not started, or another address.
const UNREACHABLE = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ECONNRESET|UND_ERR_CONNECT|did not answer|fetch failed/i;

/** The `local` of initialize: `{gguf?, llamaServer?, threads?}`, checked; or nothing. */
function localOf(local) {
  if (local === undefined || local === null || local === true) return {};
  if (typeof local !== 'object' || Array.isArray(local)) throw new Error('local_model must be a table: {gguf = ..., llama_server = ..., threads = ...}, or false');
  const out = {};
  if (local.gguf !== undefined) {
    if (typeof local.gguf !== 'string' || !isAbsolute(local.gguf)) throw new Error('local_model.gguf must be an absolute path');
    out.gguf = local.gguf;
  }
  if (local.llamaServer !== undefined) {
    if (typeof local.llamaServer !== 'string' || !local.llamaServer) throw new Error('local_model.llama_server must be a command or a path');
    out.llamaServer = local.llamaServer;
  }
  if (local.threads !== undefined) {
    if (!(Number.isInteger(local.threads) && local.threads > 0)) throw new Error('local_model.threads must be a whole number above 0');
    out.threads = local.threads;
  }
  return out;
}

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
      const {embedding, rerank, notes} = profileConfig(params);
      profile = params.profile ?? null;
      const index = indexConfig(params.index);
      // No embedding model named, nor a profile, nor turned off: the small one of local.mjs, served here.
      const own = params.embedding === undefined && !params.profile && params.local !== false
        ? new LocalModel({dataDir: params.dataDir, ...localOf(params.local), log}) : null;
      meaning = new Meaning({
        dataDir: params.dataDir, config: {index, ...(params.projectDir ? {projectDir: params.projectDir} : {})}, embedding,
        ...(own ? {embedder: own, provider: own} : {}),
        reranker: rerank ? new Reranker({entries: rerank, log}) : null, notes,
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
    async files(params) {
      const root = rootOf(params);
      return withPaths(root, await needed().files(root, queryOf(params), {limit: params.limit ?? 20}));
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
    async needs() {
      const m = needed();
      return {state: m.state, ...(await m.needs())};
    },
    async download() {
      const m = needed();
      await m.turnOn({progress: how => notify('progress', how)});
      return {state: m.state};
    },
    async status() {
      return needed().snapshot();
    },
    async check() {
      const m = needed();
      const missing = m.provider && m.state !== 'on' ? await m.needs() : null;
      const embedding = missing ? {ok: false, local: missing, model: m.modelName} : m.embedder ? await (async () => {
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
      // The notes writer, asked for one note on a small piece of its own (not the project's code).
      const notes = m.writer ? await (async () => {
        const started = Date.now();
        const counts = {written: m.writer.written, tokens: {...m.writer.tokens}, cost: m.writer.cost, ms: m.writer.ms};
        const {notes: [written], errors} = await m.writer.write([{hash: 'check', file: 'math.js', from: 1, name: 'add', text: '/** The sum of a and b. */\nexport function add(a, b) { return a + b }'}]);
        Object.assign(m.writer, counts); // the check's note is not the project's
        const about = {model: m.writer.about, sendCode: m.writer.entry.sendCode, idleMs: m.writer.entry.idleMs, written: m.writer.written};
        return written ? {ok: true, ms: Date.now() - started, note: written.note, ...about}
          : {ok: false, ms: Date.now() - started, error: errors[0] ?? 'no answer', unreachable: UNREACHABLE.test(errors[0] ?? ''), ...about};
      })() : null;
      return {profile, embedding, rerank, notes, local: m.provider?.snapshot?.().local ?? null};
    },
  };

  const lines = readLines(input, async message => {
    if (message?.method === 'cancel') return meaning?.dropRerank(WHO);
    if (message?.method === 'visited') return meaning?.visited(message.params?.path);
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
