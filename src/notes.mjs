// The notes writer: a sentence or two on what a piece of code does, written by a language model in the background, so
// that search by meaning finds it in the words people search with without anyone asking a coding agent (see
// Meaning.pendingNotes and addNotes: the same path an agent's notes take, with the writer's model as their source).
//
// A writer is an entry `{api, baseUrl, model, ...key, concurrency?, chars?, idleMs?, timeoutMs?, sendCode?}`:
//
// - api "openai": an OpenAI-compatible /chat/completions (llama.cpp's llama-server, Ollama, LM Studio, vLLM, a cloud
//   API); a Qwen3.5 model is asked without its thinking;
// - api "anthropic": Anthropic's Messages API (Claude Haiku by default), POST <baseUrl>/messages.
//
// The code of each piece goes to the writer's model. A model on this machine (127.0.0.1, localhost, ::1) may read it;
// any other only with `sendCode = true` in the entry: the cloud profile says so for its writer, and a writer of one's
// own elsewhere must say so itself. Without it the writer is refused, whatever its other settings.
import {apiKeyOf} from './config.mjs';

export const NOTE_APIS = ['openai', 'anthropic'];
export const NOTE_CHARS = 2000; // of each piece's code, what the model reads: its head and doc comment say the most
export const NOTE_CONCURRENCY = 2; // pieces asked at once: a llama-server's --parallel slots
export const NOTE_IDLE_MS = 60_000; // how long nothing was searched before notes are written
export const NOTE_TIMEOUT_MS = 120_000; // a CPU model takes seconds a piece; one that takes this long is stuck
const MAX_TOKENS = 160; // a note's two sentences, with room: one that runs on is cut where a sentence ends
export const NO_NOTE = 'no note in the answer';
const ANTHROPIC_VERSION = '2026-10-21';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const SYSTEM = 'You write notes on pieces of code for a code search index. Given one piece, write one or two '
  + 'plain sentences: what it does, and what someone would be trying to do when they need it. Keep its identifiers '
  + '(function, type and option names) exactly as written. No preamble, no lists, no markdown, no quotes around the note.';

/** Whether `baseUrl` is this machine: a model there may read the code. */
export function isLocal(baseUrl) {
  try { return LOCAL_HOSTS.has(new URL(baseUrl).hostname); } catch { return false; }
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The `notes` entry, checked: `{api, baseUrl, model, ...key, concurrency, chars, idleMs, timeoutMs, sendCode}` with
 * the defaults filled; null without one (no notes are written). A writer that is not on this machine and has no
 * `sendCode = true` is refused: its model would read the project's code.
 */
export function notesConfig(entry, name = 'notes') {
  if (entry === undefined || entry === null || entry === false) return null;
  if (!isObject(entry)) throw new Error(`${name} must be a table, for example {api = "openai", baseUrl = "http://127.0.0.1:18122/v1", model = "qwen3.5-2b"}`);
  const api = entry.api ?? 'openai';
  if (!NOTE_APIS.includes(api)) throw new Error(`${name}.api must be one of ${NOTE_APIS.map(each => `"${each}"`).join(', ')}`);
  if (typeof entry.baseUrl !== 'string' || !entry.baseUrl) throw new Error(`${name}.baseUrl is missing`);
  if (typeof entry.model !== 'string' || !entry.model) throw new Error(`${name}.model is missing`);
  const keys = ['apiKey', 'apiKeyFile', 'apiKeyEnv'].filter(field => entry[field] !== undefined && entry[field] !== null);
  if (keys.length > 1) throw new Error(`${name} takes one of ${keys.join(', ')}`);
  for (const field of keys) if (typeof entry[field] !== 'string' || !entry[field]) throw new Error(`${name}.${field} must be text`);
  const whole = (field, least, most) => {
    if (entry[field] !== undefined && !(Number.isInteger(entry[field]) && entry[field] >= least && entry[field] <= most)) throw new Error(`${name}.${field} must be a whole number from ${least} to ${most}`);
  };
  whole('concurrency', 1, 32);
  whole('chars', 200, 20_000);
  for (const field of ['idleMs', 'timeoutMs']) {
    if (entry[field] !== undefined && !(typeof entry[field] === 'number' && entry[field] >= 0)) throw new Error(`${name}.${field} must be a number of milliseconds`);
  }
  if (entry.sendCode !== undefined && typeof entry.sendCode !== 'boolean') throw new Error(`${name}.sendCode must be true or false`);
  if (!isLocal(entry.baseUrl) && entry.sendCode !== true) {
    throw new Error(`${name}: ${entry.baseUrl} is not this machine, and every piece's code would go to it; set sendCode = true in the notes entry to allow that`);
  }
  return {
    ...entry, api, concurrency: entry.concurrency ?? NOTE_CONCURRENCY, chars: entry.chars ?? NOTE_CHARS,
    idleMs: entry.idleMs ?? NOTE_IDLE_MS, timeoutMs: entry.timeoutMs ?? NOTE_TIMEOUT_MS, sendCode: entry.sendCode === true,
  };
}

/** What the model reads of a piece `{file, name, text}`: where it is, what names it, and its code cut to `chars`. */
export function notePrompt(piece, chars = NOTE_CHARS) {
  const text = String(piece.text ?? '');
  const code = text.length > chars ? `${text.slice(0, chars)}\n…` : text;
  return `File: ${piece.file}${piece.name ? `\nName: ${piece.name}` : ''}\n\n${code}`;
}

/**
 * The model's answer as a note: its thinking and any markdown or quotes dropped, on one line, at most two sentences
 * (and 400 characters); null when nothing is left.
 */
export function cleanNote(text) {
  let note = String(text ?? '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  note = note.replace(/^(note|summary)\s*:\s*/i, '').replace(/^[`*_"'\s]+|[`*_"'\s]+$/g, '');
  note = note.replace(/\s+/g, ' ').trim();
  const sentences = note.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [];
  if (sentences.length > 2) note = sentences.slice(0, 2).join('').trim();
  if (note.length > 400) note = `${note.slice(0, 400).replace(/\s+\S*$/, '')}…`;
  return note.length >= 8 ? note : null;
}

/**
 * A notes writer: `write(pieces)` resolves `[{hash, note, ms, input, output}]`, one for each piece it could write a
 * note for (asked `concurrency` at a time); a piece it got no note for is left out, and its failure is `errors`'.
 * `name` is the source the notes are kept under ("writer:<model>").
 */
export class NotesWriter {
  constructor({entry, apiKey = () => apiKeyOf(entry), fetch = globalThis.fetch, log = () => {}}) {
    Object.assign(this, {entry, apiKey, fetch, log});
    this.written = 0;
    this.ms = 0;
    this.tokens = {input: 0, output: 0};
  }

  get name() { return `writer:${this.entry.model}`; }

  get about() { return `${this.entry.model} at ${this.entry.baseUrl}`; }

  async write(pieces, {signal} = {}) {
    const out = [];
    const errors = [];
    let next = 0;
    const lane = async () => {
      while (next < pieces.length && !signal?.aborted) {
        const piece = pieces[next++];
        try {
          const started = Date.now();
          const {text, input, output} = await this.ask(piece, signal);
          const note = cleanNote(text);
          const ms = Date.now() - started;
          this.ms += ms;
          this.tokens.input += input ?? 0;
          this.tokens.output += output ?? 0;
          if (!note) { errors.push(`${piece.file}:${piece.from}: ${NO_NOTE}`); continue; }
          this.written += 1;
          out.push({hash: piece.hash, note, ms, input, output});
        } catch (error) {
          errors.push(`${piece.file}:${piece.from}: ${error.message}`);
          if (/401|403|ECONNREFUSED|fetch failed|did not answer/.test(error.message)) break; // the same for every piece
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(this.entry.concurrency, pieces.length)}, lane));
    return {notes: out, errors};
  }

  async ask(piece, signal) {
    const key = this.apiKey();
    const base = this.entry.baseUrl.replace(/\/+$/, '');
    const prompt = notePrompt(piece, this.entry.chars);
    const anthropic = this.entry.api === 'anthropic';
    const url = anthropic ? `${base}/messages` : `${base}/chat/completions`;
    const headers = {'content-type': 'application/json', ...(anthropic
      ? {'anthropic-version': ANTHROPIC_VERSION, ...(key ? {'x-api-key': key} : {})}
      : key ? {authorization: `Bearer ${key}`} : {})};
    // Haiku 5.5 thinks by default: off, at low effort, for a sentence. A Qwen3.5 on llama-server thinks unless told not to.
    const body = anthropic
      ? {model: this.entry.model, max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{role: 'user', content: prompt}], thinking: {type: 'disabled'}, output_config: {effort: 'low'}}
      : {model: this.entry.model, max_tokens: MAX_TOKENS, temperature: 0.2, messages: [{role: 'system', content: SYSTEM}, {role: 'user', content: prompt}], chat_template_kwargs: {enable_thinking: false}};
    const timeout = AbortSignal.timeout(this.entry.timeoutMs);
    let response;
    try {
      response = await this.fetch(url, {method: 'POST', headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
    } catch (error) {
      throw new Error(error.name === 'TimeoutError' ? `${this.about} did not answer within ${this.entry.timeoutMs} ms` : `${this.about}: ${error.cause?.code ?? error.message}`);
    }
    if (!response.ok) throw new Error(`${this.about}: ${response.status} ${(await response.text().catch(() => '')).slice(0, 200)}`);
    const answer = await response.json();
    if (anthropic) {
      const text = (answer.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
      return {text, input: answer.usage?.input_tokens, output: answer.usage?.output_tokens};
    }
    return {text: answer.choices?.[0]?.message?.content ?? '', input: answer.usage?.prompt_tokens, output: answer.usage?.completion_tokens};
  }
}
