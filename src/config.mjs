// The backend's settings, as the Lua plugin's setup() passes them: the `embedding` model, the `rerank` models and
// where the index lives. Each is checked here, with a message that names the field.
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';

export const RERANK_TOP = 10;
export const RERANK_TIMEOUT_MS = 3000;
export const FALLBACK_TIMEOUT_MS = 1000; // a model another follows in the list
export const RERANK_APIS = ['system-one', 'llama-cpp', 'openai', 'rerank'];
const KEYS = ['apiKey', 'apiKeyFile', 'apiKeyEnv'];

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/** An entry's API key: `apiKey`, the file `apiKeyFile` or the environment variable `apiKeyEnv`; or none. */
export function apiKeyOf(entry) {
  if (entry.apiKey) return entry.apiKey;
  if (entry.apiKeyFile) return readFileSync(entry.apiKeyFile.replace(/^~(?=\/)/, homedir()), 'utf8').trim();
  if (entry.apiKeyEnv) return process.env[entry.apiKeyEnv];
  return undefined;
}

function keysOf(entry, name) {
  const keys = KEYS.filter(field => entry[field] !== undefined && entry[field] !== null);
  if (keys.length > 1) throw new Error(`${name} takes one of ${keys.join(', ')}`);
  for (const field of keys) if (typeof entry[field] !== 'string' || !entry[field]) throw new Error(`${name}.${field} must be text`);
}

/**
 * The `embedding` entry: `{api = "openai", baseUrl, model, dimensions?, queryPrefix?, documentPrefix?, timeoutMs?,
 * apiKey | apiKeyFile | apiKeyEnv}`; null without one (words only).
 */
export function embeddingConfig(entry, name = 'embedding') {
  if (entry === undefined || entry === null || entry === false) return null;
  if (!isObject(entry)) throw new Error(`${name} must be a table, for example {api = "openai", baseUrl = "http://127.0.0.1:8080/v1", model = "embeddinggemma"}`);
  if ((entry.api ?? 'openai') !== 'openai') throw new Error(`${name}.api must be "openai": an OpenAI-compatible /v1/embeddings`);
  if (typeof entry.baseUrl !== 'string' || !entry.baseUrl) throw new Error(`${name}.baseUrl is missing`);
  if (typeof entry.model !== 'string' || !entry.model) throw new Error(`${name}.model is missing`);
  keysOf(entry, name);
  for (const field of ['queryPrefix', 'documentPrefix']) {
    if (entry[field] !== undefined && typeof entry[field] !== 'string') throw new Error(`${name}.${field} must be text`);
  }
  if (entry.dimensions !== undefined && !(Number.isInteger(entry.dimensions) && entry.dimensions > 0)) throw new Error(`${name}.dimensions must be a whole number above 0`);
  if (entry.timeoutMs !== undefined && !(typeof entry.timeoutMs === 'number' && entry.timeoutMs > 0)) throw new Error(`${name}.timeoutMs must be a number of milliseconds`);
  return {...entry, api: 'openai'};
}

/**
 * The `rerank` entry: a decision model `{api, baseUrl, model, top?, timeoutMs?, ...key}`, or a list of them, best
 * first. `api` is "system-one" (POST <baseUrl>/systemone), "llama-cpp" (a chat model on llama.cpp's server, asked for
 * each answer's probability), "openai" (OpenAI's Decisions API, POST <baseUrl>/decisions) or "rerank" (a cross-encoder's
 * POST <baseUrl>/rerank: llama.cpp's --rerank, Cohere, Jina, Voyage; it reorders every piece it reads). Each comes back with its
 * `top` (10) and `timeoutMs` (3 s; 1 s for one another follows). null without one: off.
 */
export function rerankConfig(value, name = 'rerank') {
  if (value === undefined || value === null || value === false) return null;
  const list = Array.isArray(value);
  if (list && !value.length) throw new Error(`${name} lists no model`);
  return (list ? value : [value]).map((entry, i, all) => {
    const label = list ? `${name}[${i}]` : name;
    if (!isObject(entry)) throw new Error(`${label} must be a table, for example {api = "system-one", baseUrl = "http://127.0.0.1:8080/v1", model = "d1-2B"}`);
    const {top, timeoutMs} = entry;
    if (!RERANK_APIS.includes(entry.api)) throw new Error(`${label}.api must be one of ${RERANK_APIS.map(api => `"${api}"`).join(', ')}`);
    if (typeof entry.baseUrl !== 'string' || !entry.baseUrl) throw new Error(`${label}.baseUrl is missing`);
    if (typeof entry.model !== 'string' || !entry.model) throw new Error(`${label}.model is missing`);
    keysOf(entry, label);
    if (top !== undefined && !(Number.isInteger(top) && top >= 2 && top <= 30)) throw new Error(`${label}.top must be a whole number from 2 to 30`);
    if (timeoutMs !== undefined && !(typeof timeoutMs === 'number' && timeoutMs > 0)) throw new Error(`${label}.timeoutMs must be a number of milliseconds`);
    return {...entry, top: top ?? RERANK_TOP, timeoutMs: timeoutMs ?? (i < all.length - 1 ? FALLBACK_TIMEOUT_MS : RERANK_TIMEOUT_MS)};
  });
}

/** `index`: "data" (Neovim's data folder, the default) or "project" (.semantic-grep/ in the repository). */
export function indexConfig(value) {
  if (value === undefined || value === null) return 'data';
  if (value !== 'data' && value !== 'project') throw new Error('index must be "data" or "project"');
  return value;
}
