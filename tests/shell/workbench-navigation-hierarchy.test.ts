import assert from "node:assert/strict";
import test from "node:test";
import {
  createApplicationNavigation,
  type ApplicationRoute,
} from "../../apps/workbench-web/src/runtime/workbench-navigation";
import { createWorkbenchThreadLocation } from "../../packages/workbench-runtime/src/workbench-location";
const inbox: ApplicationRoute = { kind: "extension-view", viewId: "im.inbox", resourceUri: null };
const parents = (route: ApplicationRoute) =>
  route.kind === "extension-view" && route.viewId === "im.chat" ? inbox : null;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ids = (nav: ReturnType<typeof createApplicationNavigation>) =>
  nav.getSnapshot().navigationPath?.map((page) => page.route);

test("Inbox child and sibling navigation returns to the exact parent; forward keeps the path", async () => {
  const nav = createApplicationNavigation(createWorkbenchThreadLocation("host", "thread"), {
    mode: "memory",
    resolveParentRoute: parents,
  });
  try {
    nav.openExtensionView("im.inbox");
    const parentScope = nav.getSnapshot().routeScopeId;
    nav.openExtensionView("im.chat", "group-a");
    assert.equal(nav.getSnapshot().canReturn, true);
    nav.openExtensionView("im.chat", "group-b");
    assert.equal(ids(nav)?.length, 2, "siblings replace semantic descendants");
    nav.returnToParent();
    await tick();
    assert.deepEqual(nav.getSnapshot().applicationRoute, inbox);
    assert.equal(nav.getSnapshot().routeScopeId, parentScope);
    assert.equal(nav.getSnapshot().canReturn, false);
    nav.forward();
    await tick();
    assert.equal(nav.getSnapshot().url, "/views/im.chat?resource=group-a");
    assert.equal(nav.getSnapshot().canReturn, true);
    nav.returnToParent();
    await tick();
    nav.openSettings();
    assert.equal(nav.getSnapshot().canGoForward, false);
    assert.equal(nav.getSnapshot().canReturn, false, "history does not make a root into a child");
  } finally {
    nav.dispose();
  }
});
test("deep-linked group returns to its declared parent with REPLACE, without leaving the app", () => {
  const nav = createApplicationNavigation(null, {
    mode: "memory",
    initialEntries: ["/views/im.chat?resource=group-a"],
    resolveParentRoute: parents,
  });
  try {
    assert.equal(nav.getSnapshot().canGoBack, false);
    assert.equal(nav.getSnapshot().canReturn, true);
    nav.returnToParent();
    assert.deepEqual(nav.getSnapshot().applicationRoute, inbox);
    assert.equal(nav.getSnapshot().historyIndex, 0);
    assert.equal(nav.getSnapshot().action, "replace");
  } finally {
    nav.dispose();
  }
});
test("children opened from another surface restore the caller rather than the canonical Inbox", async () => {
  const nav = createApplicationNavigation(null, { mode: "memory", resolveParentRoute: parents });
  try {
    nav.openSettings("models");
    nav.openExtensionView("im.chat", "assistant");
    nav.returnToParent();
    await tick();
    assert.deepEqual(nav.getSnapshot().applicationRoute, { kind: "settings", slug: "models" });
  } finally {
    nav.dispose();
  }
});
test("resource depth, replacement and root switching remain Router-owned", async () => {
  const nav = createApplicationNavigation(null, { mode: "memory", resolveParentRoute: parents });
  try {
    nav.openExtensionView("im.inbox");
    nav.openExtensionView("im.chat", "group");
    nav.pushExtensionViewResource("im.chat", "details");
    assert.equal(ids(nav)?.length, 3);
    nav.replaceExtensionViewResource("im.chat", "members");
    assert.equal(ids(nav)?.length, 3);
    nav.returnToParent();
    await tick();
    assert.equal(nav.getSnapshot().url, "/views/im.chat?resource=group");
    nav.openExtensionView("another.root");
    assert.equal(nav.getSnapshot().canReturn, false);
    nav.back();
    await tick();
    assert.equal(nav.getSnapshot().canReturn, true);
  } finally {
    nav.dispose();
  }
});
test("late parent registration updates context without creating history or a new navigation revision", () => {
  let changed: () => void = () => {},
    loaded = false,
    disposed = false;
  const nav = createApplicationNavigation(null, {
    mode: "memory",
    initialEntries: ["/views/im.chat?resource=a"],
    resolveParentRoute: (r) => (loaded ? parents(r) : null),
    subscribeRouteHierarchy: (fn) => {
      changed = fn;
      return () => {
        disposed = true;
      };
    },
  });
  const before = nav.getSnapshot();
  loaded = true;
  changed();
  assert.equal(nav.getSnapshot().revision, before.revision);
  assert.equal(nav.getSnapshot().historyIndex, before.historyIndex);
  assert.equal(nav.getSnapshot().canReturn, true);
  assert.equal(nav.getSnapshot().contextOnly, true);
  nav.dispose();
  assert.equal(disposed, true);
});
test("cyclic or oversized contribution parents fail closed", () => {
  const nav = createApplicationNavigation(null, {
    mode: "memory",
    initialEntries: ["/views/a"],
    resolveParentRoute: (r) =>
      r.kind === "extension-view"
        ? { kind: "extension-view", viewId: r.viewId === "a" ? "b" : "a", resourceUri: null }
        : null,
  });
  try {
    assert.equal(nav.getSnapshot().canReturn, false);
    nav.returnToParent();
    assert.equal(nav.getSnapshot().url, "/views/a");
  } finally {
    nav.dispose();
  }
});

test("semantic return supersedes a pending conversation activation through the existing transaction", async () => {
  const { createWorkbenchNavigationTransaction } = await import(
    "../../apps/workbench-web/src/runtime/workbench-navigation-transaction"
  );
  const first = createWorkbenchThreadLocation("host", "first"),
    late = createWorkbenchThreadLocation("host", "late");
  let prepared!: (value: any) => void,
    commits = 0;
  const nav = createWorkbenchNavigationTransaction(
    first,
    {
      setViewId() {},
      cancelPending() {},
      mountRestored() {},
      prepare: () =>
        new Promise((resolve) => {
          prepared = resolve;
        }),
    } as any,
    { getActiveDraft: () => null, getActiveViewId: () => "view", getActiveKey: () => first.key } as any,
    { mode: "memory", resolveParentRoute: parents, isRetainedView: () => true },
  );
  try {
    nav.openExtensionView("im.inbox");
    nav.openExtensionView("im.chat", "group");
    const pending = nav.navigate(late);
    nav.returnToParent();
    await tick();
    prepared({
      commit: () => {
        commits++;
        return true;
      },
      cancel() {},
    });
    assert.equal(await pending, false);
    assert.equal(commits, 0);
    assert.deepEqual(nav.getSnapshot().applicationRoute, inbox);
  } finally {
    nav.dispose();
  }
});

test("semantic return reports acceptance independently of presentation completion", () => {
  const nav = createApplicationNavigation(null, { mode: "memory", resolveParentRoute: parents });
  try {
    assert.equal(nav.returnToParent(), false);
    nav.openExtensionView("im.inbox");
    nav.openExtensionView("im.chat", "group");
    assert.equal(nav.returnToParent(), true);
    assert.deepEqual(nav.getSnapshot().applicationRoute, inbox);
    assert.equal(nav.returnToParent(), false);
  } finally {
    nav.dispose();
  }
});

test("a blocked semantic return reports rejection and leaves the page owner intact", async () => {
  const { createWorkbenchNavigationTransaction } = await import(
    "../../apps/workbench-web/src/runtime/workbench-navigation-transaction"
  );
  const location = createWorkbenchThreadLocation("host", "thread");
  let blocked = false;
  const nav = createWorkbenchNavigationTransaction(
    location,
    { setViewId() {}, cancelPending() {} } as any,
    { getActiveDraft: () => (blocked ? { phase: "submitting" } : null) } as any,
    { mode: "memory", resolveParentRoute: parents },
  );
  try {
    nav.openExtensionView("im.inbox");
    nav.openExtensionView("im.chat", "group");
    const before = nav.getSnapshot();
    blocked = true;
    assert.equal(nav.returnToParent(), false);
    assert.equal(nav.getSnapshot(), before);
    blocked = false;
    assert.equal(nav.returnToParent(), true);
    await tick();
    assert.deepEqual(nav.getSnapshot().applicationRoute, inbox);
  } finally {
    nav.dispose();
  }
});
