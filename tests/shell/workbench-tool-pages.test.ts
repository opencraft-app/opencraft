import assert from "node:assert/strict";
import test from "node:test";
import type { SettingsPageContribution } from "@opencraft/extension-contract";
import { ExtensionContributionStore } from "@opencraft/extension-runtime";
import { isWorkbenchToolPage } from "../../apps/workbench-web/src/runtime/workbench-tool-pages";

const owner = { extensionId: "example.tools", activationId: "first", generation: 1 };
const page = { id: "example.tools.any-id", title: "Tool", viewId: "example.tools.view" };
const batch = (page: SettingsPageContribution) => ({ commands: [], views: [{ id: page.viewId, title: "Tool", viewType: "example.tools.view" }],
  navigation: [], sidebarCatalogs: [], settingsPages: [page], settingsSchemas: [], workbenchSurfaces: [], themes: [], bots: [] });

test("a workbench tool is declared by its owner, with no private page-ID convention", () => {
  const store = new ExtensionContributionStore();
  const management = { familyId: "example.tools.manage", scope: "agent" as const, entryPoint: "workbench" as const };
  store.prepare(owner, batch({ ...page, management }))();
  const saved = store.getSnapshot().settingsPages[0]!.contribution;
  assert.equal(isWorkbenchToolPage(saved), true);
  assert.ok(Object.isFrozen(saved.management));
  Reflect.set(management, "entryPoint", undefined);
  assert.equal(isWorkbenchToolPage(saved), true, "caller mutation cannot change an active declaration");
  assert.equal(isWorkbenchToolPage({ ...page, id: "example.tools.different", management: saved.management }), true);
  assert.equal(isWorkbenchToolPage({ ...page, management: { familyId: "example.tools.manage", scope: "agent" } }), false);
  assert.equal(isWorkbenchToolPage(page), false);
  assert.equal(isWorkbenchToolPage(null), false);
  store.removeOwner(owner);
  assert.equal(store.getSnapshot().settingsPages.length, 0, "retirement withdraws the entry with its page");
});

test("malformed dynamic workbench declarations fail atomically; contextual pages stay compatible", () => {
  for (const entryPoint of [null, false, "", "modal", "sidebar", {}]) {
    const store = new ExtensionContributionStore();
    assert.throws(() => store.prepare(owner, batch({ ...page, management: {
      familyId: "example.tools.manage", scope: "host", entryPoint,
    } } as SettingsPageContribution)), /invalid management entry point/);
    assert.equal(store.getSnapshot().views.length, 0);
    assert.equal(store.getSnapshot().settingsPages.length, 0);
  }
  const store = new ExtensionContributionStore();
  store.prepare(owner, batch({ ...page, management: { familyId: "example.tools.manage", scope: "host" } }))();
  assert.equal(isWorkbenchToolPage(store.getSnapshot().settingsPages[0]!.contribution), false);
});
