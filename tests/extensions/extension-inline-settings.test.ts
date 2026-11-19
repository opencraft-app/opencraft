import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionContributionStore } from "../../packages/extension-runtime/src/contribution-store";
import { projectMiniApps } from "../../apps/workbench-web/src/runtime/mini-apps";
const owner = { extensionId: "fixture.plugin", activationId: "fixture", platform: "web" as const };
const page = {
  id: "fixture.plugin.settings",
  viewId: "fixture.plugin.view",
  title: "Policy",
  placement: "extension" as const,
};
const batch = (settings: any) => ({
  commands: [],
  views: [{ id: page.viewId, title: "Policy", viewType: "fixture.policy" }],
  settingsPages: [settings],
  settingsSchemas: [],
  navigation: [],
  sidebarCatalogs: [],
  workbenchSurfaces: [],
  themes: [],
  bots: [],
});
test("extension-only placement is explicit and rejects malformed values atomically", () => {
  for (const placement of [null, false, "", "hidden", {}]) {
    const store = new ExtensionContributionStore();
    assert.throws(() => store.prepare(owner, batch({ ...page, placement })));
    assert.equal(store.getSnapshot().settingsPages.length, 0);
  }
  for (const placement of [undefined, "navigation", "extension"]) {
    const store = new ExtensionContributionStore();
    store.prepare(owner, batch({ ...page, placement }))();
    assert.equal(store.getSnapshot().settingsPages[0]?.contribution.placement, placement);
  }
});
test("embedding preserves extension ownership and cannot advertise a standalone mini app destination", () => {
  const store = new ExtensionContributionStore(),
    b = batch(page);
  (b.navigation as any[]).push({
    id: "fixture.plugin.app",
    title: "Policy",
    surface: "applications",
    target: { kind: "settings", pageId: page.id },
  });
  store.prepare(owner, b)();
  assert.equal(store.getSnapshot().settingsPages[0]?.owner.extensionId, owner.extensionId);
  assert.equal(projectMiniApps(store.getSnapshot(), "web", false, () => true).length, 0);
  store.removeOwner(owner);
  assert.equal(store.getSnapshot().settingsPages.length, 0);
});
