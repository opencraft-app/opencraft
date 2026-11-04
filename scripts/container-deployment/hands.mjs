import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const data = process.env.OPENCRAFT_BROWSER_DATA_DIR;
if (!data || !data.startsWith('/')) throw new Error('Set OPENCRAFT_BROWSER_DATA_DIR to an absolute path');
await mkdir(data, { recursive: true, mode: 0o700 });
const info = await stat(data);
if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error('Hands data directory must be private and owned by this user');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), children = [];
let stopping;
const stop = code => stopping ??= (async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(child => new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('close', resolve))));
  process.exitCode = code;
})();
for (const entry of ['browser/owner.cjs', 'hands-execution-owner.mjs']) {
  const child = spawn(join(root, 'bin/node'), [join(root, 'runtime', entry)], { cwd: process.env.OPENCRAFT_WORKSPACE_DIR, env: process.env, stdio: 'inherit', shell: false });
  child.once('error', () => void stop(1)); child.once('exit', () => { if (!stopping) void stop(1); }); children.push(child);
}
process.once('SIGINT', () => void stop(0)); process.once('SIGTERM', () => void stop(0));
for (let attempt = 0; attempt < 120; attempt++) {
  try {
    const sockets = await Promise.all([join(data, 'owner.sock'), process.env.OPENCRAFT_HANDS_EXECUTION_SOCKET].map(path => stat(path)));
    if (sockets.every(value => value.isSocket())) { console.log('OpenCraft Hands browser and Codex exec-server owner ready.'); break; }
  } catch {}
  if (attempt === 119) await stop(1); else await new Promise(resolve => setTimeout(resolve, 500));
}
