import assert from "node:assert/strict";
import test from "node:test";
import { TencentOaController } from "../../plugins/tencentoa/src/controller";
import { TencentOaCreatorGrouping } from "../../plugins/tencentoa/src/creator-grouping";
import { TencentOaParticipantsController, type ParticipantsClient } from "../../plugins/tencentoa/src/participants-controller";
import { LocalAccountPreferences } from "../../../../apps/workbench-web/src/runtime/local-account-preferences";
import { ExtensionSupervisor, type TrustedExtensionApiV1 } from "@opencraft/extension-runtime";
import type { ThreadListReference } from "@opencraft/extension-react";
import type { AppServerWorkbenchRuntime, HostConnectionProfile } from "@opencraft/workbench-runtime";
import { readHostThreadCatalog } from "../../../../apps/workbench-web/src/runtime/host-thread-catalog";

function backend() {
  const rows = new Map<string, string>();
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); } };
  const events = new EventTarget() as unknown as Window;
  return { rows, storage, port: new LocalAccountPreferences("opencraft", storage, events) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test("participant changes only repaint grouping when membership or the active creator projection changes", async t => {
  const identity = new TencentOaController((async () => new Response(JSON.stringify({ available: true,
    identity: { loginName: "alice", staffId: "11", expiresAt: new Date(Date.now() + 60000).toISOString() } }))) as typeof fetch);
  await identity.refresh();
  let creator = "alice", names = ["alice"], revision = 1;
  const client = { connectionGeneration: 1, initializeResult: { capabilities: { extensions: { "opencraft/ioa/thread-participants/list": { version: 1 } } } },
    requestRaw: async (_method: string, input: { threadIds: string[] }) => ({ data: input.threadIds.map(threadId => ({ threadId, revision, creator, participants: names })) }),
    subscribeNotification: () => () => {}, subscribeStatus: () => () => {}, subscribeRequestLifecycle: () => () => {},
  } as unknown as ParticipantsClient;
  const participants = new TencentOaParticipantsController(() => client);
  const grouping = new TencentOaCreatorGrouping(identity, participants, null);
  t.after(() => { grouping.dispose(); participants.dispose(); identity.dispose(); });
  const refs = [{ hostId: "local", threadId: "thread", updatedAt: 1 }];
  const unwatch = grouping.watch(refs); t.after(unwatch);
  await settle();
  const refresh = async () => { revision++; participants.refresh("local", "thread"); await settle(); };
  const before = grouping.getSnapshot().revision;
  names = ["alice", "bob"]; await refresh();
  assert.equal(grouping.getSnapshot().revision, before, "badges update their counts without rebuilding the catalog");
  creator = "bob"; await refresh();
  assert.equal(grouping.getSnapshot().revision, before, "inactive creator grouping does not own a redraw");
  names = ["bob"]; await refresh();
  assert.ok(grouping.getSnapshot().revision > before, "unread membership remains live even when filtering is off");
  assert.equal(grouping.isParticipant(refs[0]!), false);
  grouping.setMode("creator");
  const grouped = grouping.getSnapshot().revision;
  creator = "carol"; await refresh();
  assert.ok(grouping.getSnapshot().revision > grouped);
  assert.equal(grouping.project(refs)[0]?.id, "employee:carol");
  const release = grouping.watch([{ hostId: "local", threadId: "other", updatedAt: 2 }]);
  await settle(); release();
  const current = grouping.getSnapshot().revision;
  participants.refresh("local", "thread"); await settle();
  assert.equal(grouping.getSnapshot().revision, current, "releasing a second watcher does not create a spurious update");
  creator = "dave"; await refresh();
  assert.ok(grouping.getSnapshot().revision > current, "the first watcher still observes creator changes");
  assert.equal(grouping.project(refs)[0]!.id, "employee:dave");
});

test("personal filter discovers older creator and sender matches beyond the catalog and metadata batch windows", async t => {
  const identity = new TencentOaController((async () => new Response(JSON.stringify({ available: true,
    identity: { loginName: "alice", staffId: "11", expiresAt: new Date(Date.now() + 60000).toISOString() } }))) as typeof fetch);
  await identity.refresh();
  const batches: string[][] = [];
  const client = { connectionGeneration: 1, initializeResult: { capabilities: { extensions: { "opencraft/ioa/thread-participants/list": { version: 1 } } } },
    requestRaw: async (_method: string, input: { threadIds: string[] }) => {
      batches.push(input.threadIds);
      return { data: input.threadIds.map(threadId => ({ threadId, revision: 1,
        creator: threadId === "older-creator" ? "alice" : "bob", participants: threadId === "older-sender" ? ["alice"] : [] })) };
    }, subscribeNotification: () => () => {}, subscribeStatus: () => () => {}, subscribeRequestLifecycle: () => () => {},
  } as unknown as ParticipantsClient;
  const participants = new TencentOaParticipantsController(() => client);
  const grouping = new TencentOaCreatorGrouping(identity, participants, null);
  t.after(() => { grouping.dispose(); participants.dispose(); identity.dispose(); });
  const rows = [...Array.from({ length: 319 }, (_, n) => ({ id: `recent-${n}` })), { id: "older-creator" }, { id: "older-sender" }];
  const cursors: Array<string | null> = [];
  const runtime = { getSnapshot: () => ({ phase: "ready" }), resources: { threads: {
    list: async ({ cursor, limit }: { cursor: string | null; limit: number }) => {
      cursors.push(cursor); const offset = cursor === null ? 0 : Number(cursor);
      return { data: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
    },
  } } } as unknown as AppServerWorkbenchRuntime;
  const profile = { hostId: "local", hostKind: "local", enabled: true, autoConnect: true, includeInSidebar: true, revision: 1 } as HostConnectionProfile;
  const catalog = await readHostThreadCatalog({ profile, currentProfile: () => profile, management: null,
    registry: { peekRuntime: () => runtime, ensureConnected: async () => runtime } });
  const refs = catalog.data.map((thread, updatedAt) => ({ hostId: "local", threadId: thread.id, updatedAt }));
  grouping.setFilterEnabled(true);
  assert.equal(grouping.filterThreads(refs).length, 0, "unfinished metadata is not confirmed membership");
  const remove = grouping.watch(refs); t.after(remove);
  for (let attempt = 0; attempt < 20 && refs.some(ref => participants.getSnapshot(ref.hostId, ref.threadId).phase !== "ready"); attempt++) await settle();
  assert.deepEqual(cursors, [null, "50", "100", "150", "200", "250", "300"]);
  assert.equal(batches.flat().length, 321);
  assert.ok(batches.every(batch => batch.length <= 100));
  assert.deepEqual(grouping.filterThreads(refs).map(ref => ref.threadId), ["older-creator", "older-sender"]);
  assert.ok(refs.slice(-2).every(ref => grouping.isParticipant(ref)));
  assert.equal(grouping.filterThreads(refs.slice(0, 50)).length, 0, "the old first-page-only catalog could not find either match");
});
test("local preferences isolate product, plugin and account; obsolete activations cannot read or write", async t => {
  const b = backend(), alice = b.port.open("plugin.a", "account.a"), bob = b.port.open("plugin.a", "account.b");
  alice.set("view", { mode: "example" });
  assert.equal(bob.get("view"), null); assert.equal(b.port.open("plugin.b", "account.a").get("view"), null);
  assert.equal(new LocalAccountPreferences("other", b.storage, new EventTarget() as unknown as Window).open("plugin.a", "account.a").get("view"), null);
  const observer = b.port.open("plugin.a", "account.a"); let changes = 0;
  const remove = observer.subscribe(() => changes++); alice.set("view", null); assert.equal(changes, 1); remove();
  assert.throws(() => alice.set("../../../../view", null), /key/);
  const disabled = new LocalAccountPreferences("opencraft", () => { throw new Error("storage disabled"); }, new EventTarget() as unknown as Window).open("plugin.a", "account.a");
  assert.throws(() => disabled.get("view"), /disabled/); assert.throws(() => disabled.set("view", null), /disabled/);
  const supervisor = new ExtensionSupervisor({ platform: "web", localPreferences: b.port.open }); t.after(() => supervisor.dispose());
  let api!: TrustedExtensionApiV1;
  await supervisor.activate({ manifest: { manifestVersion: 1, id: "test.preferences", name: "Test", version: "1.0.0", apiVersion: 1, platforms: ["web"], trust: "trusted", activationEvents: ["*"] }, activate(value) { api = value; } });
  const handle = api.localPreferences!.forAccount("account.a"); handle.set("view", "local");
  assert.equal(b.port.open("test.preferences", "account.a").get("view"), "local");
  await supervisor.dispose(); assert.throws(() => handle.get("view"), /stale/); assert.throws(() => handle.set("view", "late"), /stale/);
});

test("IOA creator groups are personal, own-first, alphabetical, distinct across Hosts and preserve collapsed data", async t => {
  const b = backend(); let loginName = "zed", staffId = "1";
  const identity = new TencentOaController((async () => new Response(JSON.stringify({ available: true, identity: loginName ? { loginName, staffId, expiresAt: new Date(Date.now() + 60000).toISOString() } : null }), { status: loginName ? 200 : 401 })) as typeof fetch);
  await identity.refresh(); let reads = 0;
  const creators: Record<string, string | null> = { mine: "zed", a: "alice", b: "bob", old: null, failed: null };
  const client = { connectionGeneration: 1, initializeResult: { capabilities: { extensions: { "opencraft/ioa/thread-participants/list": { version: 1 } } } },
    requestRaw: async (_method: string, input: { threadIds: string[] }) => { reads++; return { data: input.threadIds.map(threadId => ({ threadId, revision: 1, creator: creators[threadId] ?? null, participants: ["unrelated.participant"] })) }; },
    subscribeNotification: () => () => {}, subscribeStatus: () => () => {}, subscribeRequestLifecycle: () => () => {},
  } as unknown as ParticipantsClient;
  const participants = new TencentOaParticipantsController(() => client);
  const storage = { forAccount: (account: string) => b.port.open("ioa", account) };
  const grouping = new TencentOaCreatorGrouping(identity, participants, storage);
  t.after(() => { grouping.dispose(); participants.dispose(); identity.dispose(); });
  const refs: ThreadListReference[] = [
    { hostId: "one", threadId: "mine", updatedAt: 1 }, { hostId: "one", threadId: "a", updatedAt: 2 },
    { hostId: "one", threadId: "b", updatedAt: 3 }, { hostId: "two", threadId: "a", updatedAt: 4, pinned: true },
    { hostId: "one", threadId: "old", updatedAt: 5 },
  ];
  grouping.setFilterEnabled(false);
  assert.ok(refs.every(ref => !grouping.isParticipant(ref)), "unresolved participation cannot expose unread dots");
  const noWatch = grouping.watch(refs); await settle(); await settle();
  assert.equal(reads, 2, "unread membership remains watched with personal filtering off");
  assert.equal(grouping.isParticipant(refs[0]!), true);noWatch();
  grouping.setMode("creator");
  const remove = grouping.watch(refs); t.after(remove); await settle(); await settle();
  let groups = grouping.project(refs); assert.deepEqual(groups.map(group => group.label), ["zed", "alice", "bob", { id: "ioa.grouping.unknown", defaultMessage: "Creator unknown" }]);
  assert.equal(groups.flatMap(group => group.threads).length, refs.length);
  assert.deepEqual(groups[1]!.threads.map(ref => ref.hostId), ["two", "one"], "pinned first within creator group and Hosts remain distinct");
  grouping.toggleGroup("employee:alice"); groups = grouping.project(refs); assert.equal(groups[1]!.collapsed, true); assert.equal(groups[1]!.threads.length, 2);
  const reopened = new TencentOaCreatorGrouping(identity, participants, storage); t.after(() => reopened.dispose());
  assert.equal(reopened.getSnapshot().mode, "creator"); assert.equal(reopened.project(refs)[1]!.collapsed, true);
  staffId = "2"; loginName = "bob"; await identity.refresh(); assert.equal(grouping.getSnapshot().mode, null);
  grouping.setMode("creator"); assert.equal(grouping.project(refs)[0]!.label, "bob"); assert.equal(grouping.project(refs).find(group => group.id === "employee:alice")!.collapsed, false);
  loginName = ""; await identity.refresh(); assert.equal(grouping.getSnapshot().mode, null);
  staffId = "1"; loginName = "zed"; await identity.refresh(); assert.equal(grouping.getSnapshot().mode, "creator"); assert.equal(grouping.project(refs)[1]!.collapsed, true);
  grouping.setMode(null); assert.equal(grouping.getSnapshot().hideRowBadge, false);
});

test("unavailable local storage reports a preference failure without clearing creator data or faking persistence", async t => {
  const identity = new TencentOaController((async () => new Response(JSON.stringify({ available: true, identity: { loginName: "alice", staffId: "1", expiresAt: new Date(Date.now() + 60000).toISOString() } }))) as typeof fetch);
  await identity.refresh(); const participants = new TencentOaParticipantsController(() => undefined);
  const grouping = new TencentOaCreatorGrouping(identity, participants, { forAccount: () => ({ get: () => null, set: () => { throw new Error("quota"); }, subscribe: () => () => {} }) });
  t.after(() => { grouping.dispose(); participants.dispose(); identity.dispose(); });
  grouping.setMode("creator"); assert.equal(grouping.getSnapshot().mode, "creator"); assert.ok(grouping.getSnapshot().notice);
  grouping.dispose(); grouping.setMode(null); assert.equal(grouping.getSnapshot().mode, "creator");
});


test("participation filter defaults off, keeps unresolved data, excludes known empty participation and isolates account preferences", async t => {
  const b = backend(); let loginName = "alice", staffId = "11";
  const identity = new TencentOaController((async () => new Response(JSON.stringify({ available: true,
    identity: { loginName, staffId, expiresAt: new Date(Date.now() + 60000).toISOString() } }))) as typeof fetch);
  await identity.refresh();
  const rows = [
    { threadId: "created", creator: "alice", participants: [] },
    { threadId: "joined", creator: "bob", participants: ["alice"] },
    { threadId: "other", creator: "bob", participants: ["bob"] },
    { threadId: "legacy", creator: null, participants: [] },
    { threadId: "legacy-joined", participants: ["alice"] },
  ];
  const client = { connectionGeneration: 1, initializeResult: { capabilities: { extensions: { "opencraft/ioa/thread-participants/list": { version: 1 } } } },
    requestRaw: async (_: string, input: { threadIds: string[] }) => ({ data: rows.filter(row => input.threadIds.includes(row.threadId)).map(row => ({ ...row, revision: 1 })) }),
    subscribeNotification: () => () => {}, subscribeStatus: () => () => {}, subscribeRequestLifecycle: () => () => {},
  } as unknown as ParticipantsClient;
  const participants = new TencentOaParticipantsController(() => client);
  const storage = { forAccount: (account: string) => b.port.open("ioa", account) };
  const grouping = new TencentOaCreatorGrouping(identity, participants, storage);
  t.after(() => { grouping.dispose(); participants.dispose(); identity.dispose(); });
  const refs = rows.map(row => ({ hostId: "one", threadId: row.threadId, updatedAt: 1 }));
  assert.equal(grouping.getSnapshot().filter?.enabled, false);
  assert.equal(grouping.filterThreads(refs).length, refs.length, "unknown before reads is visible");
  const remove = grouping.watch(refs); t.after(remove); await settle(); await settle();
  assert.equal(grouping.filterThreads(refs).length, refs.length, "resolved conversations remain visible by default");
  grouping.setFilterEnabled(true);
  const savedOn = new TencentOaCreatorGrouping(identity, participants, storage);
  assert.equal(savedOn.getSnapshot().filter?.enabled, true, "explicit opt-in survives reopening"); savedOn.dispose();
  assert.deepEqual(grouping.filterThreads(refs).map(ref => ref.threadId), ["created", "joined", "legacy-joined"]);
  grouping.setMode("creator");
  assert.equal(grouping.project(grouping.filterThreads(refs)).flatMap(group => group.threads).length, 3);
  grouping.setFilterEnabled(false); assert.equal(grouping.filterThreads(refs).length, refs.length);
  assert.deepEqual(refs.map(ref => grouping.isParticipant(ref)), [true,true,false,false,true], "unread eligibility remains personal with filtering off");
  const reopened = new TencentOaCreatorGrouping(identity, participants, storage); t.after(() => reopened.dispose());
  assert.equal(reopened.getSnapshot().filter?.enabled, false);
  staffId = "22"; loginName = "bob"; await identity.refresh();
  assert.equal(grouping.getSnapshot().filter?.enabled, false);
  assert.deepEqual(refs.map(ref => grouping.isParticipant(ref)), [false,true,true,false,false]);
  staffId = "11"; loginName = "alice"; await identity.refresh();
  assert.equal(grouping.getSnapshot().filter?.enabled, false);
  grouping.dispose(); grouping.setFilterEnabled(true); assert.equal(grouping.getSnapshot().filter?.enabled, false);
});

test("absent display identity hides the descriptor, retains all rows and restores the saved participation preference", async t => {
  const b = backend(); let authenticated = false, unavailable = false;
  const identity = new TencentOaController((async () => unavailable ? new Response("", {status: 500}) : authenticated
    ? new Response(JSON.stringify({available: true, identity: {loginName: "alice", staffId: "11", expiresAt: new Date(Date.now()+60000).toISOString()}}))
    : new Response("", {status: 401})) as typeof fetch);
  const rows = [{threadId: "mine", creator: "alice", participants: []}, {threadId: "other", creator: "bob", participants: ["bob"]}];
  const client = {connectionGeneration: 1, initializeResult: {capabilities: {extensions: {"opencraft/ioa/thread-participants/list": {version: 1}}}},
    requestRaw: async (_: string, input: {threadIds: string[]}) => ({data: rows.filter(row=>input.threadIds.includes(row.threadId)).map(row=>({...row, revision: 1})), errors: input.threadIds.filter(id=>!rows.some(row=>row.threadId===id)).map(threadId=>({threadId}))}),
    subscribeNotification: () => () => {}, subscribeStatus: () => () => {}, subscribeRequestLifecycle: () => () => {}} as unknown as ParticipantsClient;
  const participants = new TencentOaParticipantsController(() => client);
  const grouping = new TencentOaCreatorGrouping(identity, participants, {forAccount: account=>b.port.open("ioa",account)});
  t.after(()=>{grouping.dispose();participants.dispose();identity.dispose();});
  const refs = [...rows.map(row=>({hostId: "host", threadId: row.threadId, updatedAt: 1})), {hostId: "host", threadId: "missing", updatedAt: 1}];
  assert.equal(grouping.getSnapshot().filter, undefined, "initial anonymous snapshot has no descriptor");
  await identity.refresh();assert.equal(identity.getSnapshot().displayIdentity,null);
  assert.equal(grouping.getSnapshot().filter, undefined);assert.deepEqual(grouping.filterThreads(refs),refs);
  authenticated=true;await identity.refresh();assert.equal(grouping.getSnapshot().filter?.enabled,false);
  grouping.setFilterEnabled(true);
  const stop=grouping.watch(refs);t.after(stop);await settle();await settle();
  assert.deepEqual(grouping.filterThreads(refs).map(row=>row.threadId),["mine"],"missing metadata cannot establish participation");
  grouping.setFilterEnabled(false);const saved=[...b.rows];
  unavailable=true;await identity.refresh();assert.ok(identity.getSnapshot().displayIdentity);
  assert.equal(grouping.getSnapshot().filter?.enabled,false,"temporary failure retains the display identity's preference");
  unavailable=false;authenticated=false;await identity.refresh();
  assert.equal(grouping.getSnapshot().filter,undefined);assert.deepEqual(grouping.filterThreads(refs),refs);
  assert.ok(refs.every(ref=>!grouping.isParticipant(ref)), "signed-out identity cannot expose unread");
  assert.deepEqual([...b.rows],saved,"identity loss does not write preferences");
  authenticated=true;await identity.refresh();assert.equal(grouping.getSnapshot().filter?.enabled,false);
  assert.deepEqual([...b.rows],saved,"restoration reuses saved preference without writing it");
});

test("pinned SSH conversations resume personal filtering after pending history and an error retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const identity = new TencentOaController((async () => Response.json({ available: true,
    identity: { loginName: "fixture.self", staffId: "123", expiresAt: new Date(Date.now() + 60000).toISOString() },
  })) as typeof fetch);
  await identity.refresh();
  let mode: "pending" | "error" | "ready" = "pending";
  const client = { connectionGeneration: 1,
    initializeResult: { capabilities: { extensions: { "opencraft/ioa/thread-participants/list": { version: 1 } } } },
    requestRaw: async (_method: string, input: { threadIds: string[] }) => {
      if (mode === "pending") return { data: input.threadIds.map(threadId => ({ threadId, revision: 0, creator: null, participants: [], pending: true })) };
      if (mode === "error") throw Error("history unavailable");
      return { data: input.threadIds.map(threadId => ({ threadId, revision: 1, creator: null,
        participants: [threadId === "mine" ? "fixture.self" : "fixture.other"] })) };
    },
    subscribeNotification: () => () => {}, subscribeStatus: () => () => {}, subscribeRequestLifecycle: () => () => {},
  } as unknown as ParticipantsClient;
  const participants = new TencentOaParticipantsController(() => client);
  const grouping = new TencentOaCreatorGrouping(identity, participants);
  grouping.setFilterEnabled(true);
  const refs: ThreadListReference[] = ["mine", "other"].map(threadId => ({ hostId: "ssh:fixture", threadId, pinned: true, updatedAt: 1 }));
  const unwatch = grouping.watch(refs);
  try {
    await settle();
    assert.equal(participants.getSnapshot("ssh:fixture", "other").phase, "loading");
    assert.equal(participants.getSnapshot("ssh:fixture", "other").data, null);
    assert.deepEqual(grouping.project(refs)[0]!.label, { id: "ioa.grouping.loading", defaultMessage: "Loading creators…" });
    assert.deepEqual(grouping.filterThreads(refs), [], "unknown metadata is excluded from personal matches");
    mode = "error"; t.mock.timers.tick(5000); await settle();
    assert.equal(participants.getSnapshot("ssh:fixture", "other").phase, "error");
    assert.deepEqual(grouping.project(refs)[0]!.label, { id: "ioa.grouping.unavailable", defaultMessage: "Creator unavailable" });
    mode = "ready"; t.mock.timers.tick(15000); await settle();
    assert.deepEqual(grouping.filterThreads(refs), [refs[0]], "retry restores filtering even in the pinned section");
    assert.ok(refs.every(ref => ref.pinned), "filtering does not change pin state");
  } finally { unwatch(); grouping.dispose(); participants.dispose(); identity.dispose(); }
});


test("missing, legacy and malformed preferences default off; saved booleans retain the user's choice", async t => {
  const identity = new TencentOaController((async () => Response.json({ available: true,
    identity: { loginName: "alice", staffId: "11", expiresAt: new Date(Date.now() + 60000).toISOString() },
  })) as typeof fetch);
  await identity.refresh();
  const participants = new TencentOaParticipantsController(() => undefined);
  t.after(() => { participants.dispose(); identity.dispose(); });
  for (const [stored, expected] of [
    [null, false], [{ mode: null, collapsed: [] }, false],
    [{ mode: "creator", collapsed: ["employee:bob"] }, false],
    [{ mode: null, collapsed: [], mineEnabled: "true" }, false],
    [{ mode: null, collapsed: [], mineEnabled: true }, true],
    [{ mode: null, collapsed: [], mineEnabled: false }, false],
  ] as const) {
    let writes = 0;
    const grouping = new TencentOaCreatorGrouping(identity, participants, { forAccount: () => ({
      get: () => stored, set: () => { writes++; }, subscribe: () => () => {},
    }) });
    assert.equal(grouping.getSnapshot().filter?.enabled, expected, JSON.stringify(stored));
    assert.equal(writes, 0, "reading defaults never rewrites a saved preference");
    grouping.dispose();
  }
});


test("identical ordered watch handoffs keep leases live without rereading metadata", () => {
  let reads = 0, acquired = 0, released = 0;
  let creator = "alice";
  let onAcquire: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const identity = { getSnapshot: () => ({ displayIdentity: { staffId: "fixture", loginName: "alice" } }), subscribe: () => () => {} };
  const participants = {
    getSnapshot: () => { reads++; return { phase: "ready", data: { creator, participants: [creator] } }; },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    watch: () => { acquired++; const callback = onAcquire; onAcquire = null; callback?.(); return () => { released++; }; },
  };
  const grouping = new TencentOaCreatorGrouping(identity as unknown as TencentOaController,
    participants as unknown as TencentOaParticipantsController, null);
  const refs = Array.from({ length: 1000 }, (_, index) => ({ hostId: "fixture", threadId: `thread-${index}`, updatedAt: index }));
  let release = grouping.watch(refs);
  const baselineReads = reads;
  for (let turn = 0; turn < 20; turn++) {
    const next = grouping.watch(refs.map(ref => ({ ...ref, updatedAt: ref.updatedAt + turn, pinned: true })));
    assert.equal(acquired - released, refs.length * 2, "successor acquires before predecessor releases");
    release(); release = next;
    assert.equal(acquired - released, refs.length);
  }
  assert.equal(reads, baselineReads, "unchanged identity and order need no metadata reread");
  const revision = grouping.getSnapshot().revision;
  onAcquire = () => { creator = "bob"; for (const listener of listeners) listener(); };
  const notifyingSuccessor = grouping.watch(refs);
  assert.ok(grouping.getSnapshot().revision > revision, "synchronous membership changes during acquisition still publish");
  release(); release = notifyingSuccessor;
  const afterNotification = reads;
  const reverse = grouping.watch([...refs].reverse());
  assert.ok(reads > afterNotification, "reordered references use the full ordered union");
  const extra = grouping.watch([{ hostId: "other-host", threadId: "extra", updatedAt: 1 }]);
  const beforeRelease = reads; release();
  assert.ok(reads > beforeRelease, "multiple surviving leases still recompute their union");
  extra(); reverse(); grouping.dispose();
  assert.equal(acquired, released);
});
