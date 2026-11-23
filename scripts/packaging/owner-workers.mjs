// Workers that own blocking IO for network processes (@opencraft/worker-owner).
// A bundled caller starts `<name>-worker.mjs` beside itself, so every package
// that bundles a network process builds this whole list next to its bundle.
import { build } from "esbuild";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const OWNER_WORKERS = Object.freeze([
  ["apps/opencraft-daemon/src/ssh-connections.worker.ts", "ssh-connections-worker.mjs"],
  ["packages/hub-network/src/hub-state.worker.ts", "hub-state-worker.mjs"],
  ["apps/personal-assistant/src/runtime/memory-browser-offline-worker.mjs", "memory-browser-offline-worker.mjs"],
  ["packages/storage-node/src/server/server-core-owner.worker.ts", "server-core-owner-worker.mjs"],
  ["apps/headless-server/src/server-core-worker.mjs", "server-core-worker.mjs"],
  ["plugins/local-account/src/desktop-account-owner.worker.ts", "desktop-account-owner-worker.mjs"],
  ["plugins/im/src/switchboard.worker.ts", "switchboard-worker.mjs"],
  ["plugins/thread-participants/src/thread-participants.worker.ts", "thread-participants-worker.mjs"],
]);

export async function buildOwnerWorkers(directory, { target = "node24" } = {}) {
  for (const [entry, file] of OWNER_WORKERS) {
    await build({
      entryPoints: [join(repositoryRoot, entry)],
      outfile: join(directory, file),
      nodePaths: [join(repositoryRoot, "node_modules")],
      bundle: true,
      platform: "node",
      format: "esm",
      target,
      logLevel: "warning",
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });
  }
}
