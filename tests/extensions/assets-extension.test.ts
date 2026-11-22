import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import { createAssetsExtension, e2bAssetProvider } from "../../plugins/assets/src/index";

for (const platform of ["web", "electron"] as const)
  test(`assets has one provider-neutral navigation/view owner on ${platform}`, async () => {
    const supervisor = new ExtensionSupervisor({
      platform,
      internalContributions: {
        platformViewRenderer: {
          prepare() {
            return {
              commit() {
                return () => {};
              },
            };
          },
        },
      },
    });
    let reads = 0,
      subscriptions = 0;
    await supervisor.activate(
      createAssetsExtension({
        account: {
          getScope: () => "local:fixture-a",
          subscribe() {
            subscriptions++;
            return () => {};
          },
          refresh() {},
        },
        endpoint: "/test-assets",
        providers: [e2bAssetProvider],
        fetcher: async () => {
          reads++;
          throw Error("Must not load data during registration");
        },
      }),
    );
    const snapshot = supervisor.contributions.getSnapshot();
    assert.deepEqual(
      snapshot.views.map(({ contribution }) => contribution.id),
      ["opencraft.assets", "opencraft.assets.entry"],
    );
    assert.equal(snapshot.views[0].contribution.keepConversationSidebar, true);
    assert.equal(snapshot.sidebarCatalogs.length, 1);
    assert.equal(snapshot.sidebarCatalogs[0].contribution.presentation, "entry");
    assert.equal(snapshot.sidebarCatalogs[0].contribution.viewId, "opencraft.assets.entry");
    assert.equal(reads, 0);
    assert.equal(subscriptions, 0);
    assert.ok(snapshot.views.every(({ owner }) => owner.extensionId === "opencraft.assets"));
    await supervisor.deactivate("opencraft.assets");
    assert.equal(supervisor.contributions.getSnapshot().sidebarCatalogs.length, 0);
    assert.equal(supervisor.contributions.getSnapshot().views.length, 0);
  });
