import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, cp, lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()
    || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Terminal owner directory must be private');
}
export async function terminalOwnerLocation(dataDirectory: string) {
  const directory = join(resolve(dataDirectory), 'terminal-pty');
  await privateDirectory(directory);
  const key = createHash('sha256').update(directory).digest('hex').slice(0, 24);
  // Prefer the stable data root: TMPDIR may change across Host generations,
  // and systemd PrivateTmp would hide /tmp sockets from the sibling owner.
  let socketDirectory = directory;
  if (Buffer.byteLength(join(directory, 'owner.sock')) > 100) {
    const uid = process.getuid?.() ?? 0;
    const base = process.platform === 'linux' ? (uid === 0 ? '/run' : `/run/user/${uid}`) : tmpdir();
    socketDirectory = join(base, `opencraft-pty-${uid}-${key}`);
    if (process.platform !== 'win32') await privateDirectory(socketDirectory);
  }
  return { directory, endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\opencraft-pty-${key}` : join(socketDirectory, 'owner.sock'), unit: `opencraft-pty-${key}` };
}
async function treeIdentity(directory: string, hash: ReturnType<typeof createHash>, prefix = '') {
  for (const name of (await readdir(directory)).sort()) {
    const relative = join(prefix, name), path = join(directory, name), info = await lstat(path);
    if (info.isDirectory()) await treeIdentity(path, hash, relative);
    else if (info.isFile()) { hash.update(relative); hash.update(String(info.mode & 0o777)); hash.update(await readFile(path)); }
    else throw new Error('Unsupported terminal runtime asset');
  }
}
/** Retain the full native closure outside removable release directories. */
export async function terminalOwnerCommand(directory: string) {
  const bundled = new URL('./terminal-pty-owner.mjs', import.meta.url);
  if (!existsSync(bundled)) {
    const source = new URL('./terminal-pty-owner.ts', import.meta.url);
    await access(source, constants.R_OK);
    return ['--import', 'tsx', fileURLToPath(source), '--terminal-pty-owner'];
  }
  let native: string | undefined;
  const candidates = [new URL('./native/node-pty/package.json', import.meta.url), new URL('./node_modules/node-pty/package.json', import.meta.url)];
  for (const candidate of candidates) if (existsSync(candidate)) { native = dirname(fileURLToPath(candidate)); break; }
  native ??= dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  const entry = await readFile(bundled), hash = createHash('sha256').update(entry);
  await treeIdentity(native, hash);
  const identity = hash.digest('hex'), root = join(directory, 'runtimes'), destination = join(root, identity);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!existsSync(destination)) {
    const temporary = join(root, '.stage-' + randomUUID());
    await mkdir(join(temporary, 'node_modules'), { recursive: true, mode: 0o700 });
    try {
      await cp(fileURLToPath(bundled), join(temporary, 'terminal-pty-owner.mjs'));
      await cp(native, join(temporary, 'node_modules/node-pty'), { recursive: true });
      const verify = createHash('sha256').update(await readFile(join(temporary, 'terminal-pty-owner.mjs')));
      await treeIdentity(join(temporary, 'node_modules/node-pty'), verify);
      if (verify.digest('hex') !== identity) throw new Error('Terminal owner runtime changed during publication');
      await rename(temporary, destination).catch(error => { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const retained = createHash('sha256').update(await readFile(join(destination, 'terminal-pty-owner.mjs')));
  await treeIdentity(join(destination, 'node_modules/node-pty'), retained);
  if (retained.digest('hex') !== identity) throw new Error('Terminal owner runtime integrity check failed');
  return [join(destination, 'terminal-pty-owner.mjs'), '--terminal-pty-owner'];
}
export async function launchTerminalOwner(location: Awaited<ReturnType<typeof terminalOwnerLocation>>) {
  const args = [...await terminalOwnerCommand(location.directory), location.directory, location.endpoint];
  // A detached child still belongs to a service's control-group. Managed Linux
  // must create a sibling unit; failure never silently weakens that guarantee.
  if (process.platform === 'linux' && process.env.INVOCATION_ID) {
    const user = process.getuid?.() !== 0;
    await new Promise<void>((resolve, reject) => {
      const child = spawn('systemd-run', [...(user ? ['--user'] : []), '--collect', '--quiet', '--service-type=exec', '--unit=' + location.unit,
        '-p', 'UMask=0077', '-p', 'StandardOutput=null', '-p', 'StandardError=null',
        '-p', 'WorkingDirectory=' + process.cwd(),
        '/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', process.execPath, ...args], { stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Terminal owner manager timed out')); }, 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      // A concurrent Host may have won. Connection to the private socket, not
      // the launcher exit status, decides whether an owner is available.
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  } else {
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  }
}
