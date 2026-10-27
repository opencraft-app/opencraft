import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function buildGitIdentityRuntime(directory, additionalEntries = []) {
  await mkdir(directory, { recursive: true });
  const entries = [{ entry: join(root, 'scripts/git-identity-wrapper.ts'), name: 'git-identity-wrapper.mjs' }, ...additionalEntries];
  const seen = new Set();
  for (const { entry, name } of entries) {
    if (!/^[a-z0-9][a-z0-9-]*\.mjs$/u.test(name) || seen.has(name)) throw new Error('Invalid Git runtime entry name');
    seen.add(name);
    await build({ entryPoints: [entry], outfile: join(directory, name), nodePaths: [join(root, 'node_modules')],
      bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning',
      banner: { js: "import { createRequire as createOpenCraftGitRequire } from 'node:module'; const require = createOpenCraftGitRequire(import.meta.url);" } });
  }
  await cp(join(root, 'scripts/git-identity-peer-bridge.py'), join(directory, 'git-identity-peer-bridge.py'));
  await cp(join(root, 'scripts/git-identity-shell-env.sh'), join(directory, 'git-identity-shell-env.sh'));
}
