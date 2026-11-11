import { build } from 'esbuild';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build the pinned, self-contained Pi provider bridge artifact the Host launches. */
export async function buildPiBridge(output) {
  const outfile = resolve(output ?? process.env.PI_BRIDGE_OUT ?? fileURLToPath(new URL('../plugins/pi-bridge/dist/main.mjs', import.meta.url)));
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [fileURLToPath(new URL('../plugins/pi-bridge/src/main.ts', import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Optional native PTY bindings are reachable only from the AppServer Pi
    // shell worker, which a bridge session disables (`shell: false`).
    external: ['node-pty', 'bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire as __createPiBridgeRequire } from 'node:module'; const require = __createPiBridgeRequire(import.meta.url);" },
    logLevel: 'info',
  });
  await chmod(outfile, 0o755);
  return outfile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await buildPiBridge(process.argv[2]));
}
