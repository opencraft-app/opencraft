// Workers that own blocking IO for network processes (@opencraft/worker-owner).
// A bundled caller starts `<name>-worker.mjs` beside itself. A package whose
// bundles run the Server builds this whole list next to them; Relay, which
// starts only a few owners, builds just those (`buildStartedOwnerWorkers`).
import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { siblingReferences } from "./verify-sibling-files.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const OWNER_WORKERS = Object.freeze([
  ["apps/opencraft-daemon/src/ssh-connections.worker.ts", "ssh-connections-worker.mjs"],
  ["packages/hub-network/src/hub-state.worker.ts", "hub-state-worker.mjs"],
  ["packages/sqlite-node/src/lock.worker.ts", "lock-worker.mjs"],
  ["apps/personal-assistant/src/runtime/memory-browser-offline-worker.mjs", "memory-browser-offline-worker.mjs"],
  ["packages/storage-node/src/server/server-core-owner.worker.ts", "server-core-owner-worker.mjs"],
  ["apps/headless-server/src/server-core-worker.mjs", "server-core-worker.mjs"],
  ["plugins/local-account/src/desktop-account-owner.worker.ts", "desktop-account-owner-worker.mjs"],
  ["plugins/im/src/switchboard.worker.ts", "switchboard-worker.mjs"],
  ["plugins/thread-participants/src/thread-participants.worker.ts", "thread-participants-worker.mjs"],
  ["plugins/login-admission/src/login-admission.worker.ts", "login-admission-worker.mjs"],
]);

/** `only` limits the build to the named files, for a directory whose bundles start just those. */
export async function buildOwnerWorkers(directory, { target = "node24", only } = {}) {
  for (const [entry, file] of OWNER_WORKERS) {
    if (only && !only.includes(file)) continue;
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

/**
 * Builds only the owner Workers that the bundles already in `directory` start,
 * then those the built Workers start in turn. An owner no bundle starts is not
 * shipped, so the files it would start are not needed either. Returns the files built.
 */
export async function buildStartedOwnerWorkers(directory, { target = "node24" } = {}) {
  const built = [];
  for (;;) {
    const present = new Set(await readdir(directory));
    const started = new Set();
    for (const name of present) {
      if (!/\.(?:mjs|cjs|js)$/u.test(name)) continue;
      for (const sibling of siblingReferences(await readFile(join(directory, name), "utf8")))
        if (!present.has(sibling)) started.add(sibling);
    }
    const only = OWNER_WORKERS.map(([, file]) => file).filter((file) => started.has(file));
    if (!only.length) return built;
    await buildOwnerWorkers(directory, { target, only });
    built.push(...only);
  }
}
