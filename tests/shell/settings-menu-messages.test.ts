import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionContributionStore } from "@opencraft/extension-runtime";
import type { SettingsPageContribution } from "@opencraft/extension-contract";

const owner = { extensionId: "test.menu", activationId: "first", generation: 1 };
const batch = (page: SettingsPageContribution) => ({ commands: [], views: [{ id: "test.menu.view", title: "Fixture", viewType: "test.menu.fixture" }], navigation: [], sidebarCatalogs: [], settingsPages: [page], settingsSchemas: [], workbenchSurfaces: [], themes: [], bots: [] });
const page = { id: "test.menu.page", viewId: "test.menu.view", title: "Legacy plugin", group: "Legacy group" };

test("localized settings copy is an immutable snapshot, while legacy labels remain compatible", () => {
  const store = new ExtensionContributionStore();
  const titleMessage = { id: "menu.title", defaultMessage: "Models" };
  const groupMessage = { id: "menu.group", defaultMessage: "Server" };
  store.prepare(owner, batch({ ...page, titleMessage, groupMessage }))();
  const saved = store.getSnapshot().settingsPages[0]!.contribution;
  titleMessage.defaultMessage = "changed externally";
  groupMessage.id = "changed externally";
  assert.equal(saved.titleMessage?.defaultMessage, "Models");
  assert.equal(saved.groupMessage?.id, "menu.group");
  assert.ok(Object.isFrozen(saved.titleMessage));
  assert.ok(Object.isFrozen(saved.groupMessage));
  assert.equal(saved.title, "Legacy plugin");
  const legacy = new ExtensionContributionStore();
  legacy.prepare(owner, batch(page))();
  assert.equal(legacy.getSnapshot().settingsPages[0]!.contribution.title, "Legacy plugin");
});

test("malformed copy is rejected atomically before publishing a settings entry", () => {
  for (const value of [null, false, {}, { id: "", defaultMessage: "Title" }, { id: "menu", defaultMessage: " " }, { id: 1, defaultMessage: "Title" }]) {
    for (const field of ["titleMessage", "groupMessage"]) {
      const store = new ExtensionContributionStore();
      assert.throws(() => store.prepare(owner, batch({ ...page, [field]: value } as SettingsPageContribution)));
      assert.equal(store.getSnapshot().settingsPages.length, 0);
    }
  }
});
