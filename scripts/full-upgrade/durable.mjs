import { constants } from 'node:fs';
import { open, mkdir, rename, unlink, lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
export function invariant(condition, code) { if (!condition) throw new Error(code); }
export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  invariant(info.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o077), 'private-directory-required');
  for (const path of [directory, dirname(directory)]) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
// A successful call includes the directory entry durability boundary. If fsync
// fails after rename the result is uncertain: callers stop, then reconcile.
export async function atomicBytes(path, bytes, mode = 0o600, io = {}) {
  const fsOpen = io.open ?? open, fsRename = io.rename ?? rename;
  const temporary = join(dirname(path), '.' + randomUUID() + '.tmp');
  let file;
  try {
    file = await fsOpen(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    await file.writeFile(bytes); await file.chmod(mode); await file.sync(); await file.close(); file = null;
    await fsRename(temporary, path);
    const directory = await fsOpen(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await file?.close(); await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export const atomicJson = (path, value, io = {}) => atomicBytes(path, JSON.stringify(value) + '\n', 0o600, io);
export async function readPrivateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await file.stat();
    invariant(s.isFile() && s.uid === process.getuid() && !(s.mode & 0o077) && s.size <= 4 * 1024 ** 2, 'private-file-required');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
export async function command(binary, args, { fd, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore', ...(fd === undefined ? [] : [fd])],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
    let output = '', exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', data => { output += data; if (output.length > 65536) { exceeded = true; child.kill('SIGKILL'); } });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); code === 0 && !exceeded ? resolve(output) : reject(new Error('command-failed')); });
  });
}
// flock(1) locks inherited fd 3's open-file-description. The parent retains the
// fd and therefore the kernel lock after flock exits. Never unlink lock files.
export async function acquireLock(path) {
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    invariant((await file.stat()).isFile(), 'lock-file-required');
    await command('/usr/bin/flock', ['-n', '3'], { fd: file.fd });
    return () => file.close();
  } catch (error) { await file.close(); throw error; }
}
export async function bootIdentity() { return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); }
