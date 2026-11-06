import { buildDshRoutingRuntime } from '../../scripts/package-dsh-routing-runtime.mjs';
import { buildTranscriptCacheRuntime } from '../../scripts/package-transcript-cache-runtime.mjs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildTerminalOwnerRuntime } from '../../scripts/package-terminal-runtime.mjs';
await buildTranscriptCacheRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildDshRoutingRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildTerminalOwnerRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await build({ entryPoints: ['src/bin.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['node-pty'], outfile: 'dist/main.cjs',
  define: { 'import.meta.url': 'import_meta_url' },
  banner: { js: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;" } });
