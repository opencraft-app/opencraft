import assert from "node:assert/strict";
import test from "node:test";
import { HermesTranscriptWindow } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/transcript-window";
import { HermesDashboardHistoryClient } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/history-client";
import { HermesAppServerAdapter } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import { dispatchAppServerRequest } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol";
import type { HermesMessagesPage } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/types";

test("history cancellation reaches the HTTP request and rejects reconstruction", async () => {
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  const history = new HermesDashboardHistoryClient({
    async fetchJson(_path, options) {
      observed = options?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        observed?.addEventListener("abort", () => reject(observed!.reason), { once: true });
      });
    }, close() {},
  }, "test-only");
  const pending = new HermesTranscriptWindow(history, "s").readTail(controller.signal);
  assert.equal(observed, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("late response from an expired read cannot start another page", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = new HermesTranscriptWindow({
    async readMessages() {
      calls++;
      controller.abort();
      return { session_id: "s", messages: [{ id: 2, role: "assistant", content: "tail" }] };
    }, dispose() {},
  }, "s").readTail(controller.signal);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
});

for (const method of ["thread/resume", "thread/read", "thread/turns/list"]) {
  test(`${method}: cancellation reaches history and a late result cannot seed the next request`, async () => {
    let complete!: (page: HermesMessagesPage) => void;
    let received!: () => void;
    const entered = new Promise<void>(resolve => { received = resolve; });
    const pendingPage = new Promise<HermesMessagesPage>(resolve => { complete = resolve; });
    let calls = 0;
    let signal: AbortSignal | undefined;
    const adapter = new HermesAppServerAdapter({
      onEvent() { return () => {}; },
      async call<T>(name: string): Promise<T> {
        if (name === "session.resume") return { session_id: "live", stored_session_id: "s", messages: [], message_count: 2, running: false } as T;
        if (name === "session.list") return { sessions: [{ id: "s", title: "test", profile: "default", message_count: 2 }] } as T;
        throw new Error(`Unexpected RPC ${name}`);
      },
    }, "/", {
      async readMessages(_id, _query, inputSignal) {
        calls++;
        if (calls === 1) { signal = inputSignal; received(); return pendingPage; }
        return { session_id: "s", messages: [{ id: 100, role: "user", content: "fresh" }] };
      }, dispose() {},
    });
    try {
      await adapter.loadThread("s", false, "default");
      const controller = new AbortController();
      const result = dispatchAppServerRequest(adapter, { id: 1, method, params: {
        threadId: "s", includeTurns: true, excludeTurns: true, limit: 5,
      } }, { signal: controller.signal });
      await entered;
      assert.equal(signal, controller.signal);
      controller.abort();
      complete({ session_id: "s", messages: [{ id: 1, role: "user", content: "expired" }] });
      await assert.rejects(result, { name: "AbortError" });
      const fresh = await adapter.readTurnsPage("s", 0, 5, "desc");
      assert.equal(calls, 2, "expired page must not become the prepared Resume page");
      assert.equal(fresh.data[0].id, "hermes-turn-s-100");
      assert.throws(() => adapter.readTurnItems("hermes-turn-s-1"), /turn not found/);
    } finally { adapter.dispose(); }
  });
}

test("runtime failure cannot suppress a later independent REST preview", async () => {
  let finish!: (page: HermesMessagesPage) => void;
  const previews: unknown[] = [];
  const adapter = new HermesAppServerAdapter({
    onEvent() { return () => {}; },
    async call<T>(name: string): Promise<T> {
      if (name === "session.list") return { sessions: [{ id: "s", title: "test", preview: "", profile: "default" }] } as T;
      if (name === "session.resume") throw new Error("runtime unavailable");
      throw new Error(`Unexpected RPC ${name}`);
    },
  }, "/", {
    readMessages() { return new Promise(resolve => { finish = resolve; }); }, dispose() {},
  });
  try {
    await adapter.listThreads({ profile: "default" });
    adapter.subscribeNotification((method, params) => { if (method === "thread/history/preview") previews.push(params); });
    const pending = dispatchAppServerRequest(adapter, { id: 1, method: "thread/resume", params: {
      threadId: "s", excludeTurns: true, historyPreviewToken: "preview-owner", initialTurnsPage: { limit: 5 },
    } });
    await Promise.resolve();
    finish({ session_id: "s", messages: [{ id: 1, role: "user", content: "history survives" }] });
    await assert.rejects(pending, /runtime unavailable/);
    assert.equal(previews.length, 1);
  } finally { adapter.dispose(); }
});
