import { access, chmod, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The published macOS prebuild may contain a non-executable spawn helper.
// Repair only this checkout's dependency, as desktop packaging already does.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  let prepared = false;
  for (const directory of ['build/Release', 'build/Debug', `prebuilds/darwin-${process.arch}`]) {
    try { await stat(join(root, directory, 'pty.node')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const helper = join(root, directory, 'spawn-helper');
    if (!(await stat(helper)).isFile()) throw new Error('Invalid local PTY spawn helper');
    await chmod(helper, 0o755);
    await access(helper, constants.X_OK);
    prepared = true;
    break;
  }
  if (!prepared) throw new Error('Local macOS PTY native prebuild is missing');
  console.log('Local macOS PTY spawn helper is executable.');
}
