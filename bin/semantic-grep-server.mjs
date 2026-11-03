#!/usr/bin/env node
// The stdio JSON-RPC server one Neovim spawns (see src/server.mjs), and the notes a coding agent writes:
//
//   semantic-grep-server notes pending [--root DIR] [--limit N]   pieces without a note, one JSON line each:
//                                                                {hash, file, from, to, name, text}
//   semantic-grep-server notes put [--root DIR] [--source NAME]   notes from stdin, one JSON line each: {hash, note}
//   semantic-grep-server notes write [--root DIR] [--profile laptop|beefy|cloud] [--model NAME] [--base-url URL]
//                       [--api openai|anthropic] [--api-key-env VAR] [--send-code] [--concurrency N] [--chars N] [--limit N]
//                                                                a note for each piece without one, by a language model
//                                                                (src/notes.mjs; the profile's writer, laptop's by default)
//
// both with [--data-dir DIR] (default Neovim's: ~/.local/share/nvim/semantic-grep), [--index data|project] and
// [--project-dir NAME], as the plugin's setup has them. A Neovim searching the project picks the notes up as they come.
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {readLines} from '../src/jsonl.mjs';

// node:sqlite says it is experimental on stderr, which Neovim would show as the server's complaint: that one is
// dropped, every other warning still told.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && /SQLite/.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(this, warning, ...rest);
};

const [major, minor] = process.versions.node.split('.').map(Number);
if (!process.getBuiltinModule?.('node:sqlite') || major < 22 || (major === 22 && minor < 16)) {
  process.stderr.write(`semantic-grep needs Node 22.16 or later (node:sqlite with FTS5); this is ${process.version}\n`);
  process.exit(1);
}

const [command, action, ...rest] = process.argv.slice(2);
if (command === 'notes') {
  process.exit(await notes(action, rest));
}
// Stopped by a signal: exit as by the end of stdin, so the llama-server it started (local.mjs) stops with it.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(128 + {SIGHUP: 1, SIGINT: 2, SIGTERM: 15}[signal]));
const {serve} = await import('../src/server.mjs');
await serve();
process.exit(0);

async function notes(action, args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    options[name] = args[i + 1] === undefined || args[i + 1].startsWith('--') ? true : args[++i];
  }
  if (!['pending', 'put', 'write'].includes(action)) {
    process.stderr.write('usage: semantic-grep-server notes pending|put|write [--root DIR] [--data-dir DIR] [--index data|project] [--project-dir NAME] [--limit N] [--source NAME]\n'
      + '  write: [--profile laptop|beefy|cloud] [--model NAME] [--base-url URL] [--api openai|anthropic] [--api-key-env VAR] [--send-code] [--concurrency N] [--chars N]\n');
    return 2;
  }
  let writer = null;
  if (action === 'write') {
    const {profileConfig} = await import('../src/profiles.mjs');
    const {NotesWriter} = await import('../src/notes.mjs');
    const own = Object.fromEntries(Object.entries({
      api: options.api, baseUrl: options['base-url'], model: options.model, apiKeyEnv: options['api-key-env'],
      sendCode: options['send-code'] === true ? true : undefined,
      concurrency: options.concurrency && Number(options.concurrency), chars: options.chars && Number(options.chars),
    }).filter(([, value]) => value !== undefined));
    try {
      writer = new NotesWriter({entry: profileConfig({profile: options.profile, notes: own}).notes, log: line => process.stderr.write(`${line}\n`)});
    } catch (error) {
      process.stderr.write(`semantic-grep: ${error.message}\n`);
      return 2;
    }
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
    } else if (action === 'write') {
      // As many notes as --limit (all by default), a batch at a time; a note is kept as soon as its batch is written.
      const most = options.limit === undefined ? Infinity : Number(options.limit);
      const failed = new Set();
      const started = Date.now();
      let written = 0;
      for (;;) {
        const answer = await meaning.pendingNotes(root, {limit: Math.min(writer.entry.concurrency * 8, most - written), skip: failed});
        if (answer.problem) throw new Error(answer.problem);
        if (!answer.pieces.length || written >= most) break;
        const {notes, errors} = await writer.write(answer.pieces);
        for (const error of errors) process.stderr.write(`  ${error}\n`);
        if (!notes.length && errors.some(error => !error.endsWith('no note in the answer'))) throw new Error(`${writer.about} wrote no note: ${errors[0]}`);
        const noted = new Set(notes.map(note => note.hash));
        for (const piece of answer.pieces) if (!noted.has(piece.hash)) failed.add(piece.hash);
        await meaning.addNotes(root, notes, {source: writer.name});
        written += notes.length;
        const s = (Date.now() - started) / 1000;
        process.stderr.write(`${written} notes written, ${answer.pending - notes.length} pieces without one; ${written ? `${(s / written * 1000).toFixed(0)} s a thousand` : 'none yet'}\n`);
      }
      const {input, output} = writer.tokens;
      process.stderr.write(`${written} notes by ${writer.about} in ${Math.round((Date.now() - started) / 1000)} s; ${input} tokens read, ${output} written\n`);
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
