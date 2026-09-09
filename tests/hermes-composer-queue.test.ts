import assert from "node:assert/strict";
import test from "node:test";

import { HermesAppServerAdapter } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import {
  LocalStorageHermesComposerQueueStore,
  MemoryHermesComposerQueueStore,
} from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/composer-queue-store";
import type { HermesRpcClient } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/rpc-transport";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

test("Hermes composer queues persist by credential and Bot scope", () => {
  const storage = new MemoryStorage();
  const first = new LocalStorageHermesComposerQueueStore("account-a:bot-a", storage);
  first.replace("stored-thread", [{
    id: "queued-1",
    input: [{ type: "text", text: "persist me" }],
    clientUserMessageId: "client-1",
  }]);

  const restored = new LocalStorageHermesComposerQueueStore("account-a:bot-a", storage);
  assert.deepEqual(restored.read("stored-thread"), [{
    id: "queued-1",
    input: [{ type: "text", text: "persist me" }],
    clientUserMessageId: "client-1",
  }]);
  assert.deepEqual(
    new LocalStorageHermesComposerQueueStore("account-a:bot-b", storage).read("stored-thread"),
    [],
    "a different physical Bot must not inherit another Bot's pending queue",
  );
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
  const queue = new MemoryHermesComposerQueueStore();
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", undefined, undefined, undefined, queue);
  const thread = await adapter.startThread();
  const queued = adapter.addQueuedSubmission(
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
  const queue = new MemoryHermesComposerQueueStore();
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", undefined, undefined, undefined, queue);
  const thread = await adapter.startThread();
  const queued = adapter.addQueuedSubmission(
    thread.id,
    [{ type: "text", text: "do not lose me" }],
    "client-retry",
  );

  await assert.rejects(adapter.startQueuedSubmission(thread.id, queued.id), /admission rejected/u);
  assert.deepEqual(
    adapter.listQueuedSubmissions(thread.id, null, null).data.map((entry) => entry.id),
    [queued.id],
  );
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
  const queue = new MemoryHermesComposerQueueStore();
  queue.replace("stored-restored", [{
    id: "queued-restored",
    input: [{ type: "text", text: "resume me" }],
    clientUserMessageId: "client-restored",
  }]);
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
  const queue = new MemoryHermesComposerQueueStore();
  const adapter = new HermesAppServerAdapter(rpc, "/workspace", undefined, undefined, undefined, queue);
  const thread = await adapter.startThread();
  const queued = adapter.addQueuedSubmission(
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
