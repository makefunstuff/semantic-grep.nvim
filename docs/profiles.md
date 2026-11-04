# Model profiles

`setup({profile = 'laptop'})` (or `'beefy'`, `'cloud'`) fills `embedding` and `rerank` with the models the
[benchmark](benchmark.md) measured best for that kind of machine. What `embedding` and `rerank` set themselves goes
over the profile's: `embedding = {baseUrl = 'http://127.0.0.1:9000/v1'}` moves it, another `model` drops the profile's
settings for its own (prompts, band, a reranker's top and wait), a key of your own or another `baseUrl` drops the
profile's key (it is never sent elsewhere), `rerank = false` turns its reranker off, a list of rerankers is your own.
The laptop profile has no reranker: a `rerank` there is a whole entry of your own.

| profile | embedding | reranker | MRR⁰ | search, p50 / p95 | memory |
| --- | --- | --- | --- | --- | --- |
| `laptop` | EmbeddingGemma 2 (Q8_0), 4 CPU threads | none | 0.600 | 15 / 19 ms | 0.8 GB RAM |
| `beefy` | Qwen3-Embedding-8B (Q5_K_M), GPU | Qwen3-Reranker-0.6B (Q8_0), GPU, top 20 | 0.657 (fused 0.610)¹ | 114 / 215 ms | 9.6 GB GPU |
| `cloud` | Voyage `voyage-code-3` | Voyage `rerank-2.5`, top 30 | not measured yet | | |

⁰ laptop: the fused list over all 372 questions, nothing left out by the band (with its band, 0.005 less: see
"Each model's thresholds"), as measured 2026-11-03; with the titles of small pieces since (docs/benchmark.md, "Context
and tuning"), 0.592 with its band, and its files view 0.801. ¹ On hono, cobra and fd (171 questions), with the model's band, where the fused list
alone has 0.610; over all 372 questions the 8B's fused list has 0.628 against EmbeddingGemma 2's 0.600 and the old
beefy (Qwen3-Embedding-4B) 0.615.

With no profile and no `embedding`, the plugin runs the laptop's model itself: it downloads
`embeddinggemma-2-Q8_0.gguf` once (asked first; pinned by commit and SHA-256) into Neovim's data folder and starts the
`llama-server` on PATH with the laptop's arguments below, on a free port of 127.0.0.1, stopping it after 15 minutes
unused and when Neovim goes (`local_model` in `setup()` points at a GGUF or a llama-server of your own). The laptop
profile is the same model on a server you run.

The local profiles expect llama.cpp's `llama-server` on this machine: the embedding model at
`http://127.0.0.1:18120/v1`, the reranker at `http://127.0.0.1:18121/v1`. Each profile's notes writer writes in the background
(Qwen3.5-2B on the laptop's CPU, Qwen3-4B-Instruct-2507 on beefy's GPU, both at `http://127.0.0.1:18122/v1`, on unless
`notes = false`; Claude Haiku 5.5 in the cloud, only with `notes = true`): [notes.md](notes.md). `:checkhealth semantic-grep` names the
profile and each model nothing answers for ("unreachable"), with where it looked.

## Running the models

GGUF files from Hugging Face:

| model | file |
| --- | --- |
| EmbeddingGemma 2 | [ggml-org/embeddinggemma-2-GGUF](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF) `embeddinggemma-2-Q8_0.gguf` (310 MB) |
| Qwen3-Embedding-8B | [Qwen/Qwen3-Embedding-8B-GGUF](https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF) `Qwen3-Embedding-8B-Q5_K_M.gguf` (5.4 GB) |
| Qwen3-Reranker-0.6B | [ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) `qwen3-reranker-0.6b-q8_0.gguf` (640 MB) |

laptop:

```sh
CUDA_VISIBLE_DEVICES= llama-server --model embeddinggemma-2-Q8_0.gguf --alias embeddinggemma-2 --host 127.0.0.1 --port 18120 \
  --embedding --pooling mean --ctx-size 8192 --batch-size 2048 --ubatch-size 2048 --parallel 1 --gpu-layers 0 --threads 4
```

beefy (one 16 GB card; pick it with `CUDA_VISIBLE_DEVICES`):

```sh
llama-server --model Qwen3-Embedding-8B-Q5_K_M.gguf --alias qwen3-embedding-8b --host 127.0.0.1 --port 18120 \
  --embedding --pooling last --ctx-size 8192 --batch-size 2048 --ubatch-size 2048 --parallel 1 --gpu-layers 99
llama-server --model qwen3-reranker-0.6b-q8_0.gguf --alias qwen3-reranker-0.6b --host 127.0.0.1 --port 18121 \
  --rerank --ctx-size 16384 --batch-size 2048 --ubatch-size 2048 --gpu-layers 99
```

As systemd user services that start with your session, one file each in `~/.config/systemd/user/`
(`semantic-grep-embeddings.service` here; the reranker's is the same with its own line), then
`systemctl --user daemon-reload && systemctl --user enable --now semantic-grep-embeddings semantic-grep-rerank`:

```ini
[Unit]
Description=semantic-grep embeddings (llama.cpp)

[Service]
Environment=CUDA_VISIBLE_DEVICES=0
ExecStart=/usr/local/bin/llama-server --model %h/models/Qwen3-Embedding-8B-Q5_K_M.gguf --alias qwen3-embedding-8b --host 127.0.0.1 --port 18120 --embedding --pooling last --ctx-size 8192 --batch-size 2048 --ubatch-size 2048 --parallel 1 --gpu-layers 99
Nice=10
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

cloud: a key from [Voyage](https://dash.voyageai.com/) in `$VOYAGE_API_KEY` (the profile names it by `apiKeyEnv`; it
is never written in the config). `cloud-openai` and `cloud-gemini` in `bench/profiles.json` are the same with
OpenAI's `text-embedding-3-large` and Cohere's `rerank-v3.5`, or Gemini's embeddings and Jina's reranker: copy their
entries into `setup()`. They are checked as configs and their /rerank answers against fakes; their numbers are to come,
`VOYAGE_API_KEY=… npm run bench -- --profile cloud`.

## How they were chosen

Budgets: laptop, search and rerank under about 300 ms on 4 CPU threads, models under about 2 GB of RAM; beefy, under
about 200 ms on one GPU; cloud, the best quality at a sane cost. Every candidate GGUF ran on the same llama.cpp
(`llama-server` build 3828), one at a time, at nice 19, on a machine with 12 cores, 125 GB of RAM and two RTX 5060 Ti
16 GB, shared with other work. Quality is the same on a CPU and a GPU (the same vectors), so every model's quality
was measured on the GPU over all 372 questions, and the laptop's candidates were timed again on 4 CPU threads, built
afresh on cobra and fd (1892 pieces, 123 questions). Each candidate is a profile of
[`bench/candidates.json`](../bench/candidates.json) (`npm run bench -- --profiles bench/candidates.json --profile gpu-qwen8b`);
the runs are in [`bench/results/profiles-2026-11-03/`](../bench/results/profiles-2026-11-03/), on this change's code
(uncommitted then: their `changed` field lists the changed files, not the new ones).

### Embedding models

Fused MRR is the list the picker shows once meaning came (words and meaning by reciprocal rank); each model with
every piece in its band (see below). Build: a first index, seconds per thousand pieces.

| model | params | fused R@1 | R@5 | R@10 | MRR meaning | MRR fused | GPU ms p50/p95 | GPU build s/1k | GPU MB | CPU query ms p50/p95 | CPU build s/1k | CPU RAM MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [EmbeddingGemma 300M](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF) Q8_0 | 300M | 0.449 | 0.772 | 0.855 | 0.584 | 0.589 | 6 / 8 | 6² | 624 | 12 / 15 | 76 | 640 |
| [EmbeddingGemma 2](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF) Q8_0 | 270M text | 0.473 | 0.766 | 0.831 | 0.581 | **0.600** | 7 / 9 | 8 | 624 | 15 / 19 | 108 | 783 |
| [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF) Q8_0 | 0.6B | 0.411 | 0.726 | 0.831 | 0.523 | 0.550 | 7 / 10 | 11 | 1792 | 46 / 58 | 221 | 1885 |
| [jina-embeddings-v2-base-code](https://huggingface.co/ggml-org/jina-embeddings-v2-base-code-Q8_0-GGUF) Q8_0 | 161M | 0.358 | 0.667 | 0.747 | 0.450 | 0.495 | 5 / 8 | 5 | 472 | | | |
| [snowflake-arctic-embed-l-v2.0](https://huggingface.co/Casual-Autopsy/snowflake-arctic-embed-l-v2.0-gguf) Q8_0 | 568M | 0.438 | 0.710 | 0.809 | 0.550 | 0.563 | 7 / 10 | 10 | 544 | | | |
| [jina-code-embeddings-0.5b](https://huggingface.co/jinaai/jina-code-embeddings-0.5b-GGUF) Q8_0³ | 0.5B | 0.430 | 0.750 | 0.852 | 0.541 | 0.565 | 6 / 9 | 8 | 930 | | | |
| [jina-code-embeddings-1.5b](https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF) Q8_0³ | 1.5B | 0.446 | 0.742 | 0.847 | 0.530 | 0.571 | 10 / 13 | 15 | 2244 | | | |
| [Qwen3-Embedding-4B](https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF) Q8_0 | 4B | 0.487 | 0.788 | 0.866 | 0.595 | 0.615 | 19 / 24 | 29² | 5720 | | | |
| [Qwen3-Embedding-8B](https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF) Q5_K_M | 8B | **0.500** | **0.809** | **0.866** | **0.616** | **0.628** | 26 / 33 | 62 | 6936 | | | |
| [nomic-embed-code](https://huggingface.co/nomic-ai/nomic-embed-code-GGUF) Q4_K_M | 7B | failed⁴ | | | | | | ~400 | | | | |

² Its vectors were reused from the baseline run; the build time is the baseline's (docs/benchmark.md).
³ CC BY-NC 4.0: not for commercial use.
⁴ Its server stopped answering a quarter of the way into the first build (`UND_ERR_SOCKET`), at about 400 s a thousand
pieces on the GPU; not run again: at that speed it is no candidate for a first build of a large project.

- **laptop: EmbeddingGemma 2.** The best of the small ones (fused MRR 0.600, recall@1 0.473), 15 ms a query on 4
  threads, 0.8 GB. EmbeddingGemma 300M is close (0.589) and a third faster to build (76 s against 108 s a thousand on
  4 threads: a 10,000-piece project in 13 rather than 18 minutes); serve `embeddinggemma-300M-Q8_0.gguf` at 18120
  instead (`--alias embeddinggemma-300M --pooling mean`) and set `embedding = {model = 'embeddinggemma-300M'}`. The code-specific small models (jina's, snowflake's, Qwen3 0.6B) did worse on these questions, which are
  worded the way people search, not like code.
- **beefy: Qwen3-Embedding-8B.** The best on every number; 26 ms a query, 6.9 GB of a card. The 4B is 0.013 behind at
  5.7 GB and builds twice as fast.

### Rerankers

A cross-encoder (`api = 'rerank'`) reads the search with each of the first `top` pieces (`chars` characters of each)
and every piece it read takes its place by its score. On hono, cobra and fd (171 questions; the CPU ones on cobra and
fd, 123), after each profile's own embedding model:

| embedding | reranker | where | top | chars | fused MRR | rerank R@1 | R@5 | MRR | search ms p50/p95 | memory MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EmbeddingGemma 2 | [jina-reranker-v2-base-multilingual](https://huggingface.co/gpustack/jina-reranker-v2-base-multilingual-GGUF)³ | GPU | 10 | 500 | 0.586 | 0.398 | 0.731 | 0.540 | 24 / 32 | 304 |
| EmbeddingGemma 2 | [bge-reranker-v2-m3](https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF) | GPU | 10 | 500 | 0.586 | 0.433 | 0.737 | 0.561 | 50 / 68 | 644 |
| EmbeddingGemma 2 | Qwen3-Reranker-0.6B | GPU | 10 | 500 | 0.586 | 0.503 | 0.760 | 0.610 | 62 / 76 | 2718 |
| EmbeddingGemma 2 | jina-reranker-v2-base-multilingual | 4 CPU threads | 10 | 500 | 0.583 | 0.423 | 0.748 | 0.562 | 387 / 582 | 679 RAM |
| EmbeddingGemma 2 | bge-reranker-v2-m3 | 4 CPU threads | 10 | 500 | 0.583 | 0.455 | 0.764 | 0.578 | 1244 / 1876 | 1010 RAM |
| EmbeddingGemma 2 | Qwen3-Reranker-0.6B | 4 CPU threads | 10 | 500 | 0.583 | 0.537 | 0.764 | 0.630 | 2244 / 2950 | 2776 RAM |
| Qwen3-Embedding-8B | Qwen3-Reranker-0.6B | GPU | 30 | 1200 | 0.610 | 0.520 | 0.825 | 0.646 | 116 / 282 | 2722 |
| Qwen3-Embedding-8B | **Qwen3-Reranker-0.6B** | GPU | **20** | 1200 | 0.610 | 0.538 | 0.825 | **0.657** | **114 / 215** | 2720 |
| Qwen3-Embedding-8B | [Qwen3-Reranker-4B](https://huggingface.co/Voodisss/Qwen3-Reranker-4B-GGUF-llama_cpp) Q8_0 | GPU | 10 | 1200 | 0.610 | 0.614 | 0.830 | 0.701 | 308 / 492 | 6918 |
| Qwen3-Embedding-8B | Qwen3-Reranker-4B Q8_0 | GPU | 30 | 1200 | 0.610 | 0.608 | 0.848 | 0.704 | 427 / 1284 | 6920 |

The d1-2B decision model (the laptop's before) gave MRR 0.625 from 0.582 at 2.6 / 4.5 s on 4 CPU threads (baseline,
docs/benchmark.md).

- **laptop: no reranker.** None fits a picker's wait on 4 CPU threads: the smallest (jina's, 278M) takes 0.4 s for
  ten pieces and makes the list worse, as bge's does; Qwen3-Reranker-0.6B is the only one that helps (MRR 0.583 to
  0.630, recall@1 0.455 to 0.537) and takes 2.2 s. A laptop that can wait two seconds after the pause gains that:
  `rerank = {api = 'rerank', baseUrl = 'http://127.0.0.1:18121/v1', model = 'qwen3-reranker-0.6b', top = 10, chars = 500, timeoutMs = 4000}`
  with its server on 4 threads.
- **beefy: Qwen3-Reranker-0.6B, top 20.** MRR 0.610 to 0.657 and recall@1 0.480 to 0.538 at the budget: p50
  114 ms for the whole search, p95 215 ms, a little over the 200; top 30 was no better and slower. Qwen3-Reranker-4B
  is much better (0.701, recall@1 0.614) at three times the time and 4.2 GB more (6.9 GB against 2.7): on a card with room, and a picker that may wait half a second,
  `rerank = {model = 'qwen3-reranker-4b', top = 10, timeoutMs = 2000}` with its server at 18121 instead.
- **Every piece it read in the cross-encoder's order.** The cross-encoders above all move the whole top `top`; the
  decision models only their first choice, when it stands out. The full order is what the numbers measure.

### Each model's thresholds

`band` (how far below the best piece a piece may mean and still be listed) and `pickNear` (how close a search must
mean to one you opened a piece for, for that piece to go first) were constants, 0.1 and 0.75, set for EmbeddingGemma
300M. Models spread their similarities very differently: EmbeddingGemma 2 rates unrelated searches 0.62 (median)
where snowflake's rates them 0.19. `npm run bench:calibrate -- --profile NAME --run FILE` measures both from a run
with a band wide enough to leave nothing out:

- **band**: the 95th percentile of how far below the best piece the right one means, over the questions answered;
- **pickNear**: the 99.9th percentile of the similarity of unrelated questions (same repository, other files), so
  that among the thousands of searches a project keeps, a new one rarely comes near a wrong one.

| model | band | pickNear | unrelated p50 / p99.9 | other searches for the same lines, p50 |
| --- | --- | --- | --- | --- |
| EmbeddingGemma 300M | 0.12 | 0.71 | 0.25 / 0.71 | 0.54 |
| EmbeddingGemma 2 | 0.06 | 0.85 | 0.62 / 0.84 | 0.77 |
| Qwen3-Embedding-0.6B | 0.14 | 0.79 | 0.36 / 0.79 | 0.66 |
| Qwen3-Embedding-4B | 0.12 | 0.78 | 0.33 / 0.78 | 0.66 |
| Qwen3-Embedding-8B | 0.12 | 0.79 | 0.34 / 0.78 | 0.67 |
| jina-embeddings-v2-base-code | 0.15 | 0.79 | 0.19 / 0.78 | 0.60 |
| snowflake-arctic-embed-l-v2.0 | 0.15 | 0.66 | 0.19 / 0.65 | 0.48 |
| jina-code-embeddings-0.5b | 0.16 | 0.74 | 0.13 / 0.73 | 0.55 |
| jina-code-embeddings-1.5b | 0.15 | 0.71 | 0.12 / 0.70 | 0.54 |

They are known by the model's name (`src/embedder.mjs`); `band` and `pickNear` in the `embedding` entry set them for
another model. A model not in the table keeps 0.1 and 0.75. They were measured at each model's own number of
dimensions: with fewer (`dimensions`), set them yourself.

The learned picks go first only for a search worded close to the one they were opened for: with these values, other
searches for the same lines reach it 6 to 14% of the time (EmbeddingGemma 2: 7%), the same search typed again always.
EmbeddingGemma 2's earlier constants (0.1 and 0.75) let unrelated searches through: half of them reach 0.62. The band leaves out what means little, so a search that
matches nothing well shows little; it costs a little of the right answers past it: on hono, cobra and fd the fused
MRR is 0.586 with EmbeddingGemma 2's band against 0.591 with none, and 0.610 against 0.616 for Qwen3-Embedding-8B.
The quality tables above are without it (`"band": 2`), so models are compared on their lists, not their bands; the
reranker table is with each model's band, as the plugin runs it.
