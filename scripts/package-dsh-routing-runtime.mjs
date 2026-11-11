import { build } from 'esbuild';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function buildDshRoutingRuntime(directory) {
  await build({ entryPoints: [fileURLToPath(new URL('../apps/local-agent-host/src/dsh-session-routing.worker.ts', import.meta.url))],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    outfile: join(directory, 'dsh-session-routing-worker.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node26', logLevel: 'warning' });
}
