import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export async function buildConversationCli(output) {
  await build({ entryPoints: [fileURLToPath(new URL('../apps/opencraft-cli/src/main.ts', import.meta.url))], outfile: output,
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    external: ['bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire as __createCliRequire } from 'node:module'; const require = __createCliRequire(import.meta.url);" } });
  await chmod(output, 0o755);
}
