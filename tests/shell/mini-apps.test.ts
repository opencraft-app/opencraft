import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationContribution } from "@opencraft/extension-contract";
import { ExtensionContributionStore } from "@opencraft/extension-runtime";
import { projectMiniApps, OVERHOME_VIEW_ID } from "../../apps/workbench-web/src/runtime/mini-apps";
import { createApplicationNavigation, parseApplicationRouteUrl, workbenchLocationUrl } from "../../apps/workbench-web/src/runtime/workbench-navigation";
import { createWorkbenchDraftLocation } from "@opencraft/workbench-runtime";

const owner = { extensionId: "example.apps", activationId: "one", generation: 1 };
const app: NavigationContribution = { id: "example.apps.clock", title: "Clock", surface: "applications",
  target: { kind: "settings", pageId: "example.apps.clock-settings" } };
function batch(navigation: readonly NavigationContribution[] = [app]) {
  return { commands: [], settingsSchemas: [], sidebarCatalogs: [], workbenchSurfaces: [], themes: [], bots: [], navigation,
    views: [{ id: "example.apps.clock-view", title: "Clock", viewType: "clock" }],
    settingsPages: [{ id: "example.apps.clock-settings", title: "Clock", viewId: "example.apps.clock-view" }] };
}

test("miniapp catalog follows atomic publication and retirement of its actual owner", () => {
  const store = new ExtensionContributionStore();
  const publish = store.prepare(owner, batch());
  assert.deepEqual(projectMiniApps(store.getSnapshot(), "web", false, () => true), []);
  publish();
  assert.deepEqual(projectMiniApps(store.getSnapshot(), "web", false, () => true).map(app => app.id), [app.id]);
  assert.deepEqual(projectMiniApps(store.getSnapshot(), "web", false, () => false), [], "unrenderable targets are not advertised");
  store.removeOwner(owner);
  assert.deepEqual(projectMiniApps(store.getSnapshot(), "web", false, () => true), []);
});

test("catalog filters platform, audience and unresolved destinations without starting commands", () => {
  const store = new ExtensionContributionStore();
  store.prepare(owner, batch([
    app,
    { ...app, id: "example.apps.desktop", platforms: ["electron"] },
    { ...app, id: "example.apps.internal", audience: "internal" },
    { ...app, id: "example.apps.sidebar", surface: "sidebar-primary" },
  ]))();
  assert.deepEqual(projectMiniApps(store.getSnapshot(), "web", false, () => true).map(app => app.id), [app.id]);
  assert.equal(projectMiniApps(store.getSnapshot(), "electron", true, () => true).length, 3);
  const missing = new ExtensionContributionStore();
  assert.throws(() => missing.prepare(owner, batch([{ ...app, target: { kind: "view", viewId: "example.apps.not-registered" } }])), /unregistered contribution/);
  assert.deepEqual(projectMiniApps({ ...store.getSnapshot(), views: [] }, "web", false, () => true), [], "revoked destination cannot stay exposed");
  const invalid = new ExtensionContributionStore();
  assert.throws(() => invalid.prepare(owner, batch([{ ...app, target: { kind: "command", commandId: "example.apps.run" } }])), /View or Settings target/);
  assert.equal(invalid.getSnapshot().navigation.length, 0);
});

test("a target's audience and platform also govern its desktop exposure", () => {
  for (const restriction of [{ audience: "internal" as const }, { platforms: ["electron" as const] }]) {
    const store = new ExtensionContributionStore(), value = batch();
    store.prepare(owner, { ...value, views: value.views.map(view => ({ ...view, ...restriction })) })();
    assert.equal(projectMiniApps(store.getSnapshot(), "web", false, () => true).length, 0);
    assert.equal(projectMiniApps(store.getSnapshot(), "electron", true, () => true).length, 1);
  }
});

test("Overhome launch, deep link and back/forward retain the original Chat draft and scope", async () => {
  const location = createWorkbenchDraftLocation("fixture", "unsent-draft");
  const nav = createApplicationNavigation(location, { mode: "memory", initialEntries: ["/"] });
  const scope = nav.getSnapshot().routeScopeId;
  try {
    nav.openExtensionView(OVERHOME_VIEW_ID);
    assert.equal(nav.getSnapshot().url, "/overhome");
    assert.deepEqual(parseApplicationRouteUrl(new URL("https://fixture.test/overhome/")), nav.getSnapshot().applicationRoute);
    assert.equal(workbenchLocationUrl(location, nav.getSnapshot().applicationRoute), "/overhome");
    nav.openSettings("opencraft.schedules");
    nav.back(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(nav.getSnapshot().url, "/overhome");
    nav.back(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(nav.getSnapshot().applicationRoute.kind, "conversation");
    assert.deepEqual(nav.getSnapshot().location, location);
    assert.equal(nav.getSnapshot().routeScopeId, scope);
    nav.forward(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(nav.getSnapshot().url, "/overhome");
  } finally { nav.dispose(); }
});
