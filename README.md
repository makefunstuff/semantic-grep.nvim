# semantic-grep.nvim

Find code by what it does, not only by what it calls it. A live picker that works like `live_grep`: on every key
it shows the pieces of code that have your words (identifiers split, so `removeUserFromTeam` is also remove, user,
from and team; comments and strings too). Pause for 150 ms and the pieces closest to what you *mean* join the list
below them, so nothing you already see moves. With a decision model set, the first pieces are then reranked in
place, and the piece you are on stays selected.

The words work with no model at all (SQLite FTS5, BM25, stemming). Meaning needs an embedding model behind an
OpenAI-compatible `/v1/embeddings` (llama.cpp's `llama-server --embeddings`, Ollama, LM Studio, vLLM, a cloud API).
Three profiles name the models measured best for a machine: `laptop` (CPU only), `beefy` (a GPU) and `cloud` (hosted
APIs); [docs/profiles.md](docs/profiles.md) has their numbers and how to run each model's server.

## Requirements

- Neovim 0.10 or later (0.12 shows indexing progress in the statusline/fidget)
- Node 22.16 or later (`node:sqlite` with FTS5; no npm install, no native dependencies)
- git (or ripgrep) to list the project's files
- Optional: [telescope.nvim](https://github.com/nvim-telescope/telescope.nvim) (preferred),
  [snacks.nvim](https://github.com/folke/snacks.nvim)'s picker or [fzf-lua](https://github.com/ibhagwan/fzf-lua);
  without them, `vim.ui.select`

## Install (lazy.nvim)

```lua
{
  'makefunstuff/semantic-grep.nvim',
  dependencies = {'nvim-telescope/telescope.nvim'},
  cmd = 'SemanticGrep',
  keys = {
    {'<M-s>', '<cmd>SemanticGrep<cr>', desc = 'Search by meaning'},
    {'<M-s>', function() require('semantic-grep').find(require('semantic-grep').selected()) end, mode = 'x', desc = 'Search the selection by meaning'},
  },
  opts = {profile = 'laptop'}, -- or 'beefy', 'cloud': see docs/profiles.md to start its models

}
```

The plugin sets no keymaps; `Alt-s` above is a suggestion. As a Telescope extension:
`require('telescope').load_extension('semantic_grep')`, then `:Telescope semantic_grep`.

## Configuration

```lua
require('semantic-grep').setup({
  -- The embedding and rerank models measured for a machine (docs/profiles.md): 'laptop', 'beefy' or 'cloud'. What
  -- `embedding` and `rerank` set goes over the profile's (embedding = {baseUrl = ...} moves it; another model drops
  -- the profile's settings for its own); rerank = false turns its reranker off.
  profile = nil,
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
  picker = 'auto',          -- 'telescope', 'snacks', 'fzf-lua' or 'select'
  debounce_ms = 150,        -- the pause before meaning is asked
  rerank_delay_ms = 0,      -- how long meaning's list must stay before it is reranked
  data_dir = nil,           -- default stdpath('data') .. '/semantic-grep'
  index = 'data',           -- or 'project': .semantic-grep/ in the repository, added to .git/info/exclude
  index_on_start = false,   -- index the project when Neovim starts, not at the first search
  node = 'node',
})
```

In the picker, `Enter` opens a piece at its line and `<C-q>` sends the list to quickfix in the order shown. A
quickfix list sent before the rerank came is reordered in place when it comes (unless you changed it meanwhile).

## It learns

- **What you open.** When you pick a result, your search is kept with that piece, beside the index (a rebuild keeps
  it). The same search, or one worded close to it, finds that piece first, by its words and by their meaning.
- **Notes from a coding agent.** A sentence per piece on what it does, in the words you would search with, is
  searched with its code and read by the reranker. Any agent can write them:

  ```sh
  # the plugin's bin/semantic-grep-server.mjs, e.g. with lazy.nvim:
  alias semantic-grep-server='node ~/.local/share/nvim/lazy/semantic-grep.nvim/bin/semantic-grep-server.mjs'
  semantic-grep-server notes pending --root . --limit 200 > pending.jsonl   # {hash, file, from, to, name, text}
  semantic-grep-server notes put --root . < notes.jsonl                     # {hash, note}, one a line
  ```

  For example, in Claude Code: "Run `semantic-grep-server notes pending --root . --limit 200`, write a one or two
  sentence note for each piece (what it does, what someone would be trying to do when they need it, in plain words,
  keeping its identifiers), and pipe `{hash, note}` lines into `semantic-grep-server notes put --root .`; repeat until
  none is pending." A note holds while its piece's code does not change; `pending` then lists it again. Both
  commands take `--data-dir` (default Neovim's), `--index` and `--project-dir`, as `setup` has them. The code goes
  to the agent's model.

## Commands

| | |
| --- | --- |
| `:SemanticGrep [words]` | Open the live picker, with the words typed in (with a range, the lines' words) |
| `:SemanticGrep rebuild` | Make the project's index again from its files, every vector too |
| `:Telescope semantic_grep` | The same picker, as a Telescope extension |
| `:checkhealth semantic-grep` | Node, the profile, the embedding and rerank models (each asked once; one that nothing answers for is named unreachable), and this project's index |

## How it works

Each Neovim spawns one small Node server (`bin/semantic-grep-server.mjs`, JSON-RPC over stdio; it exits with
Neovim). It lists the files git lists (tracked and untracked, `.gitignore` respected), cuts them into functions,
classes and methods with their doc comments using Neovim's tree-sitter in a headless `nvim -u NONE`, else into
blocks cut where the indentation starts a statement or an object's key, and keeps one SQLite file per repository:
the words in FTS5 and a vector per piece's hash and model, no copy of the code. Each piece is embedded with a title,
its file and the name of what encloses it (`config-users.ts: _users: anna`); imports alone are no piece. Worktrees of a repository share it, and a save embeds only what changed.
Meaning is a brute-force cosine over every vector (the pieces within 0.1 of the best); a single list fuses words and
meaning by reciprocal rank. The same code is a library (`import {Meaning} from 'semantic-grep'`), and another
program can be the picker's source instead of the server: see `lua/semantic-grep/init.lua`.

Tests: `npm test` (unit), `npm run test:nvim` (headless Neovim, Telescope), `npm run test:e2e` (live models).

## Benchmark

`npm run bench:fetch`, then `npm run bench -- --profile laptop` (or `words`, `beefy`, `cloud`): six public
repositories pinned by commit, 372 questions written the way people search, each asked by words, by meaning, fused
and reranked, scored by recall@1/5/10, MRR and latency. Your own searches and the pieces you opened run through the
same bench, privately (`npm run bench:export`). See [docs/benchmark.md](docs/benchmark.md) for how, and the results.

## License

MIT
