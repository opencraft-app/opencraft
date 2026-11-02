import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildTerminalOwnerRuntime } from '../../scripts/package-terminal-runtime.mjs';
await buildTerminalOwnerRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await build({ entryPoints: ['src/bin.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['node-pty'], outfile: 'dist/main.cjs',
  define: { 'import.meta.url': 'import_meta_url' },
  banner: { js: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;" } });
