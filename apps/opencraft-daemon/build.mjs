import { buildDshRoutingRuntime } from '../../scripts/package-dsh-routing-runtime.mjs';
import { buildTranscriptCacheRuntime } from '../../scripts/package-transcript-cache-runtime.mjs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildTerminalOwnerRuntime } from '../../scripts/package-terminal-runtime.mjs';
await buildTranscriptCacheRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildDshRoutingRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildTerminalOwnerRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await build({ entryPoints: ['src/bin.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['node-pty', '@earendil-works/pi-*', '@earendil-works/chord'], outfile: 'dist/main.cjs',
  define: { 'import.meta.url': 'import_meta_url' },
  banner: { js: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;" } });

await build({entryPoints:['../../packages/access-control/src/orchestration-runtime.worker.ts'],outfile:'dist/orchestration-runtime-worker.mjs',bundle:true,platform:'node',format:'esm',target:'node26'});

await build({entryPoints:['../../apps/personal-assistant/src/runtime/assistant-server.mjs'],outfile:'dist/assistant-server.mjs',bundle:true,platform:'node',format:'esm',target:'node26',external:['@earendil-works/pi-*','@earendil-works/chord'],banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});

await (await import('node:fs/promises')).copyFile('../../apps/personal-assistant/src/adapters/sqlite/schema.sql','dist/schema.sql');
await build({ entryPoints: ["../agent-bridge-host/src/storage.worker.ts"], outfile: "dist/storage.worker.mjs", bundle: true, platform: "node", format: "esm", banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
