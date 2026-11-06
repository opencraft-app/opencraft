import { buildTranscriptCacheRuntime } from '../../scripts/package-transcript-cache-runtime.mjs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildTerminalOwnerRuntime } from '../../scripts/package-terminal-runtime.mjs';
await buildTranscriptCacheRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildTerminalOwnerRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await build({entryPoints:['src/execution-fault.worker.ts'],outfile:'dist/execution-fault-worker.mjs',bundle:true,platform:'node',format:'esm',target:'node26'});
await build({ entryPoints: ['src/bin.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['node-pty'], outfile: 'dist/main.cjs',
  define: { 'import.meta.url': 'import_meta_url' },
  banner: { js: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;" } });
