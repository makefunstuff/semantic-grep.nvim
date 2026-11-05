---
name: semantic-grep-notes
description: Populate semantic-grep notes, the one-or-two-sentence descriptions of code pieces that make semantic-grep searches find them by plain words. Use when asked to "populate semantic-grep notes", "write semantic-grep notes", fill in missing notes for a semantic-grep index, or finish the README's "Notes from a coding agent" loop.
---

# Populate semantic-grep notes

Write a short note for every piece of code that has none, then put the notes back into semantic-grep. A note says
what the piece does and what someone would be trying to do when they need it, in plain words, keeping its
identifiers. This skill's helper finds the plugin's CLI, checks the server and index, batches large jobs, and puts the
notes back.

## 1. Find the helper and check the ground

This skill's folder is the one holding this SKILL.md. Call the helper from there (if `$CLAUDE_SKILL_DIR` is set, use
`$CLAUDE_SKILL_DIR/scripts/sg-notes.mjs`; otherwise use the absolute path you found):

```sh
node <skill-folder>/scripts/sg-notes.mjs check --root .
```

It prints the server it found, the index it opened, and `N pending, M written`. If it fails, stop and tell the person
exactly what it said. The helper explains a missing server (install semantic-grep.nvim, or set
`SEMANTIC_GREP_SERVER`) and an index that cannot be opened (open the project in Neovim, run
`:SemanticGrep rebuild` or its first search, then try again). Never keep retrying a failed check.

If the person named `--data-dir`, `--index` or `--project-dir`, add the same flag and value to every helper command
below. Also pass `--root DIR` when they want another project than the current directory. Without them, use
`--root .` and the default index.

## 2. Repeat until nothing is pending

Work in a temporary folder, for example `work=$(mktemp -d)`.

1. Get the next pieces:

   ```sh
   node <skill-folder>/scripts/sg-notes.mjs pending --root . --limit 200 --out "$work/pending.jsonl"
   ```

   It prints `pending: N pieces without a note (M written); wrote K to ...`. If `N` is `0`, go to step 5.
2. Read `"$work/pending.jsonl"`. Each line is one piece:
   `{"hash": "...", "file": "...", "from": 1, "to": 20, "name": "...", "text": "..."}`.
3. Write one note for each piece, as `{"hash": "...", "note": "..."}` JSON lines, to `"$work/notes.jsonl"`. Use the
   piece's hash exactly and do not add a note for a piece you did not read. Keep the rules below. For more than 40
   pieces, use subagents (section 3) instead of writing them all yourself.
4. Put the notes back:

   ```sh
   node <skill-folder>/scripts/sg-notes.mjs put --root . --notes "$work/notes.jsonl"
   ```

   It prints `notes: K added` (and perhaps `U unknown` for pieces whose code changed since they were listed). Add
   `K` to the running total, keep the `U` pieces for the next round, and go back to step 1. A non-zero exit after
   `unknown` is not a reason to stop; a real failure is, and the helper explains the failure in plain words.
5. Check again with `check`. If it still says pieces are pending, loop from step 1. If the pending count does not
   fall from one round to the next, stop and report the helper's output rather than looping forever.

Never mark a piece as noted by inventing a hash. A note on a hash the index does not have is discarded by the server,
and the same piece comes back.

## 3. Large batches: split and use subagents

For more than 40 pieces, split the pending file:

```sh
node <skill-folder>/scripts/sg-notes.mjs split --file "$work/pending.jsonl" --outdir "$work/chunks" --size 25
```

It prints one JSON line `{"total": N, "outdir": "...", "chunks": [{"file": "...", "count": 25}, ...]}` and writes
`manifest.json` beside the chunk files. Start one subagent per chunk in a single parallel message, using the Task
tool (or whatever your environment calls subagents). Give each one this prompt, with its own paths filled in:

> You are writing semantic-grep notes. Read the JSON lines in `<chunk file>`. For every line, write exactly one
> line to `<chunk file without .jsonl>-notes.jsonl`, in the same order, as
> `{"hash": "<the line's hash, unchanged>", "note": "<one or two sentences>"}`. The note says what the piece does
> and what someone would be trying to do when they need it, in plain words, keeping its identifiers. Do not add
> prose, markdown or code fences, and do not invent hashes. Reply with only the number of notes you wrote.

Each subagent returns only `{hash, note}` lines in its notes file and a count, never a long answer. Wait for all of
them; then check that every notes file has the same number of lines as its chunk. If a subagent failed or wrote the
wrong count, write that chunk yourself in this conversation. Finally merge the files in chunk order and put them:

```sh
cat "$work"/chunks/*-notes.jsonl > "$work/notes.jsonl"
node <skill-folder>/scripts/sg-notes.mjs put --root . --notes "$work/notes.jsonl"
```

## 4. What a good note is

- One or two sentences, plain language, about 15 to 45 words.
- Say what the piece does and when someone would reach for it: "Joins a team's members into the text of the
  invitation email; someone needs it when changing what the invite says."
- Keep identifiers exactly as they are (`dropMember`, `team.members`, `--data-dir`); do not rename or translate them.
- Read the code, not only the name. Describe its actual work and its result, not the file around it.
- No markdown, no quotes around the whole note, no "This function..." preamble, no line breaks. Under 1000 characters.
- A note for a changed piece describes the changed code. An empty note is not a note.

## 5. Report

When nothing is pending, run `check` one last time and report to the person:

- how many notes this run wrote (the total of every `notes: K added`),
- the final `N pending, M written` from `check`,
- any pieces left behind and why, if the server kept rejecting them.

If the server or index was missing, say exactly what the helper said and what to do (install the plugin, or build the
index in Neovim). Never claim notes were written when `put` did not add them.
