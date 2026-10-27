import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  MemoryUiPreferenceStore,
  UiPreferencesRuntime,
  type UiPreferenceKey,
} from "../../packages/ui-preferences/src/index.ts";
import { readModelSelection, rememberModelSelection } from "../../apps/workbench-web/src/runtime/model-selection-preferences.ts";
import { IndexedDbUiPreferenceStore } from "../../apps/workbench-web/src/runtime/indexeddb-ui-preference-store.ts";
import { openWorkbenchUiPreferences } from "../../apps/workbench-web/src/runtime/ui-preferences-runtime.tsx";

const createSilentChannel = () => ({
  addEventListener() {},
  close() {},
  postMessage() {},
}) as unknown as BroadcastChannel;

test("UI preference defaults keep Applications unpinned", async () => {
  const runtime = await UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() });
  assert.equal(runtime.get("shell.applicationsPinned"), false);
  assert.equal(runtime.get("chat.defaultFollowUpAction"), "queue");
  assert.equal(runtime.get("chat.turnNotifications"), false);
  assert.equal(runtime.get("interface.touchFriendly"), "auto");
  assert.equal(runtime.get("shell.accountPinned"), false);
  assert.equal(runtime.get("shell.navigationDetent"), "expanded");
  assert.equal(runtime.get("shell.navigationWidth"), 137);
  assert.equal(runtime.get("shell.contextSidebarWidth"), 275);
  await runtime.close();
});

test("IndexedDB installation preferences survive runtime recreation", async () => {
  const factory = new IDBFactory();
  const firstStore = await IndexedDbUiPreferenceStore.open({
    databaseName: "ui-preferences-test",
    factory,
    createChannel: createSilentChannel,
  });
  const first = await UiPreferencesRuntime.open({ installation: firstStore });
  await Promise.all([
    first.set("shell.applicationsPinned", true),
    first.set("chat.defaultFollowUpAction", "queue"),
    first.set("chat.turnNotifications", true),
    first.set("shell.navigationDetent", "compact"),
    first.set("shell.navigationWidth", 132),
    first.set("shell.contextSidebarWidth", 360),
    first.set("sidebar.serverFilter", { serverId: "ssh:fixture", label: "Remote fixture" }),
  ]);
  await first.close();

  const secondStore = await IndexedDbUiPreferenceStore.open({
    databaseName: "ui-preferences-test",
    factory,
    createChannel: createSilentChannel,
  });
  const second = await UiPreferencesRuntime.open({ installation: secondStore });
  assert.equal(second.get("shell.applicationsPinned"), true);
  assert.equal(second.get("chat.defaultFollowUpAction"), "queue");
  assert.equal(second.get("chat.turnNotifications"), true);
  assert.equal(second.get("shell.navigationDetent"), "compact");
  assert.equal(second.get("shell.navigationWidth"), 132);
  assert.equal(second.get("shell.contextSidebarWidth"), 360);
  assert.deepEqual(second.get("sidebar.serverFilter"), { serverId: "ssh:fixture", label: "Remote fixture" });
  assert.equal(second.storedRevision("shell.applicationsPinned"), 1);
  await second.close();
});

test("legacy shell migration resets the contaminated Applications default", async () => {
  const values = new Map<string, string>([
    ["opencraft.shell-navigation.v2", JSON.stringify({
      applications: true,
      account: true,
      railDetent: "compact",
      lastVisibleRailDetent: "compact",
    })],
    ["opencraft.shell-navigation.width.v3", "132"],
    ["sidebar-width", "360"],
  ]);
  const runtime = await openWorkbenchUiPreferences({
    factory: new IDBFactory(),
    storage: {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => { values.delete(key); },
    },
    createChannel: createSilentChannel,
  });

  assert.equal(runtime.get("shell.applicationsPinned"), false);
  assert.equal(runtime.get("shell.accountPinned"), true);
  assert.equal(runtime.get("shell.navigationDetent"), "compact");
  assert.equal(runtime.get("shell.lastVisibleNavigationDetent"), "compact");
  assert.equal(runtime.get("shell.navigationWidth"), 132);
  assert.equal(runtime.get("shell.contextSidebarWidth"), 360);
  assert.equal(values.size, 0);
  await runtime.close();
});

test("follow-up preference validates input and publishes live changes", async () => {
  const runtime = await UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() });
  const observed: string[] = [];
  const unsubscribe = runtime.subscribe(() => observed.push(runtime.get("chat.defaultFollowUpAction")));
  await runtime.set("chat.defaultFollowUpAction", "steer");
  await runtime.set("chat.defaultFollowUpAction", "queue");
  await runtime.set("chat.defaultFollowUpAction", "steer");
  await assert.rejects(runtime.set("chat.defaultFollowUpAction", "invalid" as "queue"), TypeError);
  assert.equal(runtime.get("chat.defaultFollowUpAction"), "steer");
  assert.ok(observed.includes("queue"));
  assert.equal(observed.at(-1), "steer");
  unsubscribe();
  await runtime.close();
});

test("invalid stored follow-up preference falls back to the authority default", async () => {
  const installation = new MemoryUiPreferenceStore();
  await installation.compareAndSet("chat.defaultFollowUpAction", 0, '"invalid"');
  const runtime = await UiPreferencesRuntime.open({ installation });
  assert.equal(runtime.get("chat.defaultFollowUpAction"), "queue");
  await runtime.set("chat.defaultFollowUpAction", "steer");
  assert.equal(runtime.get("chat.defaultFollowUpAction"), "steer");
  await runtime.close();
});


test("workbench entries share automatic touch experience and preserve manual choices", async () => {
  const factory = new IDBFactory();
  const options = { factory, storage: { getItem: () => null, removeItem() {} }, createChannel: createSilentChannel };
  let runtime = await openWorkbenchUiPreferences(options);
  assert.equal(runtime.get("interface.touchFriendly"), "auto");
  assert.equal(runtime.storedRevision("interface.touchFriendly"), 0);
  await runtime.set("interface.touchFriendly", "off");
  await runtime.close();
  runtime = await openWorkbenchUiPreferences(options);
  assert.equal(runtime.get("interface.touchFriendly"), "off");
  await runtime.set("interface.touchFriendly", "on");
  await runtime.close();
  runtime = await openWorkbenchUiPreferences(options);
  assert.equal(runtime.get("interface.touchFriendly"), "on");
  await runtime.reset("interface.touchFriendly");
  assert.equal(runtime.get("interface.touchFriendly"), "auto");
  await runtime.close();
});

test("retired Newera records neither override touch intent nor need destructive migration", async () => {
  const legacyKey = "chat.touchNewera" as UiPreferenceKey;
  for (const legacy of [true, false]) for (const choice of [undefined, "auto", "on", "off"] as const) {
    const store = new MemoryUiPreferenceStore();
    await store.compareAndSet(legacyKey, 0, JSON.stringify(legacy));
    if (choice !== undefined) await store.compareAndSet("interface.touchFriendly", 0, JSON.stringify(choice));
    const original = await store.load(legacyKey);
    const runtime = await UiPreferencesRuntime.open({ installation: store });
    assert.equal(runtime.get("interface.touchFriendly"), choice ?? "auto");
    assert.equal("chat.touchNewera" in runtime.getSnapshot().values, false);
    await runtime.set("interface.touchFriendly", "off");
    assert.deepEqual(await store.load(legacyKey), original);
    await runtime.close();
  }
});

test("an explicit value matching a contextual default is persisted; invalid data and reset use the entry default", async () => {
  const store = new MemoryUiPreferenceStore();
  let runtime = await UiPreferencesRuntime.open({installation:store},{defaults:{"shell.accountPinned":true}});
  await runtime.set("shell.accountPinned",true);
  assert.equal(runtime.storedRevision("shell.accountPinned"),1);
  await runtime.close();
  runtime = await UiPreferencesRuntime.open({installation:store});
  assert.equal(runtime.get("shell.accountPinned"),true);
  await runtime.reset("shell.accountPinned");assert.equal(runtime.get("shell.accountPinned"),false);
  await runtime.close();
  await store.compareAndSet("shell.accountPinned",2,'"invalid"');
  runtime = await UiPreferencesRuntime.open({installation:store},{defaults:{"shell.accountPinned":true}});
  assert.equal(runtime.get("shell.accountPinned"),true);
  await runtime.set("shell.accountPinned",false);await runtime.reset("shell.accountPinned");
  assert.equal(runtime.get("shell.accountPinned"),true);await runtime.close();
});


test("live refresh keeps each entry fallback while sharing explicit user choices", async () => {
  const store=new MemoryUiPreferenceStore();
  const standalone=await UiPreferencesRuntime.open({installation:store},{defaults:{"shell.accountPinned":true}});
  const embedded=await UiPreferencesRuntime.open({installation:store});
  await standalone.set("shell.accountPinned",true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(embedded.get("shell.accountPinned"),true);
  await embedded.set("shell.accountPinned",false);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(standalone.get("shell.accountPinned"),false);
  await store.compareAndSet("shell.accountPinned",2,'null');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(standalone.get("shell.accountPinned"),true);
  assert.equal(embedded.get("shell.accountPinned"),false);
  await standalone.close();await embedded.close();
});


test("model memory isolates account, display and target Host through production read/write", async () => {
  const store = new MemoryUiPreferenceStore();
  const first = await UiPreferencesRuntime.open({ installation: store });
  const scope = { displayScope: "opencraft", accountScope: "account-a", hostId: "local" };
  const otherAccount = { ...scope, accountScope: "account-b" };
  const anonymous = { ...scope, accountScope: "anonymous" };
  const targetHost = { ...scope, hostId: "fixture-secondary" };
  const otherDisplay = { ...scope, displayScope: "other-product" };
  const choice = { model: "provider-a/model", effort: "high", serviceTier: "priority" };
  await rememberModelSelection(first, scope, choice);
  const read = (runtime: UiPreferencesRuntime, key: typeof scope | null) => readModelSelection(runtime.get("chat.modelSelections"), key);
  for (const key of [otherAccount, anonymous, targetHost, otherDisplay, null]) assert.equal(read(first, key), undefined);
  await rememberModelSelection(first, targetHost, { model: "secondary-model", effort: "low" });
  assert.deepEqual(read(first, scope), choice, "cross-Agent write does not overwrite current Host");
  await rememberModelSelection(first, otherAccount, { model: "provider-b/model", effort: null, serviceTier: null });
  await rememberModelSelection(first, anonymous, { model: "anonymous-model", effort: null });
  await rememberModelSelection(first, null, { model: "embedded-model", effort: null });
  assert.equal(Object.keys(first.get("chat.modelSelections")).length, 4, "embedded presentation does not persist a choice");
  await first.close();
  const restored = await UiPreferencesRuntime.open({ installation: store });
  assert.deepEqual(read(restored, scope), choice);
  assert.deepEqual(read(restored, targetHost), { model: "secondary-model", effort: "low" });
  assert.deepEqual(read(restored, otherAccount), { model: "provider-b/model", effort: null, serviceTier: null });
  assert.deepEqual(read(restored, anonymous), { model: "anonymous-model", effort: null });
  assert.equal(read(restored, otherDisplay), undefined);
  assert.equal(read(restored, null), undefined);
  await assert.rejects(restored.set("chat.modelSelections", { bad: { model: "", effort: null } }));
  for (const serviceTier of [true, 1, "", " ", "x".repeat(129)]) {
    await assert.rejects(restored.set("chat.modelSelections", { bad: { model: "valid", effort: null, serviceTier } } as never));
  }
  assert.deepEqual(read(restored, scope), choice, "invalid input preserves the last valid selection");
  await restored.close();
});
