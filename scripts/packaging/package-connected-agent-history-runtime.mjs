import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Builds the native-history worker next to the Host entry that imports it.
 * The source `connected-agent-history-worker.mjs` is a tsx loader for local
 * development; packaged Hosts must receive this bundled worker under the same
 * name instead. */
export async function buildConnectedAgentHistoryRuntime(directory) {
  await build({ entryPoints: [fileURLToPath(new URL('../../apps/local-agent-host/src/connected-agent-history.worker.ts', import.meta.url))],
    outfile: join(directory, 'connected-agent-history-worker.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node26', logLevel: 'warning' });
}
