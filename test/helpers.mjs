// What the tests share: scratch folders removed when the file's tests end, a wait for a condition, and which tools
// this machine has.
import {execFileSync} from 'node:child_process';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after} from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'semantic-grep-test-')));
after(() => rmSync(root, {recursive: true, force: true}));

/** A new empty folder named `prefix` and six random characters, removed when the file's tests end. */
export const scratch = (prefix = 'scratch-') => mkdtempSync(join(root, prefix));

/** Resolves once `check()` is true; rejects after `timeoutMs`. */
export async function until(check, what, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const has = command => { try { execFileSync(command, ['--version'], {stdio: 'ignore'}); return true; } catch { return false; } };
export const hasNvim = has('nvim');
export const hasRg = has('rg');
