// Deployment-level stores (push, MCP apps, managed connectors) on the
// runtime-neutral SQL port in workerd (Miniflare, no Cloudflare account); see
// tests/storage/workerd/deployment-stores.scenarios.ts and gateway-split.md
// §5.1 G3. The store modules themselves must bundle for a runtime without
// node:* modules: only the Node openers import @opencraft/sqlite-node.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { DEPLOYMENT_STORE_SCENARIOS } from "./workerd/deployment-stores.scenarios.ts";

const root = resolve(import.meta.dirname, "../..");
const NEUTRAL_STORES = [
  "packages/web-push-node/src/sql-store.ts",
  "packages/mcp-apps/src/store.ts",
  "packages/connector-host/src/store.ts",
];

for (const entry of NEUTRAL_STORES)
  test(`${entry} bundles without node:* modules or the Node SQLite owner`, async () => {
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
      inputs.filter((input) => input.startsWith("node:") || input.includes("packages/sqlite-node/")),
      [],
    );
  });

testScenariosOnMiniflare("deployment-stores-workerd", DEPLOYMENT_STORE_SCENARIOS);
