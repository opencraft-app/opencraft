import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { LocalAccountPreferences } from "@opencraft/workbench-web/runtime/local-account-preferences";
import { readHostThreadCatalog } from "@opencraft/workbench-web/runtime/host-thread-catalog";
import type { ThreadListReference } from "@opencraft/extension-react";
import type { AppServerWorkbenchRuntime, HostConnectionProfile } from "@opencraft/workbench-runtime";
import {
  ThreadParticipantsController,
  type ThreadParticipantsClient,
} from "../../plugins/thread-participants/src/controller";
import {
  CreatorGrouping,
  type ThreadParticipantsViewer,
  type ThreadParticipantsViewerIdentity,
} from "../../plugins/thread-participants/src/creator-grouping";
import { createThreadParticipation } from "../../plugins/thread-participants/src/participation";
import {
  LEGACY_THREAD_PARTICIPANTS_CHANGED,
  LEGACY_THREAD_PARTICIPANTS_LIST,
  THREAD_PARTICIPANTS_CHANGED,
  THREAD_PARTICIPANTS_LIST,
  parseThreadParticipantsResponse,
} from "../../plugins/thread-participants/src/contract";

/** A verified reader that the identity product would supply. */
class Viewer implements ThreadParticipantsViewer {
  #value: ThreadParticipantsViewerIdentity | null;
  readonly #listeners = new Set<() => void>();
  constructor(loginName: string | null, accountKey = loginName ? `account:${loginName}` : "") {
    this.#value = loginName ? { accountKey, loginName } : null;
  }
  getSnapshot = () => this.#value;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  set(loginName: string | null, accountKey = loginName ? `account:${loginName}` : "") {
    this.#value = loginName ? { accountKey, loginName } : null;
    for (const listener of this.#listeners) listener();
  }
}
type Row = { threadId: string; revision?: number; creator?: string | null; participants: string[]; pending?: boolean };
function client(read: (threadIds: string[], method: string) => unknown, method = THREAD_PARTICIPANTS_LIST) {
  const notifications = new Set<(notification: { method: string; params?: unknown }) => void>();
  const value = {
    connectionGeneration: 1,
    initializeResult: { capabilities: { extensions: { [method]: { version: 1 } } } },
    requestRaw: async (requested: string, input: { threadIds: string[] }) => read(input.threadIds, requested),
    subscribeNotification: (listener: (notification: { method: string; params?: unknown }) => void) => {
      notifications.add(listener);
      return () => {
        notifications.delete(listener);
      };
    },
    subscribeStatus: () => () => {},
    subscribeRequestLifecycle: () => () => {},
  };
  return Object.assign(value as unknown as ThreadParticipantsClient, {
    emit: (notification: { method: string; params?: unknown }) => {
      for (const listener of notifications) listener(notification);
    },
  });
}
const rowsFor = (rows: readonly Row[]) => (threadIds: string[]) => ({
  data: rows.filter((row) => threadIds.includes(row.threadId)).map((row) => ({ revision: 1, ...row })),
  errors: threadIds.filter((id) => !rows.some((row) => row.threadId === id)).map((threadId) => ({ threadId })),
});
function backend() {
  const rows = new Map<string, string>();
  const storage = {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
  };
  const port = new LocalAccountPreferences("opencraft", storage, new EventTarget() as unknown as Window);
  return { rows, storage: { forAccount: (account: string) => port.open("thread-participants", account) } };
}
const settle = async () => {
  await tick();
  await tick();
};

test("the wire parser accepts exactly one outcome per requested Thread", () => {
  const { rows, errors } = parseThreadParticipantsResponse(
    { data: [{ threadId: "a", revision: 2, participants: ["x.y"], creator: null }], errors: [{ threadId: "b" }] },
    ["a", "b"],
  );
  assert.deepEqual(rows.get("a"), { threadId: "a", revision: 2, participants: ["x.y"], creator: null });
  assert.deepEqual([...errors], ["b"]);
  assert.throws(() => parseThreadParticipantsResponse({ data: [] }, ["a"]), /Incomplete/);
  assert.throws(
    () => parseThreadParticipantsResponse({ data: [{ threadId: "a", revision: 1, participants: ["a b"] }] }, ["a"]),
    /Invalid participant row/,
  );
  assert.throws(
    () => parseThreadParticipantsResponse({ data: [{ threadId: "a", revision: 1, participants: ["x", "x"] }] }, ["a"]),
    /Invalid participant row/,
  );
  assert.throws(
    () => parseThreadParticipantsResponse({ data: [{ threadId: "z", revision: 1, participants: [] }] }, ["a"]),
    /Unexpected/,
  );
});

test("the controller prefers the core method and falls back to the alias on an older Host", async (t) => {
  for (const method of [THREAD_PARTICIPANTS_LIST, LEGACY_THREAD_PARTICIPANTS_LIST]) {
    const calls: string[] = [];
    let names = ["alice"];
    const host = client((threadIds, requested) => {
      calls.push(requested);
      return rowsFor([{ threadId: "t", participants: names }])(threadIds);
    }, method);
    const controller = new ThreadParticipantsController(() => host);
    t.after(() => controller.dispose());
    const release = controller.watch("h", "t");
    await settle();
    assert.deepEqual(calls, [method]);
    assert.deepEqual(controller.getSnapshot("h", "t").data?.participants, ["alice"]);
    names = ["alice", "bob"];
    const other =
      method === THREAD_PARTICIPANTS_LIST ? LEGACY_THREAD_PARTICIPANTS_CHANGED : THREAD_PARTICIPANTS_CHANGED;
    host.emit({ method: other, params: { threadId: "t" } });
    await settle();
    assert.equal(calls.length, 1, "a Host sending both names causes one read");
    host.emit({
      method: method === THREAD_PARTICIPANTS_LIST ? THREAD_PARTICIPANTS_CHANGED : LEGACY_THREAD_PARTICIPANTS_CHANGED,
      params: { threadId: "t" },
    });
    await settle();
    assert.deepEqual(controller.getSnapshot("h", "t").data?.participants, ["alice", "bob"]);
    release();
  }
});

test("a Host without the capability is unsupported rather than empty", async (t) => {
  const host = client(() => {
    throw new Error("not called");
  }, "opencraft/other");
  const controller = new ThreadParticipantsController(() => host);
  t.after(() => controller.dispose());
  const release = controller.watch("h", "t");
  t.after(release);
  await settle();
  assert.deepEqual(controller.getSnapshot("h", "t"), { phase: "unsupported", data: null });
});

test("participation overview preserves pending and partial outcomes without inventing people", async () => {
  const host = client(() => ({
    data: [
      { threadId: "a", revision: 1, participants: ["real"], creator: "creator", pending: false },
      { threadId: "b", revision: 1, participants: [], pending: true },
    ],
    errors: [{ threadId: "c" }],
  }));
  const result = await createThreadParticipation(
    "test",
    () => host,
    () => "account",
  ).read("host", ["a", "b", "c"], new AbortController().signal);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0]?.participants, ["real"]);
  assert.equal(result[0]?.creator, "creator");
  assert.equal(result[1]?.pending, true);
  assert.deepEqual(
    await createThreadParticipation(
      "test",
      () => host,
      () => null,
    ).read("host", ["a"], new AbortController().signal),
    [],
    "a signed-out reader reads nothing",
  );
});

test("participation overview drops a response after account replacement and splits large batches", async () => {
  let account = "one";
  const batches: number[] = [];
  const replaced = client((threadIds) => {
    account = "two";
    return rowsFor([])(threadIds);
  });
  await assert.rejects(
    createThreadParticipation(
      "test",
      () => replaced,
      () => account,
    ).read("host", ["a"], new AbortController().signal),
    /scope changed/,
  );
  const many = Array.from({ length: 250 }, (_, n) => `t${n}`);
  const host = client((threadIds) => {
    batches.push(threadIds.length);
    return rowsFor(threadIds.map((threadId) => ({ threadId, participants: [] })))(threadIds);
  });
  assert.equal(
    (
      await createThreadParticipation(
        "test",
        () => host,
        () => "one",
      ).read("host", many, new AbortController().signal)
    ).length,
    250,
  );
  assert.deepEqual(batches, [100, 100, 50]);
});

test("participant changes only repaint grouping when membership or the active creator projection changes", async (t) => {
  let creator = "alice",
    names = ["alice"],
    revision = 1;
  const host = client((threadIds) => ({
    data: threadIds.map((threadId) => ({ threadId, revision, creator, participants: names })),
  }));
  const participants = new ThreadParticipantsController(() => host);
  const grouping = new CreatorGrouping("test", new Viewer("alice"), participants);
  t.after(() => {
    grouping.dispose();
    participants.dispose();
  });
  const refs = [{ hostId: "local", threadId: "thread", updatedAt: 1 }];
  const unwatch = grouping.watch(refs);
  t.after(unwatch);
  await settle();
  const refresh = async () => {
    revision++;
    participants.refresh("local", "thread");
    await settle();
  };
  const before = grouping.getSnapshot().revision;
  names = ["alice", "bob"];
  await refresh();
  assert.equal(grouping.getSnapshot().revision, before, "badges update their counts without rebuilding the catalog");
  creator = "bob";
  await refresh();
  assert.equal(grouping.getSnapshot().revision, before, "inactive creator grouping does not own a redraw");
  names = ["bob"];
  await refresh();
  assert.ok(grouping.getSnapshot().revision > before, "unread membership remains live even when filtering is off");
  assert.equal(grouping.isParticipant(refs[0]!), false);
  grouping.setMode("creator");
  const grouped = grouping.getSnapshot().revision;
  creator = "carol";
  await refresh();
  assert.ok(grouping.getSnapshot().revision > grouped);
  assert.equal(grouping.project(refs)[0]?.id, "employee:carol");
  const release = grouping.watch([{ hostId: "local", threadId: "other", updatedAt: 2 }]);
  await settle();
  release();
  const current = grouping.getSnapshot().revision;
  participants.refresh("local", "thread");
  await settle();
  assert.equal(
    grouping.getSnapshot().revision,
    current,
    "releasing a second watcher does not create a spurious update",
  );
  creator = "dave";
  await refresh();
  assert.ok(grouping.getSnapshot().revision > current, "the first watcher still observes creator changes");
  assert.equal(grouping.project(refs)[0]!.id, "employee:dave");
});

test("personal filter discovers older creator and sender matches beyond the catalog and metadata batch windows", async (t) => {
  const batches: string[][] = [];
  const host = client((threadIds) => {
    batches.push(threadIds);
    return {
      data: threadIds.map((threadId) => ({
        threadId,
        revision: 1,
        creator: threadId === "older-creator" ? "alice" : "bob",
        participants: threadId === "older-sender" ? ["alice"] : [],
      })),
    };
  });
  const participants = new ThreadParticipantsController(() => host);
  const grouping = new CreatorGrouping("test", new Viewer("alice"), participants);
  t.after(() => {
    grouping.dispose();
    participants.dispose();
  });
  const rows = [
    ...Array.from({ length: 319 }, (_, n) => ({ id: `recent-${n}` })),
    { id: "older-creator" },
    { id: "older-sender" },
  ];
  const cursors: Array<string | null> = [];
  const runtime = {
    getSnapshot: () => ({ phase: "ready" }),
    resources: {
      threads: {
        list: async ({ cursor, limit }: { cursor: string | null; limit: number }) => {
          cursors.push(cursor);
          const offset = cursor === null ? 0 : Number(cursor);
          return {
            data: rows.slice(offset, offset + limit),
            nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
          };
        },
      },
    },
  } as unknown as AppServerWorkbenchRuntime;
  const profile = {
    hostId: "local",
    hostKind: "local",
    enabled: true,
    autoConnect: true,
    includeInSidebar: true,
    revision: 1,
  } as HostConnectionProfile;
  const catalog = await readHostThreadCatalog({
    profile,
    currentProfile: () => profile,
    management: null,
    registry: { peekRuntime: () => runtime, ensureConnected: async () => runtime },
  });
  const refs = catalog.data.map((thread, updatedAt) => ({ hostId: "local", threadId: thread.id, updatedAt }));
  grouping.setFilterEnabled(true);
  assert.equal(grouping.filterThreads(refs).length, 0, "unfinished metadata is not confirmed membership");
  const remove = grouping.watch(refs);
  t.after(remove);
  for (
    let attempt = 0;
    attempt < 20 && refs.some((ref) => participants.getSnapshot(ref.hostId, ref.threadId).phase !== "ready");
    attempt++
  )
    await settle();
  assert.equal(batches.flat().length, 321);
  assert.ok(batches.every((batch) => batch.length <= 100));
  assert.deepEqual(
    grouping.filterThreads(refs).map((ref) => ref.threadId),
    ["older-creator", "older-sender"],
  );
  assert.ok(refs.slice(-2).every((ref) => grouping.isParticipant(ref)));
  assert.equal(
    grouping.filterThreads(refs.slice(0, 50)).length,
    0,
    "a first-page-only catalog could not find either match",
  );
});

test("creator groups are personal, own-first, alphabetical, distinct across Hosts and preserve collapsed data", async (t) => {
  const b = backend();
  const viewer = new Viewer("zed", "account-1");
  let reads = 0;
  const creators: Record<string, string | null> = { mine: "zed", a: "alice", b: "bob", old: null };
  const host = client((threadIds) => {
    reads++;
    return {
      data: threadIds.map((threadId) => ({
        threadId,
        revision: 1,
        creator: creators[threadId] ?? null,
        participants: ["unrelated.participant"],
      })),
    };
  });
  const participants = new ThreadParticipantsController(() => host);
  const grouping = new CreatorGrouping("test", viewer, participants, b.storage);
  t.after(() => {
    grouping.dispose();
    participants.dispose();
  });
  const refs: ThreadListReference[] = [
    { hostId: "one", threadId: "mine", updatedAt: 1 },
    { hostId: "one", threadId: "a", updatedAt: 2 },
    { hostId: "one", threadId: "b", updatedAt: 3 },
    { hostId: "two", threadId: "a", updatedAt: 4, pinned: true },
    { hostId: "one", threadId: "old", updatedAt: 5 },
  ];
  assert.ok(
    refs.every((ref) => !grouping.isParticipant(ref)),
    "unresolved participation cannot expose unread dots",
  );
  const noWatch = grouping.watch(refs);
  await settle();
  assert.equal(reads, 2, "unread membership remains watched with personal filtering off; one batch per Host");
  assert.equal(grouping.isParticipant(refs[0]!), true);
  noWatch();
  grouping.setMode("creator");
  const remove = grouping.watch(refs);
  t.after(remove);
  await settle();
  let groups = grouping.project(refs);
  assert.deepEqual(
    groups.map((group) => group.label),
    ["zed", "alice", "bob", { id: "threadParticipants.grouping.unknown", defaultMessage: "Creator unknown" }],
  );
  assert.deepEqual(
    groups[0]!.identity,
    { kind: "employee", name: "zed" },
    "the Shell resolves the photo through the identity resolver",
  );
  assert.equal(groups[0]!.avatarUrl, null);
  assert.equal(groups[3]!.identity, undefined);
  assert.equal(groups.flatMap((group) => group.threads).length, refs.length);
  assert.deepEqual(
    groups[1]!.threads.map((ref) => ref.hostId),
    ["two", "one"],
    "pinned first within creator group and Hosts remain distinct",
  );
  grouping.toggleGroup("employee:alice");
  groups = grouping.project(refs);
  assert.equal(groups[1]!.collapsed, true);
  assert.equal(groups[1]!.threads.length, 2);
  const reopened = new CreatorGrouping("test", viewer, participants, b.storage);
  t.after(() => reopened.dispose());
  assert.equal(reopened.getSnapshot().mode, "creator");
  assert.equal(reopened.project(refs)[1]!.collapsed, true);
  viewer.set("bob", "account-2");
  assert.equal(grouping.getSnapshot().mode, null);
  grouping.setMode("creator");
  assert.equal(grouping.project(refs)[0]!.label, "bob");
  assert.equal(grouping.project(refs).find((group) => group.id === "employee:alice")!.collapsed, false);
  viewer.set(null);
  assert.equal(grouping.getSnapshot().mode, null);
  viewer.set("zed", "account-1");
  assert.equal(grouping.getSnapshot().mode, "creator");
  assert.equal(grouping.project(refs)[1]!.collapsed, true);
  grouping.setMode(null);
  assert.equal(grouping.getSnapshot().hideRowBadge, false);
});

test("unavailable local storage reports a preference failure without clearing creator data or faking persistence", (t) => {
  const participants = new ThreadParticipantsController(() => undefined);
  const grouping = new CreatorGrouping("test", new Viewer("alice"), participants, {
    forAccount: () => ({
      get: () => null,
      set: () => {
        throw new Error("quota");
      },
      subscribe: () => () => {},
    }),
  });
  t.after(() => {
    grouping.dispose();
    participants.dispose();
  });
  grouping.setMode("creator");
  assert.equal(grouping.getSnapshot().mode, "creator");
  assert.ok(grouping.getSnapshot().notice);
  grouping.dispose();
  grouping.setMode(null);
  assert.equal(grouping.getSnapshot().mode, "creator");
});

test("participation filter defaults off, keeps unresolved data, excludes known empty participation and isolates account preferences", async (t) => {
  const b = backend();
  const viewer = new Viewer("alice", "11");
  const rows: Row[] = [
    { threadId: "created", creator: "alice", participants: [] },
    { threadId: "joined", creator: "bob", participants: ["alice"] },
    { threadId: "other", creator: "bob", participants: ["bob"] },
    { threadId: "legacy", creator: null, participants: [] },
    { threadId: "legacy-joined", participants: ["alice"] },
  ];
  const participants = new ThreadParticipantsController(
    (
      (host) => () =>
        host
    )(client(rowsFor(rows))),
  );
  const grouping = new CreatorGrouping("test", viewer, participants, b.storage);
  t.after(() => {
    grouping.dispose();
    participants.dispose();
  });
  const refs = rows.map((row) => ({ hostId: "one", threadId: row.threadId, updatedAt: 1 }));
  assert.equal(grouping.getSnapshot().filter?.enabled, false);
  assert.equal(grouping.filterThreads(refs).length, refs.length, "unknown before reads is visible");
  const remove = grouping.watch(refs);
  t.after(remove);
  await settle();
  assert.equal(grouping.filterThreads(refs).length, refs.length, "resolved conversations remain visible by default");
  grouping.setFilterEnabled(true);
  const savedOn = new CreatorGrouping("test", viewer, participants, b.storage);
  assert.equal(savedOn.getSnapshot().filter?.enabled, true, "explicit opt-in survives reopening");
  savedOn.dispose();
  assert.deepEqual(
    grouping.filterThreads(refs).map((ref) => ref.threadId),
    ["created", "joined", "legacy-joined"],
  );
  grouping.setMode("creator");
  assert.equal(grouping.project(grouping.filterThreads(refs)).flatMap((group) => group.threads).length, 3);
  grouping.setFilterEnabled(false);
  assert.equal(grouping.filterThreads(refs).length, refs.length);
  assert.deepEqual(
    refs.map((ref) => grouping.isParticipant(ref)),
    [true, true, false, false, true],
    "unread eligibility remains personal with filtering off",
  );
  viewer.set("bob", "22");
  assert.equal(grouping.getSnapshot().filter?.enabled, false);
  assert.deepEqual(
    refs.map((ref) => grouping.isParticipant(ref)),
    [false, true, true, false, false],
  );
  viewer.set("alice", "11");
  assert.equal(grouping.getSnapshot().filter?.enabled, false);
  grouping.dispose();
  grouping.setFilterEnabled(true);
  assert.equal(grouping.getSnapshot().filter?.enabled, false);
});

test("absent reader identity hides the filter, retains all rows and restores the saved preference without writing", async (t) => {
  const b = backend();
  const viewer = new Viewer(null);
  const rows: Row[] = [
    { threadId: "mine", creator: "alice", participants: [] },
    { threadId: "other", creator: "bob", participants: ["bob"] },
  ];
  const participants = new ThreadParticipantsController(
    (
      (host) => () =>
        host
    )(client(rowsFor(rows))),
  );
  const grouping = new CreatorGrouping("test", viewer, participants, b.storage);
  t.after(() => {
    grouping.dispose();
    participants.dispose();
  });
  const refs = [
    ...rows.map((row) => ({ hostId: "host", threadId: row.threadId, updatedAt: 1 })),
    { hostId: "host", threadId: "missing", updatedAt: 1 },
  ];
  assert.equal(grouping.getSnapshot().filter, undefined, "initial anonymous snapshot has no descriptor");
  assert.deepEqual(grouping.filterThreads(refs), refs);
  viewer.set("alice");
  assert.equal(grouping.getSnapshot().filter?.enabled, false);
  grouping.setFilterEnabled(true);
  const stop = grouping.watch(refs);
  t.after(stop);
  await settle();
  assert.deepEqual(
    grouping.filterThreads(refs).map((row) => row.threadId),
    ["mine"],
    "missing metadata cannot establish participation",
  );
  grouping.setFilterEnabled(false);
  const saved = [...b.rows];
  viewer.set(null);
  assert.equal(grouping.getSnapshot().filter, undefined);
  assert.deepEqual(grouping.filterThreads(refs), refs);
  assert.ok(
    refs.every((ref) => !grouping.isParticipant(ref)),
    "a signed-out reader cannot expose unread",
  );
  assert.deepEqual([...b.rows], saved, "identity loss does not write preferences");
  viewer.set("alice");
  assert.equal(grouping.getSnapshot().filter?.enabled, false);
  assert.deepEqual([...b.rows], saved, "restoration reuses the saved preference without writing it");
});

test("pinned conversations resume personal filtering after pending history and an error retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let mode: "pending" | "error" | "ready" = "pending";
  const host = client((threadIds) => {
    if (mode === "pending")
      return {
        data: threadIds.map((threadId) => ({ threadId, revision: 0, creator: null, participants: [], pending: true })),
      };
    if (mode === "error") throw Error("history unavailable");
    return {
      data: threadIds.map((threadId) => ({
        threadId,
        revision: 1,
        creator: null,
        participants: [threadId === "mine" ? "fixture.self" : "fixture.other"],
      })),
    };
  });
  const participants = new ThreadParticipantsController(() => host);
  const grouping = new CreatorGrouping("test", new Viewer("fixture.self"), participants);
  grouping.setFilterEnabled(true);
  const refs: ThreadListReference[] = ["mine", "other"].map((threadId) => ({
    hostId: "ssh:fixture",
    threadId,
    pinned: true,
    updatedAt: 1,
  }));
  const unwatch = grouping.watch(refs);
  try {
    await settle();
    assert.equal(participants.getSnapshot("ssh:fixture", "other").phase, "loading");
    assert.equal(participants.getSnapshot("ssh:fixture", "other").data, null);
    assert.deepEqual(grouping.project(refs)[0]!.label, {
      id: "threadParticipants.grouping.loading",
      defaultMessage: "Loading creators…",
    });
    assert.deepEqual(grouping.filterThreads(refs), [], "unknown metadata is excluded from personal matches");
    mode = "error";
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(participants.getSnapshot("ssh:fixture", "other").phase, "error");
    assert.deepEqual(grouping.project(refs)[0]!.label, {
      id: "threadParticipants.grouping.unavailable",
      defaultMessage: "Creator unavailable",
    });
    mode = "ready";
    t.mock.timers.tick(15000);
    await settle();
    assert.deepEqual(grouping.filterThreads(refs), [refs[0]], "retry restores filtering even in the pinned section");
    assert.ok(
      refs.every((ref) => ref.pinned),
      "filtering does not change pin state",
    );
  } finally {
    unwatch();
    grouping.dispose();
    participants.dispose();
  }
});

test("missing, legacy and malformed preferences default off; saved booleans retain the user's choice", (t) => {
  const participants = new ThreadParticipantsController(() => undefined);
  t.after(() => participants.dispose());
  for (const [stored, expected] of [
    [null, false],
    [{ mode: null, collapsed: [] }, false],
    [{ mode: "creator", collapsed: ["employee:bob"] }, false],
    [{ mode: null, collapsed: [], mineEnabled: "true" }, false],
    [{ mode: null, collapsed: [], mineEnabled: true }, true],
    [{ mode: null, collapsed: [], mineEnabled: false }, false],
  ] as const) {
    let writes = 0;
    const grouping = new CreatorGrouping("test", new Viewer("alice"), participants, {
      forAccount: () => ({
        get: () => stored,
        set: () => {
          writes++;
        },
        subscribe: () => () => {},
      }),
    });
    assert.equal(grouping.getSnapshot().filter?.enabled, expected, JSON.stringify(stored));
    assert.equal(writes, 0, "reading defaults never rewrites a saved preference");
    grouping.dispose();
  }
});

test("authenticated creation shows in My conversations without waiting for an older metadata batch", async (t) => {
  const calls: string[][] = [];
  let release!: (value: unknown) => void;
  const host = client((threadIds) => {
    calls.push(threadIds);
    if (calls.length === 1)
      return new Promise((resolve) => {
        release = resolve;
      });
    return {
      data: threadIds.map((threadId) => ({ threadId, revision: 1, creator: "alice", participants: ["alice"] })),
    };
  });
  const participants = new ThreadParticipantsController(() => host);
  const grouping = new CreatorGrouping("test", new Viewer("alice"), participants);
  const stops: (() => void)[] = [];
  t.after(() => {
    stops.forEach((stop) => stop());
    grouping.dispose();
    participants.dispose();
  });
  grouping.setFilterEnabled(true);
  const old = Array.from({ length: 100 }, (_, i) => ({ hostId: "h", threadId: `old-${i}`, updatedAt: 1 }));
  stops.push(grouping.watch(old));
  await tick();
  const fresh = { hostId: "h", threadId: "new", updatedAt: 3, createdByViewer: true };
  stops.push(grouping.watch([fresh]));
  await tick();
  assert.equal(calls.length, 1, "the new metadata request waits behind the old request");
  assert.deepEqual(
    grouping.filterThreads([fresh]),
    [fresh],
    "trusted creation evidence is independent of participant read latency",
  );
  assert.deepEqual(
    grouping.filterThreads([{ ...fresh, createdByViewer: undefined }]),
    [],
    "an unknown relation is not invented",
  );
  assert.deepEqual(
    grouping.filterThreads([{ ...fresh, createdByViewer: false }]),
    [],
    "another creator does not establish participation",
  );
  release({
    data: old.map((row) => ({ threadId: row.threadId, revision: 1, creator: "alice", participants: ["alice"] })),
  });
  await settle();
  assert.deepEqual(calls[1], ["new"]);
  assert.deepEqual(grouping.filterThreads([fresh]), [fresh]);
});

test("identical ordered watch handoffs keep leases live without rereading metadata", () => {
  let reads = 0,
    acquired = 0,
    released = 0;
  let creator = "alice";
  let onAcquire: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const participants = {
    getSnapshot: () => {
      reads++;
      return { phase: "ready" as const, data: { threadId: "", revision: 1, creator, participants: [creator] } };
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    watch: () => {
      acquired++;
      const callback = onAcquire;
      onAcquire = null;
      callback?.();
      return () => {
        released++;
      };
    },
  };
  const grouping = new CreatorGrouping("test", new Viewer("alice"), participants);
  const refs = Array.from({ length: 1000 }, (_, index) => ({
    hostId: "fixture",
    threadId: `thread-${index}`,
    updatedAt: index,
  }));
  let release = grouping.watch(refs);
  const baselineReads = reads;
  for (let turn = 0; turn < 20; turn++) {
    const next = grouping.watch(refs.map((ref) => ({ ...ref, updatedAt: ref.updatedAt + turn, pinned: true })));
    assert.equal(acquired - released, refs.length * 2, "successor acquires before predecessor releases");
    release();
    release = next;
    assert.equal(acquired - released, refs.length);
  }
  assert.equal(reads, baselineReads, "unchanged identity and order need no metadata reread");
  const revision = grouping.getSnapshot().revision;
  onAcquire = () => {
    creator = "bob";
    for (const listener of listeners) listener();
  };
  const notifyingSuccessor = grouping.watch(refs);
  assert.ok(
    grouping.getSnapshot().revision > revision,
    "synchronous membership changes during acquisition still publish",
  );
  release();
  release = notifyingSuccessor;
  const afterNotification = reads;
  const reverse = grouping.watch([...refs].reverse());
  assert.ok(reads > afterNotification, "reordered references use the full ordered union");
  const extra = grouping.watch([{ hostId: "other-host", threadId: "extra", updatedAt: 1 }]);
  const beforeRelease = reads;
  release();
  assert.ok(reads > beforeRelease, "multiple surviving leases still recompute their union");
  extra();
  reverse();
  grouping.dispose();
  assert.equal(acquired, released);
});
