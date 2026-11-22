import { buildServerSpacesRuntime } from '../../scripts/packaging/package-server-spaces-runtime.mjs';
import { buildConnectedAgentHistoryRuntime } from '../../scripts/packaging/package-connected-agent-history-runtime.mjs';
import { buildDshRoutingRuntime } from '../../scripts/packaging/package-dsh-routing-runtime.mjs';
import { buildTranscriptCacheRuntime } from '../../scripts/packaging/package-transcript-cache-runtime.mjs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { daemonMainBundle } from './main-bundle.mjs';
import { buildTerminalOwnerRuntime } from '../../scripts/packaging/package-terminal-runtime.mjs';
import { buildOwnerWorkers } from '../../scripts/packaging/owner-workers.mjs';
await buildTranscriptCacheRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildDshRoutingRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildServerSpacesRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildConnectedAgentHistoryRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildTerminalOwnerRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildOwnerWorkers(fileURLToPath(new URL('./dist/', import.meta.url)), { target: 'node26' });
await build({entryPoints:['src/execution-fault.worker.ts'],outfile:'dist/execution-fault-worker.mjs',bundle:true,platform:'node',format:'esm',target:'node26'});
await build(daemonMainBundle);

await build({entryPoints:['../../packages/access-control/src/orchestration-runtime.worker.ts'],outfile:'dist/orchestration-runtime-worker.mjs',bundle:true,platform:'node',format:'esm',target:'node26'});

await build({entryPoints:['../../apps/personal-assistant/src/runtime/assistant-server.mjs'],outfile:'dist/assistant-server.mjs',bundle:true,platform:'node',format:'esm',target:'node26',external:['@earendil-works/pi-*','@earendil-works/chord'],banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});

await (await import('node:fs/promises')).copyFile('../../apps/personal-assistant/src/adapters/sqlite/schema.sql','dist/schema.sql');
await build({ entryPoints: ["../agent-bridge-host/src/storage.worker.ts"], outfile: "dist/storage.worker.mjs", bundle: true, platform: "node", format: "esm", banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
