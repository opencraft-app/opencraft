import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export const suites = {
  'core-anthropic': ['run', 'test:codex-anthropic'],
  core: ['run', 'test:codex-core'],
  assistant: ['run', 'test:assistant-runtime'],
  gate: ['run', 'gate'],
};

// Additional suites come from an explicit JSON file mapping suite names to npm
// arguments. They extend, but never redefine, the suites above.
export function loadSuites(file) {
  const extra = JSON.parse(readFileSync(file, 'utf8'));
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw Error('Suite configuration must be a JSON object');
  for (const [name, args] of Object.entries(extra)) {
    if (Object.hasOwn(suites, name)) throw Error('Suite configuration cannot redefine: ' + name);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw Error('Invalid suite name: ' + name);
    if (!Array.isArray(args) || !args.length || !args.every(arg => typeof arg === 'string' && arg))
      throw Error('Suite arguments must be non-empty strings: ' + name);
  }
  return { ...suites, ...extra };
}

// Tests must never borrow a developer's production data, profiles or credentials.
// Raw Node child processes also need the source loader; tsx's execArgv alone
// is not inherited by spawn(process.execPath, [entry]).
export async function runIsolatedTest(command, args, { root = repository, loader, parent = process.env } = {}) {
  loader ??= createRequire(join(root, 'package.json')).resolve('tsx');
  const base = process.platform !== 'win32' && Buffer.byteLength(tmpdir()) > 40 ? '/tmp' : tmpdir();
  const temporary = mkdtempSync(join(base, 'oc-ci-'));
  for (const name of ['home', 'data', 'workspace']) mkdirSync(join(temporary, name), { mode: 0o700 });
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'COMSPEC', 'PATHEXT',
    'PLAYWRIGHT_BROWSERS_PATH',
    'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'GCC_EXEC_PREFIX', 'COMPILER_PATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH'])
    if (parent[key] !== undefined) env[key] = parent[key];
  Object.assign(env, {
    HOME: join(temporary, 'home'), USERPROFILE: join(temporary, 'home'),
    TMPDIR: temporary, TEMP: temporary, TMP: temporary, CI: 'true',
    OPENCRAFT_DATA_DIR: join(temporary, 'data'), OPENCRAFT_WORKSPACE_DIR: join(temporary, 'workspace'),
    NODE_OPTIONS: `--max-old-space-size=6144 --import=${pathToFileURL(resolve(loader)).href}`,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', npm_config_userconfig: process.platform === 'win32' ? 'NUL' : '/dev/null',
  });
  let child;
  const forward = signal => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  try {
    child = spawn(command, args, { cwd: root, env, stdio: 'inherit', detached: process.platform !== 'win32' });
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    return await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { suites: { type: 'string' } } });
  const selectable = values.suites === undefined ? suites : loadSuites(values.suites);
  const names = Object.keys(selectable), suite = positionals[0];
  if (positionals.length !== 1 || !Object.hasOwn(selectable, suite)) throw Error(`Select ${names.slice(0, -1).join(', ')} or ${names.at(-1)}`);
  process.exitCode = await runIsolatedTest(process.platform === 'win32' ? 'npm.cmd' : 'npm', selectable[suite]);
}
