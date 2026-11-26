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
import { memoryStateDocumentStore } from "@opencraft/document-storage/state";
import { captureWorkspaceHistory, readWorkspaceHistory, recordWorkspaceHistory } from "../../apps/headless-server/src/cloudflare/workspace-history-preview.ts";
import { EndpointMessageTooLargeError } from "../../apps/headless-server/src/cloudflare/workspace-link.ts";
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
  "packages/account-pool-host/src/codex-core-read-isolation.ts",
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

const sleepingPlacement = {
  receipt: { backend: "cloudflare", instanceId: "fixture-instance" },
  snapshot: { backend: "cloudflare", id: "fixture-snapshot", image: "fixture-image", takenAt: 1 },
};
const previewPlacement = (threadId: string) => ({
  serverId: "server", threadId, workspaceId: "workspace", revision: 1, state: "placed" as const,
});
const previewMetadata = (threadId: string) => ({
  thread: { id: threadId, ephemeral: false, status: { type: "idle" }, turns: [] },
});
const previewPage = (threadId: string, bytes: number) => ({
  data: [{ id: threadId + "-turn", items: [{ id: "message", type: "agentMessage", text: "a".repeat(bytes) }] }],
  nextCursor: "next", backwardsCursor: "backwards",
});

test("sleep preview shrinks past transport and storage budgets without changing opaque cursors", async () => {
  const documents = memoryStateDocumentStore();
  const placement = previewPlacement("small-window");
  const limits: number[] = [];
  const largeTurns = Array.from({ length: 5 }, (_, index) => previewPage("turn-" + index, 24 * 1024).data[0]!);
  const compactPage = { data: largeTurns.slice(0, 2), nextCursor: "next-two", backwardsCursor: "before-first" };
  const captured = await captureWorkspaceHistory(placement, async read => {
    if (read.method === "thread/read") return previewMetadata(placement.threadId);
    limits.push(read.params.limit);
    if (read.params.limit === 10) throw new EndpointMessageTooLargeError();
    if (read.params.limit === 5) return { ...compactPage, data: largeTurns, nextCursor: "next-five" };
    return compactPage;
  });
  assert.deepEqual(limits, [10, 5, 2]);
  assert.ok(captured);
  await recordWorkspaceHistory(documents, sleepingPlacement, [captured]);
  assert.deepEqual(await readWorkspaceHistory(documents, sleepingPlacement, placement, {
    method: "thread/turns/list",
    params: { threadId: placement.threadId, cursor: null, limit: 2, sortDirection: "desc", itemsView: "full" },
  }), compactPage);
});

test("sleep history pages inside the checkpoint and hands off at the native cursor", async () => {
  const documents = memoryStateDocumentStore();
  const placement = previewPlacement("paged-history");
  const other = previewPlacement("another-thread");
  const data = ["newest", "middle", "oldest"].map(id => ({ id, items: [] }));
  const page = { data, nextCursor: "native-tail", backwardsCursor: "native-head" };
  await recordWorkspaceHistory(documents, sleepingPlacement, [placement, other].map(entry => ({
    placement: entry, metadata: previewMetadata(entry.threadId), page,
  })));
  const readPage = (
    sandbox: Parameters<typeof readWorkspaceHistory>[1],
    thread: typeof placement,
    limit: number,
    cursor: string | null = null,
  ) => readWorkspaceHistory(documents, sandbox, thread, {
    method: "thread/turns/list",
    params: { threadId: thread.threadId, cursor, limit, sortDirection: "desc", itemsView: "full" },
  });

  assert.deepEqual(await readPage(sleepingPlacement, placement, 10), page);
  const first = await readPage(sleepingPlacement, placement, 1) as typeof page | null;
  assert.ok(first?.nextCursor);
  assert.notEqual(first.nextCursor, page.nextCursor, "the native cursor skips the cached suffix");
  assert.deepEqual(first.data, data.slice(0, 1));
  assert.equal(first.backwardsCursor, page.backwardsCursor);
  assert.deepEqual(await readWorkspaceHistory(documents, sleepingPlacement, placement, {
    method: "thread/read",
    params: { threadId: placement.threadId, includeTurns: false,
      initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "full" } },
  }), { ...previewMetadata(placement.threadId), initialTurnsPage: first });
  const tail = { data: data.slice(1), nextCursor: page.nextCursor, backwardsCursor: null };
  assert.deepEqual(await readPage(sleepingPlacement, placement, 2, first.nextCursor), tail);
  assert.deepEqual(await readPage(sleepingPlacement, placement, 20, first.nextCursor), tail);
  assert.equal(await readPage(sleepingPlacement, other, 2, first.nextCursor), null);
  assert.equal(await readPage(sleepingPlacement, placement, 2, page.nextCursor), null);
  const restored = { ...sleepingPlacement, receipt: { ...sleepingPlacement.receipt, instanceId: "restored" } };
  assert.equal(await readPage(restored, placement, 2, first.nextCursor), null);
  assert.deepEqual(await readPage({
    ...restored, restoredFrom: sleepingPlacement.snapshot.id,
  }, placement, 2, first.nextCursor), tail);
  const replaced = { ...sleepingPlacement, snapshot: { ...sleepingPlacement.snapshot, id: "replacement" } };
  await recordWorkspaceHistory(documents, replaced, [{ placement, metadata: previewMetadata(placement.threadId), page }]);
  assert.equal(await readPage(replaced, placement, 2, first.nextCursor), null);
});

test("sleep preview retains metadata when a single Turn exceeds the budget or another page fills the checkpoint", async () => {
  const documents = memoryStateDocumentStore();
  const placements = ["single-large-turn", "first-page", "second-page"].map(previewPlacement);
  const previews = await Promise.all(placements.map(placement => captureWorkspaceHistory(placement, async read =>
    read.method === "thread/read" ? previewMetadata(placement.threadId) :
      previewPage(placement.threadId, (placement.threadId === "single-large-turn" ? 100 : 70) * 1024))));
  assert.ok(previews.every(preview => preview !== null));
  await recordWorkspaceHistory(documents, sleepingPlacement, previews);
  for (const placement of placements) {
    assert.deepEqual(await readWorkspaceHistory(documents, sleepingPlacement, placement, {
      method: "thread/read", params: { threadId: placement.threadId, includeTurns: false },
    }), previewMetadata(placement.threadId));
    assert.equal(await readWorkspaceHistory(documents, sleepingPlacement, placement, {
      method: "thread/read", params: { threadId: placement.threadId, includeTurns: true },
    }), null);
  }
  const readPage = (placement: ReturnType<typeof previewPlacement>) => readWorkspaceHistory(documents, sleepingPlacement, placement, {
    method: "thread/turns/list",
    params: { threadId: placement.threadId, cursor: null, limit: 10, sortDirection: "desc", itemsView: "full" },
  });
  assert.equal(await readPage(placements[0]!), null);
  assert.deepEqual(await readPage(placements[1]!), previewPage("first-page", 70 * 1024));
  assert.equal(await readPage(placements[2]!), null);
});

testScenariosOnMiniflare("workspace-host-do-workerd", WORKSPACE_HOST_DO_SCENARIOS);
