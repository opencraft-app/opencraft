// The production AccountCore Durable Object (apps/headless-server/src/cloudflare/)
// in workerd (Miniflare, no Cloudflare account): the model policy sequence and
// the configuration, credential and lease operations against Node, sealed
// storage, eviction, a refused open and the internal authority path
// (tests/storage/workerd/account-core-do.scenarios.ts, shared with
// `npm run cf:rehearsal`). See docs/architecture/platform/cloudflare-deployment.md §5.6.
//
// Runtime-neutral packaging: the account object reaches the account module, the
// model gateway's domain, route, contributions, shared-SQL owner and personal
// subscriptions over the account pool,
// the account pool's domain, renewal and shared-SQL owner, their neutral ports
// and the Durable Object adapters, and no Node owner implementation (the
// policy file owner and native readers, the account pool's file owner, the
// model gateway's file owner, the Codex Core client and maintenance processes, the
// proxy, file stores, the Node account inputs). The only file of the Node
// SQLite package it reaches is the generated migration registry, pure data
// that both owners of the account pool read the published SQL from.
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
  "apps/local-agent-host/src/model-config/index.ts",
  "apps/headless-server/src/assembly/account-node.mjs",
  "apps/headless-server/src/headless-application.mjs",
  "apps/headless-server/src/serve-workbench-web.mjs",
];
/** The account package's runtime-neutral modules; everything else in it is Node (files, processes, sockets, undici). */
const ACCOUNT_POOL_NEUTRAL = new Set(
  [
    "credential-leases.ts",
    "credential-lease-exchange.ts",
    "account-pool.ts",
    "account-pool-schema.ts",
    "account-pool-sql-owner.ts",
    "account-pool-core.ts",
    "account-refresh-schedule.ts",
    "account-renewal.ts",
    "oauth-refresh.ts",
    "account-diagnostics.ts",
    "codex-auth-file-format.ts",
    "codex-launch.ts",
    "model-gateway.ts",
    "model-gateway-http.ts",
    "model-gateway-sql-owner.ts",
    "personal-subscriptions.ts",
  ].map((file) => `packages/account-pool-host/src/${file}`),
);
/** Pure data: the published SQL the Node owner's registry appends, read by both account pool owners. */
const GENERATED_MIGRATIONS = "packages/sqlite-node/src/store-migrations.generated.ts";

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
        (NODE_OWNERS.some((owner) => input.includes(owner)) && input !== GENERATED_MIGRATIONS) ||
        (input.includes("packages/account-pool-host/") && !ACCOUNT_POOL_NEUTRAL.has(input)),
    ),
    [],
  );
  // The generated registry module has no imports of its own.
  assert.deepEqual(result.metafile.inputs[GENERATED_MIGRATIONS]?.imports, []);
  // The same composition as the Node root: the account module, its shared routes and neutral ports.
  for (const shared of [
    "apps/headless-server/src/assembly/account.mjs",
    "apps/headless-server/src/account-routes.ts",
    "packages/model-usage-policy/src/store.ts",
    "packages/model-usage-policy/src/http.ts",
    "packages/model-usage-policy/src/sql-owner.ts",
    "packages/account-pool-host/src/credential-leases.ts",
    "packages/secret-storage/src/sealed.ts",
    "packages/secret-storage/src/sealed-records.ts",
    "packages/sql/src/migrations.ts",
    "packages/account-pool-host/src/account-pool.ts",
    "packages/account-pool-host/src/account-pool-sql-owner.ts",
    "packages/account-pool-host/src/oauth-refresh.ts",
    "packages/account-pool-host/src/account-refresh-schedule.ts",
    "packages/account-pool-host/src/account-renewal.ts",
    "packages/owner-wake/src/index.ts",
    "apps/local-agent-host/src/model-config/repository.ts",
    "apps/local-agent-host/src/model-config/provider-credentials.ts",
    "apps/local-agent-host/src/model-config/gateway-contributions.ts",
    "packages/account-pool-host/src/model-gateway.ts",
    "packages/account-pool-host/src/model-gateway-http.ts",
    "packages/account-pool-host/src/model-gateway-sql-owner.ts",
    "packages/account-pool-host/src/personal-subscriptions.ts",
  ])
    assert.ok(inputs.includes(shared), shared);
  const builtins = new Set(
    Object.values(result.metafile.inputs).flatMap((input) =>
      input.imports
        .filter((imported) => imported.external && imported.path.startsWith("node:"))
        .map((imported) => imported.path),
    ),
  );
  // node:crypto: migration checksums (as the Node owner computes them), synchronous record sealing, the account
  // pool's digests and the speech service's binding; node:path: the shared auth file reference's absolute-path
  // rule (pure computation). Both are provided by workerd under nodejs_compat.
  assert.deepEqual([...builtins].sort(), ["node:crypto", "node:path"]);
});

// The egress holds nothing: its bundle is the lease exchange client, the forwarding rule and the shared reply
// shape, with no storage adapter, no ledger, no SQL and no Node module.
test("apps/headless-server/src/cloudflare/egress.ts reaches no storage and no Node module", async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["apps/headless-server/src/cloudflare/egress.ts"],
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
    inputs.filter((input) =>
      /packages\/(?:storage-cloudflare|document-storage|secret-storage|sql|sqlite-node)\//u.test(input),
    ),
    [],
  );
  assert.deepEqual(inputs.filter((input) => input.includes("packages/account-pool-host/")).sort(), [
    "packages/account-pool-host/src/credential-egress.ts",
    "packages/account-pool-host/src/credential-lease-exchange.ts",
    "packages/account-pool-host/src/credential-leases.ts",
  ]);
  assert.deepEqual(
    Object.values(result.metafile.inputs).flatMap((input) =>
      input.imports.filter((imported) => imported.external).map((imported) => imported.path),
    ),
    [],
  );
});

testScenariosOnMiniflare("account-core-do-workerd", ACCOUNT_CORE_DO_SCENARIOS);
