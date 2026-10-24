import { chmod, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** npm extraction honors the installer's private umask. Only the immutable,
 * public browser distribution is mounted into the separate dynamic UID. Never
 * widen access to deployment parents, credentials or browser user data. */
export async function prepareBrowserRuntimeAccess(directory) {
  async function visit(path) {
    const info = await lstat(path);
    if (!info.isDirectory() && !info.isFile()) throw new Error('Unsupported browser runtime entry');
    const mode = info.isDirectory() || (info.mode & 0o111) ? 0o755 : 0o644;
    // Correctly provisioned read-only distributions need no permission writes.
    if ((info.mode & 0o7777) !== mode) await chmod(path, mode);
    if (info.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
  }
  await visit(directory);
}
