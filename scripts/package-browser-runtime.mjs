import { cp, mkdir, readdir, stat, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyRemoteBrowserArtifact } from './remote-browser-artifact.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Ship a verified owned artifact when explicitly selected, otherwise the
 * pinned stock runtime. The worker advertises only APIs that actually exist. */
export async function packageBrowserRuntime(destination) {
  const require = createRequire(import.meta.url);
  // Release builds install dependencies with --ignore-scripts. Prepare only
  // this pinned runtime explicitly; Electron verifies its bundled checksums.
  let distribution;
  if (process.env.OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION) {
    distribution = await verifyRemoteBrowserArtifact(process.env.OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION, join(root, 'vendor/electron/fork.json'));
  } else {
    await promisify(execFile)(process.execPath, [join(dirname(require.resolve('electron/package.json')), 'install.js')],
      { timeout: 300_000, maxBuffer: 1024 * 1024 });
    distribution = dirname(require('electron'));
  }
  await mkdir(destination, { recursive: true });
  await cp(distribution, join(destination, 'electron'), { recursive: true });
  for (const name of ['worker.cjs','owner.cjs','diagnostics.cjs','controls.cjs','touch.cjs','clipboard.cjs','ime.cjs','focus.cjs','encoder-preload.cjs','encoder.html'])
    await cp(join(root, 'scripts/remote-browser', name), join(destination, name));
  // The private worker uses shared input/media policies. Bundle their closure
  // so an isolated installed runtime never depends on source-workspace links.
  await build({ entryPoints: [join(root, 'scripts/remote-browser/worker.cjs')], outfile: join(destination, 'worker.cjs'),
    bundle: true, format: 'cjs', platform: 'node', target: 'node24', external: ['electron'] });
  await build({ entryPoints: [join(root, 'packages/browser-preview-bridge/src/index.ts')], outfile: join(destination, 'preview-bridge.js'),
    bundle: true, format: 'iife', globalName: 'OpenCraftPreviewBridgeRuntime', platform: 'browser', target: 'chrome120' });
  // Public code/assets must be traversable inside the dynamic-UID mount even
  // when the build/install process uses a private umask. No user data is here.
  async function permissions(path) {
    await chmod(path, 0o755);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await permissions(target);
      else if (entry.isFile()) await chmod(target, (await stat(target)).mode & 0o111 ? 0o755 : 0o644);
    }
  }
  await permissions(destination);
}
