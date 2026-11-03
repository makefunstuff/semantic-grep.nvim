// What the benchmark's scripts share: their flags, and the cache folder the repositories and indexes go in.
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

/** `--name value` and `--flag` (true) into `flags`; the rest in order. */
export function options(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const match = /^--([\w-]+)(?:=(.*))?$/.exec(args[i]);
    if (!match) rest.push(args[i]);
    else if (match[2] !== undefined) flags[match[1]] = match[2];
    else if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) flags[match[1]] = args[++i];
    else flags[match[1]] = true;
  }
  return {flags, rest};
}

/** The bench's cache: `--cache`, $SEMANTIC_GREP_BENCH_CACHE, or ~/.cache/semantic-grep-bench. */
export const cacheDir = flag => resolve(flag ?? process.env.SEMANTIC_GREP_BENCH_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'semantic-grep-bench'));

/** The tree-sitter parsers this machine's Neovim has (the pieces are then cut as the plugin cuts them), or none. */
export function neovimParsers() {
  try {
    const out = execFileSync('nvim', ['--headless', '-c', 'lua io.write(vim.json.encode(vim.api.nvim_get_runtime_file("parser/*", true)))', '-c', 'qa!'], {encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore']});
    return JSON.parse(out || '[]');
  } catch {
    return [];
  }
}

/** Resolves once the index of `root` is read and every piece has its vector (with an embedder); `tick(progress)` every few seconds. */
export async function settled(meaning, root, tick = () => {}) {
  const index = meaning.open(root);
  await index.ready;
  meaning.work();
  let last = 0;
  for (;;) {
    if (index.failure) throw index.failure;
    if (meaning.problem) throw new Error(meaning.problem);
    const waiting = index.pending().length + index.learnedPending().length;
    if (!meaning.working && (!waiting || meaning.state !== 'on')) return index;
    if (!meaning.working) meaning.work();
    if (Date.now() - last > 5000) { last = Date.now(); tick(index.progress()); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
