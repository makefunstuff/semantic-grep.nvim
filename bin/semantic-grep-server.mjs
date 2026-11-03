#!/usr/bin/env node
// The stdio JSON-RPC server one Neovim spawns (see src/server.mjs), and the notes a coding agent writes:
//
//   semantic-grep-server notes pending [--root DIR] [--limit N]   pieces without a note, one JSON line each:
//                                                                {hash, file, from, to, name, text}
//   semantic-grep-server notes put [--root DIR] [--source NAME]   notes from stdin, one JSON line each: {hash, note}
//
// both with [--data-dir DIR] (default Neovim's: ~/.local/share/nvim/semantic-grep), [--index data|project] and
// [--project-dir NAME], as the plugin's setup has them. A Neovim searching the project picks the notes up as they come.
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {readLines} from '../src/jsonl.mjs';

if (!process.getBuiltinModule?.('node:sqlite')) {
  process.stderr.write(`semantic-grep needs Node 22.13 or later (node:sqlite); this is ${process.version}\n`);
  process.exit(1);
}

const [command, action, ...rest] = process.argv.slice(2);
if (command === 'notes') {
  process.exit(await notes(action, rest));
}
const {serve} = await import('../src/server.mjs');
await serve();
process.exit(0);

async function notes(action, args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) options[args[i].replace(/^--/, '')] = args[i + 1];
  if (!['pending', 'put'].includes(action)) {
    process.stderr.write('usage: semantic-grep-server notes pending|put [--root DIR] [--data-dir DIR] [--index data|project] [--project-dir NAME] [--limit N] [--source NAME]\n');
    return 2;
  }
  const {Meaning} = await import('../src/meaning.mjs');
  const {execFileSync} = await import('node:child_process');
  const {realpathSync} = await import('node:fs');
  const root = realpathSync(resolve(options.root ?? process.cwd()));
  const dataDir = resolve(options['data-dir'] ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'nvim', 'semantic-grep'));
  // The parsers the user's Neovim has: the pieces are cut as its server cuts them, so their hashes agree.
  let parsers = [];
  try {
    parsers = JSON.parse(execFileSync('nvim', ['--headless', '-c', 'lua io.write(vim.json.encode(vim.api.nvim_get_runtime_file("parser/*", true)))', '-c', 'qa!'], {encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore']}) || '[]');
  } catch {}
  const meaning = new Meaning({dataDir, config: {index: options.index ?? 'data', ...(options['project-dir'] ? {projectDir: options['project-dir']} : {})}, log: line => process.stderr.write(`${line}\n`)});
  meaning.useParsers(parsers);
  try {
    if (action === 'pending') {
      const answer = await meaning.pendingNotes(root, {limit: Number(options.limit ?? 50)});
      if (answer.problem) throw new Error(answer.problem);
      for (const piece of answer.pieces) process.stdout.write(`${JSON.stringify(piece)}\n`);
      process.stderr.write(`${answer.pieces.length} shown of ${answer.pending} pieces without a note (${answer.noted} noted)\n`);
    } else {
      const notes = [];
      await new Promise(done => readLines(process.stdin, message => notes.push(message)).on('close', done));
      const answer = await meaning.addNotes(root, notes, {source: options.source ?? 'agent'});
      if (answer.problem) throw new Error(answer.problem);
      process.stderr.write(`${answer.added} notes added${answer.unknown.length ? `; ${answer.unknown.length} for pieces the index does not have (changed since?)` : ''}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`semantic-grep: ${error.message}\n`);
    return 1;
  } finally {
    await meaning.close();
  }
}
