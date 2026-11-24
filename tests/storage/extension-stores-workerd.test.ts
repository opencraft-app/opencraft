// Plugin and extension stores (login admission, thread participants, tasks and
// extension documents) on the runtime-neutral SQL port in workerd (Miniflare, no
// Cloudflare account); see tests/storage/workerd/extension-stores.scenarios.ts
// and storage-ports.md §3.7. The store modules must bundle for a runtime
// without node:* modules or Node globals: only their Node owners (the storage
// Worker modules and the `node-store.ts` openers) import node:sqlite or
// @opencraft/sqlite-node.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { EXTENSION_STORE_SCENARIOS } from "./workerd/extension-stores.scenarios.ts";

const root = resolve(import.meta.dirname, "../..");
const NEUTRAL_STORES = [
  "plugins/login-admission/src/sql-store.ts",
  "plugins/thread-participants/src/sql-participant-store.ts",
  "plugins/tasks/src/sqlite.ts",
  "packages/document-storage/src/sqlite.ts",
];

for (const entry of NEUTRAL_STORES)
  test(`${entry} bundles without node:* modules, Buffer or the Node SQLite owner`, async () => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "import"],
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs);
    assert.deepEqual(
      inputs.filter(
        (input) =>
          input.startsWith("node:") ||
          input.includes("packages/sqlite-node/") ||
          input.includes("worker-owner") ||
          input.endsWith("node-store.ts") ||
          input.endsWith("/store.ts") ||
          input.endsWith("/participant-store.ts"),
      ),
      [],
    );
    // Comments are gone from the bundle; any remaining Buffer is a Node global dependency.
    assert.doesNotMatch(result.outputFiles[0]!.text, /\bBuffer\b/u);
  });

testScenariosOnMiniflare("extension-stores-workerd", EXTENSION_STORE_SCENARIOS);
