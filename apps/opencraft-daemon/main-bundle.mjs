/**
 * esbuild options for the daemon entry. Packaged desktops ship only node-pty
 * beside this bundle, so every other external must load lazily, when the
 * feature that needs it runs (tests/desktop/daemon-bundle.test.mjs).
 */
export const daemonMainBundle = {
  entryPoints: ['src/bin.ts'], bundle: true, platform: 'node', format: 'cjs',
  // esbuild is only used by source previews; the pi runtime only by a connected Pi agent.
  external: ['node-pty', 'esbuild', '@earendil-works/pi-*', '@earendil-works/chord'],
  outfile: 'dist/main.cjs',
  define: { 'import.meta.url': 'import_meta_url' },
  banner: { js: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
};

/** Externals a packaged desktop provides next to the daemon bundle. */
export const packagedDaemonExternals = new Set(['node-pty']);
