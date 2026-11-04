import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** DSH loads this resource without the parent Host's TypeScript loader. */
export async function buildDshCapabilityPlugin(outfile) {
  await build({
    entryPoints: [resolve(root, 'apps/local-agent-host/src/dsh-capability-plugin.mjs')],
    outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    nodePaths: [resolve(root, 'node_modules')],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
}
