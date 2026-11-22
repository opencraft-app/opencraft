// Read-only migration probe, executed inside each selected image as its runtime UID.
// Input contains paths only; no config contents or credential files are emitted.
import { access, lstat, stat, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';

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
if (process.argv[1] === '--retained-workspace-probe') {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  await checkWorkspaces(JSON.parse(input));
  console.log('Retained workspace access verified');
}
