import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
export async function buildTranscriptCacheRuntime(directory) {
  await build({entryPoints:[fileURLToPath(new URL('../packages/native-history-node/src/transcript-cache-storage.worker.ts',import.meta.url))],
    outfile:join(directory,'transcript-cache-storage-worker.mjs'),bundle:true,platform:'node',format:'esm',target:'node26',logLevel:'warning'});
}
