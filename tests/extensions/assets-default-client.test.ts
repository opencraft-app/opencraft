import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import { createServerAssetsExtension, ServerAssetsAccount } from "../../plugins/assets/src/client.js";
const scope = "actor:human://fixture/one";
for (const platform of ["web", "electron"] as const)
  test(`default ${platform} registration discovers the real service and releases its one navigation owner`, async () => {
    const events = new Map<string, Set<() => void>>();
    let reads = 0;
    const owner = new ExtensionSupervisor({
      platform,
      internalContributions: { platformViewRenderer: { prepare: () => ({ commit: () => () => {} }) } },
    });
    const extension = createServerAssetsExtension(
      async () => {
        reads++;
        return Response.json({ version: 1, scope });
      },
      {
        addEventListener(type: string, listener: () => void) {
          const set = events.get(type) ?? new Set();
          set.add(listener);
          events.set(type, set);
        },
        removeEventListener(type: string, listener: () => void) {
          events.get(type)?.delete(listener);
        },
      } as unknown as Window,
    );
    assert.equal(reads, 0);
    await owner.activate(extension);
    assert.equal(reads, 1);
    assert.equal(owner.contributions.getSnapshot().sidebarCatalogs.length, 1);
    assert.equal(owner.contributions.getSnapshot().views.length, 2);
    await owner.deactivate("opencraft.assets");
    assert.equal(owner.contributions.getSnapshot().sidebarCatalogs.length, 0);
    for (const set of events.values()) assert.equal(set.size, 0);
  });
test("an absent service advertises no default menu and makes no configuration request", async () => {
  const owner = new ExtensionSupervisor({ platform: "web" });
  const paths: unknown[] = [];
  await owner.activate(
    createServerAssetsExtension(async (path) => {
      paths.push(path);
      return new Response("", { status: 404 });
    }),
  );
  assert.deepEqual(paths, ["/__opencraft_assets/status"]);
  assert.equal(owner.contributions.getSnapshot().sidebarCatalogs.length, 0);
  await owner.deactivate("opencraft.assets");
});
test("late account reads cannot restore another Human; transient failures retain drafts, verified logout clears scope", async () => {
  const reads: ((response: Response) => void)[] = [];
  const account = new ServerAssetsAccount(() => new Promise((resolve) => reads.push(resolve)));
  const first = account.refresh(),
    second = account.refresh();
  reads[1]!(Response.json({ version: 1, scope: "actor:human://fixture/two" }));
  await second;
  reads[0]!(Response.json({ version: 1, scope }));
  await first;
  assert.equal(account.getScope(), "actor:human://fixture/two");
  const offline = account.refresh();
  reads[2]!(new Response("", { status: 503 }));
  await assert.rejects(offline);
  assert.equal(account.getScope(), "actor:human://fixture/two");
  const logout = account.refresh();
  reads[3]!(Response.json({ version: 1, scope: null }));
  await logout;
  assert.equal(account.getScope(), null);
  const late = account.refresh();
  account.dispose();
  reads[4]!(Response.json({ version: 1, scope }));
  await late;
  assert.equal(account.getScope(), null);
});
