import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import {
  computeRightPanelDefaultWidth,
  createConversationPanelState,
  getRightPanelWidthBounds,
  interpolateRightPanelWidth,
  isRightPanelResponsiveBlocked,
  normalizeRightPanelWidth,
  reduceConversationPanelState,
  RIGHT_PANEL_COLLAPSE_SHELF,
  WorkbenchPanelService,
  type PanelTabDescriptor,
} from "@opencraft/workbench-panels";

const tab = (
  id: string,
  options: Partial<PanelTabDescriptor> = {},
): PanelTabDescriptor => ({
  id,
  kind: options.kind ?? "test",
  region: options.region ?? "right",
  title: options.title ?? id,
  closable: options.closable ?? true,
  preview: options.preview ?? false,
  ...options,
});

test("right panel tabs preserve MRU activation and close behavior", () => {
  let state = createConversationPanelState({ ownerId: "thread-a" });
  state = reduceConversationPanelState(state, {
    type: "open-tab",
    tab: tab("changes"),
  });
  state = reduceConversationPanelState(state, {
    type: "open-tab",
    tab: tab("terminal"),
  });
  state = reduceConversationPanelState(state, {
    type: "activate-tab",
    region: "right",
    tabId: "changes",
  });
  state = reduceConversationPanelState(state, {
    type: "close-tab",
    region: "right",
    tabId: "changes",
  });

  assert.equal(state.right.activeTabId, "terminal");
  assert.equal(state.right.open, true);
  assert.deepEqual(state.right.recentTabIds, ["terminal"]);
});

test("a new preview replaces the prior preview without replacing durable tabs", () => {
  let state = createConversationPanelState({ ownerId: "thread-a" });
  state = reduceConversationPanelState(state, {
    type: "open-tab",
    tab: tab("changes"),
  });
  state = reduceConversationPanelState(state, {
    type: "open-tab",
    tab: tab("resource:a", { kind: "resource", preview: true }),
  });
  state = reduceConversationPanelState(state, {
    type: "open-tab",
    tab: tab("resource:b", { kind: "resource", preview: true }),
  });

  assert.deepEqual(
    state.right.tabs.map((candidate) => candidate.id),
    ["changes", "resource:b"],
  );
  assert.equal(state.right.activeTabId, "resource:b");
});

test("passive preview replacement never leaves a dangling active tab", () => {
  let state = createConversationPanelState({ ownerId: "thread-a" });
  state = reduceConversationPanelState(state, {
    type: "open-tab",
    tab: tab("resource:a", { preview: true }),
  });
  state = reduceConversationPanelState(state, {
    type: "open-tab",
    tab: tab("resource:b", { preview: true }),
    activate: false,
  });
  assert.equal(state.right.activeTabId, "resource:b");
  assert.deepEqual(state.right.recentTabIds, ["resource:b"]);
});

test("tabs reorder without changing active identity", () => {
  let state = createConversationPanelState({ ownerId: "thread-a" });
  for (const id of ["one", "two", "three"]) {
    state = reduceConversationPanelState(state, { type: "open-tab", tab: tab(id) });
  }
  state = reduceConversationPanelState(state, {
    type: "move-tab",
    region: "right",
    tabId: "three",
    beforeTabId: "one",
  });

  assert.deepEqual(
    state.right.tabs.map((candidate) => candidate.id),
    ["three", "one", "two"],
  );
  assert.equal(state.right.activeTabId, "three");
});

test("a panel runtime can update tab presentation without replacing identity", () => {
  let state = createConversationPanelState({ ownerId: "thread-a" });
  state = reduceConversationPanelState(state, {
    type: "open-tab",
    tab: tab("browser:one", {
      kind: "browser",
      icon: "browser",
      resource: "session-one",
      title: "New tab",
    }),
  });
  const revision = state.revision;
  state = reduceConversationPanelState(state, {
    type: "update-tab",
    region: "right",
    tabId: "browser:one",
    patch: { title: "example.com" },
  });

  assert.equal(state.right.tabs[0]?.id, "browser:one");
  assert.equal(state.right.tabs[0]?.resource, "session-one");
  assert.equal(state.right.tabs[0]?.title, "example.com");
  assert.equal(state.right.activeTabId, "browser:one");
  assert.equal(state.revision, revision + 1);
});

test("responsive suppression is Window-owned and never mutates Conversation panel state", () => {
  const open = createConversationPanelState({
    ownerId: "open",
    initialTabs: [tab("changes")],
    rightPanelOpen: true,
  });
  assert.equal(open.right.open, true);
  assert.equal(isRightPanelResponsiveBlocked({ viewportWidth: 700, sidebarOpen: false }), true);
  assert.equal(open.right.open, true, "viewport policy cannot rewrite Conversation state");
});

test("an open empty outlet can maximize and restore without manufacturing a tab", () => {
  let state = createConversationPanelState({ ownerId: "empty" });
  state = reduceConversationPanelState(state, { type: "set-region-open", region: "right", open: true, reason: "manual", allowEmpty: true });
  state = reduceConversationPanelState(state, { type: "toggle-right-full-width" });
  assert.equal(state.rightPanelFullWidth, true);
  assert.equal(state.right.open, true);
  assert.equal(state.right.tabs.length, 0);
  state = reduceConversationPanelState(state, { type: "toggle-right-full-width" });
  assert.equal(state.rightPanelFullWidth, false);
  assert.equal(state.right.open, true);
  state = reduceConversationPanelState(state, { type: "toggle-right-full-width" });
  state = reduceConversationPanelState(state, { type: "set-region-open", region: "right", open: false, reason: "manual" });
  assert.equal(state.rightPanelFullWidth, false);
});

test("closing the last tab preserves the outlet and its width for the launcher", () => {
  let state = createConversationPanelState({
    ownerId: "thread-a",
    initialTabs: [tab("changes")],
    rightPanelOpen: true,
  });
  state = reduceConversationPanelState(state, { type: "toggle-right-full-width" });
  state = reduceConversationPanelState(state, {
    type: "close-tab",
    region: "right",
    tabId: "changes",
  });
  assert.equal(state.right.open, true);
  assert.equal(state.rightPanelFullWidth, true);
  assert.equal(state.right.activeTabId, null);
  assert.equal(state.right.tabs.length, 0);
});

test("Workbench may reveal an empty right-panel outlet without inventing a tab", () => {
  const initial = createConversationPanelState({ ownerId: "thread-empty-panel" });
  const opened = reduceConversationPanelState(initial, {
    type: "set-region-open",
    region: "right",
    open: true,
    reason: "manual",
    allowEmpty: true,
  });

  assert.equal(opened.right.open, true);
  assert.deepEqual(opened.right.tabs, []);

  const closed = reduceConversationPanelState(opened, {
    type: "set-region-open",
    region: "right",
    open: false,
    reason: "manual",
  });
  assert.equal(closed.right.open, false);
});

test("Right panel geometry retains content reserve and magnetic shelf", () => {
  assert.deepEqual(getRightPanelWidthBounds(1_440), {
    minimum: 320,
    maximum: 1_088,
  });
  assert.equal(
    computeRightPanelDefaultWidth({
      mainContentWidth: 1_440,
      shellHeight: 960,
    }),
    940,
  );
  assert.equal(computeRightPanelDefaultWidth({ mainContentWidth: 1_440, shellHeight: 960, size: "compact" }), 940 * 2 / 3);
  assert.equal(computeRightPanelDefaultWidth({ mainContentWidth: 700, shellHeight: 600, size: "compact" }), 320);
  assert.equal(RIGHT_PANEL_COLLAPSE_SHELF, 160);
  // The pointer has a 160px magnetic travel corridor: drag geometry can fall
  // below the visible minimum while the rendered panel and its chrome remain
  // pinned at 320px. Only crossing the 160px shelf closes it.
  const shelfRatio = normalizeRightPanelWidth(240, 1_440);
  assert.equal(shelfRatio, 0);
  assert.equal(interpolateRightPanelWidth(shelfRatio, 1_440), 320);
  assert.equal(
    isRightPanelResponsiveBlocked({ viewportWidth: 720, sidebarOpen: false }),
    true,
  );
  assert.equal(
    isRightPanelResponsiveBlocked({ viewportWidth: 900, sidebarOpen: true }),
    true,
  );
  assert.equal(
    isRightPanelResponsiveBlocked({ viewportWidth: 900, sidebarOpen: false }),
    false,
  );
});

test("Cordis panel service keeps independent Conversation Scope projections", async () => {
  const context = new Context();
  const fiber = context.plugin(WorkbenchPanelService, {
    defaultRightPanelOpen: true,
  });
  await fiber;
  const unregister = context.workbenchPanels.register({
    kind: "changes",
    initialTab: { order: 0, params: {} },
    createTab: () => tab("changes", { kind: "changes" }),
  });

  const first = context.workbenchPanels.ensureOwner("view-a");
  const second = context.workbenchPanels.ensureOwner("view-b");
  assert.equal(first.right.open, true);
  assert.equal(second.right.open, true);

  context.workbenchPanels.dispatch("view-a", {
    type: "set-region-open",
    region: "right",
    open: false,
    reason: "manual",
  });
  assert.equal(
    context.workbenchPanels.getOwnerSnapshot("view-a").right.open,
    false,
  );
  assert.equal(
    context.workbenchPanels.getOwnerSnapshot("view-b").right.open,
    true,
  );

  unregister();
  await fiber.dispose();
});

test("panel toolbar actions are plugin-owned, ordered contributions", async () => {
  const context = new Context();
  const fiber = context.plugin(WorkbenchPanelService);
  await fiber;
  const calls: string[] = [];
  const removeSecond = context.workbenchPanels.registerToolbarAction({
    id: "test.second",
    region: "right",
    order: 20,
    label: "Second",
    icon: "test",
    run: ({ hostId }) => calls.push(`second:${hostId}`),
  });
  const removeFirst = context.workbenchPanels.registerToolbarAction({
    id: "test.first",
    region: "right",
    order: 10,
    label: "First",
    icon: "test",
    run: ({ hostId }) => calls.push(`first:${hostId}`),
  });

  assert.deepEqual(
    context.workbenchPanels.getToolbarActionSnapshot().map((action) => action.id),
    ["test.first", "test.second"],
  );
  await context.workbenchPanels.getToolbarActionSnapshot()[0]?.run({
    ownerId: "view-a",
    resourceOwnerId: "scope-a",
    hostId: "host-a",
    cwd: "/workspace/a",
  });
  assert.deepEqual(calls, ["first:host-a"]);

  removeFirst();
  removeSecond();
  assert.deepEqual(context.workbenchPanels.getToolbarActionSnapshot(), []);
  await fiber.dispose();
});

test("logical panel state remains attached to one stable Conversation Scope", async () => {
  const context = new Context();
  const fiber = context.plugin(WorkbenchPanelService);
  await fiber;
  const unregister = context.workbenchPanels.register({
    kind: "browser",
    createTab: () => tab("browser:one", { kind: "browser" }),
  });

  const viewId = "client-new-thread:one";
  context.workbenchPanels.open(viewId, "browser", {});
  const state = context.workbenchPanels.dispatch(viewId, {
    type: "toggle-right-full-width",
  });
  assert.equal(state.ownerId, viewId);
  assert.equal(state.right.activeTabId, "browser:one");
  assert.equal(state.rightPanelFullWidth, true);
  assert.equal(context.workbenchPanels.getOwnerSnapshot(viewId), state);

  unregister();
  await fiber.dispose();
});

test("the logical panel service, not React, disposes tab resources", async () => {
  const context = new Context();
  const fiber = context.plugin(WorkbenchPanelService);
  await fiber;
  const disposed: string[] = [];
  const reasons: string[] = [];
  const unregister = context.workbenchPanels.register({
    kind: "owned",
    createTab: ({ id }: { readonly id: string }) => tab(id, { kind: "owned" }),
    disposeTab: (ownedTab, _viewId, reason) => {
      disposed.push(ownedTab.id);
      reasons.push(reason);
    },
  });

  context.workbenchPanels.open("scope-a", "owned", { id: "explicit-close" });
  context.workbenchPanels.close("scope-a", "right", "explicit-close");
  context.workbenchPanels.open("scope-b", "owned", { id: "owner-release" });
  context.workbenchPanels.releaseOwner("scope-b");
  context.workbenchPanels.register({
    kind: "preview-owned",
    createTab: ({ id }: { readonly id: string }) => tab(id, {
      kind: "preview-owned",
      preview: true,
    }),
    disposeTab: (ownedTab, _viewId, reason) => {
      disposed.push(ownedTab.id);
      reasons.push(reason);
    },
  });
  context.workbenchPanels.open("scope-c", "preview-owned", { id: "preview-old" });
  context.workbenchPanels.open("scope-c", "preview-owned", { id: "preview-new" });
  assert.deepEqual(disposed, ["explicit-close", "owner-release", "preview-old"]);
  assert.deepEqual(reasons, ["close", "owner-release", "replace"]);

  unregister();
  await fiber.dispose();
});

test("unregistering a panel kind disposes even non-closable logical resources", async () => {
  const context = new Context();
  const fiber = context.plugin(WorkbenchPanelService);
  await fiber;
  const disposed: string[] = [];
  const unregister = context.workbenchPanels.register({
    kind: "non-closable-owned",
    createTab: () => tab("non-closable", {
      kind: "non-closable-owned",
      closable: false,
      resource: "resource-one",
    }),
    disposeTab: (ownedTab) => disposed.push(ownedTab.resource ?? "missing"),
  });
  context.workbenchPanels.open("scope-owned", "non-closable-owned", {});
  unregister();
  assert.deepEqual(disposed, ["resource-one"]);
  assert.deepEqual(
    context.workbenchPanels.getOwnerSnapshot("scope-owned").right.tabs,
    [],
  );
  await fiber.dispose();
});

test("a stable panel tab ID cannot silently replace its resource identity", async () => {
  const context = new Context();
  const fiber = context.plugin(WorkbenchPanelService);
  await fiber;
  const unregister = context.workbenchPanels.register({
    kind: "identity",
    createTab: ({ resource }: { readonly resource: string }) => tab("stable-tab", {
      kind: "identity",
      resource,
      durableRoute: { resource },
    }),
  });
  context.workbenchPanels.open("scope-identity", "identity", { resource: "first" });
  assert.throws(
    () => context.workbenchPanels.open("scope-identity", "identity", { resource: "second" }),
    /cannot replace its logical resource identity/u,
  );
  assert.equal(
    context.workbenchPanels.getOwnerSnapshot("scope-identity").right.tabs[0]?.resource,
    "first",
  );
  unregister();
  await fiber.dispose();
});
