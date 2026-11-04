# Notes written by a model

A note is a sentence or two on what a piece of code does and what someone would be trying to do when they need it,
in plain words, keeping its identifiers. It is searched with its piece, by its words and by its meaning, and read by
the reranker before the code (README, "It learns"). A coding agent can write them (`notes pending` / `notes put`);
a language model writes them in the background instead, so search by meaning gains them without anyone asking for
them: with the `laptop` or `beefy` profile, its writer on this machine does unless `notes = false`; the cloud's writer
costs money and sends the code to a second company, so it writes only with `notes = true`; without a profile, `notes`
turns the laptop's writer on.

```lua
require('semantic-grep').setup({
  profile = 'beefy', -- notes on: the profile's writer
  notes = {idleMs = 300000}, -- or over it (another model, concurrency, ...); false: no notes
})
```

Once every piece of a file has its note, the writer writes one more, on the file: what it is for, from its pieces'
notes (not its code). It goes in the title of the file's small pieces (README, "How it works"), so a short method
in a file whose name says little is found by what its file is for. Only a file of several pieces that has small ones
and says nothing of itself (no module docstring, package comment or header comment: those are its summary already)
gets one.

- **When.** Only while nothing is searched: once no search came for the writer's `idleMs` (2 minutes on the laptop,
  30 s on beefy and in the cloud) and no project is being indexed. Idle means no search, not no typing: on a laptop,
  its model works on the CPU while you edit (at the nice its server runs at, below), so set `idleMs` higher, or
  write the notes at once with the command below, if that is in the way. Then it takes the pieces with no note, the
  project searched last first, and in it those nearest the file you are in (the same file, its folder, the folder
  above; a file you were in before counts as two folders further), a few at a time, and stops at the next search (the
  piece it was writing is dropped and written later). Each note is kept as it comes, so a Neovim closed half way keeps
  what was written. A project new to you is noted where you are reading first.
- **What.** Every piece without a note, then those files: one written by an agent is never written over. A piece whose code changed has
  a new hash, so it has no note until one is written again. A writer that does not answer at all rests five
  minutes, twice as long each time in a row up to an hour (a writer nobody started is seldom asked), and its pieces
  are asked again after; a piece it fails on three times (no usable note, too long a wait)
  is left until the next session.
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

Measured on the bench's `test` questions of flask, cobra and fd (137 questions, 3481 pieces), with the laptop's
embedding model (EmbeddingGemma 2), and again over all of their 189 questions (`dev` and `test`) with the same notes;
fused is the list the picker shows once meaning came, files the files view (`:SemanticGrep files`):

| writer | where | pieces fused R@1 | MRR (all 189) | files R@1 | files MRR (all 189) | a thousand pieces |
| --- | --- | --- | --- | --- | --- | --- |
| none | | 0.409 | 0.544 (0.578) | 0.584 | 0.725 (0.756) | |
| **laptop: Qwen3.5-2B** (Q4_K_M, 1.3 GB) | 4 CPU threads | 0.453 | 0.582 (0.603) | 0.577 | 0.729 (0.766) | 28 min on 4 CPU threads; 1.9 min on a GPU |
| **beefy: Qwen3-4B-Instruct-2507** (Q4_K_M, 2.5 GB) | a GPU | 0.431 | 0.571 (0.606) | 0.606 | 0.753 (0.785) | 3.4 min on a GPU, four at a time; 72 min on 4 CPU threads |
| Qwen3-30B-A3B-Instruct-2507 | OpenRouter | 0.394 | 0.538 (0.565) | 0.569 | 0.721 (0.754) | $0.04, 4.6 min |
| **cloud: Claude Haiku 5.5** | Anthropic (here through OpenRouter) | 0.474 | 0.605 (0.609) | 0.613 | 0.760 (0.787) | **$0.10**, 2.8 min |
| Claude Sonnet 5.5, low effort | OpenRouter | 0.533 | 0.633 (0.629) | 0.635 | 0.773 (0.798) | $1.92, 4.3 min |

- **Notes help, more so the better the writer.** The pieces' list gains most (Sonnet's notes: MRR 0.544 to 0.633,
  recall@1 0.409 to 0.533), the files view less (0.725 to 0.773): a file's many pieces already say much of what a note
  would. The notes' own words matter as much as their meaning: the words alone go from MRR 0.100 to 0.22 with
  Claude's notes, as a search's plain words now meet the note's.
- **Kept: one writer a profile.** The laptop's Qwen3.5-2B is the smallest that helps (pieces +0.025 over all 189,
  files +0.010, within the noise: its gain is the pieces' list), at 1.7 s a piece on 4 CPU threads: a 5,000-piece
  project is noted in about 2.3 hours of idle time.
  Beefy's Qwen3-4B helps the files view more (+0.029) and writes 1,000 pieces in 3.4 minutes on a GPU; on a CPU
  it takes 72 minutes, which is why it is not the laptop's. The cloud's Claude Haiku 5.5 is the best
  for its price, 10 cents a thousand pieces; Claude Sonnet 5.5 is better still at 19 times that:
  `notes = {model = 'claude-sonnet-5-5', chars = 3000, concurrency = 4, request = {thinking = {type = 'between_tools'}}}`
  with the cloud profile (Sonnet 5.5 takes no other way to turn its thinking off; measured through OpenRouter at low
  reasoning effort, not this way), for a project worth $2 a thousand pieces.
- **With each profile's own models** (2026-11-04, on this change's titles and fusion: docs/benchmark.md, "Context and
  tuning"; the same 189 questions, each profile's writer, with its notes on the files): the laptop's Qwen3.5-2B takes
  the pieces' MRR from 0.573 to 0.607 (plain questions +0.060 [0.004, 0.120]) and leaves the files view where it is
  (0.800 to 0.800), its tuned fusion having taken the files most of the way already. Beefy's Qwen3-4B, with its
  Qwen3-Embedding-8B, adds to the fused list (pieces 0.597 to 0.620, files 0.799 to 0.823) and nothing to what its
  reranker gives (pieces 0.645 to 0.643, files 0.828 to 0.813, within the noise): a strong embedder and a reranker
  that reads the code leave notes little to add. They are on with both local profiles all the same: they cost
  nothing but idle time, help the pieces' list wherever it is not reranked (on the laptop always, on beefy when its
  reranker fails or is too slow); `notes = false` if the idle time is in the way. The cloud profile's models (Voyage's embedder and reranker) are not measured
  with notes, for want of a key; its writer costs money, so it writes only when asked.
- **Dropped:** Qwen3-30B-A3B (no better than no notes, a little worse), and Qwen3.5-9B, whose run was stopped before
  it was measured: on this machine it would not fit whole in the GPU memory free beside other work, and wrote about
  45 pieces a minute half on the CPU.
- **Noise.** 137 questions move an MRR by a few hundredths for no reason: the 2B and 4B swap places between `test` and
  all 189, and per repository a writer gains on one and loses a little on another. What holds over both is the
  order: no notes < the small local ones < Haiku < Sonnet, and Qwen3-30B no gain.
- **A caution on Claude's lead.** The bench's questions were written by Claude reading the code (benchmark.md, "The
  questions"); notes by Claude may share their wording more than other models' do. Your own searches through the
  bench (`npm run bench:export`) are the check.
- **Searches cost a little more.** Each note is a vector beside its piece's: the meaning search compares twice as
  many, a few milliseconds more on a large project.

Tokens a thousand pieces: about 260,000 read and 44,000 to 60,000 written by the Qwen models, 376,000 read and
116,000 to 122,000 written by Claude (its tokenizer counts more, and it writes longer notes). Times are a run's
wall clock, four pieces at a time on a GPU or eight through OpenRouter, one at a time on the CPU; the runs and their
notes' cost are in [`bench/results/notes-2026-11-03/`](../bench/results/notes-2026-11-03/) (`npm run bench --
--profiles bench/candidates.json --profile gpu-gemma2 --split test --repos cobra,fd,flask --modes words,meaning,fused
--notes laptop-qwen3.5-2b`: the laptop's model on a GPU, the same vectors; on this change's code, uncommitted then, as
their `changed` field says; the writers in
[`bench/writers.json`](../bench/writers.json); a writer's notes are cached by piece, so a run again costs nothing).
The Claude numbers were measured through OpenRouter (`or-haiku-5.5`, `or-sonnet-5.5`), the same models as
Anthropic's API serves: the cloud profile's own request to Anthropic (thinking off, low effort) is checked against a
fake only, for want of a key here, and is to be measured when one comes (`npm run bench -- ... --notes cloud-haiku`).
The CPU times ([`cpu-times.json`](../bench/results/notes-2026-11-03/cpu-times.json)) were measured apart, on cobra's first 40 pieces with `notes write --concurrency 1 --chars 1500` on a
llama-server with 4 threads: 1.66 s a piece for the 2B (4.3 GB of RAM at most, the model included), 4.3 s for the 4B (6.7 GB).

## Running a writer

The local ones expect llama.cpp's `llama-server` at `http://127.0.0.1:18122/v1` (the embedding model is at 18120,
the reranker at 18121, docs/profiles.md):

```sh
# laptop: on the CPU, beside the embedding model; nice, so the editor and a search come first
CUDA_VISIBLE_DEVICES= nice -n 19 llama-server --model Qwen3.5-2B-Q4_K_M.gguf --alias qwen3.5-2b --host 127.0.0.1 --port 18122 \
  --ctx-size 4096 --parallel 1 --gpu-layers 0 --threads 4
# beefy: on a GPU (pick it with CUDA_VISIBLE_DEVICES), four pieces at a time
llama-server --model Qwen3-4B-Instruct-2507-Q4_K_M.gguf --alias qwen3-4b-instruct-2507 --host 127.0.0.1 --port 18122 \
  --ctx-size 8192 --parallel 4 --gpu-layers 99
```

GGUF files: [unsloth/Qwen3.5-2B-GGUF](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF) `Qwen3.5-2B-Q4_K_M.gguf`,
[unsloth/Qwen3-4B-Instruct-2507-GGUF](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF)
`Qwen3-4B-Instruct-2507-Q4_K_M.gguf`. A writer on this machine is asked without its thinking
(`chat_template_kwargs: {enable_thinking: false}`, which Qwen3.5 needs).

The cloud writer needs a key from [Anthropic](https://console.anthropic.com/) in `$ANTHROPIC_API_KEY`; it is asked
with thinking off at low effort. Any OpenAI-compatible `/chat/completions` works as a writer, with `sendCode = true`
when it is not on this machine; `request` adds fields to each request's body. Through OpenRouter, for example:

```lua
notes = {api = 'openai', baseUrl = 'https://openrouter.ai/api/v1', model = 'anthropic/claude-haiku-5.5',
  apiKeyFile = '~/.config/openrouter.key', sendCode = true, concurrency = 8, chars = 3000,
  request = {reasoning = {enabled = false}}},
```
