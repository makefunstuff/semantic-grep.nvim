// The model profiles `setup({profile = ...})` fills `embedding` and `rerank` from, each measured on the bench (see
// docs/profiles.md: the numbers, and how to run each model's server):
//
// - laptop: EmbeddingGemma 2 on the CPU (about 16 GB of RAM, no GPU), no reranker: none on 4 CPU threads reranks
//   within a picker's wait (the smallest took 0.4 s and made the list worse; Qwen3-Reranker-0.6B helps, in 2.2 s);
// - beefy: a workstation's GPU: Qwen3-Embedding-8B and the Qwen3-Reranker-0.6B cross-encoder, top 20 (about 10 GB);
// - cloud: hosted APIs, Voyage's voyage-code-3 and rerank-2.5, the key in $VOYAGE_API_KEY (not measured yet).
//
// The local ones expect llama.cpp's llama-server on this machine: the embedding model at port 18120, the reranker at
// 18121. Whatever the config says itself goes over its profile's (a baseUrl, a timeoutMs; another model or API, and the
// profile's settings for its own model are dropped; a key of its own or another baseUrl, and the profile's key is);
// `false` turns that model off.
import {embeddingConfig, rerankConfig} from './config.mjs';

const LOCAL_EMBEDDING = 'http://127.0.0.1:18120/v1';
const LOCAL_RERANK = 'http://127.0.0.1:18121/v1';

export const PROFILES = {
  laptop: {
    embedding: {api: 'openai', baseUrl: LOCAL_EMBEDDING, model: 'embeddinggemma-2'},
    rerank: null,
  },
  beefy: {
    embedding: {api: 'openai', baseUrl: LOCAL_EMBEDDING, model: 'qwen3-embedding-8b'},
    rerank: {api: 'rerank', baseUrl: LOCAL_RERANK, model: 'qwen3-reranker-0.6b', top: 20, timeoutMs: 1000},
  },
  cloud: {
    embedding: {api: 'openai', baseUrl: 'https://api.voyageai.com/v1', model: 'voyage-code-3', apiKeyEnv: 'VOYAGE_API_KEY', queryPrefix: 'Represent the query for retrieving supporting documents: ', documentPrefix: 'Represent the document for retrieval: '},
    rerank: {api: 'rerank', baseUrl: 'https://api.voyageai.com/v1', model: 'rerank-2.5', apiKeyEnv: 'VOYAGE_API_KEY', top: 30, timeoutMs: 3000},
  },
};

// What an entry says about its own model only: dropped from the profile's when the config names another model or API.
const OF_THE_MODEL = ['dimensions', 'queryPrefix', 'documentPrefix', 'band', 'pickNear', 'chars', 'top', 'timeoutMs'];
// The key: the config's own replaces the profile's, and a profile's key never goes to another server.
const KEYS = ['apiKey', 'apiKeyFile', 'apiKeyEnv'];

const trimmed = url => String(url).replace(/\/+$/, '');
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `own` over the profile's `base`: own's fields win; base's settings for its model go when own names another model or
 * API, and base's key when own has a key of its own or another baseUrl.
 */
function over(base, own, name, profile) {
  if (own === undefined || own === null) return base;
  if (own === false || Array.isArray(own) || !isObject(own)) return own;
  if (!base) {
    if (profile && !own.api && !own.model) throw new Error(`${name}: profile "${profile}" has none to change; give a whole entry, with its api, baseUrl and model`);
    return own;
  }
  const otherModel = (own.model && own.model !== base.model) || (own.api && own.api !== base.api);
  const otherKey = KEYS.some(key => own[key] !== undefined && own[key] !== null) || (own.baseUrl && trimmed(own.baseUrl) !== trimmed(base.baseUrl));
  const kept = Object.fromEntries(Object.entries(base).filter(([key]) => !(otherModel && OF_THE_MODEL.includes(key)) && !(otherKey && KEYS.includes(key))));
  return {...kept, ...own};
}

/**
 * The `embedding` and `rerank` entries of a config `{profile?, embedding?, rerank?}`, checked (config.mjs): the
 * profile's, with what the config sets itself over them. Without a profile, the config's own.
 */
export function profileConfig({profile, embedding, rerank} = {}) {
  if (profile !== undefined && profile !== null && !Object.hasOwn(PROFILES, profile)) {
    throw new Error(`profile must be one of ${Object.keys(PROFILES).map(name => `"${name}"`).join(', ')}`);
  }
  const base = profile ? PROFILES[profile] : {};
  return {
    embedding: embeddingConfig(over(base.embedding, embedding, 'embedding', profile)),
    rerank: rerankConfig(over(base.rerank, rerank, 'rerank', profile)),
  };
}
