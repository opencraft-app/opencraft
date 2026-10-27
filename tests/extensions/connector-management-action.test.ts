import assert from "node:assert/strict";
import test from "node:test";
import type { ViewContribution, SettingsPageContribution } from "@opencraft/extension-contract";
import { PlatformViewRendererRegistry } from "@opencraft/extension-react";
import { ExtensionSupervisor, type TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import { createConnectorManagementAction } from "../../apps/workbench-web/src/runtime/connector-management-action";

const definition = (view: Partial<ViewContribution> = {}, page: Partial<SettingsPageContribution> = {}, extraPage = false): TrustedExtensionDefinition => ({
  manifest: { manifestVersion: 1, id: "example.connectors", name: "Connectors", version: "1.0.0", apiVersion: 1,
    trust: "trusted", platforms: ["web", "electron"], activationEvents: ["onStartupFinished"] },
  activate(api) {
    api.views.register({ id: "example.connectors.view", title: "Library", viewType: "example.connectors.surface", role: "connector-management", ...view });
    const entry = { id: "example.connectors.library", title: "Library", viewId: "example.connectors.view", ...page };
    api.settings.registerPage(entry);
    if (extraPage) api.settings.registerPage({ ...entry, id: "example.connectors.other" });
  },
});

test("management requires one visible, platform-compatible, rendered entry", async () => {
  for (const fixture of [
    { view: {}, page: {}, available: true },
    { view: { role: undefined }, page: {}, available: false },
    { view: { audience: "internal" as const }, page: {}, available: false },
    { view: {}, page: { audience: "internal" as const }, available: false },
    { view: { platforms: ["electron" as const] }, page: {}, available: false },
    { view: {}, page: { platforms: ["electron" as const] }, available: false },
    { view: {}, page: {}, extra: true, available: false },
  ]) {
    const supervisor = new ExtensionSupervisor({ platform: "web" });
    const renderers = new PlatformViewRendererRegistry();
    const routes: string[] = [];
    await supervisor.activate(definition(fixture.view, fixture.page, fixture.extra));
    const action = () => createConnectorManagementAction(supervisor.contributions, renderers, "web", false, id => routes.push(id));
    assert.equal(action(), undefined, "a declaration alone is not a runnable page");
    const retireRenderer = renderers.register("fixture", { viewType: "example.connectors.surface", Component: () => null });
    const manage = action();
    assert.equal(manage !== undefined, fixture.available, JSON.stringify(fixture));
    manage?.();
    assert.deepEqual(routes, fixture.available ? ["example.connectors.library"] : []);
    retireRenderer();
    manage?.();
    assert.equal(routes.length, fixture.available ? 1 : 0, "retired renderer cannot navigate");
    await supervisor.dispose();
  }
});

test("old menu callbacks cannot navigate after retirement or same-ID reactivation", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const renderers = new PlatformViewRendererRegistry();
  const routes: string[] = [];
  renderers.register("fixture", { viewType: "example.connectors.surface", Component: () => null });
  await supervisor.activate(definition({ audience: "internal" }, { audience: "internal" }));
  const action = () => createConnectorManagementAction(supervisor.contributions, renderers, "web", true, id => routes.push(id));
  const stale = action(); assert.ok(stale);
  await supervisor.deactivate("example.connectors");
  stale(); assert.deepEqual(routes, []);
  await supervisor.activate(definition({ audience: "internal" }, { audience: "internal" }));
  stale(); assert.deepEqual(routes, []);
  action()?.(); assert.deepEqual(routes, ["example.connectors.library"]);
  await supervisor.dispose();
});
