import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { setImmediate as tick } from "node:timers/promises";
import type { AppServerClient } from "@opencraft/appserver-client";
import type { Thread, ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";
import { projectAppServerThread } from "@opencraft/workbench-runtime";
import { threadServerOrigin } from "@opencraft/workbench-runtime";
import { bindThreadCatalogNotifications } from "../../apps/workbench-web/src/runtime/thread-catalog-notifications";
import {
  ThreadCatalogUpdates,
  threadCatalogUpdates,
} from "../../apps/workbench-web/src/runtime/thread-catalog-updates";
import { turnStartedRecency } from "../../apps/workbench-web/src/runtime/thread-catalog-recency";
import { groupThreadsByTaskFlow, sidebarActivityDateHeadings } from "../../apps/workbench-web/src/sidebar-activity";

const now = new Date(2026, 10, 16, 12).getTime(),
  today = now / 1000,
  yesterday = today - 86400;
const row = (id = "old", at = yesterday) =>
  ({
    id,
    name: id,
    preview: "",
    cwd: "/work",
    updatedAt: at,
    recencyAt: at,
    createdAt: yesterday - 86400,
    pinned: false,
    status: { type: "idle" },
  }) as unknown as Thread;
const page = (...rows: Thread[]) => ({ data: rows, nextCursor: null }) as ThreadListResponse;
const uuid = (seconds: number) => {
  const hex = Math.floor(seconds * 1000)
    .toString(16)
    .padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000001`;
};
const key = ["appserver", "host", "threads", "sidebar-pages", "updated_at", "desc", false, 1, 1, 0];
function fixture() {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let receive!: Parameters<AppServerClient["subscribeNotification"]>[0];
  const journal = threadCatalogUpdates(query, key, "host");
  journal.enabled = true;
  const stop = bindThreadCatalogNotifications(
    {
      subscribeNotification(fn) {
        receive = fn;
        return () => {};
      },
    },
    "host",
    query,
  );
  const view = () => {
    const data = query.getQueryData<any>(key);
    return journal.project(data?.pages ? page(...data.pages.flatMap((p: ThreadListResponse) => p.data)) : data);
  };
  return {
    query,
    journal,
    view,
    emit: (method: string, params: unknown) => receive({ method, params }),
    close() {
      stop();
      query.clear();
    },
  };
}
function headings(data: ThreadListResponse) {
  const rows = data.data.map((row) => ({
    ...projectAppServerThread(row),
    serverOrigin: threadServerOrigin({ serverId: "host", label: "Host" }),
  }));
  const recent = groupThreadsByTaskFlow(rows).recent;
  const labels = sidebarActivityDateHeadings(recent, now, "zh-CN");
  return recent.map((row) => ({ id: row.id, label: labels.get(row), at: row.updatedAt }));
}

test("native turn start moves yesterday to Today immediately, including recencyAt and infinite pages", async () => {
  const f = fixture();
  try {
    f.query.setQueryData(key, { pages: [page(row()), page(row("other"))], pageParams: [null, "tail"] });
    f.emit("turn/started", { threadId: "old", turn: { id: "native", startedAt: today } });
    await tick();
    assert.equal(f.view()!.data.find((r) => r.id === "old")!.recencyAt, today);
    assert.equal(
      f.view()!.data.find((r) => r.id === "old")!.updatedAt,
      yesterday,
      "engine modification time is not fabricated",
    );
    assert.deepEqual(
      headings(f.view()!).map((r) => [r.id, r.label]),
      [
        ["old", "今天"],
        ["other", "昨天"],
      ],
    );
    assert.equal(f.query.getQueryData<any>(key).pages[0].data[0].status.type, "active");
  } finally {
    f.close();
  }
});

test("slow metadata, materialization and duplicate native events cannot regress today's date", async () => {
  const f = fixture();
  try {
    f.query.setQueryData(key, page(row()));
    f.emit("turn/started", { threadId: "old", turn: { id: "native", startedAt: today } });
    await tick();
    const revision = f.journal.getSnapshot();
    for (let i = 0; i < 4; i++) {
      f.query.setQueryData(key, f.journal.markRead(f.journal.reconcileRecency(page(row()), true), revision));
      f.journal.acknowledge(f.journal.markRead(f.view()!, f.journal.getSnapshot()));
      assert.equal(f.view()!.data[0]!.recencyAt, today);
    }
    f.emit("turn/started", { threadId: "old", turn: { id: "native", startedAt: today } });
    f.emit("turn/started", { threadId: "old", turn: { id: "old-native", startedAt: yesterday } });
    await tick();
    assert.equal(f.view()!.data[0]!.recencyAt, today);
    // Tail pages cannot acknowledge activity against a still-old first page.
    f.journal.reconcileRecency(page(row("old", today)), false);
    assert.equal(f.journal.project(page(row()))!.data[0]!.recencyAt, today);
    const caughtUp = f.journal.reconcileRecency(page(row("old", today + 1)), true);
    assert.equal(f.journal.project(caughtUp)!.data[0]!.recencyAt, today + 1);
  } finally {
    f.close();
  }
});

test("cold catalogs retain native clocks without phantom rows; status/read/resume do not promote", async () => {
  const f = fixture();
  try {
    f.emit("turn/started", { threadId: "old", turn: { id: "native", startedAt: today } });
    await tick();
    assert.equal(f.view(), undefined);
    assert.equal(f.journal.project(page())!.data.length, 0);
    f.query.setQueryData(key, f.journal.markRead(f.journal.reconcileRecency(page(row()), true), 0));
    assert.equal(f.view()!.data[0]!.recencyAt, today);
  } finally {
    f.close();
  }
  const g = fixture();
  try {
    g.query.setQueryData(key, page(row()));
    for (const method of ["thread/read", "thread/resume", "thread/status/changed"]) {
      g.emit(method, { threadId: "old", status: { type: "active", activeFlags: [] } });
      await tick();
      assert.equal(g.view()!.data[0]!.recencyAt, yesterday);
    }
  } finally {
    g.close();
  }
});

test("native time / UUIDv7 prevents replay and overnight execution from becoming today", async () => {
  assert.equal(turnStartedRecency({ id: uuid(today), startedAt: null }), today);
  assert.equal(turnStartedRecency({ id: uuid(yesterday), startedAt: today }), today);
  for (const turn of [
    null,
    undefined,
    {},
    { startedAt: NaN },
    { startedAt: -1 },
    { startedAt: Infinity },
    { id: "not-a-v7" },
    { id: "00000000-0000-4000-8000-000000000001" },
  ])
    assert.equal(turnStartedRecency(turn), undefined);
  const f = fixture();
  try {
    f.query.setQueryData(key, page(row()));
    f.emit("turn/started", { threadId: "old", turn: { id: uuid(yesterday), startedAt: null } });
    await tick();
    assert.equal(headings(f.view()!)[0]!.label, "昨天");
    f.emit("turn/started", { threadId: "old", turn: { id: "legacy-no-time", startedAt: null } });
    await tick();
    assert.equal(f.view()!.data[0]!.recencyAt, yesterday, "unknown timestamps never borrow browser now");
    f.emit("turn/started", { threadId: "old", turn: { id: uuid(today), startedAt: null } });
    await tick();
    assert.equal(headings(f.view()!)[0]!.label, "今天");
  } finally {
    f.close();
  }
});

test("activity is scoped by Host, authorization key and live reader; removal drops the floor", async () => {
  const f = fixture();
  try {
    const disabled = threadCatalogUpdates(f.query, [...key, "disabled"], "host");
    const other = threadCatalogUpdates(f.query, ["appserver", "else", "threads"], "else");
    other.enabled = true;
    f.query.setQueryData(key, page(row()));
    f.emit("turn/started", { threadId: "old", turn: { id: "live", startedAt: today } });
    await tick();
    assert.equal(disabled.project(page(row()))!.data[0]!.recencyAt, yesterday);
    assert.equal(other.project(page(row()))!.data[0]!.recencyAt, yesterday);
    f.emit("opencraft/thread-catalog/changed", {
      version: 1,
      source: "native",
      revision: 1,
      change: { type: "remove", threadId: "old" },
    });
    assert.equal(f.view()!.data.length, 0);
    f.journal.acknowledge(f.journal.markRead(page(), f.journal.getSnapshot()));
    assert.equal(f.journal.project(page(row()))!.data[0]!.recencyAt, yesterday);
  } finally {
    f.close();
  }
});

test("a canceled pre-start read cannot put yesterday back after the native event", async () => {
  const f = fixture();
  let release!: (p: ThreadListResponse) => void;
  let reads = 0;
  f.query.setQueryData(key, page(row()));
  const observer = new QueryObserver(f.query, {
    queryKey: key,
    queryFn: () =>
      ++reads === 1
        ? new Promise<ThreadListResponse>((r) => {
            release = r;
          })
        : Promise.resolve(f.journal.reconcileRecency(page(row()), true)),
  });
  const stop = observer.subscribe(() => {});
  try {
    f.emit("turn/started", { threadId: "old", turn: { id: "live", startedAt: today } });
    await tick();
    await tick();
    release(page(row()));
    await tick();
    assert.equal(reads, 2);
    assert.equal(f.view()!.data[0]!.recencyAt, today);
  } finally {
    stop();
    f.close();
  }
});
