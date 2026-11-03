// A profile's local models, each on its own llama.cpp server (`serve` in profiles.json): started when its baseUrl does
// not answer, from the GGUF found under the models folder, and stopped when the bench ends. A server already answering
// at that address is used as it is, and left running.
import {spawn} from 'node:child_process';
import {readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

/** Whether a llama.cpp (or any OpenAI-compatible) server answers at `baseUrl`. */
async function answers(baseUrl) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/v1\/?$/, '')}/health`, {signal: AbortSignal.timeout(2000)});
    return response.ok;
  } catch {
    return false;
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
 * Starts what `profile.serve` names and does not answer yet: `{stop()}`. `models` is the folder of GGUF files,
 * `llamaServer` the binary. The servers get `serve.env` (CUDA_VISIBLE_DEVICES "" keeps a CPU profile off the GPU,
 * which llama.cpp would otherwise use for big batches even with no layers on it), then `env`.
 */
export async function serveProfile(profile, {models, llamaServer = 'llama-server', env = {}, log = () => {}}) {
  const children = [];
  const stop = async () => {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(children.map(child => (child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : null)));
  };
  try {
    for (const [role, spec] of Object.entries(profile.serve ?? {})) {
      if (role === 'env') continue;
      const entry = profile[role];
      if (!entry || await answers(entry.baseUrl)) continue;
      if (!models) throw new Error(`${role}: nothing answers at ${entry.baseUrl}, and no --models folder to start ${spec.gguf} from`);
      const gguf = find(models, spec.gguf);
      if (!gguf) throw new Error(`${role}: ${spec.gguf} is not under ${models}`);
      const {hostname, port} = new URL(entry.baseUrl);
      const args = ['--model', gguf, '--host', hostname, '--port', port, '--no-webui', ...spec.args];
      log(`${role}: ${llamaServer} ${args.join(' ')}`);
      const child = spawn('nice', ['-n', '19', llamaServer, ...args], {stdio: ['ignore', 'ignore', 'pipe'], env: {...process.env, ...profile.serve.env, ...env}});
      let tail = '';
      child.stderr.on('data', chunk => { tail = (tail + chunk).slice(-2000); });
      children.push(child);
      const end = Date.now() + 300_000;
      while (!await answers(entry.baseUrl)) {
        if (child.exitCode !== null) throw new Error(`${role}: llama-server stopped (${child.exitCode}): ${tail.trim().split('\n').slice(-3).join(' ')}`);
        if (Date.now() > end) throw new Error(`${role}: llama-server did not come up at ${entry.baseUrl}`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  } catch (error) {
    await stop();
    throw error;
  }
  // Stopped with the bench, however it ends.
  const signalled = signal => { stop().finally(() => process.exit(128 + (signal === 'SIGINT' ? 2 : 15))); };
  process.once('SIGINT', signalled);
  process.once('SIGTERM', signalled);
  return {stop};
}
