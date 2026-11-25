// The production WorkspaceHost Durable Object (apps/headless-server/src/cloudflare/)
// in workerd (Miniflare, no Cloudflare account and no Containers): an in-isolate
// container double stands in for `ctx.container`
// (tests/storage/workerd/workspace-host-do.scenarios.ts). See
// docs/architecture/platform/cloudflare-deployment.md §5.7.
//
// Runtime-neutral packaging: the deployment entry reaches the workspace-host
// module, the sandbox provider and the Durable Object adapters, and no Node
// process, Worker or socket owner. The `@opencraft/sqlite-node` modules it
// reaches are the published migration registry and the Node owner subclasses
// that share a module with the domain stores the object uses; the object never
// calls them (asserted below as an exact list, so the reach cannot grow unseen).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { testScenariosOnMiniflare } from "../cloudflare/node-test.ts";
import { WORKSPACE_HOST_DO_SCENARIOS, WORKSPACE_HOST_DO_SPEC } from "./workerd/workspace-host-do.scenarios.ts";

const root = resolve(import.meta.dirname, "../..");
const ENTRY = "apps/headless-server/src/cloudflare/worker.ts";
const NODE_OWNERS = [
  "packages/worker-owner/",
  "packages/sandbox-node/",
  "packages/storage-node/src/server/owner.ts",
  "packages/storage-node/src/server/index.ts",
  "apps/personal-assistant/",
  "apps/headless-server/src/headless-application.mjs",
  "apps/headless-server/src/serve-workbench-web.mjs",
  "apps/headless-server/src/server-deployment/",
  "apps/opencraft-daemon/src/codex-core-read-isolation.ts",
  "apps/opencraft-daemon/src/native-execution-inspector.ts",
  "node_modules/ws/",
  "node_modules/proper-lockfile/",
];
/** sqlite-node files the entry reaches; none is called by the object. */
const SQLITE_NODE_REACH = [
  "packages/sqlite-node/src/backup.ts",
  "packages/sqlite-node/src/connection.ts",
  "packages/sqlite-node/src/errors.ts",
  "packages/sqlite-node/src/history-append-only.ts",
  "packages/sqlite-node/src/history-selection.ts",
  "packages/sqlite-node/src/index.ts",
  "packages/sqlite-node/src/lifecycle.ts",
  "packages/sqlite-node/src/migrations.ts",
  "packages/sqlite-node/src/read-guard.ts",
  "packages/sqlite-node/src/recovery.ts",
  "packages/sqlite-node/src/retire.ts",
  "packages/sqlite-node/src/sql-database.ts",
  "packages/sqlite-node/src/store-migrations.generated.ts",
  "packages/sqlite-node/src/store-migrations.ts",
  "packages/sqlite-node/src/writer-lock.ts",
];

test(`${ENTRY} reaches the workspace-host module and no Node process, Worker or socket owner`, async () => {
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
  assert.deepEqual(inputs.filter((input) => input.includes("packages/sqlite-node/")).sort(), SQLITE_NODE_REACH);
  for (const shared of [
    "apps/headless-server/src/assembly/workspace-host.mjs",
    "apps/headless-server/src/assembly/workspace-host-sql.ts",
    "apps/headless-server/src/workspace-host-routes.ts",
    "apps/headless-server/src/cloudflare/workspace-link.ts",
    "apps/headless-server/src/cloudflare/workspace-codex.ts",
    "packages/sandbox-cloudflare/src/index.ts",
    "packages/sandbox/src/workspace.ts",
    "packages/sql/src/families.ts",
  ])
    assert.ok(inputs.includes(shared), shared);
});

test("the Wrangler template binds the WorkspaceHost class to its container", async () => {
  const template = join(root, "deploy/cloudflare/wrangler.installation-core.jsonc");
  const config = JSON.parse(
    (await readFile(template, "utf8"))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n"),
  );
  assert.equal(resolve(dirname(template), config.main), resolve(root, "apps/headless-server/src/cloudflare/deployment-worker.mjs"));
  assert.equal(config.compatibility_date, "2026-11-01");
  assert.deepEqual(config.compatibility_flags, WORKSPACE_HOST_DO_SPEC.compatibilityFlags);
  assert.deepEqual(config.durable_objects.bindings, [
    { name: "INSTALLATION_CORE", class_name: "InstallationCore" },
    { name: "ACCOUNT_CORE", class_name: "AccountCore" },
    { name: "WORKSPACE_HOST", class_name: "WorkspaceHost" },
    { name: "CLIENT", class_name: "ClientDO" },
  ]);
  // Each class in its own migration: a deployment of the earlier template only adds the WorkspaceHost class.
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["InstallationCore"] },
    { tag: "v2", new_sqlite_classes: ["AccountCore"] },
    { tag: "v3", new_sqlite_classes: ["WorkspaceHost"] },
    { tag: "v4", new_sqlite_classes: ["ClientDO"] },
  ]);
  assert.equal(config.containers.length, 1);
  const [container] = config.containers;
  assert.equal(container.class_name, "WorkspaceHost");
  assert.equal(container.scheduling_policy, "durable_object");
  assert.match(container.images[config.vars.OPENCRAFT_WORKSPACE_IMAGE].image, /@sha256:[0-9a-f]{64}$/u, "the image is pinned by digest");
  // Configuration only, no credentials: the container receives none.
  assert.ok(Object.keys(config.vars).every((name) => !/TOKEN|SECRET|KEY|PASSWORD/u.test(name)));
  const entry = await import(resolve(root, ENTRY));
  assert.equal(typeof entry.WorkspaceHost, "function");
});

testScenariosOnMiniflare("workspace-host-do-workerd", WORKSPACE_HOST_DO_SCENARIOS);
