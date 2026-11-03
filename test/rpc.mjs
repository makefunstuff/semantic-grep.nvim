// A JSON-RPC client of the stdio server, as Neovim is one: `call(method, params)` resolves the result (or rejects with
// the error's message), `notifications` lists what the server told of its own accord, `close()` ends its stdin.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readLines} from '../src/jsonl.mjs';

export const SERVER = fileURLToPath(new URL('../bin/semantic-grep-server.mjs', import.meta.url));

export function startServer({env = process.env} = {}) {
  const child = spawn(process.execPath, [SERVER], {stdio: ['pipe', 'pipe', 'pipe'], env});
  const waiting = new Map();
  const notifications = [];
  let next = 0;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  readLines(child.stdout, message => {
    if (message.id !== undefined && waiting.has(message.id)) {
      const {resolve, reject} = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method) notifications.push(message);
  });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return {
    child, notifications, exited,
    get stderr() { return stderr; },
    call(method, params) {
      const id = ++next;
      child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`);
      return new Promise((resolve, reject) => waiting.set(id, {resolve, reject}));
    },
    notify(method, params = {}) { child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method, params})}\n`); },
    close() { child.stdin.end(); return exited; },
  };
}
