import assert from "node:assert/strict";
import test from "node:test";

import {
  SIDEBAR_LAYOUT_SCHEMA_VERSION,
  SidebarDragTransaction,
  SidebarLayoutStore,
  createSidebarEntityKey,
  mergeVisiblePinnedOrder,
  parseSidebarEntityKey,
  projectSidebarDrop,
  type SidebarLayoutDocument,
  type SidebarLayoutStorage,
} from "@opencraft/sidebar-layout";

class MemoryStorage implements SidebarLayoutStorage {
  document: SidebarLayoutDocument | null;
  failNextSave = false;
  readonly saves: SidebarLayoutDocument[] = [];

  constructor(document: SidebarLayoutDocument | null = null) {
    this.document = document;
  }

  async load(): Promise<SidebarLayoutDocument | null> {
    return this.document;
  }

  async save(_scope: string, document: SidebarLayoutDocument): Promise<SidebarLayoutDocument> {
    this.saves.push(document);
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("disk full");
    }
    this.document = document;
    return document;
  }
}

const document = (
  pinnedEntityKeys: readonly string[],
  ownership: SidebarLayoutDocument["ownership"] = "user",
): SidebarLayoutDocument => ({
  schemaVersion: SIDEBAR_LAYOUT_SCHEMA_VERSION,
  pinnedEntityKeys,
  ownership,
});

test("Sidebar entity identities are fully qualified and reversible", () => {
  const key = createSidebarEntityKey({
    kind: "bot",
    hostId: "remote:ssh/tokyo",
    entityId: "assistant:reviewer",
  });
  assert.deepEqual(parseSidebarEntityKey(key), {
    kind: "bot",
    hostId: "remote:ssh/tokyo",
    entityId: "assistant:reviewer",
  });
});

test("typed drop intent distinguishes before, after, append and unpin", () => {
  const one = createSidebarEntityKey({ kind: "bot", hostId: "h", entityId: "one" });
  const two = createSidebarEntityKey({ kind: "bot", hostId: "h", entityId: "two" });
  const three = createSidebarEntityKey({ kind: "bot", hostId: "h", entityId: "three" });
  assert.deepEqual(projectSidebarDrop([one, two], three, {
    kind: "place-pin",
    targetKey: two,
    edge: "before",
  }), [one, three, two]);
  assert.deepEqual(projectSidebarDrop([one, two], three, {
    kind: "place-pin",
    targetKey: one,
    edge: "after",
  }), [one, three, two]);
  assert.deepEqual(projectSidebarDrop([one, two], three, { kind: "append-pin" }), [one, two, three]);
  assert.deepEqual(projectSidebarDrop([one, two, three], two, { kind: "unpin" }), [one, three]);
});

test("a drag transaction projects every pointer frame from one immutable origin", () => {
  const one = createSidebarEntityKey({ kind: "bot", hostId: "h", entityId: "one" });
  const two = createSidebarEntityKey({ kind: "bot", hostId: "h", entityId: "two" });
  const three = createSidebarEntityKey({ kind: "bot", hostId: "h", entityId: "three" });
  const transaction = new SidebarDragTransaction();

  transaction.begin([one, two, three], two, "tile");
  assert.deepEqual(transaction.project({
    kind: "place-pin",
    targetKey: three,
    edge: "after",
  }).visiblePinnedKeys, [one, three, two]);
  assert.deepEqual(transaction.project({
    kind: "place-pin",
    targetKey: one,
    edge: "before",
  }).visiblePinnedKeys, [two, one, three]);

  const completion = transaction.complete();
  assert.deepEqual(completion?.visiblePinnedKeys, [two, one, three]);
  assert.equal(completion?.changed, true);
  assert.equal(transaction.getSnapshot().phase, "idle");
});

test("a drag transaction has one active owner and cancellation leaves no receipt", () => {
  const one = createSidebarEntityKey({ kind: "thread", hostId: "h", entityId: "one" });
  const transaction = new SidebarDragTransaction();
  transaction.begin([], one, "row");
  assert.throws(() => transaction.begin([], one, "row"), /already active/);
  assert.equal(transaction.cancel().phase, "idle");
  assert.equal(transaction.complete(), null);
});

test("duplicate sensor events reuse the drag snapshot instead of repainting the View", () => {
  const one = createSidebarEntityKey({ kind: "bot", hostId: "h", entityId: "one" });
  const two = createSidebarEntityKey({ kind: "bot", hostId: "h", entityId: "two" });
  const transaction = new SidebarDragTransaction();
  transaction.begin([one], two, "row");
  const first = transaction.project({ kind: "append-pin" });
  const duplicate = transaction.project({ kind: "append-pin" });
  assert.equal(duplicate, first);
});

test("visible reordering preserves unavailable extension entities", () => {
  assert.deepEqual(
    mergeVisiblePinnedOrder(
      ["hidden:a", "bot:one", "hidden:b", "bot:two"],
      ["bot:one", "bot:two", "bot:three"],
      ["bot:two", "bot:three", "bot:one"],
    ),
    ["hidden:a", "bot:two", "hidden:b", "bot:three", "bot:one"],
  );
});

test("async defaults merge until a user edit makes the layout authoritative", async () => {
  const storage = new MemoryStorage();
  const store = await SidebarLayoutStore.open(storage);
  store.adoptDefaults(["bot:hermes"]);
  store.adoptDefaults(["bot:other"]);
  assert.deepEqual(store.getSnapshot().pinnedEntityKeys, ["bot:hermes", "bot:other"]);
  assert.equal(store.getSnapshot().owned, false);
  store.commitVisibleOrder(["bot:hermes", "bot:other"], []);
  await store.flush();
  assert.deepEqual(storage.document?.pinnedEntityKeys, []);
  await store.close();

  const restored = await SidebarLayoutStore.open(storage);
  restored.adoptDefaults(["bot:hermes"]);
  assert.deepEqual(restored.getSnapshot().pinnedEntityKeys, []);
  await restored.close();
});

test("a semantic drop publishes optimistically before persistence completes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const storage: SidebarLayoutStorage = {
    async load() { return document(["bot:one"]); },
    async save(_scope, next) { await gate; return next; },
  };
  const store = await SidebarLayoutStore.open(storage);
  store.setPinned("bot:two", true);
  assert.equal(store.getSnapshot().phase, "saving");
  assert.deepEqual(store.getSnapshot().pinnedEntityKeys, ["bot:one", "bot:two"]);
  release();
  await store.flush();
  assert.equal(store.getSnapshot().phase, "ready");
  await store.close();
});

test("a failed current mutation rolls back to the durable document", async () => {
  const storage = new MemoryStorage(document(["bot:one"]));
  const store = await SidebarLayoutStore.open(storage);
  storage.failNextSave = true;
  store.setPinned("bot:two", true);
  assert.deepEqual(store.getSnapshot().pinnedEntityKeys, ["bot:one", "bot:two"]);
  await store.flush();
  assert.equal(store.getSnapshot().phase, "error");
  assert.deepEqual(store.getSnapshot().pinnedEntityKeys, ["bot:one"]);
  await store.close();
});

test("a stale failed write cannot roll back a newer optimistic layout", async () => {
  let rejectFirst!: () => void;
  const firstWrite = new Promise<void>((_resolve, reject) => {
    rejectFirst = () => reject(new Error("stale write failed"));
  });
  let saveCount = 0;
  let durable = document(["bot:one"]);
  const storage: SidebarLayoutStorage = {
    async load() { return durable; },
    async save(_scope, next) {
      saveCount += 1;
      if (saveCount === 1) await firstWrite;
      durable = next;
      return next;
    },
  };
  const store = await SidebarLayoutStore.open(storage);
  store.setPinned("bot:two", true);
  store.setPinned("bot:three", true);
  rejectFirst();
  await store.flush();
  assert.equal(store.getSnapshot().phase, "ready");
  assert.deepEqual(store.getSnapshot().pinnedEntityKeys, ["bot:one", "bot:two", "bot:three"]);
  assert.deepEqual(durable.pinnedEntityKeys, ["bot:one", "bot:two", "bot:three"]);
  await store.close();
});
