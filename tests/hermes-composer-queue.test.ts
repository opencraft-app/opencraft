import assert from "node:assert/strict";
import test from "node:test";

import { HermesAppServerAdapter } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import {
  BrowserHermesComposerQueueService,
  MemoryHermesComposerQueueService,
} from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/composer-queue/service";
import type { HermesRpcClient } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/rpc-transport";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

test("Hermes composer queues persist by credential and Bot scope", async () => {
  const storage = new MemoryStorage();
  const first = new BrowserHermesComposerQueueService("account-a:bot-a", storage);
  await first.add("stored-thread", {
    id: "queued-1",
    input: [{ type: "text", text: "persist me" }],
    clientUserMessageId: "client-1",
    createdAt: 1,
    pausedReason: null,
  });

  const restored = new BrowserHermesComposerQueueService("account-a:bot-a", storage);
  assert.deepEqual(restored.read("stored-thread"), [{
    id: "queued-1",
    input: [{ type: "text", text: "persist me" }],
    clientUserMessageId: "client-1",
    createdAt: 1,
    pausedReason: null,
  }]);
  assert.deepEqual(
    new BrowserHermesComposerQueueService("account-a:bot-b", storage).read("stored-thread"),
    [],
    "a different physical Bot must not inherit another Bot's pending queue",
  );
});

test("an empty queue is a revisioned tombstone visible to every queue owner", async () => {
  const storage = new MemoryStorage();
  const first = new BrowserHermesComposerQueueService("shared", storage);
  await first.add("thread", {
    id: "queued",
    input: [{ type: "text", text: "once" }],
    clientUserMessageId: "client-once",
    createdAt: 1,
    pausedReason: null,
  });
  const second = new BrowserHermesComposerQueueService("shared", storage);
  assert.equal(second.read("thread").length, 1);
  await first.remove("thread", "queued");
  assert.deepEqual(second.read("thread"), []);
  first.dispose();
  second.dispose();
});

test("one Thread queue has exactly one consumption owner", async () => {
  const storage = new MemoryStorage();
  const first = new BrowserHermesComposerQueueService("lease", storage);
  const second = new BrowserHermesComposerQueueService("lease", storage);
  await first.add("thread", {
    id: "queued",
    input: [{ type: "text", text: "once" }],
    clientUserMessageId: "client-once",
    createdAt: 1,
    pausedReason: null,
  });
  let release!: () => void;
  const consuming = first.withConsumptionLease("thread", "queued", async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return "accepted";
  });
  while (release === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    await second.withConsumptionLease("thread", "queued", async () => "duplicate"),
    { acquired: false },
  );
  release();
  assert.deepEqual(await consuming, { acquired: true, value: "accepted" });
  first.dispose();
  second.dispose();
});

test("Hermes queue removes an entry only after Gateway admission accepts it", async () => {
  let acceptPrompt: ((value: { status: string }) => void) | null = null;
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      if (method === "session.create") {
        return {
          session_id: "live-queue-accept",
          stored_session_id: "stored-queue-accept",
          message_count: 0,
          messages: [],
        } as T;
      }
      if (method === "prompt.submit") {
        return await new Promise<T>((resolve) => {
          acceptPrompt = (value) => resolve(value as T);
        });
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const queue = new MemoryHermesComposerQueueService();
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", undefined, undefined, undefined, queue);
  const thread = await adapter.startThread();
  const queued = await adapter.addQueuedSubmission(
    thread.id,
    [{ type: "text", text: "next" }],
    "client-next",
  );

  const start = adapter.startQueuedSubmission(thread.id, queued.id);
  while (acceptPrompt === null) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(adapter.listQueuedSubmissions(thread.id, null, null).data.length, 1);
  acceptPrompt?.({ status: "running" });
  await start;
  assert.equal(adapter.listQueuedSubmissions(thread.id, null, null).data.length, 0);
  adapter.dispose();
  queue.dispose();
});

test("Hermes queue retains an entry when Gateway admission fails", async () => {
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      if (method === "session.create") {
        return {
          session_id: "live-queue-reject",
          stored_session_id: "stored-queue-reject",
          message_count: 0,
          messages: [],
        } as T;
      }
      if (method === "prompt.submit") throw new Error("admission rejected");
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const queue = new MemoryHermesComposerQueueService();
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", undefined, undefined, undefined, queue);
  const thread = await adapter.startThread();
  const queued = await adapter.addQueuedSubmission(
    thread.id,
    [{ type: "text", text: "do not lose me" }],
    "client-retry",
  );

  await assert.rejects(adapter.startQueuedSubmission(thread.id, queued.id), /admission rejected/u);
  assert.deepEqual(
    adapter.listQueuedSubmissions(thread.id, null, null).data.map((entry) => ({
      id: entry.id,
      pausedReason: entry.pausedReason,
    })),
    [{ id: queued.id, pausedReason: "admission rejected" }],
  );
  adapter.dispose();
  queue.dispose();
});

test("an automatic queue admission failure pauses once and never retries itself", async () => {
  let attempts = 0;
  const rpc: HermesRpcClient = {
    async call<T>(method: string): Promise<T> {
      if (method === "session.resume") {
        return {
          session_id: "live-no-retry",
          stored_session_id: "stored-no-retry",
          message_count: 0,
          messages: [],
          running: false,
        } as T;
      }
      if (method === "session.list") {
        return { sessions: [{
          id: "stored-no-retry",
          title: "No retry",
          preview: "",
          started_at: 1,
          message_count: 0,
          source: "desktop",
          profile: "default",
        }] } as T;
      }
      if (method === "profiles.list") return { profiles: [{ name: "default" }] } as T;
      if (method === "prompt.submit") {
        attempts += 1;
        throw new Error("outcome unknown");
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const queue = new MemoryHermesComposerQueueService();
  await queue.add("stored-no-retry", {
    id: "queued-no-retry",
    input: [{ type: "text", text: "exactly once" }],
    clientUserMessageId: "client-no-retry",
    createdAt: 1,
    pausedReason: null,
  });
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", undefined, undefined, undefined, queue);
  await adapter.loadThread("stored-no-retry", false);
  adapter.resumeQueuedSubmissions("stored-no-retry");
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(attempts, 1);
  assert.equal(queue.read("stored-no-retry")[0]?.pausedReason, "outcome unknown");
  adapter.resumeQueuedSubmissions("stored-no-retry");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1, "level-triggered resume cannot consume a paused item");
  adapter.dispose();
  queue.dispose();
});

test("an idle resumed Hermes Thread level-triggers its restored queue", async () => {
  const submitted: string[] = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      if (method === "session.resume") {
        return {
          session_id: "live-restored",
          stored_session_id: "stored-restored",
          message_count: 0,
          messages: [],
          running: false,
        } as T;
      }
      if (method === "session.list") {
        return { sessions: [{
          id: "stored-restored",
          title: "Restored",
          preview: "",
          started_at: 1,
          message_count: 0,
          source: "desktop",
          profile: "default",
        }] } as T;
      }
      if (method === "profiles.list") {
        return { profiles: [{ name: "default" }] } as T;
      }
      if (method === "prompt.submit") {
        submitted.push(String((params as { text?: unknown }).text ?? ""));
        return { status: "running" } as T;
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const queue = new MemoryHermesComposerQueueService();
  await queue.add("stored-restored", {
    id: "queued-restored",
    input: [{ type: "text", text: "resume me" }],
    clientUserMessageId: "client-restored",
    createdAt: 1,
    pausedReason: null,
  });
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", undefined, undefined, undefined, queue);
  await adapter.loadThread("stored-restored", false);

  adapter.resumeQueuedSubmissions("stored-restored");
  while (submitted.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, ["resume me"]);
  assert.deepEqual(queue.read("stored-restored"), []);
  adapter.dispose();
  queue.dispose();
});

test("explicit interrupt parks queued Hermes work until a manual resume", async () => {
  const submitted: string[] = [];
  const rpc: HermesRpcClient = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      if (method === "session.create") {
        return {
          session_id: "live-parked",
          stored_session_id: "stored-parked",
          message_count: 0,
          messages: [],
          running: false,
        } as T;
      }
      if (method === "session.interrupt") return {} as T;
      if (method === "prompt.submit") {
        submitted.push(String((params as { text?: unknown }).text ?? ""));
        return { status: "running" } as T;
      }
      throw new Error(`Unexpected ${method}`);
    },
    onEvent: () => () => undefined,
  };
  const queue = new MemoryHermesComposerQueueService();
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", undefined, undefined, undefined, queue);
  const thread = await adapter.startThread();
  const queued = await adapter.addQueuedSubmission(
    thread.id,
    [{ type: "text", text: "wait for me" }],
    "client-parked",
  );

  await adapter.cancelTurn(thread.id);
  adapter.resumeQueuedSubmissions(thread.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, []);

  await adapter.startQueuedSubmission(thread.id, queued.id);
  assert.deepEqual(submitted, ["wait for me"]);
  assert.deepEqual(queue.read(thread.id), []);
  adapter.dispose();
  queue.dispose();
});
