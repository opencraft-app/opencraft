import assert from "node:assert/strict";
import test from "node:test";
import { createWorkbenchDraftLocation, createWorkbenchThreadLocation } from "../../packages/workbench-runtime/src/index.ts";
import { createApplicationNavigation } from "../../apps/workbench-web/src/runtime/workbench-navigation.ts";
import { createWorkbenchNavigationTransaction } from "../../apps/workbench-web/src/runtime/workbench-navigation-transaction.ts";

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

import { resolveLegacyWebsiteLocation } from "../../apps/workbench-web/src/runtime/web-deployment-config";

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

test("POP of the retained View resumes readiness locally and fences late results", async () => {
  const a = createWorkbenchDraftLocation("local", "a");
  const finishes: Array<(value: any) => void> = [];
  let commits = 0, cancellations = 0;
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: () => new Promise(resolve => { finishes.push(resolve); }),
  } as any, { getActiveDraft: () => null } as any);
  const original = nav.getSnapshot().routeScopeId;
  try {
    nav.openSettings(); nav.back(); await settle();
    assert.equal(nav.getSnapshot().applicationRoute.kind, "conversation");
    assert.equal(nav.getSnapshot().routeScopeId, original);
    assert.equal(finishes.length, 1, "POP must restart readiness canceled by Settings");
    nav.openSettings();
    finishes[0]!({ commit() { commits++; return true; }, cancel() { cancellations++; } });
    await settle();
    assert.equal(commits, 0); assert.equal(cancellations, 1);
    assert.equal(nav.getSnapshot().applicationRoute.kind, "settings");
    assert.equal(await nav.openChat(), true, "retained presentation does not await physical readiness");
    assert.equal(nav.getSnapshot().routeScopeId, original);
    assert.equal(finishes.length, 2);
    nav.dispose();
    finishes[1]!({ commit() { commits++; return true; }, cancel() { cancellations++; } });
    await settle();
    assert.equal(commits, 0); assert.equal(cancellations, 2);
  } finally { nav.dispose(); }
});

test("submission retains ownership over local Chat return and history controls", async () => {
  const a = createWorkbenchDraftLocation("local", "a");
  let blocked = false, prepared = 0;
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: async () => { prepared++; return { commit: () => true, cancel() {} }; },
  } as any, { getActiveDraft: () => blocked ? { phase: "submitting" } : null } as any,
  { mode: "memory", initialEntries: ["/?hostId=local&draftId=expired", "/?hostId=local&draftId=a"],
    resolveRestoredEntry: entry => ({ ...entry, location: a }) });
  try {
    nav.openSettings(); const before = nav.getSnapshot();
    blocked = true;
    assert.equal(await nav.openChat(), false);
    assert.equal(await nav.selectConversation(a), false);
    nav.back(); await settle();
    assert.deepEqual(nav.getSnapshot(), before);
    assert.equal(prepared, 0);
  } finally { nav.dispose(); }
});

test("selecting the retained conversation cancels another pending destination", async () => {
  const a = createWorkbenchDraftLocation("local", "a"), b = createWorkbenchDraftLocation("local", "b");
  const finishes: Array<(value: any) => void> = [];
  let cancelled = 0, commits = 0;
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: () => new Promise(resolve => { finishes.push(resolve); }),
  } as any, { getActiveDraft: () => null } as any);
  try {
    const original = nav.getSnapshot().routeScopeId;
    const pending = nav.selectConversation(b);
    assert.equal(await nav.selectConversation(a), true);
    finishes[0]!({ commit() { commits++; return true; }, cancel() { cancelled++; } });
    assert.equal(await pending, false);
    assert.equal(commits, 0); assert.equal(cancelled, 1);
    assert.deepEqual(nav.getSnapshot().location, a);
    assert.equal(nav.getSnapshot().routeScopeId, original);
  } finally { nav.dispose(); }
});

test("failed selection may be retried and cannot leave an orphaned prepared lease", async () => {
  const a = createWorkbenchDraftLocation("local", "a"), b = createWorkbenchDraftLocation("local", "b");
  let attempts = 0, cancelled = 0;
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: async () => { const attempt = ++attempts; return {
      commit() { if (attempt === 1) throw new Error("rejected View"); return true; },
      cancel() { cancelled++; },
    }; },
  } as any, { getActiveDraft: () => null } as any);
  try {
    nav.openSettings(); const before = nav.getSnapshot();
    await assert.rejects(nav.selectConversation(b), /rejected View/);
    assert.deepEqual(nav.getSnapshot(), before); assert.equal(cancelled, 1);
    assert.equal(await nav.selectConversation(b), true);
    assert.equal(attempts, 2); assert.deepEqual(nav.getSnapshot().location, b);
  } finally { nav.dispose(); }
});

test("New-chat readiness uses the same lifetime fence as retained returns", async () => {
  const a = createWorkbenchDraftLocation("local", "a"), b = createWorkbenchDraftLocation("local", "b");
  let finish!: (value: any) => void, cancelled = 0;
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {}, presentLocalDraft() {},
    prepare: () => new Promise(resolve => { finish = resolve; }),
  } as any, { getActiveDraft: () => null } as any);
  try {
    assert.equal(nav.navigateToHome(b), true);
    nav.openExtensionView("files");
    finish({ commit() { throw new Error("old readiness committed"); }, cancel() { cancelled++; } });
    await settle();
    assert.equal(cancelled, 1); assert.equal(nav.getSnapshot().applicationRoute.kind, "extension-view");
  } finally { nav.dispose(); }
});

test("late promotion is fenced and an inactive Draft cannot acquire navigation ownership", async () => {
  const a = createWorkbenchDraftLocation("local", "a"), b = createWorkbenchDraftLocation("local", "b");
  let finish!: (value: any) => void, cancelled = 0, prepared = 0;
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {}, presentLocalDraft() {},
    prepare: async () => null,
    preparePromotion: () => { prepared++; return new Promise(resolve => { finish = resolve; }); },
  } as any, { getActiveDraft: () => null } as any);
  try {
    const pending = nav.promoteDraft("a", {} as any);
    nav.navigateToHome(b);
    const before = nav.getSnapshot();
    finish({ commit() { throw new Error("old promotion committed"); }, cancel() { cancelled++; } });
    await assert.rejects(pending, /superseded/);
    assert.equal(cancelled, 1); assert.deepEqual(nav.getSnapshot(), before);
    await assert.rejects(nav.promoteDraft("a", {} as any), /no longer owns/);
    assert.equal(prepared, 1); assert.deepEqual(nav.getSnapshot(), before);
  } finally { nav.dispose(); }
});

test("a stale selection completion cannot clear the successor's pending ownership", async () => {
  const a = createWorkbenchDraftLocation("local", "a"), b = createWorkbenchDraftLocation("local", "b"), c = createWorkbenchDraftLocation("local", "c");
  const finishes: Array<(value: any) => void> = [];
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: () => new Promise(resolve => { finishes.push(resolve); }),
  } as any, { getActiveDraft: () => null } as any);
  try {
    const old = nav.selectConversation(b), current = nav.selectConversation(c);
    finishes[0]!(null);
    assert.equal(await old, false);
    assert.equal(nav.selectConversation(c), current);
    assert.equal(finishes.length, 2);
    finishes[1]!({ commit: () => true, cancel() {} });
    assert.equal(await current, true);
    assert.deepEqual(nav.getSnapshot().location, c);
  } finally { nav.dispose(); }
});

test("disposed async navigation commands reject through their Promise contract", async () => {
  const a = createWorkbenchDraftLocation("local", "a");
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {} } as any,
    { getActiveDraft: () => null } as any);
  nav.dispose();
  await assert.rejects(nav.navigate(a), /disposed/);
  await assert.rejects(nav.openChat(), /disposed/);
  await assert.rejects(nav.selectConversation(a), /disposed/);
});

test("sidebar A to B to A restores the last presented View", async () => {
  const a = createWorkbenchThreadLocation("local", "a"), b = createWorkbenchThreadLocation("local", "b");
  const activated: string[] = [];
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: async () => ({ commit: (scope: string) => { activated.push(scope); return true; }, cancel() {} }),
  } as any, { getActiveDraft: () => null } as any, { mode: "memory" });
  try {
    const original = nav.getSnapshot().routeScopeId;
    assert.equal(await nav.selectConversation(b), true);
    const bView = nav.getSnapshot().routeScopeId;
    assert.equal(await nav.selectConversation(a), true);
    assert.equal(nav.getSnapshot().routeScopeId, original);
    assert.equal(activated.at(-1), original);
    assert.equal(await nav.selectConversation(b), true);
    assert.equal(nav.getSnapshot().routeScopeId, bView);
  } finally { nav.dispose(); }
});

test("explicit open creates a separate View and sidebar remembers the successful View", async () => {
  const a = createWorkbenchThreadLocation("local", "a"), b = createWorkbenchThreadLocation("local", "b");
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: async () => ({ commit: () => true, cancel() {} }),
  } as any, { getActiveDraft: () => null } as any, { mode: "memory" });
  try {
    const original = nav.getSnapshot().routeScopeId;
    assert.equal(await nav.navigate(a), true);
    const second = nav.getSnapshot().routeScopeId;
    assert.notEqual(second, original);
    await nav.selectConversation(b);
    await nav.selectConversation(a);
    assert.equal(nav.getSnapshot().routeScopeId, second);
  } finally { nav.dispose(); }
});

test("successful POP restores its own View and makes that View the sidebar preference", async () => {
  const a = createWorkbenchThreadLocation("local", "a"), b = createWorkbenchThreadLocation("local", "b");
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: async () => ({ commit: () => true, cancel() {} }),
  } as any, { getActiveDraft: () => null } as any, { mode: "memory" });
  try {
    const original = nav.getSnapshot().routeScopeId;
    await nav.navigate(a);
    const second = nav.getSnapshot().routeScopeId;
    await nav.selectConversation(b);
    nav.back(); await settle();
    assert.equal(nav.getSnapshot().routeScopeId, second);
    nav.back(); await settle();
    assert.equal(nav.getSnapshot().routeScopeId, original);
    await nav.selectConversation(b);
    await nav.selectConversation(a);
    assert.equal(nav.getSnapshot().routeScopeId, original);
  } finally { nav.dispose(); }
});

test("failed and superseded explicit opens cannot overwrite a presented View preference", async () => {
  const a = createWorkbenchThreadLocation("local", "a"), b = createWorkbenchThreadLocation("local", "b");
  let mode: "success" | "reject" | "late" = "success", finish!: (value: any) => void, cancelled = 0;
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: () => mode === "late" ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ commit: () => mode !== "reject", cancel() { cancelled++; } }),
  } as any, { getActiveDraft: () => null } as any, { mode: "memory" });
  try {
    const original = nav.getSnapshot().routeScopeId;
    await nav.selectConversation(b);
    mode = "reject";
    assert.equal(await nav.navigate(a), false);
    mode = "late";
    const late = nav.navigate(a);
    nav.openSettings();
    finish({ commit() { throw new Error("superseded open committed"); }, cancel() { cancelled++; } });
    assert.equal(await late, false);
    mode = "success";
    await nav.selectConversation(a);
    assert.equal(nav.getSnapshot().routeScopeId, original);
    assert.equal(cancelled, 2);
  } finally { nav.dispose(); }
});

test("preferred View identity includes Host even when Thread IDs match", async () => {
  const a = createWorkbenchThreadLocation("host-a", "same"), b = createWorkbenchThreadLocation("host-b", "same");
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: async () => ({ commit: () => true, cancel() {} }),
  } as any, { getActiveDraft: () => null } as any, { mode: "memory" });
  try {
    const original = nav.getSnapshot().routeScopeId;
    await nav.selectConversation(b);
    const otherHost = nav.getSnapshot().routeScopeId;
    assert.notEqual(otherHost, original);
    await nav.selectConversation(a);
    assert.equal(nav.getSnapshot().routeScopeId, original);
    await nav.selectConversation(b);
    assert.equal(nav.getSnapshot().routeScopeId, otherHost);
  } finally { nav.dispose(); }
});

test("promotion aliases share the latest successfully presented canonical Thread View", async () => {
  const draft = createWorkbenchDraftLocation("local", "draft"), a = createWorkbenchThreadLocation("local", "a"),
    b = createWorkbenchThreadLocation("local", "b");
  const nav = createWorkbenchNavigationTransaction(draft, { setViewId() {}, cancelPending() {},
    prepare: async () => ({ commit: () => true, cancel() {} }),
    preparePromotion: async () => ({ location: a, commit: () => true, cancel() {} }),
  } as any, { getActiveDraft: () => null } as any, { mode: "memory" });
  try {
    const promotedView = nav.getSnapshot().routeScopeId;
    assert.deepEqual(await nav.promoteDraft("draft", {} as any), a);
    await nav.selectConversation(b);
    await nav.selectConversation(draft);
    assert.deepEqual(nav.getSnapshot().location, a);
    assert.equal(nav.getSnapshot().routeScopeId, promotedView);
    await nav.navigate(a);
    const second = nav.getSnapshot().routeScopeId;
    await nav.selectConversation(b);
    await nav.selectConversation(draft);
    assert.deepEqual(nav.getSnapshot().location, a);
    assert.equal(nav.getSnapshot().routeScopeId, second);
  } finally { nav.dispose(); }
});

test("owner eviction and retained-View validation revoke preferred slots", async () => {
  const a = createWorkbenchThreadLocation("local", "a"), b = createWorkbenchThreadLocation("local", "b");
  const invalid = new Set<string>();
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: async () => ({ commit: () => true, cancel() {} }),
  } as any, { getActiveDraft: () => null } as any, {
    mode: "memory", isRetainedView: (_location, viewId) => !invalid.has(viewId),
  });
  try {
    const original = nav.getSnapshot().routeScopeId;
    await nav.selectConversation(b);
    invalid.add(original);
    await nav.selectConversation(a);
    const restored = nav.getSnapshot().routeScopeId;
    assert.notEqual(restored, original);
    await nav.selectConversation(b);
    nav.forgetView(restored);
    await nav.selectConversation(a);
    assert.notEqual(nav.getSnapshot().routeScopeId, restored);
  } finally { nav.dispose(); }
});

test("preferred history remains bounded independently of Router entries", async () => {
  const a = createWorkbenchThreadLocation("local", "a"), b = createWorkbenchThreadLocation("local", "b"),
    c = createWorkbenchThreadLocation("local", "c");
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: async () => ({ commit: () => true, cancel() {} }),
  } as any, { getActiveDraft: () => null } as any, { mode: "memory", maxPreferredViews: 2 });
  try {
    const original = nav.getSnapshot().routeScopeId;
    await nav.selectConversation(b);
    await nav.selectConversation(c);
    await nav.selectConversation(a);
    assert.notEqual(nav.getSnapshot().routeScopeId, original);
  } finally { nav.dispose(); }
});

test("recycled empty Views cannot evict a preferred View whose draft owner remains retained", async () => {
  const a = createWorkbenchThreadLocation("local", "a"), b = createWorkbenchThreadLocation("local", "b"),
    c = createWorkbenchThreadLocation("local", "c");
  const recycled = new Set<string>();
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: async () => ({ commit: () => true, cancel() {} }),
  } as any, { getActiveDraft: () => null } as any, {
    mode: "memory", maxPreferredViews: 2, isRetainedView: (_location, viewId) => !recycled.has(viewId),
  });
  try {
    const original = nav.getSnapshot().routeScopeId;
    await nav.selectConversation(b);
    recycled.add(nav.getSnapshot().routeScopeId);
    await nav.selectConversation(c);
    await nav.selectConversation(a);
    assert.equal(nav.getSnapshot().routeScopeId, original);
  } finally { nav.dispose(); }
});

test("account reset clears preferences and fences pending presentation", async () => {
  const a = createWorkbenchThreadLocation("local", "a"), b = createWorkbenchThreadLocation("local", "b");
  let finish!: (value: any) => void, late = false, cancelled = 0;
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: () => late ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ commit: () => true, cancel() {} }),
  } as any, { getActiveDraft: () => null } as any, { mode: "memory" });
  try {
    const original = nav.getSnapshot().routeScopeId;
    await nav.selectConversation(b);
    late = true;
    const pending = nav.navigate(a);
    nav.clearPreferredViews();
    finish({ commit() { throw new Error("previous account committed"); }, cancel() { cancelled++; } });
    assert.equal(await pending, false);
    assert.equal(cancelled, 1);
    late = false;
    await nav.selectConversation(a);
    assert.notEqual(nav.getSnapshot().routeScopeId, original);
  } finally { nav.dispose(); }
});

test("account reset rolls back an unaccepted POP before releasing its late activation", async () => {
  const a = createWorkbenchThreadLocation("local", "a"), b = createWorkbenchThreadLocation("local", "b"),
    c = createWorkbenchThreadLocation("local", "c");
  let finish!: (value: any) => void, late = false, cancelled = 0;
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {},
    prepare: () => late ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ commit: () => true, cancel() {} }),
  } as any, { getActiveDraft: () => null } as any, { mode: "memory" });
  try {
    await nav.selectConversation(b);
    const bView = nav.getSnapshot().routeScopeId;
    late = true;
    nav.back(); await settle();
    assert.deepEqual(nav.getSnapshot().location, b, "unaccepted POP has not published its target");
    nav.clearPreferredViews(); await settle();
    finish({ commit() { throw new Error("previous account POP committed"); }, cancel() { cancelled++; } });
    await settle();
    assert.equal(cancelled, 1);
    assert.deepEqual(nav.getSnapshot().location, b);
    assert.equal(nav.getSnapshot().routeScopeId, bView);
    assert.equal(nav.getSnapshot().canGoBack, true);
    assert.equal(nav.getSnapshot().canGoForward, false);
    late = false;
    await nav.selectConversation(c);
    await nav.selectConversation(b);
    assert.notEqual(nav.getSnapshot().routeScopeId, bView, "rollback cannot reintroduce account-cleared preferences");
  } finally { nav.dispose(); }
});

test("legacy website locations normalize on initial entry and real POP/forward", async () => {
  const nav = createApplicationNavigation(createWorkbenchDraftLocation("local", "new"), {
    mode: "memory", initialEntries: ["/?hostId=hypernode&draftId=old", "/settings/appearance"],
    resolveLocation: resolveLegacyWebsiteLocation,
  });
  try {
    nav.back(); await settle();
    assert.deepEqual(nav.getSnapshot().location, createWorkbenchDraftLocation("local", "old"));
    nav.forward(); await settle();
    assert.equal(nav.getSnapshot().applicationRoute.kind, "settings");
    nav.back(); await settle();
    assert.deepEqual(nav.getSnapshot().location, createWorkbenchDraftLocation("local", "old"));
  } finally { nav.dispose(); }
});
