// The model a setup with no `embedding` and no profile uses: the laptop profile's EmbeddingGemma 2 (Q8_0, 310 MB, about
// 0.8 GB of RAM on the CPU), downloaded once into the data folder when the person says so, and served by a llama.cpp
// `llama-server` this process starts on a free port of 127.0.0.1 at the first text to embed and stops once nothing was
// embedded for a while, or when it exits. llama-server is the one on PATH (or `llamaServer`); without one, or before
// the download, the word search works alone. It is Meaning's `provider` and its `embedder` at once (see meaning.mjs).
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWriteStream, existsSync, statSync} from 'node:fs';
import {mkdir, rename, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {availableParallelism} from 'node:os';
import {delimiter, isAbsolute, join} from 'node:path';
import {HttpEmbedder} from './embedder.mjs';

// Pinned by the repository's commit and the file's hash: what was measured is what is run.
export const LOCAL_MODEL = {
  model: 'embeddinggemma-2',
  name: 'EmbeddingGemma 2',
  file: 'embeddinggemma-2-Q8_0.gguf',
  url: 'https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/6ea3e3a309d12a4779cfda98b8c19800d2d5da71/embeddinggemma-2-Q8_0.gguf',
  bytes: 309_855_456,
  sha256: '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135',
  // As the laptop profile was measured (docs/profiles.md): on the CPU, one request at a time.
  args: ['--embedding', '--pooling', 'mean', '--ctx-size', '8192', '--batch-size', '2048', '--ubatch-size', '2048', '--parallel', '1', '--gpu-layers', '0'],
};
export const IDLE_MS = 15 * 60_000; // the server stops when nothing was embedded for this long, and starts again at the next text
const START_MS = 120_000;
const FOUND_MS = 30_000; // how long where llama-server is (or that it is not) is believed
const STALL_MS = 60_000; // a download that brings nothing for this long fails

/** The `name` executable on PATH, or null. */
export function onPath(name, path = process.env.PATH ?? '') {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name];
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const each of names) {
      const full = join(dir, each);
      try { if (statSync(full).isFile()) return full; } catch {}
    }
  }
  return null;
}

/** A port of 127.0.0.1 that nothing listens on now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * `dataDir`'s copy of the model, its download and its server. `gguf`: a model file of one's own (nothing is downloaded);
 * `llamaServer`: the binary (default the one on PATH); `threads`: the CPU threads it embeds with (default 4, fewer on a
 * smaller CPU). `run(command, args, options)` starts a process (child_process.spawn), `fetch` downloads, `spec` is the
 * model (LOCAL_MODEL's fields).
 */
export class LocalModel extends HttpEmbedder {
  constructor({dataDir, gguf = null, llamaServer = 'llama-server', threads = Math.max(1, Math.min(4, availableParallelism())), idleMs = IDLE_MS, log = () => {}, fetch = globalThis.fetch, run = spawn, spec = LOCAL_MODEL}) {
    super({entry: {api: 'openai', baseUrl: 'http://127.0.0.1/v1', model: spec.model}, apiKey: () => undefined, fetch, log});
    Object.assign(this, {dataDir, llamaServer, threads, idleMs, run, spec, download: fetch});
    this.path = gguf ?? join(dataDir, 'models', spec.file);
    this.own = !!gguf;
    this.child = null;
    this.starting = null;
    this.downloading = null; // {done, total} while it comes
    this.found = null;
    this.stopOnExit = () => this.child?.kill('SIGTERM');
    process.on('exit', this.stopOnExit);
  }

  // As a provider (see Meaning): its name, state, what it needs, and turning it on (the download).
  get name() { return `${this.spec.model} (its own llama-server${this.port ? ` at 127.0.0.1:${this.port}` : ''})`; }

  /** The llama-server it runs, or null: looked up again at most every FOUND_MS. */
  runtime() {
    if (!this.found || Date.now() - this.found.at > FOUND_MS) this.found = {at: Date.now(), path: onPath(this.llamaServer)};
    return this.found.path;
  }

  hasModel() { return existsSync(this.path); }

  state() {
    if (this.downloading) return 'downloading';
    return this.hasModel() && this.runtime() ? 'on' : 'off';
  }

  /** What is missing: `{runtime: "llama-server" | null, model: bool, bytes, path}`. */
  async needs() {
    return {runtime: this.runtime() ? null : this.llamaServer, model: !this.hasModel(), own: this.own, bytes: this.spec.bytes, path: this.path, name: this.spec.name};
  }

  /** Downloads the model unless it is there (`progress({phase: "downloading", done, total})`): `{runtime, model}`. */
  async turnOn({progress = () => {}} = {}) {
    if (this.hasModel()) return {runtime: false, model: false};
    if (this.own) throw new Error(`${this.path} is missing`);
    await this.fetchModel(progress);
    return {runtime: false, model: true};
  }

  async turnOff() {
    await this.stop();
    if (!this.own) await rm(this.path, {force: true});
    return {venv: false};
  }

  snapshot() {
    return {local: {model: this.spec.model, path: this.path, downloaded: this.hasModel(), llamaServer: this.runtime(), wanted: this.llamaServer, running: !!this.child, port: this.port ?? null, downloading: this.downloading}};
  }

  /**
   * The file, from its url into a part of this process's own (another Neovim may fetch it at the same time), checked
   * by its size and hash, then put in place; a stall of STALL_MS fails it.
   */
  async fetchModel(progress) {
    const part = `${this.path}.${process.pid}.part`;
    await mkdir(join(this.path, '..'), {recursive: true});
    this.downloading = {done: 0, total: this.spec.bytes};
    const abort = new AbortController();
    let stall;
    const waiting = () => {
      clearTimeout(stall);
      stall = setTimeout(() => abort.abort(new Error(`downloading ${this.spec.file}: nothing came for ${STALL_MS / 1000} s`)), STALL_MS);
    };
    try {
      waiting();
      const response = await this.download(this.spec.url, {redirect: 'follow', signal: abort.signal});
      if (!response.ok || !response.body) throw new Error(`downloading ${this.spec.file}: the server answered ${response.status}`);
      const hash = createHash('sha256');
      const out = createWriteStream(part);
      let told = 0;
      try {
        for await (const chunk of response.body) {
          waiting();
          hash.update(chunk);
          this.downloading.done += chunk.length;
          if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
          if (Date.now() - told > 500) { told = Date.now(); progress({phase: 'downloading', ...this.downloading}); }
        }
      } finally {
        await new Promise((resolve, reject) => out.end(error => (error ? reject(error) : resolve())));
      }
      const sha = hash.digest('hex');
      if (this.downloading.done !== this.spec.bytes || sha !== this.spec.sha256) {
        throw new Error(`downloading ${this.spec.file}: it came with ${this.downloading.done} bytes and sha256 ${sha.slice(0, 12)}…, not the ${this.spec.bytes} bytes and ${this.spec.sha256.slice(0, 12)}… expected`);
      }
      if (!this.hasModel()) await rename(part, this.path); // another's came first: the same bytes
      progress({phase: 'downloading', done: this.spec.bytes, total: this.spec.bytes});
    } catch (error) {
      throw abort.signal.aborted && abort.signal.reason instanceof Error ? abort.signal.reason : error;
    } finally {
      clearTimeout(stall);
      await rm(part, {force: true});
      this.downloading = null;
    }
  }

  // As an embedder: each request goes to its server, started first if it is not running.
  get ready() { return !!this.child && !this.starting; }

  async request(input) {
    await this.serve();
    this.idle();
    try {
      return await super.request(input);
    } finally {
      this.idle();
    }
  }

  /** The server stops once nothing was embedded for idleMs. */
  idle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref?.();
  }

  /** Starts llama-server on a free port, unless it runs: resolves once it answers /health. */
  serve() {
    if (this.child && !this.starting) return Promise.resolve();
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async start() {
    const binary = this.runtime();
    if (!binary) throw new Error(`${this.llamaServer} is not on PATH: search by meaning needs llama.cpp's llama-server (see :checkhealth semantic-grep)`);
    if (!this.hasModel()) throw new Error(`${this.spec.name} is not downloaded yet (:SemanticGrep download)`);
    const port = await freePort();
    const args = ['--model', this.path, '--alias', this.spec.model, '--host', '127.0.0.1', '--port', String(port), '--no-webui', ...this.spec.args, '--threads', String(this.threads)];
    this.log(`local model: ${binary} ${args.join(' ')}`);
    // CUDA_VISIBLE_DEVICES empty: a CUDA build would still use a GPU for big batches with no layers on it.
    const child = this.run(binary, args, {stdio: ['ignore', 'ignore', 'pipe'], env: {...process.env, CUDA_VISIBLE_DEVICES: ''}});
    let tail = '';
    let gone = null;
    child.stderr?.on('data', chunk => { tail = (tail + chunk).slice(-2000); });
    child.on('error', error => {
      gone = `cannot run ${binary}: ${error.message}`;
      if (this.child === child) { this.child = null; this.port = null; }
    });
    child.on('exit', (code, signal) => {
      gone ??= `llama-server stopped (${code ?? signal}): ${tail.trim().split('\n').slice(-3).join(' ')}`;
      if (this.child === child) { this.child = null; this.port = null; }
    });
    this.child = child;
    this.port = port;
    this.entry = {...this.entry, baseUrl: `http://127.0.0.1:${port}/v1`};
    const end = Date.now() + START_MS;
    for (;;) {
      if (gone) throw new Error(gone);
      try {
        const response = await this.fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(2000)});
        if (response.ok) return;
      } catch {}
      if (Date.now() > end) {
        child.kill('SIGKILL');
        if (this.child === child) { this.child = null; this.port = null; }
        throw new Error(`llama-server did not come up on 127.0.0.1:${port} within ${START_MS / 1000} s`);
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  /** Stops the server (it starts again at the next text). */
  async stop() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.port = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(kill); resolve(); });
      child.kill('SIGTERM');
    });
  }

  close() {
    super.close();
    process.off('exit', this.stopOnExit);
    this.stop();
  }
}
