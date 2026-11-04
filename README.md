# semantic-grep.nvim

Write a plain sentence, get the files it is about. `:SemanticGrep files where search results are reranked` lists the
files of the project that answer it, best first, each at its best matching line; Enter opens it there. A small model
runs on your own machine, on the CPU (EmbeddingGemma 2, 310 MB, under 1 GB of RAM): no service, no key, nothing to
set up.

## Install (lazy.nvim)

```lua
{'makefunstuff/semantic-grep.nvim', dependencies = {'nvim-telescope/telescope.nvim'}, cmd = 'SemanticGrep', opts = {}}
```

Then `:SemanticGrep files` and a sentence. The first time, it asks to download the model (310 MB, once, into Neovim's
data folder) and searches by words meanwhile. It runs the model with llama.cpp's `llama-server`, which must be on
PATH (`brew install llama.cpp`, `winget install llama.cpp`, `nix profile install nixpkgs#llama-cpp`, or a release from
[llama.cpp](https://github.com/ggml-org/llama.cpp/releases)); it starts it on a free local port and stops it after 15 minutes unused or when
Neovim goes. Without it, the search works by words alone and `:checkhealth semantic-grep` says what is missing.
On the [benchmark](docs/benchmark.md)'s questions, the right file is among the first five 95% of the time, in about
20 ms a search on 4 CPU threads.

## Pieces of code

The files view is one of two. The other finds the pieces of code themselves: a live picker that works like `live_grep`: on every key
it shows the pieces of code that have your words (identifiers split, so `removeUserFromTeam` is also remove, user,
from and team; comments and strings too). Pause for 150 ms and the pieces closest to what you *mean* join the list
below them, so nothing you already see moves. With a decision model set, the first pieces are then reranked in
place, and the piece you are on stays selected.

The words work with no model at all (SQLite FTS5, BM25, stemming). Meaning needs an embedding model: the small local
one by default, or any behind an OpenAI-compatible `/v1/embeddings` (llama.cpp's `llama-server --embeddings`, Ollama,
LM Studio, vLLM, a cloud API). Three profiles name the models measured best for a machine: `laptop` (CPU only, the
default's model on a server of your own), `beefy` (a GPU) and `cloud` (hosted APIs);
[docs/profiles.md](docs/profiles.md) has their numbers and how to run each model's server.

## Requirements

- Neovim 0.10 or later (0.12 shows indexing progress in the statusline/fidget)
- Node 22.16 or later (`node:sqlite` with FTS5; no npm install, no native dependencies)
- git (or ripgrep) to list the project's files
- For search by meaning with no setup: llama.cpp's `llama-server` on PATH (above)
- Optional: [telescope.nvim](https://github.com/nvim-telescope/telescope.nvim) (preferred),
  [snacks.nvim](https://github.com/folke/snacks.nvim)'s picker or [fzf-lua](https://github.com/ibhagwan/fzf-lua);
  without them, `vim.ui.select`

## Keys and profiles

```lua
{
  'makefunstuff/semantic-grep.nvim',
  dependencies = {'nvim-telescope/telescope.nvim'},
  cmd = 'SemanticGrep',
  keys = {
    {'<leader>sm', '<cmd>SemanticGrep files<cr>', desc = 'Files by meaning'},
    {'<M-s>', '<cmd>SemanticGrep<cr>', desc = 'Search by meaning'},
    {'<M-s>', function() require('semantic-grep').find(require('semantic-grep').selected()) end, mode = 'x', desc = 'Search the selection by meaning'},
  },
  opts = {}, -- or {profile = 'beefy'} ('laptop', 'cloud'): models of your own, see docs/profiles.md to start them
}
```

The plugin sets no keymaps; these are suggestions. As a Telescope extension:
`require('telescope').load_extension('semantic_grep')`, then `:Telescope semantic_grep files` or `:Telescope semantic_grep`.

## Configuration

```lua
require('semantic-grep').setup({
  -- The embedding and rerank models measured for a machine (docs/profiles.md): 'laptop', 'beefy' or 'cloud'. What
  -- `embedding` and `rerank` set goes over the profile's (embedding = {baseUrl = ...} moves it; another model drops
  -- the profile's settings for its own); rerank = false turns its reranker off.
  profile = nil,
  -- With no `embedding` and no profile: the small local model, EmbeddingGemma 2 Q8_0, downloaded once when you say so
  -- (or `gguf`, a file of your own) and served by `llama_server` (default the one on PATH) on `threads` CPU threads
  -- (4, fewer on a smaller CPU); it stops after 15 minutes unused and starts again at the next search. false: words only.
  local_model = {gguf = nil, llama_server = 'llama-server', threads = nil},
  -- An OpenAI-compatible /v1/embeddings. Known prompts are added for EmbeddingGemma, nomic-embed-text/-code and
  -- Qwen3-Embedding; set queryPrefix/documentPrefix for another ({title} in documentPrefix places each piece's
  -- file and name; without it they are the piece's first line). Key: apiKey, apiKeyFile or apiKeyEnv. band: how far
  -- below the best piece a piece may mean and still be listed; pickNear: how close a search must mean to one you
  -- opened a piece for, for that piece to go first. Both are measured per model (docs/profiles.md); 0.1 and 0.75 for
  -- a model not measured.
  embedding = {api = 'openai', baseUrl = 'http://127.0.0.1:8092/v1', model = 'embeddinggemma-2', dimensions = 768},
  -- A decision model, or a list of them best first (the next is asked when one fails or is slower than its
  -- timeoutMs; one that failed rests for a minute). api: 'system-one', 'llama-cpp', 'openai' (Decisions API) or
  -- 'rerank' (a cross-encoder's /rerank: llama.cpp's --rerank, Cohere, Jina, Voyage; it reorders every piece it reads).
  -- top: pieces it reads (2-30, default 10); timeoutMs: default 3000, 1000 for one another follows; chars: how much
  -- of each piece it reads (default 160, 1200 for 'rerank').
  rerank = {api = 'system-one', baseUrl = 'http://127.0.0.1:8091/v1', model = 'd1-2B', top = 15, timeoutMs = 2000},
  -- Notes on the pieces of code, written by a language model while nothing is searched (docs/notes.md): true for the
  -- profile's writer (the laptop's without a profile), or an entry over it, e.g. {model = 'qwen3.5-9b'}. api: 'openai'
  -- (/chat/completions: llama-server, Ollama, ...) or 'anthropic'; concurrency: pieces asked at once; chars: how much
  -- of each piece it reads; idleMs: how long without a search before it writes. On with the laptop and beefy profiles
  -- (their writers run on this machine), off without a profile and with the cloud's (it costs money); false turns it
  -- off. The code goes to a writer elsewhere than this machine only with sendCode = true.
  notes = nil,
  picker = 'auto',          -- 'telescope', 'snacks', 'fzf-lua' or 'select'
  debounce_ms = 150,        -- the pause before meaning is asked
  rerank_delay_ms = 0,      -- how long meaning's list must stay before it is reranked
  data_dir = nil,           -- default stdpath('data') .. '/semantic-grep'
  index = 'data',           -- or 'project': .semantic-grep/ in the repository, added to .git/info/exclude
  index_on_start = false,   -- index the project when Neovim starts, not at the first search
  node = 'node',
})
```

In the files view, `Enter` opens the file at its best line (in Telescope, `<C-q>` sends the files to quickfix). A file ranks by its
pieces among the first 60 of the search's (words and meaning fused): its best one, plus half the next, a quarter of
the one after, so a file with several close pieces goes above one with a single near one (docs/benchmark.md, "Files").

In the picker of pieces, `Enter` opens a piece at its line and `<C-q>` sends the list to quickfix in the order shown. A
quickfix list sent before the rerank came is reordered in place when it comes (unless you changed it meanwhile).

## It learns

- **What you open.** When you pick a result, your search is kept with that piece, beside the index (a rebuild keeps
  it). The same search, or one worded close to it, finds that piece first, by its words and by their meaning.
- **Notes from a coding agent.** A sentence per piece on what it does, in the words you would search with, is
  searched with its code and read by the reranker. Any agent can write them:

  ```sh
  # the plugin's bin/semantic-grep-server.mjs, e.g. with lazy.nvim:
  alias semantic-grep-server='node ~/.local/share/nvim/lazy/semantic-grep.nvim/bin/semantic-grep-server.mjs'
  semantic-grep-server notes pending --root . --limit 200 > pending.jsonl   # {hash, file, from, to, name, text}, or a
                                                                            # file: {kind: "file", file, notes}
  semantic-grep-server notes put --root . < notes.jsonl                     # {hash, note} or {file, note}, one a line
  ```

  For example, in Claude Code: "Run `semantic-grep-server notes pending --root . --limit 200`, write a one or two
  sentence note for each piece (what it does, what someone would be trying to do when they need it, in plain words,
  keeping its identifiers), and for each `{kind: "file"}` line one sentence on what the file is for from its pieces'
  notes; pipe `{hash, note}` and `{file, note}` lines into `semantic-grep-server notes put --root .`; repeat until
  none is pending." A note holds while its piece's code does not change; `pending` then lists it again. Both
  commands take `--data-dir` (default Neovim's), `--index` and `--project-dir`, as `setup` has them. The code goes
  to the agent's model.
- **Notes written in the background.** With the `laptop` or `beefy` profile (or `notes = true` in `setup()`), a
  language model writes those notes itself, while nothing is searched (for 30 s, or 2 minutes on the laptop), a few
  pieces at a time, starting near the file you are in, and stops at the next search: the profile's writer, a small
  model on the CPU for the laptop, a bigger one on the GPU for beefy, Claude Haiku for the cloud (only with
  `notes = true`: it costs money). Once a file's pieces have theirs, it writes one on the file, from them: what the
  file is for, which titles its small pieces. `notes = false` turns them off. `semantic-grep-server notes write --root . --profile beefy` writes them all at once. A writer
  that is not on this machine gets no code unless its entry says `sendCode = true` (the cloud profile's does). How to
  run each, what they cost and what they gain: [docs/notes.md](docs/notes.md). On the bench, Claude Haiku 5.5's notes
  (measured through OpenRouter, with the laptop's embedding model) take the pieces' MRR from 0.544 to 0.605 and the files view's from 0.725 to 0.760,
  for 10 cents a thousand pieces.

## Commands

| | |
| --- | --- |
| `:SemanticGrep files [sentence]` | The files the sentence is about, best first, each at its best line |
| `:SemanticGrep [words]` | Open the live picker of pieces, with the words typed in (with a range, the lines' words) |
| `:SemanticGrep rebuild` | Make the project's index again from its files, every vector too |
| `:SemanticGrep download` | Download the local model now (or again, after "No, words only") |
| `:Telescope semantic_grep files` | The files view, as a Telescope extension (`:Telescope semantic_grep` the pieces) |
| `:checkhealth semantic-grep` | Node, llama-server and the local model, the profile, the embedding and rerank models (each asked once; one that nothing answers for is named unreachable), and this project's index |

From Lua: `require('semantic-grep').files(sentence)` and `.find(words)`.

## How it works

Each Neovim spawns one small Node server (`bin/semantic-grep-server.mjs`, JSON-RPC over stdio; it exits with
Neovim). It lists the files git lists (tracked and untracked, `.gitignore` respected), cuts them into functions,
classes and methods with their doc comments using Neovim's tree-sitter in a headless `nvim -u NONE`, else into
blocks cut where the indentation starts a statement or an object's key, and keeps one SQLite file per repository:
the words in FTS5 and a vector per piece's text, title and model, no copy of the code. Each piece is embedded with a
title, its file and the name of what encloses it (`config-users.ts: _users: anna`); a small one (under 400
characters: a short method, a getter) also with what its file is for (its docstring or header comment, else a note
on the file) and the head and doc of the class or function around it (`app.py (The app.): class Flask(App): The WSGI
application. > get`), so it keeps what it is part of; imports alone are no piece. Worktrees of a repository share it, and a save embeds only what changed.
Meaning is a brute-force cosine over every vector (the pieces within the model's band of the best); a single list
fuses words, meaning and the searches kept by reciprocal rank; the files view ranks files by it with settings tuned on
the bench for each profile's model (`src/embedder.mjs`). The same code is a library (`import {Meaning} from 'semantic-grep'`), and another
program can be the picker's source instead of the server: see `lua/semantic-grep/init.lua`.

Tests: `npm test` (unit), `npm run test:nvim` (headless Neovim, Telescope), `npm run test:e2e` (live models).

## Benchmark

`npm run bench:fetch`, then `npm run bench -- --profile laptop` (or `words`, `beefy`, `cloud`): six public
repositories pinned by commit, 372 questions written the way people search, each asked by words, by meaning, fused
and reranked, scored by recall@1/5/10, MRR and latency, of the pieces and of the files view. Your own searches and the pieces you opened run through the
same bench, privately (`npm run bench:export`); `npm run bench:tune` tunes the fusion for a model. See
[docs/benchmark.md](docs/benchmark.md) for how, and the results.

Each profile as it ships, over all 372 questions (2026-11-04; the files view is answered by the labelled file):

| profile | pieces R@1 / R@5 / MRR | files R@1 / R@5 / MRR | files view, p50 / p95 |
| --- | --- | --- | --- |
| `laptop` (EmbeddingGemma 2, fused) | 0.46 / 0.76 / 0.592 | 0.69 / 0.95 / 0.801 | 15 / 19 ms on 4 CPU threads¹ |
| `beefy` (Qwen3-Embedding-8B, reranked by Qwen3-Reranker-0.6B) | 0.51 / 0.82 / 0.643 | 0.68 / 0.95 / 0.801 | 176 / 229 ms² |
| `cloud` (Voyage) | not measured yet (no key) | | |

¹ The query's embedding on the CPU (docs/profiles.md); the rest of a search, 1 to 2 ms. ² On a GPU shared with other
work. With notes on flask, cobra and fd, the laptop's pieces gain 0.027 MRR; beefy's reranked list, nothing measurable
(docs/notes.md). The last change, context for small pieces and the fusion tuned per profile, took the laptop's files
view from 0.765 to 0.801 and beefy's fused one from 0.781 to 0.800, and left the pieces' lists and beefy's reranked
files view where they were (docs/benchmark.md, "Context and tuning").

## License

MIT
