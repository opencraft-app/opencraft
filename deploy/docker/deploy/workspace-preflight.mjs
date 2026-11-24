// Deployment probes run inside each selected image as its runtime UID.
// Input contains paths only; no config contents or credential files are emitted.
import { access, lstat, stat, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { isAbsolute, join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function checkWorkspaces(workspaces) {
  if (!Array.isArray(workspaces) || !workspaces.length) throw Error('Expected retained workspace inventory');
  for (const row of workspaces) {
    if (!row || !isAbsolute(row.cwd ?? '') || !Array.isArray(row.readablePaths ?? [])) throw Error('Invalid workspace inventory');
    try {
      await access(row.cwd, constants.R_OK | constants.W_OK | constants.X_OK);
      if (!(await stat(row.cwd)).isDirectory()) throw Error('Not a directory');
      // Codex reads project configuration and rules along the ancestor chain.
      // Probe only these paths, never the whole .codex directory/auth store.
      for (let current = row.cwd;; current = dirname(current)) {
        for (const name of ['AGENTS.md', '.codex/config.toml', '.codex/rules']) {
          const path = join(current, name);
          try { await lstat(path); }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          await readable(path, new Set());
        }
        if (current === dirname(current)) break;
      }
      for (const path of row.readablePaths ?? []) {
        if (typeof path !== 'string' || !isAbsolute(path)) throw Error('Expected absolute read path');
        await readable(path, new Set());
      }
    } catch (error) {
      throw Error(`Retained workspace unavailable: ${row.cwd} (${['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'invalid path or access'}); restore mounts/access for the runtime UID before cutover`);
    }
  }
}
async function readable(path, seen) {
  const resolved = await realpath(path);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  const info = await lstat(resolved);
  await access(resolved, constants.R_OK | (info.isDirectory() ? constants.X_OK : 0));
  if (info.isDirectory()) for (const name of await readdir(resolved)) await readable(join(resolved, name), seen);
}
export async function checkAuthorityPath(path, owner) {
  const parent = dirname(path);
  const resolved = await realpath(parent);
  const info = await stat(resolved);
  if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid() ||
      (owner && resolved !== parent)) {
    throw Error(`Workspace authority needs a private directory owned by the runtime UID; Gateway must use its real path: ${parent} -> ${resolved}`);
  }
  await access(parent, constants.X_OK | (owner ? constants.W_OK : 0));
  const socket = await lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (socket && (!socket.isSocket() || (socket.mode & 0o777) !== 0o600 || socket.uid !== process.getuid())) {
    throw Error(`Workspace authority socket must be owned by the runtime UID with mode 0600: ${path}`);
  }
  return parent;
}

async function checkAuthoritySocket(role, path, token) {
  const owner = role === 'gateway';
  const parent = await checkAuthorityPath(path, owner);
  // Resolve the sibling relative to the already validated directory, even when
  // the configured absolute pathname is near the Unix socket length limit.
  process.chdir(parent);
  const sibling = '.oc-' + token;
  if (owner) {
    process.umask(0o177);
    const server = createServer(peer => {
      peer.on('error', () => {});
      peer.end(token);
    });
    await once(server.listen(sibling), 'listening');
    const timer = setTimeout(close, 35_000);
    function close() {
      clearTimeout(timer);
      server.close();
    }
    process.once('SIGTERM', close);
    console.log('Gateway socket parent verified at ' + parent);
    return;
  }
  const deadline = Date.now() + 25_000;
  while (true) {
    const peer = createConnection(sibling);
    peer.setTimeout(2_000, () => peer.destroy(Error('Workspace socket handshake timed out')));
    try {
      let response = '';
      for await (const chunk of peer) response += chunk;
      if (response !== token) throw Error('Brain reached a different socket listener');
      console.log('Brain reached the Gateway socket listener from ' + parent);
      return;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) || Date.now() >= deadline) throw error;
      await delay(150);
    } finally {
      peer.destroy();
    }
  }
}

if (process.argv[1] === '--retained-workspace-probe') {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  await checkWorkspaces(JSON.parse(input));
  console.log('Retained workspace access verified');
}
if (process.argv[1] === '--authority-socket-probe') {
  await checkAuthoritySocket(...process.argv.slice(2));
}
if (process.argv[1] === '--authority-path-probe') {
  await checkAuthorityPath(process.argv[3], process.argv[2] === 'gateway');
}
