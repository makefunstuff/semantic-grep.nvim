# Benchmark

How well does a search find what a person means? `npm run bench` measures it: six public repositories pinned by
commit, 372 questions written the way people type them, each asked four ways.

```sh
npm run bench:fetch                       # the repositories, into ~/.cache/semantic-grep-bench/repos
npm run bench -- --profile words          # no model
npm run bench -- --profile laptop --models /path/to/gguf --llama-server /path/to/llama-server
npm run bench -- --profile beefy --models /path/to/gguf --compare bench/results/laptop-2026-11-03.json
```

## What is measured

Each question is asked as the plugin asks it:

| mode | what | in the picker |
| --- | --- | --- |
| `words` | SQLite FTS5, BM25: pieces with every word of the question (stop words left out) | on every key |
| `meaning` | the question's vector against every piece's, cosine | after the pause |
| `fused` | both lists fused by reciprocal rank | `:SemanticGrep` with `vim.ui.select`, the library's `search` |
| `rerank` | the fused list, its first pieces reordered by the profile's reranker | once the list settles |

A result answers a question when it is in the labelled file and its lines overlap the labelled range (or one of the
question's `also` places). For each mode: **recall@1/5/10** (the share of questions answered within the first 1, 5,
10 results), **MRR** (the mean of 1/rank of the first answer, 0 past 30 results) and the **p50/p95 latency** of the
whole search in milliseconds, including embedding the question and the rerank. Per repository, overall, and by the
style of question. Each run is saved as JSON (`bench/results/<profile>-<date>.json`, with every question's rank and
time), and `--compare FILE` prints the change against an earlier one.

Flags: `--repos hono,flask`, `--split dev|test`, `--modes words,fused`, `--questions FILE`, `--out FILE`, `--fresh`
(index again; otherwise a run reuses the vectors in the cache), `--parsers none` (cut pieces by indentation, not
Neovim's tree-sitter), `--profiles FILE` (your own profiles), `--cache DIR`.

## The corpus

[`bench/corpus.json`](../bench/corpus.json), fetched by `bench/fetch.mjs` (one shallow fetch of each commit, not
vendored):

| name | repository | language | files | pieces |
| --- | --- | --- | --- | --- |
| hono | honojs/hono | TypeScript | 572 | 4186 |
| telescope | nvim-telescope/telescope.nvim | Lua | 103 | 1558 |
| flask | pallets/flask | Python (and its docs) | 227 | 1589 |
| cobra | spf13/cobra | Go | 64 | 1021 |
| fd | sharkdp/fd | Rust | 57 | 871 |
| vue-docs | vuejs/docs | Markdown: documentation | 437 | 1902 |

Pieces are cut with the tree-sitter parsers of the Neovim on the machine (50 here), as the plugin cuts them; with
others the pieces differ a little, the labels (lines) do not.

## The questions

[`bench/questions.jsonl`](../bench/questions.jsonl): 372 questions, one JSON line each:

```json
{"id": "flask-025", "repo": "flask", "query": "env var values parsed as json for config", "file": "docs/config.rst", "from": 603, "to": 606, "style": "vague", "split": "test"}
```

22 pieces of each repository were drawn at random (seeded; at most a sixth of them tests, one per file; no lockfiles,
changelogs or data). For each, Claude read the piece in its file and wrote 3 to 5 searches a developer would type to
land there, without its identifiers, file names or literal strings, and labelled each with the lines that answer it
(narrowed where only part of the piece does, with other places that answer as well in `also`). Pieces nobody would
search for (bare imports, a licence header, a frontmatter, a benchmark file the same as its siblings) were left out:
16 of 132. Styles: `vague` (short, typed before knowing the names: "fake current time in tests"), `plain` (a plain
description: "error when more than one flag from an exclusive group is set") and `multi-hop` (a purpose with a context,
or a symptom: "why does my completion still show descriptions I disabled with an environment variable").

A third of the pieces, with all their questions, are `dev` (121 questions) and the rest `test` (251): tune on
`--split dev`, report `--split test`. The pieces were drawn before anything was tuned on them.

A sample of 37 questions (one in ten, seeded) was read by hand against its labelled lines: all are realistic
searches and answered by their label; one (`telescope-037`, "picker listing ctags entries…") is labelled with a block
that holds that picker among two others, a few name the thing tested ("test that …") rather than the code, and a
handful of thin pieces (an old helper kept for compatibility, a link-only docs section) are easy to miss for any
search. Recall here is a floor: a search can find a right answer the labels do not list.

## Your own searches

The plugin keeps each search you made and the piece you opened for it (see the README, "It learns"). Exported, they
are a private questions file, outside this repository and outside the project, and run through the same bench:

```sh
npm run bench:export -- --root ~/code/app            # ~/.cache/semantic-grep-bench/private/app-picks.jsonl
npm run bench -- --profile laptop --questions ~/.cache/semantic-grep-bench/private/app-picks.jsonl
```

`repo` is then the project's path, and the run is saved in the cache, not in `bench/results`. The bench indexes the
project afresh in its own data folder, so what the plugin learned does not answer for it. These are searches whose
piece was found (else you would not have opened it): they tell whether what works keeps working, not what is missed.

## Profiles

[`bench/profiles.json`](../bench/profiles.json); each entry is the plugin's `embedding` and `rerank` config, so a
profile that measures well is one to copy into `setup()`. A local profile's `serve` says how to start its models:
when nothing answers at its `baseUrl`, the bench starts `llama-server` (`--llama-server`, `$LLAMA_SERVER` or the one
on the PATH) with the GGUF found under `--models` (or `$SEMANTIC_GREP_BENCH_MODELS`), at nice 19, and stops it at
the end. A server already answering there is used as it is.

- **words**: no model.
- **laptop**: CPU only (llama.cpp with `CUDA_VISIBLE_DEVICES=""`, 4 threads each), about 16 GB of RAM:
  [EmbeddingGemma 300M](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF) Q8_0 and the d1-2B decision model
  (`system-one`, top 15) — the setup the README suggests.
- **beefy**: one GPU of 16 GB, about 6 GB of it: [Qwen3-Embedding-4B](https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF)
  Q8_0 and the [Qwen3-Reranker-0.6B](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) cross-encoder
  (`rerank`, `llama-server --rerank`, top 30). Choose the card with `CUDA_VISIBLE_DEVICES`.
- **cloud**: [Voyage](https://docs.voyageai.com/) `voyage-code-3` embeddings and `rerank-2.5`, the key in
  `$VOYAGE_API_KEY`. Voyage's `/v1/embeddings` takes OpenAI's shape; the prompts it adds for `input_type` are set as
  `queryPrefix`/`documentPrefix`. Also **cloud-openai** (`text-embedding-3-large` at 1024 dimensions, Cohere
  `rerank-v3.5`) and **cloud-gemini** (`gemini-embedding-001` through Gemini's OpenAI-compatible endpoint, Jina's
  reranker). A key is named, never written: `apiKeyEnv`.

The cloud profiles are configured and their wire formats tested with fakes (`test/bench.test.mjs`,
`test/rerank.test.mjs`); they have not been measured yet, for want of a key. With one:
`VOYAGE_API_KEY=… npm run bench -- --profile cloud`, and add the numbers below.

## Results

RESULTS_HERE
