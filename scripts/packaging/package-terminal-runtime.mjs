import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
export async function buildTerminalOwnerRuntime(directory) {
  await build({entryPoints:[join(root,'apps/local-agent-host/src/terminal-admission.worker.ts')],
    outfile:join(directory,'terminal-admission-worker.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',logLevel:'warning',
    banner:{js:"import {createRequire as createTerminalAdmissionRequire} from 'node:module';const require=createTerminalAdmissionRequire(import.meta.url);"}});
  return build({ entryPoints: [join(root, 'apps/local-agent-host/src/terminal-pty-owner.ts')],
    outfile: join(directory, 'terminal-pty-owner.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
    external: ['node-pty'], logLevel: 'warning',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
}
