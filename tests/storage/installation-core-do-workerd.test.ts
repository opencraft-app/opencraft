// The production InstallationCore Durable Object (apps/headless-server/src/cloudflare/)
// in workerd (Miniflare, no Cloudflare account): the same call sequence as the
// Node Headless server, eviction, alarm-driven access watches and a refused
// open (tests/storage/workerd/installation-core-do.scenarios.ts, shared with
// `npm run cf:rehearsal`). See docs/architecture/platform/cloudflare-deployment.md §5.
//
// Runtime-neutral packaging: the deployment entry reaches the installation
// module, its neutral ports and the Durable Object adapters, and no Node owner
// implementation (files, Workers, node:sqlite, the Node password hasher, the
// Node root or gateway). The node:* modules it still reaches are the ones the
// installation module's collaboration steps import (gateway-split §4.1.1
// "仍有的 Node 痕迹"), which nodejs_compat provides; the identity steps the
// object opens use only node:crypto.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { parseHumanAuthConfiguration } from "@opencraft/access-control/human-auth-configuration";
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { COMPATIBILITY_DATE } from "../cloudflare/worker-runtime.ts";
import { INSTALLATION_CORE_DO_SCENARIOS, INSTALLATION_CORE_DO_SPEC } from "./workerd/installation-core-do.scenarios.ts";

const root = resolve(import.meta.dirname, "../..");
const ENTRY = "apps/headless-server/src/cloudflare/worker.ts";
const NODE_OWNERS = [
  "packages/sqlite-node/",
  "packages/worker-owner/",
  "packages/identity-core/src/node.ts",
  "packages/hub-network/src/node.ts",
  "packages/hub-network/src/state-port-node.ts",
  "packages/hub-network/src/store-file.ts",
  "packages/hub-network/src/controller.ts",
  "packages/access-control/src/commit-fence-shared-memory.ts",
  "packages/storage-node/src/server/owner.ts",
  "packages/storage-node/src/server/owner-serve.ts",
  "packages/storage-node/src/server/index.ts",
  "packages/storage-node/src/server/conversation-resource-journal.ts",
  "packages/model-usage-policy/",
  "packages/account-pool-host/",
  "plugins/local-account/src/password-hash-node.ts",
  "plugins/login-admission/",
  "apps/local-agent-host/src/machine-identity.ts",
  "apps/headless-server/src/headless-application.mjs",
  "apps/headless-server/src/serve-workbench-web.mjs",
  "apps/headless-server/src/server-core-worker.mjs",
  "apps/headless-server/src/assembly/root-inputs-node.mjs",
];

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
    inputs.filter((input) => NODE_OWNERS.some((owner) => input.includes(owner))),
    [],
  );
  // The same composition as the Node root: the installation module, the shared routes and owner domains.
  for (const shared of [
    "apps/headless-server/src/assembly/installation.mjs",
    "apps/headless-server/src/assembly/root-inputs.ts",
    "apps/headless-server/src/installation-routes.ts",
    "apps/headless-server/src/server-core-domains.mjs",
    "packages/storage-node/src/server/core-methods.ts",
    "packages/storage-node/src/server/repository.workerd.ts",
  ])
    assert.ok(inputs.includes(shared), shared);
  const builtins = new Set(
    Object.values(result.metafile.inputs).flatMap((input) =>
      input.imports
        .filter((imported) => imported.external && imported.path.startsWith("node:"))
        .map((imported) => imported.path),
    ),
  );
  assert.deepEqual([...builtins].sort(), [
    "node:crypto",
    "node:fs/promises",
    "node:path",
    "node:timers/promises",
    "node:url",
    "node:util",
    "node:worker_threads",
  ]);
});

test("the Wrangler template names the entry, class, bindings and runtime the tests run", async () => {
  const template = join(root, "deploy/cloudflare/wrangler.installation-core.jsonc");
  // Full-line comments only; string values may contain `//`.
  const config = JSON.parse(
    (await readFile(template, "utf8"))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n"),
  );
  assert.equal(resolve(dirname(template), config.main), resolve(root, ENTRY));
  assert.equal(config.compatibility_date, COMPATIBILITY_DATE);
  assert.deepEqual(config.compatibility_flags, INSTALLATION_CORE_DO_SPEC.compatibilityFlags);
  assert.deepEqual(config.durable_objects.bindings, [{ name: "INSTALLATION_CORE", class_name: "InstallationCore" }]);
  assert.deepEqual(config.migrations, [{ tag: "v1", new_sqlite_classes: ["InstallationCore"] }]);
  // Configuration only; the setup proof is a secret and never a var.
  assert.deepEqual(Object.keys(config.vars).sort(), ["OPENCRAFT_HUMAN_AUTH", "OPENCRAFT_MACHINE_NAME"]);
  parseHumanAuthConfiguration(JSON.parse(config.vars.OPENCRAFT_HUMAN_AUTH));
  const entry = await import(resolve(root, ENTRY));
  assert.equal(typeof entry.InstallationCore, "function");
  assert.equal(typeof entry.default.fetch, "function");
});

testScenariosOnMiniflare("installation-core-do-workerd", INSTALLATION_CORE_DO_SCENARIOS);
