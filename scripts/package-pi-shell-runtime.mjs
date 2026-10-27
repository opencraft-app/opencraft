import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Transpile the fixed third-party extension; the copied dependency closure owns native assets. */
export async function buildPiShellRuntime(directory) {
  for (const [source, name] of [['shell-worker.ts', 'pi-shell-worker.mjs'], ['shell-extension.mjs', 'pi-shell-extension.mjs']]) {
    await build({ entryPoints: [join(repositoryRoot, 'plugins/pi-engine/src', source)], outfile: join(directory, name),
      bundle: true, platform: 'node', format: 'esm', target: 'node22',
      external: ['@earendil-works/pi-*', '@earendil-works/chord', 'zigpty', '@xterm/*', '@typesafe-ai/sdk', 're2js', 'typebox'],
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
  }
}
