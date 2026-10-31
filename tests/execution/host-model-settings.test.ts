import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionSupervisor, resolveHostModelSettingsPage, type TrustedExtensionApiV1 } from "@opencraft/extension-runtime";
import type { SettingsPageContribution } from "@opencraft/extension-contract";

const page = (id: string, patch: Partial<SettingsPageContribution> = {}): SettingsPageContribution => ({
  id, title: id, viewId: `${id}-view`, targetHostId: "custom-engine", modelConfiguration: true, ...patch,
});

test("model configuration follows explicit Host declarations, visibility and priority, never engine/page names", () => {
  const pages = [
    page("opencraft.builtin-agents.codex-accounts", { targetHostId: "local-codex" }),
    page("example.unmarked", { modelConfiguration: undefined, order: -10 }),
    page("example.native", { platforms: ["electron"], order: -3 }),
    page("example.internal", { audience: "internal", order: -2 }),
    page("example.secondary", { order: 3 }),
    page("example.models"),
    page("example.z-models"),
  ];
  assert.equal(resolveHostModelSettingsPage(pages, "custom-engine", "web")?.id, "example.models");
  assert.equal(resolveHostModelSettingsPage([...pages].reverse(), "custom-engine", "web")?.id, "example.models");
  assert.equal(resolveHostModelSettingsPage(pages, "custom-engine", "electron")?.id, "example.native");
  assert.equal(resolveHostModelSettingsPage(pages, "custom-engine", "web", true)?.id, "example.internal");
  assert.equal(resolveHostModelSettingsPage(pages, "absent", "web"), undefined);
  assert.equal(resolveHostModelSettingsPage([page("example.disabled", { modelConfiguration: false })], "custom-engine", "web"), undefined);
  assert.equal(resolveHostModelSettingsPage(pages, "local-codex", "web")?.id, "opencraft.builtin-agents.codex-accounts");
});

test("invalid model configuration declarations roll back activation; valid declarations revoke on deactivation", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const definition = (contribution: SettingsPageContribution) => ({
    manifest: { manifestVersion: 1 as const, id: "example.models", name: "Models", version: "1.0.0", apiVersion: 1 as const, trust: "trusted" as const, platforms: ["web" as const], activationEvents: ["onStartupFinished" as const] },
    activate(api: TrustedExtensionApiV1) {
      api.views.register({ id: contribution.viewId, title: "Models", viewType: "example.models.surface" });
      api.settings.registerPage(contribution);
    },
  });
  try {
    for (const invalid of [
      page("example.models.page", { targetHostId: undefined }),
      page("example.models.page", { modelReadiness: true, modelConfiguration: false }),
      page("example.models.page", { modelReadiness: "yes" as unknown as boolean }),
      page("example.models.page", { modelConfiguration: "yes" as unknown as boolean }),
    ]) {
      await assert.rejects(supervisor.activate(definition(invalid)), /model configuration/);
      assert.equal(supervisor.contributions.getSnapshot().views.length, 0);
      assert.equal(supervisor.contributions.getSnapshot().settingsPages.length, 0);
    }
    await supervisor.activate(definition(page("example.models.page")));
    const get = () => resolveHostModelSettingsPage(supervisor.contributions.getSnapshot().settingsPages.map(({ contribution }) => contribution), "custom-engine", "web");
    assert.equal(get()?.id, "example.models.page");
    await supervisor.deactivate("example.models");
    assert.equal(get(), undefined);
  } finally { await supervisor.dispose(); }
});
