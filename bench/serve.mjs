// A profile's local models, each on its own llama.cpp server (`serve` in profiles.json): started when its baseUrl does
// not answer, from the GGUF found under the models folder, and stopped when the bench ends. A server already answering
// at that address is used as it is, and left running.
import {execFileSync, spawn} from 'node:child_process';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {basename, join} from 'node:path';

/** Whether a llama.cpp server answers at `baseUrl`: "up", "loading" (503 while it loads its model) or null. */
async function answers(baseUrl) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/v1\/?$/, '')}/health`, {signal: AbortSignal.timeout(2000)});
    return response.ok ? 'up' : response.status === 503 ? 'loading' : null;
  } catch {
    return null;
  }
}

/** Waits while the server at `baseUrl` loads; `gone()` says why to stop waiting. */
async function upAt(baseUrl, role, gone = () => null) {
  const end = Date.now() + 300_000;
  while (await answers(baseUrl) !== 'up') {
    const why = gone();
    if (why) throw new Error(`${role}: ${why}`);
    if (Date.now() > end) throw new Error(`${role}: nothing came up at ${baseUrl}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/** The most RAM the process `pid` has held (its VmHWM), in MB, or null. */
function peakRss(pid) {
  try { return Math.round(Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024); } catch { return null; }
}

/** The GPU memory the process `pid` holds now, in MB (nvidia-smi's), or null. */
function gpuMemory(pid) {
  try {
    const out = execFileSync('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], {encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore']});
    const mine = out.split('\n').map(line => line.split(',').map(Number)).filter(([each]) => each === pid);
    return mine.length ? mine.reduce((sum, [, mb]) => sum + mb, 0) : null;
  } catch {
    return null;
  }
}

/** The first file named `name` under `dir`, depth first. */
function find(dir, name, depth = 4) {
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  if (entries.includes(name) && statSync(join(dir, name)).isFile()) return join(dir, name);
  if (!depth) return null;
  for (const entry of entries) {
    const path = join(dir, entry);
    try { if (!statSync(path).isDirectory()) continue; } catch { continue; }
    const found = find(path, name, depth - 1);
    if (found) return found;
  }
  return null;
}

/**
 * Starts what `profile.serve` names and does not answer yet: `{stop(), servers, measured()}`; `measured()` is `servers`
 * with the most RAM each server started here took so far, and the GPU memory it holds (`rssMB`, `vramMB`). `models` is the folder of GGUF files,
 * `llamaServer` the binary. The servers get `serve.env` (CUDA_VISIBLE_DEVICES "" keeps a CPU profile off the GPU,
 * which llama.cpp would otherwise use for big batches even with no layers on it), then `env`.
 */
export async function serveProfile(profile, {models, llamaServer = 'llama-server', env = {}, log = () => {}}) {
  const children = [];
  const servers = {}; // role -> what ran it: started here (its GGUF, args and env) or found answering
  const ended = child => child.exitCode !== null || child.signalCode !== null;
  const stop = async () => {
    process.off('SIGINT', signalled);
    process.off('SIGTERM', signalled);
    for (const child of children) if (!ended(child)) child.kill('SIGTERM');
    // Ten seconds to go, then killed: a server stuck on its way out does not keep the bench.
    await Promise.all(children.map(child => (ended(child) || child.failed ? null : new Promise(resolve => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.once('exit', () => { clearTimeout(kill); resolve(); });
    }))));
  };
  // Stopped with the bench, however it ends: a signal while one loads too.
  const signalled = signal => { stop().finally(() => process.exit(128 + (signal === 'SIGINT' ? 2 : 15))); };
  process.once('SIGINT', signalled);
  process.once('SIGTERM', signalled);
  try {
    for (const [role, spec] of Object.entries(profile.serve ?? {})) {
      if (role === 'env') continue;
      const entry = profile[role];
      if (!entry) continue;
      const there = await answers(entry.baseUrl);
      if (there) { // someone else's, used as it is: its model is whatever it serves
        log(`${role}: a server answers at ${entry.baseUrl} already; it is used, as ${entry.model}`);
        servers[role] = {started: false};
        await upAt(entry.baseUrl, role);
        continue;
      }
      if (!models) throw new Error(`${role}: nothing answers at ${entry.baseUrl}, and no --models folder to start ${spec.gguf} from`);
      const gguf = find(models, spec.gguf);
      if (!gguf) throw new Error(`${role}: ${spec.gguf} is not under ${models}`);
      const {hostname, port} = new URL(entry.baseUrl);
      const args = ['--model', gguf, '--host', hostname, '--port', port, '--no-webui', ...spec.args];
      log(`${role}: ${llamaServer} ${args.join(' ')}`);
      servers[role] = {started: true, gguf: basename(gguf), args: spec.args, env: profile.serve.env ?? {}, ...(env.CUDA_VISIBLE_DEVICES ?? process.env.CUDA_VISIBLE_DEVICES ? {devices: env.CUDA_VISIBLE_DEVICES ?? process.env.CUDA_VISIBLE_DEVICES} : {})};
      const child = spawn('nice', ['-n', '19', llamaServer, ...args], {stdio: ['ignore', 'ignore', 'pipe'], env: {...process.env, ...profile.serve.env, ...env}});
      let tail = '';
      child.stderr.on('data', chunk => { tail = (tail + chunk).slice(-2000); });
      child.on('error', error => { child.failed = error; });
      child.role = role;
      children.push(child);
      await upAt(entry.baseUrl, role, () => (child.failed ? `cannot run ${llamaServer}: ${child.failed.message}`
        : ended(child) ? `llama-server stopped (${child.exitCode ?? child.signalCode}): ${tail.trim().split('\n').slice(-3).join(' ')}` : null));
    }
  } catch (error) {
    await stop();
    throw error;
  }
  const measured = () => {
    for (const child of children) {
      if (ended(child) || !child.pid) continue;
      const rssMB = peakRss(child.pid); // `nice` runs llama-server in its own process: the same pid
      const vramMB = gpuMemory(child.pid);
      Object.assign(servers[child.role], rssMB === null ? {} : {rssMB}, vramMB === null ? {} : {vramMB});
    }
    return servers;
  };
  return {stop, servers, measured};
}
