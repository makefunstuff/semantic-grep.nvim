# semantic-grep.nvim

Find code by what it does, not only by what it calls it. A live picker that works like `live_grep`: on every key
it shows the pieces of code that have your words (identifiers split, so `removeUserFromTeam` is also remove, user,
from and team; comments and strings too). Pause for 150 ms and the pieces closest to what you *mean* join the list
below them, so nothing you already see moves. With a decision model set, the first pieces are then reranked in
place, and the piece you are on stays selected.

The words work with no model at all (SQLite FTS5, BM25, stemming). Meaning needs an embedding model behind an
OpenAI-compatible `/v1/embeddings` (llama.cpp's `llama-server --embeddings`, Ollama, LM Studio, vLLM, a cloud API).

## Requirements

- Neovim 0.10 or later (0.12 shows indexing progress in the statusline/fidget)
- Node 22.13 or later (`node:sqlite`; no npm install, no native dependencies)
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
  opts = {
    embedding = {api = 'openai', baseUrl = 'http://127.0.0.1:8092/v1', model = 'embeddinggemma-2', dimensions = 768},
    rerank = {api = 'system-one', baseUrl = 'http://127.0.0.1:8091/v1', model = 'd1-2B', top = 15, timeoutMs = 2000},
  },
}
```

The plugin sets no keymaps; `Alt-s` above is a suggestion. As a Telescope extension:
`require('telescope').load_extension('semantic_grep')`, then `:Telescope semantic_grep`.

## Configuration

```lua
require('semantic-grep').setup({
  -- An OpenAI-compatible /v1/embeddings. Known prompts are added for EmbeddingGemma, nomic-embed-text/-code and
  -- Qwen3-Embedding; set queryPrefix/documentPrefix for another ({title} in documentPrefix places each piece's
  -- file and name; without it they are the piece's first line). Key: apiKey, apiKeyFile or apiKeyEnv.
  embedding = {api = 'openai', baseUrl = 'http://127.0.0.1:8092/v1', model = 'embeddinggemma-2', dimensions = 768},
  -- A decision model, or a list of them best first (the next is asked when one fails or is slower than its
  -- timeoutMs; one that failed rests for a minute). api: 'system-one', 'llama-cpp' or 'openai' (Decisions API).
  -- top: pieces it reads (2-30, default 10); timeoutMs: default 3000, 1000 for one another follows.
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

## Commands

| | |
| --- | --- |
| `:SemanticGrep [words]` | Open the live picker, with the words typed in (with a range, the lines' words) |
| `:SemanticGrep rebuild` | Make the project's index again from its files, every vector too |
| `:Telescope semantic_grep` | The same picker, as a Telescope extension |
| `:checkhealth semantic-grep` | Node, the embedding and rerank models (each asked once), and this project's index |

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

## License

MIT
