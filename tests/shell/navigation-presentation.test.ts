import assert from "node:assert/strict";
import test from "node:test";
import { createWorkbenchNavigationTransaction } from "../../apps/workbench-web/src/runtime/workbench-navigation-transaction";
import { createWorkbenchThreadLocation } from "../../packages/workbench-runtime/src/index";
const a = createWorkbenchThreadLocation("local", "a"),
  b = createWorkbenchThreadLocation("local", "b"),
  c = createWorkbenchThreadLocation("local", "c");
const scopes = { getActiveDraft: () => null } as any;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("returning to the conversation list preserves allocation only for that navigation intent", async () => {
  const nav = createWorkbenchNavigationTransaction(
    a,
    {
      setViewId() {},
      cancelPending() {},
      mountRestored() {},
      prepare: async () => ({ commit: () => true, cancel() {} }),
    } as any,
    scopes,
    { mode: "memory", isRetainedView: () => true },
  );
  try {
    const original = nav.getSnapshot();
    nav.openSettings("appearance");
    assert.equal(await nav.openChat({ sidebar: "preserve" }), true);
    assert.deepEqual(nav.getSnapshot().location, a);
    assert.equal(nav.getSnapshot().routeScopeId, original.routeScopeId, "return reuses the remembered input/View");
    assert.equal(nav.getTransition()?.sidebar, "preserve");
    await nav.selectConversation(b);
    assert.equal(nav.getTransition()?.sidebar, undefined, "a later selection has its own dismissal intent");
    nav.back();
    await tick();
    assert.deepEqual(nav.getSnapshot().location, a);
    assert.equal(nav.getTransition()?.sidebar, undefined, "POP does not inherit a previous return policy");
  } finally {
    nav.dispose();
  }
});

test("an explicit selection supersedes a pending list return, even for the same View", async () => {
  const departures = new Map<number, () => void>();
  const nav = createWorkbenchNavigationTransaction(
    a,
    { setViewId() {}, cancelPending() {}, prepare: async () => ({ commit: () => true, cancel() {} }) } as any,
    scopes,
    { mode: "memory" },
  );
  try {
    nav.openSettings();
    nav.attachDeparture((id) => new Promise((resolve) => departures.set(id, resolve)));
    const returning = nav.openChat({ sidebar: "preserve" }),
      returnId = nav.getTransition()!.id;
    const selecting = nav.selectConversation(a),
      selectionId = nav.getTransition()!.id;
    assert.notEqual(returnId, selectionId);
    assert.equal(nav.getTransition()?.sidebar, undefined);
    departures.get(returnId)!();
    assert.equal(await returning, false);
    departures.get(selectionId)!();
    assert.equal(await selecting, true);
    assert.equal(nav.getSnapshot().applicationRoute.kind, "conversation");
  } finally {
    nav.dispose();
  }
});

test("cold remembered View restoration carries the same list return policy", async () => {
  let prepared!: (value: any) => void;
  const nav = createWorkbenchNavigationTransaction(
    a,
    {
      setViewId() {},
      cancelPending() {},
      mountRestored() {},
      prepare: () => new Promise((resolve) => (prepared = resolve)),
    } as any,
    scopes,
    { mode: "memory", isRetainedView: () => false },
  );
  try {
    // A POP entry can remember a View whose actual active owner is another conversation.
    const first = nav.navigate(b);
    prepared({ commit: () => true, cancel() {} });
    await first;
    nav.openSettings();
    // Use a true router POP; then supersede its pending cold restore with the explicit return.
    nav.back();
    await tick();
    nav.back();
    await tick();
    const returning = nav.openChat({ sidebar: "preserve" });
    assert.equal(nav.getTransition()?.sidebar, "preserve");
    prepared({ commit: () => true, cancel() {} });
    assert.equal(await returning, true);
    assert.equal(nav.getTransition()?.sidebar, "preserve");
  } finally {
    nav.dispose();
  }
});

test("activation starts alongside departure; only a matching target paint reveals a committed view", async () => {
  let departed!: () => void, ready!: (v: any) => void;
  let prepareCalls = 0,
    targetPrepared = false;
  const nav = createWorkbenchNavigationTransaction(
    a,
    {
      setViewId() {},
      cancelPending() {},
      prepare() {
        prepareCalls++;
        return new Promise((resolve) => (ready = resolve));
      },
    } as any,
    scopes,
    { mode: "memory" },
  );
  const detach = nav.attachDeparture((_id, prepared) => {
    void prepared.then(() => (targetPrepared = true));
    return new Promise((resolve) => (departed = resolve));
  });
  try {
    const selecting = nav.selectConversation(b);
    assert.equal(prepareCalls, 1, "preparation is not delayed by visual departure");
    const id = nav.getTransition()!.id;
    await tick();
    assert.equal(targetPrepared, false, "old content remains until target preparation completes");
    ready({ commit: () => true, cancel() {} });
    await tick();
    assert.equal(targetPrepared, true, "prepared target authorizes the final fade before commit");
    assert.deepEqual(nav.getSnapshot().location, a, "ready data cannot replace partially visible old content");
    departed();
    assert.equal(await selecting, true);
    assert.equal(nav.getTransition()!.phase, "committed");
    assert.equal(nav.getPendingLocation(), null);
    nav.acknowledgePresented(id, "wrong-view");
    assert.equal(nav.getTransition()!.phase, "committed");
    nav.acknowledgePresented(id + 1, nav.getSnapshot().routeScopeId);
    assert.equal(nav.getTransition()!.phase, "committed");
    nav.acknowledgePresented(id, nav.getSnapshot().routeScopeId);
    assert.equal(nav.getTransition()!.phase, "presented");
  } finally {
    detach();
    nav.dispose();
  }
});

test("local lookup failure has an explicit current outcome and retains the previous route", async () => {
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {} } as any, scopes, {
    mode: "memory",
    restoreViewId: async () => {
      throw Error("fixture lookup failed");
    },
  });
  try {
    await assert.rejects(nav.selectConversation(b));
    assert.equal(nav.getTransition()!.phase, "failed");
    assert.deepEqual(nav.getTransition()!.location, b);
    assert.deepEqual(nav.getSnapshot().location, a);
    assert.equal(nav.getPendingLocation(), null);
  } finally {
    nav.dispose();
  }
});

test("retained history traversal uses local presentation and backgrounds activation", async () => {
  let hold = false,
    mounts = 0,
    depart!: () => void;
  const nav = createWorkbenchNavigationTransaction(
    a,
    {
      setViewId() {},
      cancelPending() {},
      mountRestored() {
        mounts++;
      },
      prepare: () => (hold ? new Promise(() => {}) : Promise.resolve({ commit: () => true, cancel() {} })),
    } as any,
    scopes,
    { mode: "memory", isRetainedView: () => true },
  );
  try {
    await nav.selectConversation(b);
    const viewB = nav.getSnapshot().routeScopeId;
    hold = true;
    nav.attachDeparture(() => new Promise((resolve) => (depart = resolve)));
    nav.back();
    await tick();
    assert.deepEqual(nav.getPendingLocation(), a);
    assert.deepEqual(nav.getSnapshot().location, b);
    depart();
    await tick();
    assert.deepEqual(nav.getSnapshot().location, a);
    assert.equal(mounts, 1);
    assert.equal(nav.getTransition()!.phase, "committed");
    nav.forward();
    await tick();
    depart();
    await tick();
    assert.deepEqual(nav.getSnapshot().location, b);
    assert.equal(nav.getSnapshot().routeScopeId, viewB);
    assert.equal(mounts, 2);
  } finally {
    nav.dispose();
  }
});

test("superseded departure and late lookup cannot replace or finish the newer attempt", async () => {
  const gates = new Map<number, () => void>(),
    reads = new Map<string, (id: any) => void>();
  const nav = createWorkbenchNavigationTransaction(
    a,
    { setViewId() {}, cancelPending() {}, mountRestored() {}, prepare: () => new Promise(() => {}) } as any,
    scopes,
    { mode: "memory", restoreViewId: (l) => new Promise((resolve) => reads.set((l as any).key.threadId, resolve)) },
  );
  nav.attachDeparture((id) => new Promise((resolve) => gates.set(id, resolve)));
  try {
    const first = nav.selectConversation(b);
    const old = nav.getTransition()!.id;
    await tick();
    const latest = nav.selectConversation(c);
    const current = nav.getTransition()!.id;
    await tick();
    reads.get("b")!("b-view");
    gates.get(old)!();
    assert.equal(await first, false);
    assert.equal(nav.getTransition()!.id, current);
    reads.get("c")!("c-view");
    gates.get(current)!();
    assert.equal(await latest, true);
    assert.deepEqual(nav.getSnapshot().location, c);
    nav.acknowledgePresented(old, "b-view");
    assert.equal(nav.getTransition()!.phase, "committed");
  } finally {
    nav.dispose();
  }
});

test("a synchronous retry from a failure subscriber keeps the newer pending projection", async () => {
  const reads = new Map<string, { resolve: (id: any) => void; reject: (error: Error) => void }>();
  const nav = createWorkbenchNavigationTransaction(
    a,
    { setViewId() {}, cancelPending() {}, mountRestored() {}, prepare: () => new Promise(() => {}) } as any,
    scopes,
    {
      mode: "memory",
      restoreViewId: (l) => new Promise((resolve, reject) => reads.set((l as any).key.threadId, { resolve, reject })),
    },
  );
  let latest: Promise<boolean> | undefined;
  nav.subscribeTransition(() => {
    if (nav.getTransition()?.phase === "failed") latest = nav.selectConversation(c);
  });
  try {
    const old = nav.selectConversation(b);
    await tick();
    reads.get("b")!.reject(Error("failed"));
    await assert.rejects(old);
    assert.deepEqual(nav.getPendingLocation(), c);
    assert.equal(nav.getTransition()!.phase, "preparing");
    await tick();
    reads.get("c")!.resolve("c-view");
    assert.equal(await latest, true);
  } finally {
    nav.dispose();
  }
});

test("detaching a presentation owner releases its departure gate", async () => {
  const nav = createWorkbenchNavigationTransaction(
    a,
    { setViewId() {}, cancelPending() {}, prepare: async () => ({ commit: () => true, cancel() {} }) } as any,
    scopes,
    { mode: "memory" },
  );
  try {
    const detach = nav.attachDeparture(() => new Promise(() => {}));
    const selecting = nav.selectConversation(b);
    await tick();
    assert.deepEqual(nav.getSnapshot().location, a);
    detach();
    assert.equal(await selecting, true);
    assert.deepEqual(nav.getSnapshot().location, b);
  } finally {
    nav.dispose();
  }
});

test("repeated selection of the same retained view shares its departure transaction", async () => {
  let depart!: () => void,
    calls = 0;
  const nav = createWorkbenchNavigationTransaction(
    a,
    {
      setViewId() {},
      cancelPending() {},
      mountRestored() {},
      prepare: async () => ({ commit: () => true, cancel() {} }),
    } as any,
    scopes,
    { mode: "memory", isRetainedView: () => true },
  );
  try {
    await nav.selectConversation(b);
    await nav.selectConversation(a);
    nav.attachDeparture(() => {
      calls++;
      return new Promise((resolve) => (depart = resolve));
    });
    const first = nav.selectConversation(b),
      second = nav.selectConversation(b);
    assert.equal(first, second);
    assert.equal(calls, 1);
    depart();
    assert.equal(await first, true);
  } finally {
    nav.dispose();
  }
});
