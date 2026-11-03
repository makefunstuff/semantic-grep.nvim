# Benchmark

How well does a search find what a person means? `npm run bench` measures it: six public repositories pinned by
commit, 372 questions written the way people type them, each asked four ways.

```sh
npm run bench:fetch                       # the repositories, into ~/.cache/semantic-grep-bench/repos
npm run bench -- --profile words          # no model
npm run bench -- --profile laptop --models /path/to/gguf --llama-server /path/to/llama-server
CUDA_VISIBLE_DEVICES=0 npm run bench -- --profile beefy --models /path/to/gguf --compare bench/results/laptop-2026-11-03.json
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
whole search in milliseconds, including embedding the question and the rerank. A rerank the model could not give
(it timed out, failed, or is resting a minute after a failure) keeps the fused order, as in the picker, and counts
in `rerank` all the same; the run says how many were applied (`reranks:`). The local profiles give the reranker 20 s
where the plugin's default is 3 s, so that the rerank is measured, not its timeout: its p95 says whether it fits a
picker's wait, and the `timeoutMs` to set in `setup()`. Per repository, overall, and by the
style of question. Each run is saved as JSON (`bench/results/<profile>-<date>.json`, with every question's rank and
time; a run saved under its default name never overwrites an earlier one), and `--compare FILE` prints the change against an earlier one, and
whether it asked the same questions.

Flags: `--repos hono,flask`, `--split dev|test`, `--modes words,fused`, `--questions FILE`, `--out FILE`, `--fresh`
(index again; otherwise a run reuses the index and vectors in the cache), `--parsers none` (cut pieces by indentation, not
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
search. Recall here is a floor: a search can find a right answer the labels do not list. Some questions use the
plain word a file is named by ("config", "yaml", "computed": 38 of 372), and one names an identifier (`hono-003`,
"createElement"); words alone owe some of their `vague` score to them.

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
profile that measures well is one to copy into `setup()` (with the `timeoutMs` its p95 asks for). A local profile's `serve` says how to start its models:
when nothing answers at its `baseUrl`, the bench starts `llama-server` (`--llama-server`, `$LLAMA_SERVER` or the one
on the PATH) with the GGUF found under `--models` (or `$SEMANTIC_GREP_BENCH_MODELS`), at nice 19, and stops it at
the end. A server already answering there is used as it is.

- **words**: no model.
- **laptop**: CPU only (llama.cpp with `CUDA_VISIBLE_DEVICES=""`, 4 threads each), about 16 GB of RAM:
  [EmbeddingGemma 300M](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF) Q8_0 and the d1-2B decision model
  (`system-one`, top 15) — the setup the README suggests.
- **beefy**: one GPU of 16 GB, about 6 GB of it: [Qwen3-Embedding-4B](https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF)
  Q8_0 and the [Qwen3-Reranker-0.6B](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) cross-encoder
  (`rerank`, `llama-server --rerank`, top 30, reading 1200 characters of each piece). Choose the card with
  `CUDA_VISIBLE_DEVICES`.
- **cloud**: [Voyage](https://docs.voyageai.com/) `voyage-code-3` embeddings and `rerank-2.5`, the key in
  `$VOYAGE_API_KEY`. Voyage's `/v1/embeddings` takes OpenAI's shape; the prompts it adds for `input_type` are set as
  `queryPrefix`/`documentPrefix`. Also **cloud-openai** (`text-embedding-3-large` at 1024 dimensions, Cohere
  `rerank-v3.5`) and **cloud-gemini** (`gemini-embedding-001` through Gemini's OpenAI-compatible endpoint, Jina's
  reranker). A key is named, never written: `apiKeyEnv`.

The cloud profiles are configured, checked as valid configs with their keys named by environment variable
(`test/bench.test.mjs`), and the /rerank answers of llama.cpp, Cohere, Jina and Voyage are tested against fakes
(`test/rerank.test.mjs`); embeddings use the same OpenAI-shaped `/v1/embeddings` the local profiles do. They have not
been measured yet, for want of a key. With one:
`VOYAGE_API_KEY=… npm run bench -- --profile cloud`, and add the numbers below.

## Results

The baseline, 2026-11-03, on the code of this change with nothing uncommitted (Node 25.2, 50 tree-sitter parsers);
`laptop` and `beefy` built their indexes afresh and started their own llama.cpp servers from the profiles' `serve`
entries (EmbeddingGemma 300M Q8_0 and d1-2B Q8_0 on the CPU; Qwen3-Embedding-4B Q8_0 and Qwen3-Reranker-0.6B Q8_0 on
one GPU); the runs, with every question's rank and time, are
[`words`](../bench/results/words-2026-11-03.json), [`laptop`](../bench/results/laptop-2026-11-03.json) and
[`beefy`](../bench/results/beefy-2026-11-03.json). Machine: 12 cores, 125 GB, two RTX 5060 Ti 16 GB, shared with other
work; one run at a time, every model at nice 19. The words' latency is the `words` run's; within the other runs it is
1 to 2 ms, the machine busy with their models.

Overall, 372 questions:

| | R@1 | R@5 | R@10 | MRR | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| words (the `words` run) | 0.097 | 0.140 | 0.142 | 0.115 | 0.2 | 0.7 |
| laptop meaning | 0.446 | 0.755 | 0.825 | 0.575 | 14 | 18 |
| laptop fused | 0.452 | 0.761 | 0.831 | 0.582 | 14 | 18 |
| laptop rerank (d1-2B, CPU) | 0.511 | 0.782 | 0.831 | 0.625 | 2633 | 4497 |
| beefy meaning | 0.460 | 0.766 | 0.820 | 0.585 | 17 | 21 |
| beefy fused | 0.484 | 0.774 | 0.831 | 0.605 | 18 | 23 |
| beefy rerank (Qwen3-Reranker-0.6B, GPU) | 0.489 | 0.812 | 0.855 | 0.625 | 84 | 261 |

MRR on the `test` split alone (251 questions; `dev` in brackets, 121):

| | words | meaning | fused | rerank |
| --- | --- | --- | --- | --- |
| laptop | 0.105 (0.136) | 0.600 (0.523) | 0.606 (0.533) | 0.622 (0.630) |
| beefy | 0.105 (0.136) | 0.593 (0.567) | 0.610 (0.593) | 0.630 (0.615) |

MRR per repository:

| | hono | telescope | flask | cobra | fd | vue-docs |
| --- | --- | --- | --- | --- | --- | --- |
| words | 0.111 | 0.079 | 0.134 | 0.158 | 0.047 | 0.168 |
| laptop meaning | 0.609 | 0.488 | 0.524 | 0.580 | 0.576 | 0.692 |
| laptop fused | 0.590 | 0.500 | 0.544 | 0.599 | 0.573 | 0.701 |
| laptop rerank | 0.672 | 0.539 | 0.605 | 0.605 | 0.653 | 0.695 |
| beefy meaning | 0.524 | 0.516 | 0.522 | 0.605 | 0.598 | 0.739 |
| beefy fused | 0.565 | 0.540 | 0.567 | 0.617 | 0.589 | 0.748 |
| beefy rerank | 0.556 | 0.563 | 0.548 | 0.688 | 0.652 | 0.741 |

MRR by style (vague 119, plain 137, multi-hop 116 questions):

| | vague | plain | multi-hop |
| --- | --- | --- | --- |
| words | 0.206 | 0.119 | 0.017 |
| laptop fused | 0.628 | 0.676 | 0.426 |
| laptop rerank | 0.682 | 0.714 | 0.461 |
| beefy fused | 0.627 | 0.687 | 0.484 |
| beefy rerank | 0.641 | 0.716 | 0.502 |

A first build of all six (11,127 pieces): 16.6 minutes on 4 CPU threads (EmbeddingGemma 300M), 5.4 minutes on the
GPU (Qwen3-Embedding-4B); four pieces a request either way.

What it says:

- **Words alone find little of what people type**: recall@10 0.14, and 0.017 on multi-hop questions. A piece must have
  every word of the question, and people's words are rarely the code's. In the picker the words are what shows on
  every key; meaning is what finds.
- **Meaning does the work, and the small model holds up**: EmbeddingGemma 300M on a CPU (MRR 0.575) is within 0.01 of
  Qwen3-Embedding-4B on a GPU (0.585); fusing the words adds 0.01 to 0.02.
- **The rerank helps, at a price**: d1-2B lifts MRR from 0.582 to 0.625 and recall@1 from 0.45 to 0.51, but takes
  2.6 s (p50) to 4.5 s (p95) on 4 CPU threads, past the plugin's default `timeoutMs` of 3 s; 104 of its 372 answers
  were flat (no piece stood out), and the search's order was kept. The cross-encoder on a GPU gives the same MRR in
  84 ms (p95 261 ms), and adds most to recall@5 (0.774 to 0.812).
- **A cross-encoder needs to read the piece**: Qwen3-Reranker-0.6B reading 160 characters of each piece made the list
  worse; tried on the `dev` questions in one-off runs (not kept), its MRR was 0.488 at 160 characters, 0.595 at 500
  and 0.615 at 1200, against the fused list's 0.593. 1200 is the default for `api = 'rerank'` now (`chars` in the
  entry changes it); the `test` split, not tuned on, shows the same gain (0.610 to 0.630).
- **Multi-hop questions are the hardest** for every mode (fused MRR 0.43 to 0.48 against 0.63 to 0.69).
- 21 to 24 questions had nothing to rerank: meaning keeps only the pieces within 0.1 of the best, and those lists were
  one piece long (a right one for all but 3 or 4 of them).

Not measured yet: the cloud profiles (no key), a cross-encoder on the laptop's CPU, and EmbeddingGemma on a GPU.
