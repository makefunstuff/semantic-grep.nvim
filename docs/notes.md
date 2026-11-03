# Notes written by a model

A note is a sentence or two on what a piece of code does and what someone would be trying to do when they need it,
in plain words, keeping its identifiers. It is searched with its piece, by its words and by its meaning, and read by
the reranker before the code (README, "It learns"). A coding agent can write them (`notes pending` / `notes put`);
with `notes` in `setup()`, a language model writes them in the background instead, so search by meaning gains them
without anyone asking for them.

```lua
require('semantic-grep').setup({
  profile = 'beefy',
  notes = true, -- the profile's writer; or {model = 'qwen3.5-2b', concurrency = 1, idleMs = 300000, ...} over it
})
```

- **When.** Only while nothing is searched: once no search came for the writer's `idleMs` (2 minutes on the laptop,
  30 s on beefy and in the cloud) and no project is being indexed, it takes the pieces with no note, the project
  searched last first, a few at a time, and stops at the next search (the piece it was writing is dropped and written
  later). Each note is kept as it comes, so a Neovim closed half way keeps what was written.
- **What.** Every piece without a note: one written by an agent is never written over. A piece whose code changed has
  a new hash, so it has no note until one is written again. A model that does not answer rests the writer five
  minutes; a piece it answers nothing usable for is left until the next session.
- **Where the code goes.** To the writer's model, a piece at a time (its first `chars` characters). A writer on this
  machine (127.0.0.1, localhost, ::1) gets it; any other only with `sendCode = true` in its entry, else the config is
  refused. The cloud profile's writer says so (that profile sends the code to hosted models already); a writer of your
  own elsewhere has to say so itself, and the profile's leave does not follow its `baseUrl` to another server.
- **All at once.** `semantic-grep-server notes write --root . --profile beefy` (or `--model`, `--base-url`,
  `--api`, `--api-key-env`, `--send-code`, `--concurrency`, `--chars`, `--limit`) writes them now, printing how far
  it is; a Neovim searching the project picks them up and embeds them.
- `:checkhealth semantic-grep` asks the writer for one note on a small piece of its own (not your code) and says how
  long it took, and whether the code leaves the machine.

## The writers

| profile | model | where | reads | notes a thousand pieces | tokens a thousand pieces (read / written) |
| --- | --- | --- | --- | --- | --- |
| `laptop` | Qwen3.5-2B (Q4_K_M, 1.3 GB) | 4 CPU threads, one piece at a time | 1500 chars | TODO | TODO |
| `beefy` | Qwen3.5-9B (Q4_K_M, 5.7 GB) | a GPU, four at a time | 3000 chars | TODO | TODO |
| `cloud` | Claude Haiku 5.5 (`claude-haiku-5-5`) | Anthropic's API, four at a time | 3000 chars | not measured yet | about TODO: $TODO |

The local ones expect llama.cpp's `llama-server` at `http://127.0.0.1:18122/v1` (the embedding model is at 18120,
the reranker at 18121, docs/profiles.md):

```sh
# laptop: on the CPU, beside the embedding model; nice, so the editor and a search come first
CUDA_VISIBLE_DEVICES= nice -n 19 llama-server --model Qwen3.5-2B-Q4_K_M.gguf --alias qwen3.5-2b --host 127.0.0.1 --port 18122 \
  --ctx-size 4096 --parallel 1 --gpu-layers 0 --threads 4
# beefy: on a GPU (pick it with CUDA_VISIBLE_DEVICES), four pieces at a time
llama-server --model Qwen3.5-9B-Q4_K_M.gguf --alias qwen3.5-9b --host 127.0.0.1 --port 18122 \
  --ctx-size 8192 --parallel 4 --gpu-layers 99
```

GGUF files: [unsloth/Qwen3.5-2B-GGUF](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF) `Qwen3.5-2B-Q4_K_M.gguf`,
[unsloth/Qwen3.5-9B-GGUF](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF) `Qwen3.5-9B-Q4_K_M.gguf`. They are asked
without their thinking (`chat_template_kwargs: {enable_thinking: false}`). The cloud writer needs a key from
[Anthropic](https://console.anthropic.com/) in `$ANTHROPIC_API_KEY`; it is asked with thinking off at low effort.
Any OpenAI-compatible `/chat/completions` (Ollama, LM Studio, vLLM) works as a writer: `notes = {api = 'openai',
baseUrl = ..., model = ...}`.

## What they gain

TODO
