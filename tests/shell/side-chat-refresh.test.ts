import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey } from "@opencraft/chat-core";
import { SideChatService, type SideChatRecord } from "@opencraft/workbench-runtime";
import { createSideChatPersistence } from "../../apps/workbench-web/src/runtime/side-chat-persistence";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
    clear: () => values.clear(),
  };
}
function fixture() {
  const disk = storage(),
    persistence = createSideChatPersistence(disk);
  const calls = { fork: 0, inject: 0, release: 0, interrupt: 0, unsubscribe: 0, acquire: [] as string[] };
  let acquire = async (id: string) => ({
    threadId: id,
    release: () => {
      calls.release++;
    },
    getSnapshot: () => ({ activeTurn: { turnId: "active" }, timeline: { frames: ["original history"] } }),
    interrupt: async () => {
      calls.interrupt++;
    },
  });
  const host: any = {
    resources: {
      threads: {
        fork: async (params: any, options: any) => {
          calls.fork++;
          assert.equal(params.ephemeral, false);
          assert.equal(options.deduplicate, false);
          return { id: "child-" + calls.fork };
        },
        injectItems: async () => {
          calls.inject++;
        },
        unsubscribe: async () => {
          calls.unsubscribe++;
        },
        supportsSideChat: () => true,
      },
    },
    acquireThread: async (id: string) => {
      calls.acquire.push(id);
      return acquire(id);
    },
  };
  const parent = createConversationKey("host", "parent");
  const create = async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(SideChatService, { resolveHost: async () => host, persistence });
    await fiber;
    return { service: ctx.sideChats, dispose: () => fiber.dispose() };
  };
  const record = (id: string, thread = id): SideChatRecord => ({
    id,
    parent,
    key: createConversationKey("host", thread),
  });
  return {
    disk,
    persistence,
    calls,
    host,
    parent,
    create,
    record,
    setAcquire: (fn: typeof acquire) => {
      acquire = fn;
    },
  };
}

test("page teardown detaches; fresh application recovers exact child/history without fork, injection or interruption", async () => {
  const f = fixture(),
    first = await f.create();
  const original = await first.service.open("original", f.parent, null);
  await first.dispose();
  assert.equal(f.calls.interrupt, 0);
  assert.equal(f.calls.unsubscribe, 0);
  const fresh = await f.create();
  try {
    await Promise.all([fresh.service.restore(f.parent), fresh.service.restore(f.parent)]);
    assert.equal(fresh.service.get("original")?.key.threadId, original.key.threadId);
    assert.deepEqual(fresh.service.get("original")?.lease.getSnapshot().timeline.frames, ["original history"]);
    assert.deepEqual(f.calls.acquire, ["child-1", "child-1"]);
    assert.equal(f.calls.fork, 1);
    assert.equal(f.calls.inject, 1);
    await fresh.service.close("original");
    assert.equal(f.calls.interrupt, 1);
    assert.equal(f.calls.unsubscribe, 1);
    assert.deepEqual(f.persistence.list(f.parent), []);
    await fresh.service.restore(f.parent);
    assert.equal(fresh.service.get("original"), null);
  } finally {
    await fresh.dispose();
  }
});

test("a close fences delayed acquisition and prevents the original reference from reappearing", async () => {
  const f = fixture();
  f.persistence.put(f.record("saved"));
  let resolve!: (value: any) => void;
  f.setAcquire(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const app = await f.create();
  const pending = app.service.restore(f.parent);
  await new Promise((r) => setTimeout(r, 0));
  await app.service.close("saved");
  resolve({
    release() {
      f.calls.release++;
    },
  });
  await pending;
  assert.equal(app.service.get("saved"), null);
  assert.equal(f.calls.release, 1);
  assert.deepEqual(app.service.records(f.parent), []);
  assert.equal(f.calls.fork, 0);
  await app.dispose();
});

test("a missing child keeps an explicit recoverable error and cannot suppress another child", async () => {
  const f = fixture();
  f.persistence.put(f.record("gone"));
  f.persistence.put(f.record("good"));
  const original = f.host.acquireThread;
  f.host.acquireThread = async (id: string) => {
    if (id === "gone") throw Error("Original child unavailable");
    return original(id);
  };
  const app = await f.create();
  try {
    await app.service.restore(f.parent);
    assert.match(app.service.getRecoveryError("gone")!.message, /unavailable/);
    assert.ok(app.service.get("good"));
    assert.equal(app.service.records(f.parent).length, 2);
    f.host.acquireThread = original;
    await app.service.restore(f.parent);
    assert.ok(app.service.get("gone"));
    assert.equal(app.service.getRecoveryError("gone"), null);
    assert.equal(f.calls.fork, 0);
    assert.equal(f.calls.inject, 0);
  } finally {
    await app.dispose();
  }
});

test("persistence isolates Host/parent, rejects corrupt references and uses independent entity writes", () => {
  const f = fixture();
  f.persistence.put(f.record("one"));
  f.persistence.put(f.record("two"));
  f.disk.setItem("opencraft.side-chat.v1:bad", "{");
  f.disk.setItem(
    "opencraft.side-chat.v1:foreign",
    JSON.stringify({ ...f.record("foreign"), key: createConversationKey("other-host", "foreign") }),
  );
  assert.equal(f.persistence.list(f.parent).length, 2);
  assert.deepEqual(f.persistence.list(createConversationKey("other-host", "parent")), []);
  assert.deepEqual(f.persistence.list(createConversationKey("host", "other-parent")), []);
  f.persistence.remove("one");
  assert.deepEqual(
    f.persistence.list(f.parent).map((row) => row.id),
    ["two"],
  );
});

test("a known child is classified while its boundary is pending and after a failed creation is closed", async () => {
  const f = fixture();
  let rejectBoundary!: (error: Error) => void;
  f.host.resources.threads.injectItems = () =>
    new Promise((_resolve, reject) => {
      rejectBoundary = reject;
    });
  const app = await f.create();
  const opening = app.service.open("failed", f.parent, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const key = createConversationKey("host", "child-1");
  assert.deepEqual(app.service.ownershipOf(key), { kind: "side-chat", owner: f.parent });
  rejectBoundary(Error("boundary rejected"));
  await assert.rejects(opening, /boundary rejected/);
  assert.deepEqual(f.persistence.directory?.(), [{ id: "failed", parent: f.parent, key, closed: true }]);
  await app.dispose();
  const fresh = await f.create();
  try {
    assert.equal(fresh.service.ownershipOf(key).kind, "side-chat");
    assert.deepEqual(fresh.service.records(f.parent), []);
    assert.equal(f.calls.fork, 1);
  } finally {
    await fresh.dispose();
  }
});

test("disposal during recovery releases the late lease without stopping the child or removing its reference", async () => {
  const f = fixture();
  f.persistence.put(f.record("saved"));
  let resolve!: (value: any) => void;
  f.setAcquire(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const app = await f.create();
  const pending = app.service.restore(f.parent);
  await new Promise((r) => setTimeout(r, 0));
  await app.dispose();
  resolve({
    release() {
      f.calls.release++;
    },
  });
  await pending;
  assert.equal(app.service.get("saved"), null);
  assert.equal(f.calls.release, 1);
  assert.equal(f.persistence.list(f.parent).length, 1);
  assert.equal(f.calls.interrupt, 0);
  assert.equal(f.calls.unsubscribe, 0);
});

test("failed removal leaves the session intact and close can be retried", async () => {
  const f = fixture(),
    app = await f.create();
  await app.service.open("saved", f.parent, null);
  const write = f.disk.setItem;
  f.disk.setItem = () => {
    throw Error("storage unavailable");
  };
  await assert.rejects(app.service.close("saved"), /storage unavailable/);
  assert.ok(app.service.get("saved"));
  assert.equal(f.calls.release, 0);
  assert.equal(f.calls.interrupt, 0);
  f.disk.setItem = write;
  await app.service.close("saved");
  assert.equal(app.service.get("saved"), null);
  await app.dispose();
});

test("independent side-chat intents from the same parent own distinct durable children", async () => {
  const f = fixture(),
    app = await f.create();
  const children = await Promise.all([
    app.service.open("one", f.parent, null),
    app.service.open("two", f.parent, null),
  ]);
  assert.notEqual(children[0].key.threadId, children[1].key.threadId);
  assert.equal(f.persistence.list(f.parent).length, 2);
  await app.dispose();
});

test("an embedder without persistence retains closed ownership for the application lifetime", async () => {
  const f = fixture(),
    ctx = new Context();
  const fiber = ctx.plugin(SideChatService, { resolveHost: async () => f.host });
  await fiber;
  try {
    const session = await ctx.sideChats.open("owned", f.parent, null);
    await ctx.sideChats.close("owned");
    assert.equal(ctx.sideChats.ownershipOf(session.key).kind, "side-chat");
    assert.equal(ctx.sideChats.ownershipOf(createConversationKey("host", "ordinary")).kind, "independent");
  } finally {
    await fiber.dispose();
  }
});

test("native fork instructions create and recover a side chat without an injection API", async () => {
  const f = fixture();
  f.host.resources.threads.sideChatBoundary = () => "thread-settings";
  f.host.resources.threads.injectItems = undefined;
  let configured = 0;
  f.host.resources.threads.configureSideChat = async (_id: string, instructions: string) => {
    configured++;
    assert.match(instructions, /new user message before doing any work/);
  };
  const fork = f.host.resources.threads.fork;
  f.host.resources.threads.fork = async (params: any, options: any) => {
    assert.equal(params.deferGoalContinuation, true);
    assert.match(params.developerInstructions, /new user message before doing any work/);
    assert.match(params.developerInstructions, /inherited.*reference context/);
    return fork(params, options);
  };
  const first = await f.create();
  const session = await first.service.open("native", f.parent, null);
  assert.equal(f.calls.fork, 1);
  assert.equal(f.calls.inject, 0);
  assert.equal(configured, 1);
  await first.dispose();
  const next = await f.create();
  try {
    await next.service.restore(f.parent);
    assert.equal(next.service.get("native")?.key.threadId, session.key.threadId);
    assert.equal(f.calls.fork, 1);
    assert.equal(f.calls.inject, 0);
    await next.service.close("native");
    assert.equal(f.calls.unsubscribe, 1);
  } finally {
    await next.dispose();
  }
});

test("missing boundary capabilities reject before forking", async () => {
  const f = fixture();
  f.host.resources.threads.sideChatBoundary = () => null;
  const app = await f.create();
  try {
    await assert.rejects(app.service.open("unsupported", f.parent, null), /does not support/);
    assert.equal(f.calls.fork, 0);
  } finally {
    await app.dispose();
  }
});

test("failed native policy preparation cleans up the allocated child without publishing it", async () => {
  const f = fixture();
  f.host.resources.threads.sideChatBoundary = () => "thread-settings";
  f.host.resources.threads.configureSideChat = async () => {
    throw Error("policy preparation failed");
  };
  const app = await f.create();
  try {
    await assert.rejects(app.service.open("failed-native", f.parent, null), /policy preparation failed/);
    assert.equal(f.calls.fork, 1);
    assert.equal(f.calls.inject, 0);
    assert.equal(f.calls.unsubscribe, 1);
    assert.equal(app.service.get("failed-native"), null);
    assert.deepEqual(f.persistence.list(f.parent), []);
  } finally {
    await app.dispose();
  }
});

test("save failure stays visible and retries the same allocated child", async () => {
  const f = fixture(),
    originalPut = f.persistence.put;
  let fail = true;
  f.persistence.put = (record) => {
    if (fail) throw new Error("directory unavailable");
    return originalPut(record);
  };
  const app = await f.create();
  await assert.rejects(app.service.open("attempt", f.parent, null), /directory unavailable/);
  assert.equal(app.service.getCreationError("attempt")?.message, "directory unavailable");
  assert.deepEqual(app.service.pendingIds(f.parent), ["attempt"]);
  assert.equal(f.calls.fork, 1);
  assert.equal(f.calls.unsubscribe, 0);
  fail = false;
  await app.service.retryCreation("attempt");
  assert.equal(app.service.get("attempt")?.key.threadId, "child-1");
  assert.equal(f.calls.fork, 1);
  assert.equal(f.calls.inject, 1);
  assert.equal(app.service.getCreationError("attempt"), null);
  await app.dispose();
});

test("creation checks metadata readiness before allocating a native child", async () => {
  const f = fixture();
  f.persistence.ready = async () => {
    throw new Error("account disconnected");
  };
  const app = await f.create();
  await assert.rejects(app.service.open("attempt", f.parent, null), /account disconnected/);
  assert.equal(f.calls.fork, 0);
  assert.equal(app.service.getCreationError("attempt")?.message, "account disconnected");
  f.persistence.ready = async () => {};
  await app.service.retryCreation("attempt");
  assert.equal(f.calls.fork, 1);
  await app.dispose();
});

test("policy failure is reported without waiting for stalled cleanup", async () => {
  const f = fixture();
  let release!: () => void;
  f.host.resources.threads.injectItems = async () => {
    throw new Error("policy rejected");
  };
  f.persistence.remove = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const app = await f.create();
  await assert.rejects(app.service.open("attempt", f.parent, null), /policy rejected/);
  assert.equal(app.service.getCreationError("attempt")?.message, "policy rejected");
  assert.equal(app.service.pendingCleanup().length, 1);
  release();
  await app.service.close("attempt");
  await app.dispose();
});
