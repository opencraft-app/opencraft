// The production AccountCore Durable Object (apps/headless-server/src/cloudflare/)
// in workerd (Miniflare, no Cloudflare account): the model policy sequence and
// the configuration, credential and lease operations against Node, sealed
// storage, eviction, a refused open and the internal authority path
// (tests/storage/workerd/account-core-do.scenarios.ts, shared with
// `npm run cf:rehearsal`). See docs/architecture/platform/cloudflare-deployment.md §5.6.
//
// Runtime-neutral packaging: the account object reaches the account module,
// its neutral ports and the Durable Object adapters, and no Node owner
// implementation (the policy file owner and native readers, the account pool
// and model gateway stores, the Codex Core client, file stores, the Node
// account inputs).
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { ACCOUNT_CORE_DO_SCENARIOS } from "./workerd/account-core-do.scenarios.ts";

const root = resolve(import.meta.dirname, "../..");
const ENTRY = "apps/headless-server/src/cloudflare/account-core.ts";
/** Node owners and Node-only account parts; the account package's lease contract alone is neutral. */
const NODE_OWNERS = [
  "packages/sqlite-node/",
  "packages/worker-owner/",
  "packages/model-usage-policy/src/index.ts",
  "packages/model-usage-policy/src/native.mjs",
  "packages/model-usage-policy/src/transport.ts",
  "packages/document-storage/src/state-file.ts",
  "packages/secret-storage/src/file.ts",
  "apps/local-agent-host/src/model-config/service.ts",
  "apps/local-agent-host/src/model-config/gateway-contributions.ts",
  "apps/local-agent-host/src/model-config/index.ts",
  "apps/headless-server/src/assembly/account-node.mjs",
  "apps/headless-server/src/headless-application.mjs",
  "apps/headless-server/src/serve-workbench-web.mjs",
];
const ACCOUNT_POOL_NEUTRAL = new Set(["packages/account-pool-host/src/credential-leases.ts"]);

test(`${ENTRY} reaches no Node owner implementation`, async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.deepEqual(
    inputs.filter(
      (input) =>
        NODE_OWNERS.some((owner) => input.includes(owner)) ||
        (input.includes("packages/account-pool-host/") && !ACCOUNT_POOL_NEUTRAL.has(input)),
    ),
    [],
  );
  // The same composition as the Node root: the account module, its shared routes and neutral ports.
  for (const shared of [
    "apps/headless-server/src/assembly/account.mjs",
    "apps/headless-server/src/account-routes.ts",
    "packages/model-usage-policy/src/store.ts",
    "packages/model-usage-policy/src/http.ts",
    "packages/model-usage-policy/src/sql-owner.ts",
    "packages/account-pool-host/src/credential-leases.ts",
    "packages/secret-storage/src/sealed.ts",
    "apps/local-agent-host/src/model-config/repository.ts",
    "apps/local-agent-host/src/model-config/provider-credentials.ts",
  ])
    assert.ok(inputs.includes(shared), shared);
  const builtins = new Set(
    Object.values(result.metafile.inputs).flatMap((input) =>
      input.imports
        .filter((imported) => imported.external && imported.path.startsWith("node:"))
        .map((imported) => imported.path),
    ),
  );
  // node:crypto only: migration checksums (as the Node owner computes them) and the speech service's binding.
  assert.deepEqual([...builtins].sort(), ["node:crypto"]);
});

testScenariosOnMiniflare("account-core-do-workerd", ACCOUNT_CORE_DO_SCENARIOS);
