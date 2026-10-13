import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";

import {
  MemoryUiPreferenceStore,
  UiPreferencesRuntime,
} from "../packages/ui-preferences/src/index.ts";
import { IndexedDbUiPreferenceStore } from "../apps/workbench-web/src/runtime/indexeddb-ui-preference-store.ts";
import { openWorkbenchUiPreferences } from "../apps/workbench-web/src/runtime/ui-preferences-runtime.tsx";

const createSilentChannel = () => ({
  addEventListener() {},
  close() {},
  postMessage() {},
}) as unknown as BroadcastChannel;

test("UI preference defaults keep Applications unpinned", async () => {
  const runtime = await UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() });
  assert.equal(runtime.get("shell.applicationsPinned"), false);
  assert.equal(runtime.get("chat.defaultFollowUpAction"), "queue");
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
    first.set("shell.navigationDetent", "compact"),
    first.set("shell.navigationWidth", 132),
    first.set("shell.contextSidebarWidth", 360),
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
  assert.equal(second.get("shell.navigationDetent"), "compact");
  assert.equal(second.get("shell.navigationWidth"), 132);
  assert.equal(second.get("shell.contextSidebarWidth"), 360);
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
