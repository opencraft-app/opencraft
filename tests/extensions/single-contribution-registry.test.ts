import assert from "node:assert/strict";
import test from "node:test";
import { ThreadBadgeContributionRegistry } from "../../apps/workbench-web/src/runtime/thread-badge-contributions";
import { IdentityAvatarContributionRegistry } from "../../apps/workbench-web/src/runtime/identity-avatar-contributions";
import { ThreadListGroupingContributionRegistry } from "../../apps/workbench-web/src/runtime/thread-list-grouping-contributions";
import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import type { ExtensionActivationIdentity } from "@opencraft/extension-contract";

const owner: ExtensionActivationIdentity = { extensionId: "test.contribution", activationId: "activation", generation: 1 };
// A rejected badge rolls back its whole extension, so exercise activation too.
for (const placement of [undefined, "trailing", "metadata", "title"] as const) {
  test(`badge: ${placement ?? "default"} placement activates and unloads`, async t => {
    const registry = new ThreadBadgeContributionRegistry();
    const supervisor = new ExtensionSupervisor({ platform: "web", internalContributions: { threadBadge: registry.createAdapter() } });
    t.after(() => supervisor.dispose());
    const contribution = { id: "test.badge", Component: () => null, placement };
    await supervisor.activate({
      manifest: { manifestVersion: 1, id: "test.badge", name: "Badge", version: "1.0.0", apiVersion: 1,
        platforms: ["web"], trust: "trusted", activationEvents: ["*"] },
      activate(api) { api.internal.register("threadBadge", contribution); },
    });
    assert.equal(supervisor.getSnapshot().extensions[0]?.status, "active");
    assert.equal(registry.getSnapshot().contribution, contribution);
    await supervisor.deactivate("test.badge");
    assert.equal(registry.getSnapshot().contribution, null);
  });
}

test("badge: unknown and non-string placements cannot acquire the slot", () => {
  const registry = new ThreadBadgeContributionRegistry();
  for (const placement of ["unknown", "toString", "__proto__", null, true, 1, {}, []]) {
    assert.throws(() => registry.createAdapter().prepare(owner, { id: "test.badge", Component: () => null, placement }), /Invalid thread badge contribution/);
    assert.equal(registry.getSnapshot().contribution, null);
  }
});
const fixtures = [
  { name: "badge", registry: () => new ThreadBadgeContributionRegistry(), contribution: { id: "test.badge", Component: () => null } },
  { name: "avatar", registry: () => new IdentityAvatarContributionRegistry(), contribution: { id: "test.avatar", resolve: () => null } },
  { name: "grouping", registry: () => new ThreadListGroupingContributionRegistry(), contribution: {
    id: "test.grouping", getSnapshot: () => ({ revision: 0, mode: null, modes: [], hideRowBadge: false, notice: null }),
    subscribe: () => () => {}, watch: () => () => {}, project: () => [], setMode: () => {}, toggleGroup: () => {},
  } },
];

for (const fixture of fixtures) {
  test(`${fixture.name}: retired cleanup cannot remove a new registration of the same object`, async () => {
    const registry = fixture.registry();
    const adapter = registry.createAdapter();
    const snapshots: unknown[] = [];
    const unsubscribe = registry.subscribe(() => snapshots.push(registry.getSnapshot().contribution));
    const first = await adapter.prepare(owner, fixture.contribution);
    assert.equal(registry.getSnapshot().contribution, null, "prepare has no observable side effects");
    const release = await first.commit();
    release();
    const second = await adapter.prepare({ ...owner, activationId: "replacement", generation: 2 }, fixture.contribution);
    const releaseSecond = await second.commit();
    release();
    assert.equal(registry.getSnapshot().contribution, fixture.contribution);
    assert.deepEqual(snapshots, [fixture.contribution, null, fixture.contribution]);
    releaseSecond();
    assert.equal(registry.getSnapshot().contribution, null);
    assert.equal(snapshots.length, 4);
    unsubscribe();
  });

  test(`${fixture.name}: competing prepared registrations arbitrate at commit`, async () => {
    const registry = fixture.registry(), adapter = registry.createAdapter();
    const first = await adapter.prepare(owner, fixture.contribution);
    const second = await adapter.prepare(owner, { ...fixture.contribution, id: "test.second" });
    const release = await first.commit();
    await assert.rejects(async () => second.commit(), /owner/);
    await assert.rejects(async () => adapter.prepare(owner, fixture.contribution), /owner/);
    assert.equal(registry.getSnapshot().contribution, fixture.contribution);
    release();
  });

  test(`${fixture.name}: invalid contributions never acquire the slot`, async () => {
    const registry = fixture.registry(), adapter = registry.createAdapter();
    for (const value of [null, false, {}, { ...fixture.contribution, id: " " }, { ...fixture.contribution, id: 1 }]) {
      await assert.rejects(async () => adapter.prepare(owner, value), /Invalid/);
      assert.equal(registry.getSnapshot().contribution, null);
    }
  });

  test(`${fixture.name}: supervisor rollback, reactivation and unloading release the slot`, async t => {
    const registry = fixture.registry();
    const supervisor = new ExtensionSupervisor({ platform: "web", internalContributions: {
      slot: registry.createAdapter(),
      fail: { prepare: () => ({ commit: () => { throw Error("fixture commit failed"); } }) },
    } });
    t.after(() => supervisor.dispose());
    const manifest = { manifestVersion: 1, id: "test.contribution", name: "Fixture", version: "1.0.0",
      apiVersion: 1, platforms: ["web"], trust: "trusted", activationEvents: ["*"] } as const;
    await assert.rejects(supervisor.activate({ manifest, activate(api) {
      api.internal.register("slot", fixture.contribution);
      api.internal.register("fail", {});
    } }), /fixture commit failed/);
    assert.equal(registry.getSnapshot().contribution, null);
    await supervisor.activate({ manifest, activate(api) { api.internal.register("slot", fixture.contribution); } });
    assert.equal(registry.getSnapshot().contribution, fixture.contribution);
    await supervisor.deactivate(manifest.id);
    assert.equal(registry.getSnapshot().contribution, null);
  });
}
