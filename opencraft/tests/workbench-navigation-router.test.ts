import assert from "node:assert/strict";
import test from "node:test";
import { createWorkbenchDraftLocation } from "../packages/workbench-runtime/src/index.ts";
import { createApplicationNavigation } from "../apps/workbench-web/src/runtime/workbench-navigation.ts";
import { createWorkbenchNavigationTransaction } from "../apps/workbench-web/src/runtime/workbench-navigation-transaction.ts";

test("replacing Settings with the same conversation publishes the changed route", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const history = { state: null as unknown, replaceState(state: unknown) { this.state = state; },
    pushState(state: unknown) { this.state = state; }, back() {}, forward() {}, go() {} };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    history, location: { href: "https://fixture.test/?hostId=local&draftId=a" }, addEventListener() {}, removeEventListener() {},
  } });
  const location = createWorkbenchDraftLocation("local", "a");
  const navigation = createApplicationNavigation(location);
  try {
    navigation.openSettings();
    let notifications = 0; navigation.subscribe(() => notifications++);
    navigation.replace(location);
    assert.equal(navigation.getSnapshot().applicationRoute.kind, "conversation");
    assert.equal(notifications, 1);
  } finally {
    navigation.dispose();
    if (previous) Object.defineProperty(globalThis, "window", previous); else delete (globalThis as any).window;
  }
});

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("untagged Home POP is consumed and initial memory entries support forward/back", async () => {
  const nav = createApplicationNavigation(null, { mode: "memory", initialEntries: ["/", "/settings/appearance"] });
  try {
    assert.equal(nav.getSnapshot().canGoBack, true);
    nav.back(); await settle();
    assert.equal(nav.getSnapshot().url, "/");
    assert.equal(nav.getSnapshot().applicationRoute.kind, "conversation");
    assert.equal(nav.getSnapshot().canGoForward, true);
    nav.forward(); await settle();
    assert.equal(nav.getSnapshot().applicationRoute.kind, "settings");
  } finally { nav.dispose(); }
});

test("hostless Chat is a destination, not one backward resource step", async () => {
  const nav = createApplicationNavigation(null, { mode: "memory" });
  try {
    nav.openExtensionView("files", "folder");
    nav.pushExtensionViewResource("files", "nested");
    nav.openSettings();
    nav.openChat();
    assert.equal(nav.getSnapshot().location, null);
    assert.equal(nav.getSnapshot().applicationRoute.kind, "conversation");
    assert.equal(nav.getSnapshot().url, "/");
    nav.back(); await settle();
    assert.equal(nav.getSnapshot().applicationRoute.kind, "settings");
    nav.forward(); await settle();
    assert.equal(nav.getSnapshot().applicationRoute.kind, "conversation");
  } finally { nav.dispose(); }
});

test("rejected activation leaves Settings and its history untouched", async () => {
  const a = createWorkbenchDraftLocation("local", "a"), b = createWorkbenchDraftLocation("local", "b");
  let cancelled = 0;
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: async () => ({ commit: () => false, cancel: () => { cancelled++; } }),
  } as any, { getActiveDraft: () => null } as any);
  try {
    nav.openSettings("appearance");
    const before = nav.getSnapshot();
    assert.equal(await nav.navigate(b, "replace"), false);
    assert.deepEqual(nav.getSnapshot(), before);
    assert.equal(cancelled, 1);
  } finally { nav.dispose(); }
});

test("POP restores the entry View even when its conversation matches", async () => {
  const a = createWorkbenchDraftLocation("local", "a"), b = createWorkbenchDraftLocation("local", "b");
  const activated: string[] = [];
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: async () => ({ commit: (scope: string) => { activated.push(scope); return true; }, cancel() {} }),
  } as any, { getActiveDraft: () => null } as any);
  try {
    const original = nav.getSnapshot().routeScopeId;
    nav.openSettings();
    await nav.navigate(a);
    const second = nav.getSnapshot().routeScopeId;
    assert.notEqual(second, original);
    nav.back(); await settle();
    await nav.openChat();
    assert.equal(nav.getSnapshot().routeScopeId, original);
    assert.equal(activated.at(-1), original);
    await nav.navigate(b);
    nav.back(); await settle();
    assert.equal(nav.getSnapshot().routeScopeId, original);
    assert.equal(activated.at(-1), original);
  } finally { nav.dispose(); }
});

test("disposing a navigation owner cancels a late preparation without committing", async () => {
  const a = createWorkbenchDraftLocation("local", "a");
  let finish!: (value: any) => void, cancelled = 0;
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: () => new Promise(resolve => { finish = resolve; }),
  } as any, { getActiveDraft: () => null } as any);
  const pending = nav.navigate(a);
  nav.dispose();
  finish({ commit() { throw new Error("disposed owner committed"); }, cancel() { cancelled++; } });
  assert.equal(await pending, false); assert.equal(cancelled, 1);
});

test("a late conversation preparation cannot replace a newer Settings intent", async () => {
  const a = createWorkbenchDraftLocation("local", "a"), b = createWorkbenchDraftLocation("local", "b");
  let finish!: (value: any) => void;
  let commits = 0, cancellations = 0;
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: () => new Promise(resolve => { finish = resolve; }),
  } as any, { getActiveDraft: () => null } as any);
  try {
    const pending = nav.navigate(b);
    nav.openSettings();
    finish({ commit() { commits++; return true; }, cancel() { cancellations++; } });
    assert.equal(await pending, false);
    assert.equal(nav.getSnapshot().applicationRoute.kind, "settings");
    assert.equal(commits, 0); assert.equal(cancellations, 1);
  } finally { nav.dispose(); }
});
