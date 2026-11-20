import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentPaths, readPrivateToken } from './paths.mjs';
import { codexCoreArguments } from './proxy-core.mjs';

// Model proxy owner: the split account Core (ChatGPT account pool, configured providers,
// credentials and usage). It has its own lifecycle, so Brain and Gateway releases do not
// restart it, and releasing it does not restart engines.
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
  throw new Error('The model proxy bundle requires matching Linux arm64 or amd64');
const paths = deploymentPaths();
if (paths.proxyPort === null) throw new Error('Set OPENCRAFT_PROXY_PORT for the model proxy service');
await mkdir(paths.dataDirectory, { recursive: true, mode: 0o700 });
const info = await stat(paths.dataDirectory);
if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
  throw new Error('The data directory must be owned by this user with mode 0700');
await mkdir(paths.runDirectory, { recursive: true, mode: 0o700 });
await mkdir(join(paths.dataDirectory, 'codex'), { recursive: true, mode: 0o700 });
try { await writeFile(paths.tokenPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
await readPrivateToken(paths.tokenPath);
// No separate lock file: the account Core holds the Codex writer lock (an SQLite exclusive transaction the
// kernel releases on exit). A directory lock would survive SIGKILL after a long drain and block the successor.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(join(root, 'bin/node'), [join(root, 'runtime', 'codex-core.cjs'), ...codexCoreArguments(paths, root, paths.proxyPort)], {
  cwd: paths.runtimeDirectory, env: process.env, stdio: 'inherit', shell: false,
});
const forward = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));
const [code, signal] = await new Promise(accept => {
  child.once('error', error => { console.error(error.message); accept([1, null]); });
  child.once('exit', (exitCode, exitSignal) => accept([exitCode, exitSignal]));
});
process.exitCode = code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1);
