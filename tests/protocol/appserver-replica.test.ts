import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCordisAppServerRegistry } from "@opencraft/appserver-client";
import {
  createAppServerReplicaSource,
  createCordisReplicaRuntime,
  MemoryReplicaStorage,
  ReplicaAuthority,
  ReplicaAuthorityRouter,
  ReplicaClient,
  ReplicaError,
  type ReplicaClientState,
  type ReplicaClientStorage,
  type ReplicaJsonValue,
  type ReplicaLiveEvent,
  type ReplicaSource,
} from "@opencraft/appserver-replica";
import { JsonFileReplicaStorage } from "@opencraft/appserver-replica-storage-node";
import { IndexedDbReplicaClientStorage } from "@opencraft/appserver-replica-storage-web";
import {
  createThreadViewReplicaSource,
  createEmptyThreadView,
  type ThreadView,
} from "@opencraft/appserver-session";
import {
  encodeJsonRpcMessage,
  isJsonRpcRequest,
  parseJsonRpcMessage,
} from "@opencraft/appserver-protocol";
import {
  MemoryTransport,
  type InMemoryAppServerPeer,
} from "@opencraft/appserver-transport-memory";
import { indexedDB } from "fake-indexeddb";

const SCOPE = "threads:local";

function controlled<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function ownedSource(epoch: string, subscribed: string[]): ReplicaSource {
  return { scope: SCOPE,
    subscribe: () => { subscribed.push(epoch); return () => {}; },
    sync: async () => ({ kind: "snapshot", scope: SCOPE, epoch,
      bounds: { nextSeq: 1, journalStartSeq: 1 }, entities: [{ entityId: "row", value: epoch }] }),
  };
}

test("disconnect revokes synchronization before delayed or already-complete cache preparation", async () => {
  for (const prepared of [false, true]) {
    const load = controlled<null>(), subscribed: string[] = [];
    const replica = client({ loadClient: () => load.promise, commitClient: async () => {}, clearClient: async () => {} });
    if (prepared) { load.resolve(null); await replica.prepare(); }
    const pending = replica.synchronize(ownedSource("old", subscribed));
    const canceled = assert.rejects(pending, /superseded/);
    await Promise.resolve(); // Enter prepare before revoking this source generation.
    replica.disconnect(); await canceled; load.resolve(null);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(subscribed, []);
    assert.equal(replica.getSnapshot().authoritative, false);
    replica.dispose();
  }
});

test("old persistence cannot overtake or publish into a successor source", async () => {
  const entered = controlled<void>(), release = controlled<void>(), subscribed: string[] = [];
  const writes: string[] = []; let diskEpoch = "";
  const replica = client({ loadClient: async () => null, clearClient: async () => {},
    commitClient: async state => {
      writes.push(state.epoch);
      if (state.epoch === "old") { entered.resolve(); await release.promise; }
      diskEpoch = state.epoch;
    },
  });
  const old = replica.synchronize(ownedSource("old", subscribed));
  const canceled = assert.rejects(old, /superseded/);
  await entered.promise; replica.disconnect(); await canceled;
  const next = replica.synchronize(ownedSource("new", subscribed));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, ["old"], "new write waits for accepted old I/O instead of racing it");
  release.resolve(); await next;
  assert.equal(replica.getSnapshot().epoch, "new");
  assert.equal(replica.getSnapshot().authoritative, true);
  assert.equal(diskEpoch, "new"); assert.deepEqual(writes, ["old", "new"]);
  replica.dispose();
});

function value(name: string, revision = 1): ReplicaJsonValue {
  return { name, revision };
}

function authority(
  storage: MemoryReplicaStorage,
  epoch = "epoch-1",
): ReplicaAuthority {
  return new ReplicaAuthority({
    scope: SCOPE,
    storage,
    createEpoch: () => epoch,
  });
}

function client(
  storage: ReplicaClientStorage,
  storageKey = "client-a",
  pageSize = 100,
): ReplicaClient {
  return new ReplicaClient({ scope: SCOPE, storageKey, storage, pageSize });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for Replica state");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("a pre-source Resume failure preserves painted entities and becomes visible", async () => {
  const storage = new MemoryReplicaStorage();
  await storage.commitClient({
    schemaVersion: 1,
    storageKey: "painted-failure",
    scope: SCOPE,
    epoch: "epoch-painted",
    nextSeq: 2,
    journalStartSeq: 1,
    entities: [{ entityId: "thread-one", value: value("painted") }],
  });
  const replica = client(storage, "painted-failure");
  try {
    await replica.prepare();
    replica.reportSyncFailure(new Error("resume unavailable"));
    assert.equal(replica.getSnapshot().phase, "error");
    assert.equal(replica.getSnapshot().authoritative, false);
    assert.equal(replica.getSnapshot().lastError?.message, "resume unavailable");
    assert.deepEqual(replica.get("thread-one"), value("painted"));
    replica.reportSyncStarted();
    assert.equal(replica.getSnapshot().phase, "syncing");
    assert.equal(replica.getSnapshot().authoritative, false);
    assert.equal(replica.getSnapshot().lastError, null);
    assert.deepEqual(replica.get("thread-one"), value("painted"));
  } finally {
    replica.dispose();
  }
});

test("authority assigns contiguous sequence numbers and materializes mutations", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  await server.open();
  const result = await server.commit([
    { kind: "upsert", entityId: "a", value: value("A") },
    { kind: "upsert", entityId: "b", value: value("B") },
    { kind: "delete", entityId: "a" },
  ], { commandId: "command-1" });

  assert.deepEqual(result, {
    scope: SCOPE,
    epoch: "epoch-1",
    firstSeq: 1,
    nextSeq: 4,
    replayed: false,
  });
  assert.deepEqual(server.cursor, { epoch: "epoch-1", nextSeq: 4 });
  assert.deepEqual(server.entities, [{ entityId: "b", value: value("B") }]);
});

test("concurrent authority commits serialize into one deterministic journal", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  await Promise.all(Array.from({ length: 20 }, (_, index) => server.commit([
    { kind: "upsert", entityId: String(index), value: value(String(index)) },
  ], { commandId: `parallel-${index}` })));
  const delta = await server.sync({ epoch: "epoch-1", nextSeq: 1 }, 100);

  assert.equal(delta.kind, "delta");
  assert.deepEqual(
    delta.kind === "delta" ? delta.entries.map((entry) => entry.seq) : [],
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  assert.equal(server.entities.length, 20);
});

test("authority persists epoch, nextSeq, journal and entities across restart", async () => {
  const storage = new MemoryReplicaStorage();
  const first = authority(storage);
  await first.commit([{ kind: "upsert", entityId: "a", value: value("A") }], {
    commandId: "command-1",
  });
  const restarted = authority(storage, "must-not-replace-the-stored-epoch");
  await restarted.open();

  assert.deepEqual(restarted.cursor, { epoch: "epoch-1", nextSeq: 2 });
  const delta = await restarted.sync({ epoch: "epoch-1", nextSeq: 1 }, 10);
  assert.equal(delta.kind, "delta");
  assert.deepEqual(delta.kind === "delta" ? delta.entries.map((entry) => entry.seq) : [], [1]);
});

test("authority command ids are durable and reject payload reuse", async () => {
  const storage = new MemoryReplicaStorage();
  const first = authority(storage);
  const mutations = [{ kind: "upsert" as const, entityId: "a", value: value("A") }];
  const original = await first.commit(mutations, { commandId: "same-command" });
  const restarted = authority(storage);
  const replay = await restarted.commit(mutations, { commandId: "same-command" });

  assert.equal(original.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.nextSeq, 2);
  await assert.rejects(
    restarted.commit([{ kind: "delete", entityId: "a" }], { commandId: "same-command" }),
    (error: unknown) => error instanceof ReplicaError && error.code === "COMMAND_CONFLICT",
  );
});

test("Journal compaction never weakens durable command idempotency", async () => {
  const storage = new MemoryReplicaStorage();
  const first = authority(storage);
  const mutations = [{ kind: "upsert" as const, entityId: "a", value: value("A") }];
  await first.commit(mutations, { commandId: "old-command" });
  await first.compact(first.cursor.nextSeq);

  const restarted = authority(storage);
  const replay = await restarted.commit(mutations, { commandId: "old-command" });

  assert.equal(replay.replayed, true);
  assert.equal(replay.nextSeq, 2);
  assert.deepEqual(restarted.cursor, { epoch: "epoch-1", nextSeq: 2 });
});

test("authority never broadcasts or advances a mutation that storage rejected", async () => {
  const durable = new MemoryReplicaStorage();
  let fail = false;
  const storage = {
    loadAuthority: (scope: string) => durable.loadAuthority(scope),
    clearAuthority: (scope: string) => durable.clearAuthority(scope),
    async commitAuthority(state: Parameters<typeof durable.commitAuthority>[0]) {
      if (fail) throw new Error("disk full");
      await durable.commitAuthority(state);
    },
  };
  const server = new ReplicaAuthority({ scope: SCOPE, storage, createEpoch: () => "epoch-1" });
  await server.open();
  let broadcasts = 0;
  server.subscribe(() => { broadcasts += 1; });
  fail = true;
  await assert.rejects(
    server.commit([{ kind: "upsert", entityId: "lost", value: value("lost") }], {
      commandId: "lost",
    }),
    (error: unknown) => error instanceof ReplicaError && error.code === "STORAGE_ERROR",
  );

  assert.deepEqual(server.cursor, { epoch: "epoch-1", nextSeq: 1 });
  assert.equal(server.entities.length, 0);
  assert.equal(broadcasts, 0);
});

test("optimistic writes fail closed on a stale cursor", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  await server.commit([{ kind: "upsert", entityId: "a", value: value("A") }], {
    commandId: "command-1",
  });
  await assert.rejects(
    server.commit([{ kind: "delete", entityId: "a" }], {
      commandId: "command-2",
      expectedCursor: { epoch: "epoch-1", nextSeq: 1 },
    }),
    (error: unknown) => error instanceof ReplicaError && error.code === "STALE_CURSOR",
  );
  assert.deepEqual(server.cursor, { epoch: "epoch-1", nextSeq: 2 });
});

test("sync pages a continuous retained journal", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  await server.commit(Array.from({ length: 5 }, (_, index) => ({
    kind: "upsert" as const,
    entityId: String(index + 1),
    value: value(String(index + 1)),
  })), { commandId: "batch" });

  const first = await server.sync({ epoch: "epoch-1", nextSeq: 1 }, 2);
  assert.equal(first.kind, "delta");
  assert.deepEqual(first.kind === "delta" ? first.entries.map((entry) => entry.seq) : [], [1, 2]);
  assert.equal(first.kind === "delta" && first.hasMore, true);
  const second = await server.sync({ epoch: "epoch-1", nextSeq: 3 }, 10);
  assert.deepEqual(second.kind === "delta" ? second.entries.map((entry) => entry.seq) : [], [3, 4, 5]);
  assert.equal(second.kind === "delta" && second.hasMore, false);
});

test("compacted, foreign-epoch and rewind cursors receive snapshots", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  await server.commit(Array.from({ length: 3 }, (_, index) => ({
    kind: "upsert" as const,
    entityId: String(index),
    value: value(String(index)),
  })), { commandId: "batch" });
  await server.compact(3);

  const compacted = await server.sync({ epoch: "epoch-1", nextSeq: 1 }, 10);
  const foreign = await server.sync({ epoch: "other", nextSeq: 3 }, 10);
  const rewind = await server.sync({ epoch: "epoch-1", nextSeq: 99 }, 10);
  assert.equal(compacted.kind === "snapshot" ? compacted.reason : null, "journal_compacted");
  assert.equal(foreign.kind === "snapshot" ? foreign.reason : null, "epoch_changed");
  assert.equal(rewind.kind === "snapshot" ? rewind.reason : null, "rewind");
});

test("destructive snapshot replacement rotates epoch and resets the journal", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  await server.commit([{ kind: "upsert", entityId: "old", value: value("old") }], {
    commandId: "old",
  });
  const snapshots: string[] = [];
  server.subscribe((event) => {
    if (event.kind === "snapshot") snapshots.push(event.snapshot.epoch);
  });
  await server.replaceSnapshot([{ entityId: "new", value: value("new") }], "epoch-2");

  assert.deepEqual(server.cursor, { epoch: "epoch-2", nextSeq: 1 });
  assert.deepEqual(server.entities, [{ entityId: "new", value: value("new") }]);
  assert.deepEqual(snapshots, ["epoch-2"]);
  await assert.rejects(
    server.replaceSnapshot([], "epoch-2"),
    (error: unknown) => error instanceof ReplicaError && error.code === "INVALID_STATE",
  );
});

test("client paints cache without claiming authority", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  await server.commit([{ kind: "upsert", entityId: "a", value: value("cached") }], {
    commandId: "seed",
  });
  const first = client(storage);
  await first.synchronize(server);
  first.dispose();
  const restarted = client(storage);
  await restarted.prepare();

  assert.equal(restarted.getSnapshot().phase, "painted");
  assert.equal(restarted.getSnapshot().authoritative, false);
  assert.deepEqual(restarted.get("a"), value("cached"));
});

test("client installs a snapshot and then applies live entries", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  await server.commit([{ kind: "upsert", entityId: "a", value: value("A") }], {
    commandId: "seed",
  });
  const replica = client(storage);
  await replica.synchronize(server);
  await server.commit([{ kind: "upsert", entityId: "b", value: value("B") }], {
    commandId: "live",
  });
  await waitFor(() => replica.getSnapshot().nextSeq === 3);

  assert.equal(replica.getSnapshot().phase, "live");
  assert.deepEqual([...replica.getSnapshot().entities.keys()], ["a", "b"]);
});

test("client drains every delta page before becoming authoritative", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  await server.commit(Array.from({ length: 7 }, (_, index) => ({
    kind: "upsert" as const,
    entityId: String(index),
    value: value(String(index)),
  })), { commandId: "seed" });
  const stale = client(storage, "paged", 2);
  await stale.synchronize(server);

  assert.equal(stale.getSnapshot().nextSeq, 8);
  assert.equal(stale.getSnapshot().entities.size, 7);
  assert.equal(stale.getSnapshot().authoritative, true);
});

test("malformed non-contiguous deltas fail without changing committed display state", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  await server.commit([{ kind: "upsert", entityId: "safe", value: value("safe") }], {
    commandId: "seed",
  });
  const replica = client(storage, "malformed");
  await replica.synchronize(server);
  replica.disconnect();
  const before = replica.getSnapshot().nextSeq;
  const malformed: ReplicaSource = {
    scope: SCOPE,
    async sync(cursor) {
      assert.ok(cursor);
      return {
        kind: "delta",
        scope: SCOPE,
        epoch: cursor.epoch,
        bounds: { journalStartSeq: 1, nextSeq: cursor.nextSeq + 2 },
        fromNextSeq: cursor.nextSeq,
        entries: [{
          scope: SCOPE,
          epoch: cursor.epoch,
          seq: cursor.nextSeq + 1,
          mutation: { kind: "delete", entityId: "safe" },
        }],
        hasMore: true,
      };
    },
    subscribe: () => () => undefined,
  };
  await assert.rejects(replica.synchronize(malformed), /delta gap/);

  assert.equal(replica.getSnapshot().nextSeq, before);
  assert.deepEqual(replica.get("safe"), value("safe"));
  assert.equal(replica.getSnapshot().phase, "error");
});

test("a live sequence gap triggers authoritative catch-up", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  let listener: ((event: ReplicaLiveEvent) => void) | null = null;
  const source: ReplicaSource = {
    scope: SCOPE,
    sync: (cursor, limit) => server.sync(cursor, limit),
    subscribe(next) {
      listener = next;
      return () => { listener = null; };
    },
  };
  const replica = client(storage, "gap");
  await replica.synchronize(source);
  await server.commit([{ kind: "upsert", entityId: "missed", value: value("missed") }], {
    commandId: "missed",
  });
  const delivered: ReplicaLiveEvent[] = [];
  const removeCapture = server.subscribe((event) => delivered.push(event));
  await server.commit([{ kind: "upsert", entityId: "visible", value: value("visible") }], {
    commandId: "visible",
  });
  removeCapture();
  const event = delivered[0];
  assert.ok(event);
  listener?.(event);
  await waitFor(() => replica.getSnapshot().nextSeq === 3);

  assert.deepEqual(replica.get("missed"), value("missed"));
  assert.deepEqual(replica.get("visible"), value("visible"));
});

test("duplicate live entries are dropped without advancing the cursor", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  let listener: ((event: ReplicaLiveEvent) => void) | null = null;
  const source: ReplicaSource = {
    scope: SCOPE,
    sync: (cursor, limit) => server.sync(cursor, limit),
    subscribe(next) {
      listener = next;
      return () => { listener = null; };
    },
  };
  const replica = client(storage, "duplicate");
  await replica.synchronize(source);
  const events: ReplicaLiveEvent[] = [];
  const removeCapture = server.subscribe((event) => events.push(event));
  await server.commit([{ kind: "upsert", entityId: "a", value: value("A") }], {
    commandId: "one",
  });
  removeCapture();
  const event = events[0];
  assert.ok(event);
  listener?.(event);
  await waitFor(() => replica.getSnapshot().nextSeq === 2);
  const revision = replica.getSnapshot().revision;
  listener?.(event);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(replica.getSnapshot().nextSeq, 2);
  assert.equal(replica.getSnapshot().revision, revision);
});

test("epoch replacement drops stale materialized entities atomically", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  await server.commit([{ kind: "upsert", entityId: "old", value: value("old") }], {
    commandId: "seed",
  });
  const replica = client(storage, "epoch");
  await replica.synchronize(server);
  await server.replaceSnapshot([{ entityId: "new", value: value("new") }], "epoch-2");
  await waitFor(() => replica.getSnapshot().epoch === "epoch-2");

  assert.equal(replica.get("old"), null);
  assert.deepEqual(replica.get("new"), value("new"));
  assert.equal(replica.getSnapshot().nextSeq, 1);
});

test("live updates arriving during bootstrap are buffered and replayed", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let listener: ((event: ReplicaLiveEvent) => void) | null = null;
  const source: ReplicaSource = {
    scope: SCOPE,
    async sync(cursor, limit) {
      const captured = await server.sync(cursor, limit);
      await gate;
      return captured;
    },
    subscribe(next) {
      listener = next;
      return () => { listener = null; };
    },
  };
  const replica = client(storage, "buffered");
  const syncing = replica.synchronize(source);
  await waitFor(() => replica.getSnapshot().phase === "syncing");
  const events: ReplicaLiveEvent[] = [];
  const remove = server.subscribe((event) => events.push(event));
  await server.commit([{ kind: "upsert", entityId: "during", value: value("during") }], {
    commandId: "during",
  });
  remove();
  assert.ok(events[0]);
  listener?.(events[0] as ReplicaLiveEvent);
  release();
  await syncing;

  assert.deepEqual(replica.get("during"), value("during"));
  assert.equal(replica.getSnapshot().nextSeq, 2);
});

test("concurrent synchronize calls share one bootstrap", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  let calls = 0;
  const source: ReplicaSource = {
    scope: SCOPE,
    async sync(cursor, limit) {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return server.sync(cursor, limit);
    },
    subscribe: (listener) => server.subscribe(listener),
  };
  const replica = client(storage, "dedup");
  const first = replica.synchronize(source);
  const second = replica.synchronize(source);
  assert.equal(first, second);
  await first;
  assert.equal(calls, 1);
});

test("a superseded bootstrap cannot cancel or overwrite the new source generation", async () => {
  const clientStorage = new MemoryReplicaStorage();
  const firstStorage = new MemoryReplicaStorage();
  const secondStorage = new MemoryReplicaStorage();
  const firstServer = authority(firstStorage, "epoch-old");
  const secondServer = authority(secondStorage, "epoch-new");
  await secondServer.commit([{ kind: "upsert", entityId: "new", value: value("new") }], {
    commandId: "new",
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const staleSource: ReplicaSource = {
    scope: SCOPE,
    async sync(cursor, limit) {
      const response = await firstServer.sync(cursor, limit);
      await gate;
      return response;
    },
    subscribe: () => () => undefined,
  };
  const replica = client(clientStorage, "generation");
  const stale = replica.synchronize(staleSource);
  await waitFor(() => replica.getSnapshot().phase === "syncing");
  replica.disconnect();
  await replica.synchronize(secondServer);
  release();
  await assert.rejects(stale, (error: unknown) => error instanceof ReplicaError && error.code === "DISPOSED");

  assert.equal(replica.getSnapshot().phase, "live");
  assert.equal(replica.getSnapshot().epoch, "epoch-new");
  assert.deepEqual(replica.get("new"), value("new"));
});

test("a rejected cache load is cleared and bypassed without blocking source activation", async () => {
  const serverStorage = new MemoryReplicaStorage();
  const server = authority(serverStorage);
  await server.commit([{ kind: "upsert", entityId: "source", value: value("source") }], {
    commandId: "source",
  });
  let clears = 0;
  let commits = 0;
  const storage: ReplicaClientStorage = {
    async loadClient() { throw new Error("IndexedDB transaction failed"); },
    async clearClient() { clears += 1; },
    async commitClient() { commits += 1; },
  };
  const replica = client(storage, "load-failure");
  await replica.synchronize(server);
  await waitFor(() => clears === 1);

  assert.equal(replica.getSnapshot().phase, "live");
  assert.equal(replica.getSnapshot().authoritative, true);
  assert.deepEqual(replica.get("source"), value("source"));
  assert.match(replica.getSnapshot().cacheError?.message ?? "", /IndexedDB transaction failed/);
  assert.equal(commits, 0, "a disabled cache must not receive the authoritative snapshot");
  await assert.rejects(replica.clear(), /Failed to clear/, "explicit clear must not pretend cache health");
  replica.dispose();
});

test("an invalid cache row is cleared and replaced by source authority", async () => {
  const serverStorage = new MemoryReplicaStorage();
  const server = authority(serverStorage);
  let clears = 0;
  const storage: ReplicaClientStorage = {
    async loadClient() {
      return {
        schemaVersion: 1,
        storageKey: "wrong-key",
        scope: SCOPE,
        epoch: "stale",
        nextSeq: 1,
        journalStartSeq: 1,
        entities: [],
      };
    },
    async clearClient() { clears += 1; },
    async commitClient() { throw new Error("disabled cache must not commit"); },
  };
  const replica = client(storage, "invalid-row");
  await replica.synchronize(server);
  await waitFor(() => clears === 1);

  assert.equal(replica.getSnapshot().phase, "live");
  assert.equal(replica.getSnapshot().authoritative, true);
  assert.equal(replica.getSnapshot().epoch, "epoch-1");
  assert.match(replica.getSnapshot().cacheError?.message ?? "", /wrong key/);
  replica.dispose();
});

test("a rejected cache commit degrades to source authority and skips later writes", async () => {
  const serverStorage = new MemoryReplicaStorage();
  const server = authority(serverStorage);
  let commits = 0;
  let clears = 0;
  const storage: ReplicaClientStorage = {
    async loadClient() { return null; },
    async clearClient() { clears += 1; },
    async commitClient() {
      commits += 1;
      throw new Error("quota exceeded");
    },
  };
  const replica = client(storage, "commit-failure");
  await replica.synchronize(server);
  await waitFor(() => clears === 1);
  assert.equal(replica.getSnapshot().phase, "live");
  assert.equal(replica.getSnapshot().authoritative, true);
  assert.match(replica.getSnapshot().cacheError?.message ?? "", /quota exceeded/);

  await server.commit([{ kind: "upsert", entityId: "live", value: value("live") }], {
    commandId: "live-after-cache-failure",
  });
  await waitFor(() => replica.get("live") !== null);

  assert.deepEqual(replica.get("live"), value("live"));
  assert.equal(replica.getSnapshot().phase, "live");
  assert.equal(replica.getSnapshot().authoritative, true);
  assert.equal(commits, 1, "later source updates must not retry the failed cache in this instance");
  replica.dispose();
});

test("disconnect preserves display state but removes authority", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  await server.commit([{ kind: "upsert", entityId: "a", value: value("A") }], {
    commandId: "seed",
  });
  const replica = client(storage, "offline");
  await replica.synchronize(server);
  replica.disconnect();

  assert.equal(replica.getSnapshot().phase, "offline");
  assert.equal(replica.getSnapshot().authoritative, false);
  assert.deepEqual(replica.get("a"), value("A"));
});

test("atomic JSON storage survives authority and client process replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-replica-"));
  const path = join(directory, "replica.json");
  try {
    const firstStorage = new JsonFileReplicaStorage(path);
    const server = new ReplicaAuthority({
      scope: SCOPE,
      storage: firstStorage,
      createEpoch: () => "file-epoch",
    });
    await server.commit([{ kind: "upsert", entityId: "persisted", value: value("persisted") }], {
      commandId: "persist",
    });
    const firstClient = client(firstStorage, "file-client");
    await firstClient.synchronize(server);
    firstClient.dispose();

    const restartedStorage = new JsonFileReplicaStorage(path);
    const restartedServer = new ReplicaAuthority({
      scope: SCOPE,
      storage: restartedStorage,
      createEpoch: () => "wrong-new-epoch",
    });
    await restartedServer.open();
    const restartedClient = client(restartedStorage, "file-client");
    await restartedClient.prepare();

    assert.deepEqual(restartedServer.cursor, { epoch: "file-epoch", nextSeq: 2 });
    assert.deepEqual(restartedClient.get("persisted"), value("persisted"));
    assert.equal(restartedClient.getSnapshot().phase, "painted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("IndexedDB storage paints the exact committed client cursor after reload", async () => {
  const databaseName = `opencraft-replica-test-${Date.now()}-${Math.random()}`;
  const serverStorage = new MemoryReplicaStorage();
  const server = authority(serverStorage);
  await server.commit([{ kind: "upsert", entityId: "web", value: value("web") }], {
    commandId: "web-seed",
  });
  const firstStorage = new IndexedDbReplicaClientStorage({ databaseName, factory: indexedDB });
  const first = client(firstStorage, "web-client");
  await first.synchronize(server);
  first.dispose();
  firstStorage.close();

  const restartedStorage = new IndexedDbReplicaClientStorage({ databaseName, factory: indexedDB });
  const restarted = client(restartedStorage, "web-client");
  await restarted.prepare();
  assert.equal(restarted.getSnapshot().phase, "painted");
  assert.deepEqual(restarted.getSnapshot().nextSeq, 2);
  assert.deepEqual(restarted.get("web"), value("web"));
  await restarted.clear();
  restartedStorage.close();

  const clearedStorage = new IndexedDbReplicaClientStorage({ databaseName, factory: indexedDB });
  assert.equal(await clearedStorage.loadClient("web-client"), null);
  clearedStorage.close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => reject(request.error));
  });
});

test("Cordis registry owns independent scoped replicas and disposes them", async () => {
  const storage = new MemoryReplicaStorage();
  const runtime = await createCordisReplicaRuntime(storage);
  const threads = runtime.replicas.create({ scope: "threads", storageKey: "host:threads" });
  const projects = runtime.replicas.create({ scope: "projects", storageKey: "host:projects" });

  assert.equal(runtime.replicas.get("threads"), threads);
  assert.deepEqual(runtime.replicas.list(), [threads, projects]);
  assert.equal(runtime.replicas.remove("threads"), true);
  await assert.rejects(async () => threads.prepare(), /disposed/);
  await runtime.dispose();
  await assert.rejects(async () => projects.prepare(), /disposed/);
});

test("V4 Replica sync, mutate and live entry cross the AppServer JSON-RPC boundary", async () => {
  const storage = new MemoryReplicaStorage();
  const server = authority(storage);
  const router = new ReplicaAuthorityRouter(server);
  let activePeer: InMemoryAppServerPeer | null = null;
  const removeNotifications = router.subscribe((notification) => {
    activePeer?.send(encodeJsonRpcMessage(notification));
  });
  const transport = new MemoryTransport({
    receive(frame, peer) {
      activePeer = peer;
      const request = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(request)) return;
      if (request.method === "initialize") {
        peer.send(encodeJsonRpcMessage({
          id: request.id,
          result: {
            codexHome: "/tmp/appserver-replica-fixture",
            platformFamily: "unix",
            platformOs: "linux",
            userAgent: "replica-wire-test/1",
          },
        }));
        return;
      }
      void router.handle(request.method, request.params).then(
        (result) => peer.send(encodeJsonRpcMessage({ id: request.id, result })),
        (error: unknown) => peer.send(encodeJsonRpcMessage({
          id: request.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        })),
      );
    },
  });
  const appserver = await createCordisAppServerRegistry();
  const rpcClient = appserver.clients.create({ hostId: "replica-host", transport });
  const replica = client(storage, "wire-client");
  try {
    await rpcClient.connect({ clientInfo: { name: "replica-test", version: "1" } });
    const source = createAppServerReplicaSource(rpcClient, SCOPE);
    await replica.synchronize(source);
    const response = await replica.mutate("wire-command", [
      { kind: "upsert", entityId: "over-wire", value: value("wire") },
    ]);
    await waitFor(() => replica.get("over-wire") !== null);

    assert.equal(response.replayed, false);
    assert.equal(replica.getSnapshot().epoch, "epoch-1");
    assert.equal(replica.getSnapshot().nextSeq, 2);
    assert.deepEqual(replica.get("over-wire"), value("wire"));
  } finally {
    replica.dispose();
    removeNotifications();
    router.dispose();
    await appserver.dispose();
  }
});

test("AppServer V3 adapter emits adjacent View revisions and snapshots every continuity break", async () => {
  const threadId = "thread-fixture";
  let current: ThreadView = {
    ...createEmptyThreadView("local", threadId),
    revision: 5,
    connectionGeneration: 1,
    resumeState: "resumed",
    resumeError: new Error("serialized failure"),
  };
  const listeners = new Set<() => void>();
  const source = createThreadViewReplicaSource({
    get: (candidate) => candidate === threadId ? current : null,
    subscribeThread: (_candidate, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }, "local", threadId);
  const storage = new MemoryReplicaStorage();
  const replica = new ReplicaClient({
    scope: source.scope,
    storageKey: "appserver-adapter",
    storage,
  });
  await replica.synchronize(source);
  assert.equal(replica.getSnapshot().epoch, "appserver-v3:local:1");
  assert.equal(replica.getSnapshot().nextSeq, 6);

  current = { ...current, revision: 6, notificationRevision: 1 };
  for (const listener of listeners) listener();
  await waitFor(() => replica.getSnapshot().nextSeq === 7);
  const record = replica.get(threadId);
  assert.equal(
    typeof record === "object" && record !== null && !Array.isArray(record)
      ? record.revision
      : null,
    6,
  );

  current = { ...current, revision: 8, notificationRevision: 3 };
  for (const listener of listeners) listener();
  await waitFor(() => replica.getSnapshot().nextSeq === 9);
  assert.equal(replica.getSnapshot().entities.size, 1);

  current = { ...current, revision: 9, connectionGeneration: 2 };
  for (const listener of listeners) listener();
  await waitFor(() => replica.getSnapshot().epoch === "appserver-v3:local:2");
  assert.equal(replica.getSnapshot().nextSeq, 10);
});

test("validation rechecks frozen getters and mutable descendants", async () => {
  const { validateEntities } = await import("@opencraft/appserver-replica");
  let value: unknown = "safe";
  const getter = Object.freeze({ get child() { return value; } });
  validateEntities([{ entityId: "getter", value: getter } as never]);
  value = undefined;
  assert.throws(() => validateEntities([{ entityId: "getter", value: getter } as never]), /JSON-safe/);
  const child: Record<string, unknown> = { text: "safe" };
  const outer = Object.freeze({ child });
  validateEntities([{ entityId: "outer", value: outer } as never]);
  child.text = NaN;
  assert.throws(() => validateEntities([{ entityId: "outer", value: outer } as never]), /JSON-safe/);
});


test("a binding reuses immutable projections across connection-local sources without reusing authority", async () => {
  let view = { ...createEmptyThreadView("local", "stable"), revision: 1, connectionGeneration: 1,
    turns: [{ id: "turn", items: [{ id: "item", type: "agentMessage", text: "immutable history" }] }],
  };
  const store = { get: () => view, subscribeThread: () => () => undefined };
  const cache = new WeakMap<object, ReplicaJsonValue>();
  const first = await createThreadViewReplicaSource(store, "local", "stable", cache).sync(null);
  assert.equal(first.kind, "snapshot");
  view = { ...view, revision: 2, connectionGeneration: 2 };
  const second = await createThreadViewReplicaSource(store, "local", "stable", cache).sync(null);
  assert.equal(second.kind, "snapshot");
  if (first.kind !== "snapshot" || second.kind !== "snapshot") throw Error("Expected snapshots");
  assert.notEqual(first.epoch, second.epoch);
  assert.equal((first.entities[0]!.value as any).turns, (second.entities[0]!.value as any).turns);
});


for (const hang of ["load", "commit"] as const) test(`hung cache ${hang} is bypassed without granting stale authority or racing accepted writes`, async () => {
  const entered = controlled<void>(), release = controlled<void>(), timers = new Set<() => void>();
  const subscribed: string[] = [], writes: string[] = [];
  const replica = new ReplicaClient({scope:SCOPE,storageKey:`timeout-${hang}`,storageTimeoutMs:50,
    storageClock:{setTimeout(callback){timers.add(callback);return callback;},clearTimeout(handle){timers.delete(handle as () => void);}},
    storage:{loadClient:async()=>{if(hang==='load'){entered.resolve();await release.promise;}return null;},
      commitClient:async state=>{writes.push(state.epoch);if(hang==='commit'){entered.resolve();await release.promise;}},clearClient:async()=>{}},
  });
  try {
    const old = replica.synchronize(ownedSource('old',subscribed));const canceled=assert.rejects(old,/superseded/);
    await entered.promise;replica.disconnect();await canceled;
    const next=replica.synchronize(ownedSource('new',subscribed));
    assert.equal(replica.getSnapshot().authoritative,false);
    for(const timer of [...timers])timer();
    await next;
    assert.equal(replica.getSnapshot().epoch,'new');assert.equal(replica.getSnapshot().authoritative,true);
    assert.match(replica.getSnapshot().cacheError?.message??'',/cache timed out/);
    assert.deepEqual(writes,hang==='commit'?['old']:[],'cache bypass never overlaps an accepted old write');
    release.resolve();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(replica.getSnapshot().epoch,'new');assert.equal(replica.getSnapshot().authoritative,true);
    assert.deepEqual(writes,hang==='commit'?['old']:[],'late cache completion cannot reenable persistence');
    await assert.rejects(replica.clear(),/Failed to clear/,'clear must not pretend a timed-out write was canceled');
  } finally {release.resolve();replica.dispose();}
});


test("default cache timers preserve the browser global receiver", async t => {
  const receivers: unknown[] = [];
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", function (this: unknown, ...args: Parameters<typeof setTimeout>) {
    receivers.push(this);
    assert.equal(this, globalThis);
    return Reflect.apply(schedule, globalThis, args);
  });
  t.mock.method(globalThis, "clearTimeout", function (this: unknown, ...args: Parameters<typeof clearTimeout>) {
    receivers.push(this);
    assert.equal(this, globalThis);
    return Reflect.apply(cancel, globalThis, args);
  });
  const replica = new ReplicaClient({ scope: SCOPE, storageKey: "browser-timer-receiver", storage: new MemoryReplicaStorage() });
  try {
    await replica.synchronize(ownedSource("timer-owner", []));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replica.getSnapshot().authoritative, true);
    assert.ok(receivers.length >= 2, "both timer setup and cleanup use the native global receiver");
  } finally { replica.dispose(); }
});
