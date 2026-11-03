// Runs a Lua script in a headless Neovim with this plugin (and Telescope, when asked) on its runtimepath, no config of
// the user's: `runNvim(lua, {cwd, telescope})` resolves the JSON lines the script wrote to stdout with emit(t).
import {spawn} from 'node:child_process';
import {existsSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const LAZY = join(homedir(), '.local', 'share', 'nvim', 'lazy');
export const TELESCOPE = process.env.TELESCOPE_DIR ?? join(LAZY, 'telescope.nvim');
export const PLENARY = process.env.PLENARY_DIR ?? join(LAZY, 'plenary.nvim');
export const hasTelescope = existsSync(join(TELESCOPE, 'lua', 'telescope')) && existsSync(join(PLENARY, 'lua', 'plenary'));

const PRELUDE = `
local function emit(t) io.stdout:write(vim.json.encode(t), '\\n'); io.stdout:flush() end
local function until_(check, what, ms)
  if not vim.wait(ms or 10000, check, 20) then emit({error = 'timed out waiting for ' .. what}); os.exit(1) end
end
`;

export function runNvim(lua, {cwd, telescope = false, dir, timeoutMs = 60_000} = {}) {
  const script = join(dir, `script-${Date.now()}.lua`);
  const rtp = [REPO, ...(telescope ? [TELESCOPE, PLENARY] : [])].join(',');
  writeFileSync(script, `vim.opt.rtp:prepend(${JSON.stringify(rtp)})\nvim.cmd('runtime! plugin/**/*.lua plugin/**/*.vim')\n${PRELUDE}\nlocal ok, err = xpcall(function()\n${lua}\nend, debug.traceback)\nif not ok then emit({error = err}) end\nos.exit(0)\n`);
  return new Promise((resolve, reject) => {
    const child = spawn('nvim', ['--headless', '-u', 'NONE', '-i', 'NONE', '-n', '-l', script], {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`nvim timed out:\n${stdout}\n${stderr}`)); }, timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      const lines = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      const failed = lines.find(line => line.error);
      if (failed) return reject(new Error(`${failed.error}\n${stderr}`));
      resolve({lines, stderr});
    });
  });
}
