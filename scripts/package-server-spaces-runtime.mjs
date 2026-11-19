import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
export async function buildServerSpacesRuntime(directory) {
  await build({entryPoints:[fileURLToPath(new URL('../packages/access-control/src/server-spaces.worker.ts',import.meta.url))],
    outfile:join(directory,'server-spaces-worker.mjs'),bundle:true,platform:'node',format:'esm',target:'node26',logLevel:'warning'});
}
