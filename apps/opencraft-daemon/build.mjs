import { buildServerSpacesRuntime } from '../../scripts/packaging/package-server-spaces-runtime.mjs';
import { buildConnectedAgentHistoryRuntime } from '../../scripts/packaging/package-connected-agent-history-runtime.mjs';
import { buildDshRoutingRuntime } from '../../scripts/packaging/package-dsh-routing-runtime.mjs';
import { buildTranscriptCacheRuntime } from '../../scripts/packaging/package-transcript-cache-runtime.mjs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { daemonMainBundle } from './main-bundle.mjs';
import { buildTerminalOwnerRuntime } from '../../scripts/packaging/package-terminal-runtime.mjs';
import { buildOwnerWorkers } from '../../scripts/packaging/owner-workers.mjs';
import { buildAssetsRuntime } from '../../scripts/packaging/package-assets-runtime.mjs';
import { DESKTOP_ABSENT_SIBLINGS, verifySiblingFiles } from '../../scripts/packaging/verify-sibling-files.mjs';
await buildTranscriptCacheRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildDshRoutingRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildServerSpacesRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildConnectedAgentHistoryRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildTerminalOwnerRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await buildOwnerWorkers(fileURLToPath(new URL('./dist/', import.meta.url)), { target: 'node26' });
// The desktop account service the daemon hosts serves Assets; its vault Worker lives beside the daemon.
await buildAssetsRuntime(fileURLToPath(new URL('./dist/', import.meta.url)));
await build(daemonMainBundle);

await build({entryPoints:['../../packages/access-control/src/orchestration-runtime.worker.ts'],outfile:'dist/orchestration-runtime-worker.mjs',bundle:true,platform:'node',format:'esm',target:'node26'});

await build({entryPoints:['../../apps/personal-assistant/src/runtime/assistant-server.mjs'],outfile:'dist/assistant-server.mjs',bundle:true,platform:'node',format:'esm',target:'node26',external:['@earendil-works/pi-*','@earendil-works/chord'],banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});

await (await import('node:fs/promises')).copyFile('../../apps/personal-assistant/src/adapters/sqlite/schema.sql','dist/schema.sql');
await build({ entryPoints: ["../agent-bridge-host/src/storage.worker.ts"], outfile: "dist/storage.worker.mjs", bundle: true, platform: "node", format: "esm", banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });

// The Codex bridge stack the daemon launches with --codex-bridge-stack (see src/codex-bridge-stack.ts).
const requireBanner = { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" };
for (const [source, target, format] of [
  ['../codex-core/src/bin.ts', 'codex-core.cjs', 'cjs'],
  ['../codex-core/src/app-server-bin.ts', 'codex-app-server.cjs', 'cjs'],
  ['../agent-bridge-host/src/main.ts', 'engine-host.mjs', 'esm'],
  ['../agent-bridge-host/src/storage.worker.ts', 'storage.worker.mjs', 'esm'],
  ['../agent-bridge-host/src/codex-main.ts', 'codex.cjs', 'cjs'],
]) await build({ entryPoints: [source], outfile: `dist/codex-bridge/${target}`, bundle: true, platform: 'node', format, target: 'node24',
  external: ['node-pty'], ...(format === 'esm' ? { banner: requireBanner } : {}) });
await (await import('node:fs/promises')).copyFile('src/codex-bridge-exit-with-parent.cjs', 'dist/codex-bridge/exit-with-parent.cjs');

// Every file a bundle here starts from beside itself must have been built beside it.
await verifySiblingFiles(fileURLToPath(new URL('./dist/', import.meta.url)), { nested: ['codex-bridge'], optional: DESKTOP_ABSENT_SIBLINGS });
