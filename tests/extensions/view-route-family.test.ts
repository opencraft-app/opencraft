import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import type { ExtensionManifestV1 } from "@opencraft/extension-contract";
const manifest = (id: string): ExtensionManifestV1 => ({
  manifestVersion: 1,
  id,
  name: "Family test",
  version: "1.0.0",
  apiVersion: 1,
  trust: "trusted",
  platforms: ["web"],
  activationEvents: ["onStartupFinished"],
});
test("route-family declarations are opt-in and extension-owned at transaction publication", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  try {
    await assert.rejects(
      supervisor.activate({
        manifest: manifest("opencraft.bad-family"),
        activate(api) {
          api.views.register({
            id: "opencraft.bad-family.view",
            viewType: "test",
            title: "Bad",
            routeFamily: "foreign.family",
          });
        },
      }),
      /namespaced/,
    );
    await supervisor.activate({
      manifest: manifest("opencraft.family-test"),
      activate(api) {
        api.views.register({
          id: "opencraft.family-test.collection",
          viewType: "test",
          title: "Collection",
          routeFamily: "opencraft.family-test.inbox",
        });
        api.views.register({ id: "opencraft.family-test.ordinary", viewType: "test", title: "Ordinary" });
      },
    });
    const rows = supervisor.contributions.getSnapshot().views;
    assert.equal(
      rows.some((x) => x.contribution.id === "opencraft.bad-family.view"),
      false,
    );
    assert.equal(
      rows.find((x) => x.contribution.id.endsWith("collection"))?.contribution.routeFamily,
      "opencraft.family-test.inbox",
    );
    assert.equal(rows.find((x) => x.contribution.id.endsWith("ordinary"))?.contribution.routeFamily, undefined);
  } finally {
    await supervisor.dispose();
  }
});
