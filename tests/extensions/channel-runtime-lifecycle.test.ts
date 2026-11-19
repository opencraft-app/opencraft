import assert from "node:assert/strict";
import test from "node:test";
import { ChannelsClient, type ChannelRpc } from "../../plugins/im/src/channel-client";
import { createChannelRead, getChannelRuntime } from "../../plugins/im/src/channel-runtime";
import { createChannelDisplayCache } from "../../plugins/im/src/channel-display-cache";
const wait = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check());
};
function transport() {
  const changed = new Set<(id: string) => void>(),
    disconnected = new Set<() => void>(),
    recovered = new Set<() => void>();
  let identity = "one",
    subscriptions = 0;
  const rpc = {
    get draftScope() {
      return identity;
    },
    onRecoveryHint(fn: () => void) {
      recovered.add(fn);
      return () => {
        recovered.delete(fn);
      };
    },
    connect: async () => {},
    close: async () => {},
    async request(method: string) {
      if (method.endsWith("/subscribe")) subscriptions++;
      if (method === "opencraft/channels/list") return { groups: [] };
      if (method === "opencraft/personal-assistant/get") return { assistant: null, runtime: { phase: "stopped" } };
      return {};
    },
    onChanged(fn: (id: string) => void) {
      changed.add(fn);
      return () => {
        changed.delete(fn);
      };
    },
    onDisconnect(fn: () => void) {
      disconnected.add(fn);
      return () => {
        disconnected.delete(fn);
      };
    },
  } as unknown as ChannelRpc;
  return {
    rpc,
    hint() {
      for (const fn of [...recovered]) fn();
    },
    get hints() {
      return recovered.size;
    },
    get subscriptions() {
      return subscriptions;
    },
    disconnect() {
      for (const fn of [...disconnected]) fn();
    },
    switchAccount() {
      identity = "two";
      for (const fn of [...disconnected]) fn();
    },
  };
}
test("a replacement connection refreshes without waiting for an uncooperative old read", async () => {
  const t = transport(),
    scope = new AbortController(),
    signals: AbortSignal[] = [];
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    new ChannelsClient(fetch, t.rpc).watch(
      "a",
      async (signal) => {
        signals.push(signal);
        if (signals.length === 1) await held;
      },
      (error) => {
        throw error;
      },
      scope.signal,
    );
    await wait(() => signals.length === 1);
    t.disconnect();
    assert.equal(signals[0].aborted, true);
    await wait(() => signals.length === 2);
    assert.equal(signals[1].aborted, false);
    finish();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(signals.length, 2);
  } finally {
    scope.abort();
    finish();
  }
});
test("one authenticated runtime is reused and account retirement clears every replica", async () => {
  const t = transport(),
    scope = new AbortController(),
    runtime = getChannelRuntime(fetch, t.rpc, scope.signal);
  let revoked = 0;
  try {
    assert.equal(getChannelRuntime(fetch, t.rpc, scope.signal), runtime);
    runtime.subscribeScope(() => revoked++);
    await wait(() => runtime.directory.get().authoritative);
    assert.equal(t.subscriptions, 1);
    t.switchAccount();
    assert.equal(runtime.signal.aborted, true);
    assert.equal(runtime.getScope(), false);
    assert.equal(runtime.directory.get().value, undefined);
    assert.equal(runtime.assistant.get().value, undefined);
    assert.equal(revoked, 1);
    await assert.rejects(runtime.rpc.connect());
    await assert.rejects(runtime.rpc.request("opencraft/channels/list", {}));
  } finally {
    scope.abort();
  }
});
test("replica invalidation releases its old flight and fences late publications", async () => {
  const scope = new AbortController();
  let finish!: (v: string) => void,
    reads = 0;
  const old = new Promise<string>((r) => {
    finish = r;
  });
  const resource = createChannelRead(scope.signal, async () => (++reads === 1 ? old : "fresh"));
  try {
    const pending = resource.refresh();
    resource.invalidate();
    await resource.refresh();
    assert.equal(resource.get().value, "fresh");
    finish("retired");
    await pending;
    assert.equal(resource.get().value, "fresh");
    scope.abort();
    assert.equal(resource.get().value, undefined);
  } finally {
    scope.abort();
    finish("retired");
  }
});
test("a confirmed mutation wins over older reads and held polling", async () => {
  const scope = new AbortController();
  let finish!: (v: string) => void;
  const old = new Promise<string>((r) => {
    finish = r;
  });
  const resource = createChannelRead(scope.signal, () => old);
  try {
    const pending = resource.refresh(),
      release = resource.hold();
    resource.set("written");
    finish("old");
    await pending;
    await resource.refresh();
    assert.equal(resource.get().value, "written");
    release();
  } finally {
    scope.abort();
  }
});
const message = (sequence: number, text = "text") => ({
  sequence,
  messageId: "m" + sequence,
  author: "A",
  text,
  at: sequence,
  status: "received" as const,
});
test("display cache bounds messages and entries independently from drafts, including empty tombstones", () => {
  const cache = createChannelDisplayCache();
  cache.put("long", { messages: Array.from({ length: 100 }, (_, i) => message(i)), hasEarlier: false, cursor: "one" });
  assert.equal(cache.get("long")!.messages.length, 24);
  assert.equal(cache.get("long")!.hasEarlier, true);
  cache.put("bytes", {
    messages: Array.from({ length: 24 }, (_, i) => message(i, "a".repeat(4096))),
    hasEarlier: false,
  });
  assert.ok(cache.get("bytes")!.messages.length < 24);
  for (let i = 0; i < 65; i++) cache.put("g" + i, { messages: [message(i)], hasEarlier: false });
  assert.equal(cache.size, 64);
  assert.equal(cache.get("g0"), undefined);
  cache.put("empty", { messages: [], hasEarlier: false });
  assert.deepEqual(cache.get("empty")!.messages, []);
  cache.clear();
  assert.equal(cache.size, 0);
});
test("display cache shares ordinary conversation expiry and rejects invalid clock ages", () => {
  let now = 100;
  const cache = createChannelDisplayCache(() => now);
  cache.put("a", { messages: [message(1)], hasEarlier: false });
  now += 7 * 24 * 60 * 60 * 1000 + 1;
  assert.equal(cache.get("a"), undefined);
  cache.put("a", { messages: [], hasEarlier: false });
  now--;
  assert.equal(cache.get("a"), undefined);
});
test("global directory denial retires all account data even when the identity string is unchanged", async () => {
  const t = transport(),
    scope = new AbortController();
  t.rpc.request = async () => {
    throw Error("channel_denied");
  };
  const runtime = getChannelRuntime(fetch, t.rpc, scope.signal);
  try {
    await wait(() => runtime.signal.aborted);
    assert.equal(runtime.directory.get().value, undefined);
    assert.equal(runtime.assistant.get().value, undefined);
    assert.equal(runtime.getScope(), false);
  } finally {
    scope.abort();
  }
});
test("authentication retirement withdraws the global channel search contribution", async () => {
  const { createImExtension } = await import("../../plugins/im/src/index");
  const t = transport(),
    scope = new AbortController();
  let removed = 0;
  try {
    await createImExtension(fetch, () => t.rpc, true).activate({
      signal: scope.signal,
      views: { register() {} },
      sidebar: { registerCatalog() {} },
      internal: {
        register(kind: string) {
          return () => {
            if (kind === "nativeChannelSearch") removed++;
          };
        },
      },
      subscriptions: { add() {} },
      storage: {},
    } as any);
    t.switchAccount();
    assert.equal(removed, 1);
  } finally {
    scope.abort();
  }
});
test("a foreground recovery hint catches missed group updates without requiring a socket close", async () => {
  const t = transport(),
    scope = new AbortController();
  let refreshes = 0;
  try {
    new ChannelsClient(fetch, t.rpc).watch(
      "group:a",
      async () => {
        refreshes++;
      },
      (error) => {
        throw error;
      },
      scope.signal,
    );
    await wait(() => refreshes === 1);
    t.hint();
    await wait(() => refreshes === 2);
    assert.equal(t.subscriptions, 1, "healthy hint must not duplicate subscriptions");
    scope.abort();
    assert.equal(t.hints, 0);
    t.hint();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(refreshes, 2);
  } finally {
    scope.abort();
  }
});
test("foreground recovery replaces a stale read without waiting for its ignored cancellation", async (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const transportState = transport(),
    scope = new AbortController(),
    signals: AbortSignal[] = [];
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let display = "cached";
  try {
    new ChannelsClient(fetch, transportState.rpc).watch(
      "group:a",
      async (signal) => {
        signals.push(signal);
        if (signals.length === 1) await held;
        if (!signal.aborted) display = signals.length === 1 ? "old" : "fresh";
      },
      (error) => {
        throw error;
      },
      scope.signal,
    );
    await wait(() => signals.length === 1);
    now += 30000;
    transportState.hint();
    await wait(() => signals.length === 2);
    assert.equal(signals[0].aborted, true);
    assert.equal(display, "fresh");
    finish();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(display, "fresh");
    assert.equal(transportState.subscriptions, 2);
  } finally {
    scope.abort();
    finish();
  }
});
test("the shared directory runtime forwards transport recovery hints", async () => {
  const t = transport(),
    scope = new AbortController();
  let reads = 0;
  const original = t.rpc.request;
  t.rpc.request = (async (method, ...args) => {
    if (method === "opencraft/channels/list") reads++;
    return original(method, ...args);
  }) as ChannelRpc["request"];
  try {
    const runtime = getChannelRuntime(fetch, t.rpc, scope.signal);
    await wait(() => runtime.directory.get().authoritative);
    const before = reads;
    t.hint();
    await wait(() => reads > before);
    assert.equal(runtime.getScope(), true);
  } finally {
    scope.abort();
  }
});
test("recovery hints coalesce a healthy in-flight read instead of parallelizing it", async () => {
  const t = transport(),
    scope = new AbortController();
  let reads = 0,
    finish!: () => void;
  const held = new Promise<void>((r) => {
    finish = r;
  });
  try {
    new ChannelsClient(fetch, t.rpc).watch(
      "group:a",
      async () => {
        reads++;
        if (reads === 1) await held;
      },
      (error) => {
        throw error;
      },
      scope.signal,
    );
    await wait(() => reads === 1);
    for (let i = 0; i < 20; i++) t.hint();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(reads, 1);
    assert.equal(t.subscriptions, 1);
    finish();
    await wait(() => reads === 2);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(reads, 2);
  } finally {
    scope.abort();
    finish();
  }
});
test("a denied group watch is not revived by a foreground recovery hint", async () => {
  const { ImHttpError } = await import("../../plugins/im/src/client");
  const t = transport(),
    scope = new AbortController();
  let reads = 0,
    errors = 0;
  try {
    new ChannelsClient(fetch, t.rpc).watch(
      "group:a",
      async () => {
        reads++;
        throw new ImHttpError("channel_denied", 403);
      },
      () => {
        errors++;
      },
      scope.signal,
    );
    await wait(() => errors === 1);
    t.hint();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(reads, 1);
    assert.equal(errors, 1);
  } finally {
    scope.abort();
  }
});
