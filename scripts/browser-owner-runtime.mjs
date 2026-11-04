import { access, cp, lstat, mkdir, rename, rm, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { browserRuntimeIdentity } from './browser-runtime-identity.mjs';
import { prepareBrowserRuntimeAccess } from './remote-browser-access.mjs';

/** Publish without unlinking bytes a managed instance may already have mounted.
 * The compatibility alias is only for old readers; it is never our authority. */
export async function publishBrowserOwnerRuntime(directory, dataDirectory, identity) {
  if (!/^[0-9a-f]{64}$/.test(identity)) throw new Error('Invalid browser runtime identity');
  const parent = join(dataDirectory, 'owner-runtimes'), runtime = join(parent, identity);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const verify = async path => {
    if (!(await lstat(path)).isDirectory()) throw new Error('Invalid browser retained runtime directory');
    if (await browserRuntimeIdentity(path) !== identity) throw new Error('Browser runtime identity mismatch');
  };
  let present;
  try { await access(runtime); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (present) await verify(runtime);
  else {
    const staged = join(parent, '.staging-' + randomUUID());
    try {
      await cp(directory, staged, { recursive: true, mode: constants.COPYFILE_FICLONE });
      await prepareBrowserRuntimeAccess(staged); await verify(staged);
      try { await rename(staged, runtime); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        await verify(runtime);
      }
    } finally { await rm(staged, { recursive: true, force: true }); }
  }
  try { await symlink(runtime, join(dataDirectory, 'owner-runtime')); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return runtime;
}
