import assert from "node:assert/strict";
import test from "node:test";
import { threadServerOrigin } from "@opencraft/workbench-runtime";

import {
  groupThreadsByActivityDate,
  groupThreadsByTaskFlow,
  sidebarActivityMetadata,
  sidebarActivityDateHeadings,
  type SidebarActivityThread,
} from "../../apps/workbench-web/src/sidebar-activity";
import {
  SidebarThreadMenuStore,
  isSidebarThreadMenuOpen,
  updateOpenSidebarThreadMenu,
} from "../../apps/workbench-web/src/components/sidebar-thread-menu-state";

const seconds = (value: Date) => value.getTime() / 1_000;

function thread(
  id: string,
  updatedAt: Date,
  overrides: Partial<SidebarActivityThread> = {},
): SidebarActivityThread {
  return {
    id,
    serverOrigin: threadServerOrigin({ serverId: "local-server", label: "Local" }),
    project: "opencraft",
    updatedAt: seconds(updatedAt),
    ...overrides,
  };
}

test("Activity chronology owns sections while equal thread ids retain Server provenance", () => {
  const now = new Date(2026, 8, 21, 12);
  const input = [
    thread("same", new Date(2026, 8, 20, 18), {
      serverOrigin: threadServerOrigin({ serverId: "remote-server", label: "Hermes" }),
    }),
    thread("same", new Date(2026, 8, 21, 9)),
    thread("older", new Date(2026, 8, 19, 16)),
  ];
  const groups = groupThreadsByActivityDate(input, now.getTime(), "en-US");

  assert.deepEqual(groups.map(group => group.label), ["Today", "Yesterday", "Saturday"]);
  assert.deepEqual(groups.flatMap(group => group.threads.map(item => `${item.serverOrigin.serverId}:${item.id}`)), [
    "local-server:same",
    "remote-server:same",
    "local-server:older",
  ]);
});

test("Activity metadata owns project copy while serverOrigin retains Server provenance", () => {
  const local = thread("local", new Date(2026, 8, 21, 9));
  assert.deepEqual(sidebarActivityMetadata(local), { project: "opencraft" });
  assert.deepEqual(sidebarActivityMetadata({
    ...local,
    serverOrigin: threadServerOrigin({
      serverId: "server:9.134.163.40",
      label: "9.134.163.40",
    }),
    project: "V8",
  }), { project: "V8" });
});

test("Server origin identity is independent from mutable label, Hub route and activity state", () => {
  const first = threadServerOrigin({ serverId: "fixture-hermes-cloud", label: "Hermes Cloud" });
  const renamed = threadServerOrigin({ serverId: "fixture-hermes-cloud", label: "Hermes" });
  assert.equal(first.serverId, renamed.serverId);
  assert.notEqual(first.serverId, threadServerOrigin({ serverId: "other-server", label: "Hermes" }).serverId);
  assert.throws(() => threadServerOrigin({ serverId: " ", label: "Local" }), /Server ID/u);
});

test("Sidebar owns one menu across rows and input paths; a stale close cannot dismiss its successor", () => {
  const first = { hostId: "host-a", threadId: "thread-a", kind: "dropdown" } as const;
  const second = { hostId: "host-a", threadId: "thread-b", kind: "dropdown" } as const;
  const context = { hostId: "host-a", threadId: "thread-b", kind: "context" } as const;
  let current = updateOpenSidebarThreadMenu(null, first, true);
  assert.equal(isSidebarThreadMenuOpen(current, first), true);
  current = updateOpenSidebarThreadMenu(current, second, true);
  assert.equal(isSidebarThreadMenuOpen(current, first), false);
  assert.equal(isSidebarThreadMenuOpen(current, second), true);
  current = updateOpenSidebarThreadMenu(current, first, false);
  assert.equal(isSidebarThreadMenuOpen(current, second), true);
  current = updateOpenSidebarThreadMenu(current, context, true);
  assert.equal(isSidebarThreadMenuOpen(current, second), false);
  assert.equal(isSidebarThreadMenuOpen(current, context), true);
  assert.equal(isSidebarThreadMenuOpen(current, { ...context, hostId: "host-b" }), false);
  assert.equal(updateOpenSidebarThreadMenu(current, context, false), null);
});

test("taskflow precedence is unique, keeps urgent pins visible and retains full groups for view pagination", () => {
  const now = new Date();
  const input = [
    { ...thread("run-pin", now), status: "running", pinned: true, unread: true },
    { ...thread("review-pin", now), status: "review", pinned: true },
    { ...thread("error", now), status: "error" },
    { ...thread("unread", now), status: "ready", unread: true },
    { ...thread("pin", now), status: "ready", pinned: true },
    ...Array.from({ length: 12 }, (_, i) => ({ ...thread(`recent-${i}`, new Date(now.getTime() - i * 1000)), status: "ready" })),
  ];
  const flow = groupThreadsByTaskFlow(input);
  assert.deepEqual(new Set(flow.attention.map(t => t.id)), new Set(["review-pin", "error"]));
  assert.deepEqual(flow.pinned.map(t => t.id), ["run-pin", "pin"]);
  assert.equal(flow.recent.length, 13);
  assert.ok(flow.recent.some(t => t.id === "unread" && t.unread));
  assert.equal(new Set([...flow.attention, ...flow.pinned, ...flow.recent]).size, input.length);

});


test("reading cannot resolve waits or failures, and unread never creates a todo", () => {
  for (const unread of [false, true]) {
    const input = [
      { ...thread("waiting", new Date()), status: "review", unread },
      { ...thread("failed", new Date()), status: "error", unread },
      { ...thread("completed", new Date()), status: "ready", unread },
      { ...thread("pinned-completed", new Date()), status: "ready", pinned: true, unread },
    ];
    const flow = groupThreadsByTaskFlow(input);
    assert.deepEqual(flow.attention.map(t => t.id), ["waiting", "failed"]);
    assert.deepEqual(flow.recent.map(t => t.id), ["completed"]);
    assert.deepEqual(flow.pinned.map(t => t.id), ["pinned-completed"]);
  }
});

test("running transitions keep pinned and recent membership and preserve status", () => {
  for (const status of ["ready", "running"]) {
    const input = [{ ...thread("pin", new Date()), status, pinned: true },
      { ...thread("recent", new Date()), status }];
    const flow = groupThreadsByTaskFlow(input);
    assert.deepEqual(flow.pinned.map(t => t.id), ["pin"]);
    assert.deepEqual(flow.recent.map(t => t.id), ["recent"]);
    assert.equal(flow.recent[0]?.status, status);
    assert.equal(flow.attention.length, 0);
  }
});

test("recent prioritizes running before pagination and orders old conversations by canonical recency", () => {
  const date = new Date(2026, 9, 17, 12);
  const oldRun = { ...thread("old-run", date, { createdAt: 1, updatedAt: 10 }), status: "running" };
  const newRun = { ...thread("new-run", date, { createdAt: 2, updatedAt: 5 }), status: "running" };
  const completed = Array.from({ length: 12 }, (_, i) => ({
    ...thread(`done-${i}`, date, { updatedAt: 100 - i }), status: "ready", unread: true,
  }));
  const input = [...completed, oldRun, newRun];
  const recent = () => groupThreadsByTaskFlow(input).recent;
  assert.deepEqual(recent().slice(0, 3).map(t => t.id), ["old-run", "new-run", "done-0"]);
  newRun.updatedAt = 150;
  assert.deepEqual(recent().slice(0, 2).map(t => t.id), ["new-run", "old-run"]);
  oldRun.updatedAt = 200;
  assert.deepEqual(recent().slice(0, 2).map(t => t.id), ["old-run", "new-run"]);
  oldRun.status = "ready";
  assert.deepEqual(recent().slice(0, 3).map(t => t.id), ["new-run", "old-run", "done-0"]);
  const beforeRead = recent().map(t => t.id);
  completed[0]!.unread = false;
  assert.deepEqual(recent().map(t => t.id), beforeRead);
  newRun.status = "ready";
  assert.deepEqual(recent().slice(0, 3).map(t => t.id), ["old-run", "new-run", "done-0"]);
  assert.deepEqual(input.slice(0, 12), completed, "sorting never mutates the caller array");
});

test("urgent and pinned order is unchanged and equal native times retain cross-server rows", () => {
  const base = thread("same", new Date(), { createdAt: 1, updatedAt: 1 });
  const rows = [
    { ...base, status: "running", pinned: true },
    { ...base, id: "urgent", status: "review", updatedAt: 9 },
    { ...base, id: "pin-newer", status: "ready", pinned: true, updatedAt: 8 },
    { ...base, status: "running", serverOrigin: threadServerOrigin({ serverId: "other", label: "Other" }) },
    { ...base, status: "running" },
  ];
  const flow = groupThreadsByTaskFlow(rows);
  assert.deepEqual(flow.pinned.map(t => t.id), ["pin-newer", "same"]);
  assert.deepEqual(flow.attention.map(t => t.id), ["urgent"]);
  assert.deepEqual(flow.recent.map(t => t.serverOrigin.serverId), ["local-server", "other"]);
});

test("date headings follow visible consecutive days after running prioritization", () => {
  const now = new Date(2026, 9, 17, 12);
  const yesterdayRun = { ...thread("run", new Date(2026, 9, 16, 12)), status: "running" };
  const today = { ...thread("today", now), status: "ready" };
  const yesterday = { ...thread("yesterday", new Date(2026, 9, 16, 10)), status: "ready" };
  const sameDay = { ...yesterday, id: "same-day" };
  const visible = groupThreadsByTaskFlow([today, yesterday, sameDay, yesterdayRun]).recent;
  const headings = sidebarActivityDateHeadings(visible, now.getTime(), "en-US");
  assert.deepEqual(visible.map(t => headings.get(t)), ["Yesterday", "Today", "Yesterday", undefined]);
  assert.equal(sidebarActivityDateHeadings([], now.getTime()).size, 0);
});


test("menu owner only notifies affected rows and preserves exclusivity across hosts and kinds", () => {
  const store = new SidebarThreadMenuStore();
  const a = { hostId: "a", threadId: "same", kind: "context" } as const;
  const b = { hostId: "b", threadId: "same", kind: "badge" } as const;
  const unrelated = { hostId: "a", threadId: "other" };
  const counts = [0, 0, 0];
  const off = store.subscribe(a, () => counts[0]++);
  store.subscribe(b, () => counts[1]++);
  store.subscribe(unrelated, () => counts[2]++);
  store.update(a, true);
  store.update({ ...a }, true);
  assert.deepEqual(counts, [1, 0, 0]);
  store.update(b, true);
  assert.equal(store.getKind(a), null);
  assert.equal(store.getKind(b), "badge");
  assert.deepEqual(counts, [2, 1, 0]);
  store.update(a, false);
  assert.equal(store.getKind(b), "badge");
  store.update({ ...b, kind: "dropdown" }, true);
  store.update(b, false);
  assert.equal(store.getKind(b), "dropdown");
  assert.deepEqual(counts, [2, 2, 0]);
  store.close();
  store.close();
  assert.equal(store.getSnapshot(), null);
  assert.deepEqual(counts, [2, 3, 0]);
  off();
  store.update(a, true);
  assert.deepEqual(counts, [2, 3, 0]);
});


test("list filters and thread overlays share one owner without notifying unrelated rows", () => {
  const store = new SidebarThreadMenuStore();
  const row = { hostId: "local", threadId: "a", kind: "context" } as const;
  const counts = { row: 0, unrelated: 0, filters: 0 };
  store.subscribe(row, () => counts.row++);
  store.subscribe({ hostId: "local", threadId: "b" }, () => counts.unrelated++);
  const off = store.subscribeFilters(() => counts.filters++);
  store.update(row, true);
  store.setFiltersOpen(true);
  assert.equal(store.getKind(row), null);
  assert.equal(store.getFiltersOpen(), true);
  assert.deepEqual(counts, { row: 2, unrelated: 0, filters: 1 });
  store.update(row, false); // A late row dismissal cannot close the newer filters.
  assert.equal(store.getFiltersOpen(), true);
  store.update(row, true);
  store.setFiltersOpen(false); // A late filter dismissal cannot close the newer row.
  assert.equal(store.getKind(row), "context");
  assert.deepEqual(counts, { row: 3, unrelated: 0, filters: 2 });
  store.setFiltersOpen(true);
  store.setFiltersOpen(true);
  assert.deepEqual(counts, { row: 4, unrelated: 0, filters: 3 });
  store.close();
  store.close();
  assert.equal(store.getSnapshot(), null);
  assert.deepEqual(counts, { row: 4, unrelated: 0, filters: 4 });
  off();
  store.setFiltersOpen(true);
  assert.equal(counts.filters, 4);
  let contextNotifications = 0;
  const offContext = store.subscribeListContext(() => contextNotifications++);
  store.setListContextOpen(true);
  assert.equal(store.getFiltersOpen(), false);
  assert.equal(store.getListContextOpen(), true);
  store.update(row, false); // A stale row close cannot dismiss the list context.
  assert.equal(store.getListContextOpen(), true);
  store.setFiltersOpen(true);
  store.setListContextOpen(false); // Nor can a stale context close dismiss Filters.
  assert.equal(store.getFiltersOpen(), true);
  store.setListContextOpen(true);
  store.update(row, true);
  store.setListContextOpen(false);
  assert.equal(store.getKind(row), 'context');
  assert.equal(store.getListContextOpen(), false);
  assert.equal(contextNotifications, 4);
  assert.equal(counts.unrelated, 0);
  offContext();
  store.setListContextOpen(true);
  store.close();
  assert.equal(contextNotifications, 4, 'released list subscriptions stay silent');
});
