import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { AppServerClientRegistry, type AppServerClient, type AppServerRequestLifecycleEvent } from "@opencraft/appserver-client";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { createCordisThreadSessionRuntime } from "@opencraft/appserver-session";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { readUserMessageDisplayText } from "@opencraft/chat-core";
import { TurnCompletionObserver, readTurnCompletion, type TurnCompletion } from "../../packages/workbench-runtime/src/turn-completions";
import { BrowserTurnNotifications } from "../../apps/workbench-web/src/runtime/browser-turn-notifications";
import { DshAppServerAdapter } from "../../apps/local-agent-host/src/dsh-appserver-adapter";
import type { DshClient } from "../../apps/local-agent-host/src/dsh-client";

function sourceFixture() {
  type Notification = { method: string; params: unknown };
  const hosts = new Map<string, { emit(value: Notification): void; response(method: string, result: unknown, beforeCompletion?: () => void, params?: unknown): void; client: AppServerClient; listeners: Set<(value: Notification) => void> }>();
  const registryListeners = new Set<(event: { hostId: string }) => void>();
  const registry = {
    get: (hostId: string) => hosts.get(hostId)?.client ?? null,
    getSnapshot: () => ({ revision: 1, hostIds: [...hosts.keys()] }),
    subscribeEvent: (listener: (event: { hostId: string }) => void) => { registryListeners.add(listener); return () => { registryListeners.delete(listener); }; },
  } as Pick<AppServerClientRegistry, "get" | "getSnapshot" | "subscribeEvent">;
  const add = (hostId: string) => {
    const listeners = new Set<(value: Notification) => void>();
    const responses = new Set<(event: AppServerRequestLifecycleEvent) => void>();
    const slot = { listeners, emit: (value: Notification) => { for (const listener of listeners) listener(value); },
      response: (method: string, result: unknown, beforeCompletion?: () => void, params: unknown = {}) => {
        for (const listener of responses) listener({ type: "started", hostId, id: "request", method, priority: "user-visible", startedAtMs: 0, queueWaitMs: 0, params, timeoutMs: 1000 });
        beforeCompletion?.();
        for (const listener of responses) listener({ type: "completed", hostId, id: "request", method, priority: "user-visible", endedAtMs: 1, durationMs: 1, result });
      },
      client: {
        subscribeNotification: (listener: (value: Notification) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        subscribeRequestLifecycle: (listener: (event: AppServerRequestLifecycleEvent) => void) => { responses.add(listener); return () => { responses.delete(listener); }; },
      } as AppServerClient };
    hosts.set(hostId, slot);
    for (const listener of registryListeners) listener({ hostId });
    return slot;
  };
  const remove = (hostId: string) => { hosts.delete(hostId); for (const listener of registryListeners) listener({ hostId }); };
  return { registry, add, remove, registryListeners };
}
const finished = (status = "completed", turnId = "turn", threadId = "thread") => ({ method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });
const userItem = (id: string, text: string) => ({ id, type: "userMessage", content: [{ type: "text", text }] });

test("notification context belongs to its Host/Thread/Turn, follows rename and the latest accepted input", () => {
  const f = sourceFixture(); const a = f.add("host-a"); const b = f.add("host-b");
  const source = new TurnCompletionObserver(f.registry); const values: TurnCompletion[] = [];
  source.subscribe(value => values.push(value));
  a.response("thread/list", { data: [{ id: "thread", name: "初始标题", preview: "first message" }] });
  a.emit({ method: "thread/name/updated", params: { threadId: "thread", threadName: "新的标题" } });
  const input = (item: unknown, turnId = "turn", method = "item/started") => a.emit({ method, params: { threadId: "thread", turnId, item } });
  input(userItem("first", "最初的请求")); input(userItem("steer", "最终的\n请求"));
  input(userItem("first", "最初的请求"), "turn", "item/completed");
  input({ ...userItem("pending", "还在排队"), steeringStatus: "pending" });
  input(userItem("next", "下一轮请求"), "next-turn");
  a.emit({ method: "thread/queue/updated", params: { threadId: "thread", input: [userItem("queued", "排队消息")] } });
  a.response("thread/read", { thread: { id: "other-thread", name: "另一对话", turns: [{ id: "turn", items: [userItem("other", "其他会话请求")] }] } });
  a.response("thread/read", { thread: { id: "thread", name: "旧标题", turns: [{ id: "turn", items: [userItem("first", "旧历史请求")] }] } },
    () => a.emit({ method: "thread/name/updated", params: { threadId: "thread", threadName: "最终标题" } }));
  b.response("thread/read", { thread: { id: "thread", name: "第二个 Host 的对话", turns: [{ id: "turn", items: [userItem("other-host", "其他执行方请求")] }] } });
  assert.equal(values.length, 0, "history and context never trigger notifications");
  a.emit(finished()); b.emit(finished()); a.emit(finished("completed", "turn", "other-thread"));
  assert.deepEqual(values.map(v => [v.threadTitle, v.userMessage]), [["最终标题", "最终的 请求"], ["第二个 Host 的对话", "其他执行方请求"], ["另一对话", "其他会话请求"]]);
  source.dispose();
});

test("completion snapshots supply context without Item events, fallback is honest and summaries preserve Unicode", () => {
  const f = sourceFixture(); const a = f.add("host-c"); const source = new TurnCompletionObserver(f.registry);
  const values: TurnCompletion[] = []; source.subscribe(v => values.push(v));
  a.emit({ method: "thread/started", params: { thread: { id: "thread", name: null, preview: "😀".repeat(90) } } });
  a.emit({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed", itemsView: "full", items: [userItem("one", "旧请求"), userItem("two", "你好😀".repeat(80)), { id: "answer", type: "agentMessage", text: "Do not include the answer" }] } } });
  assert.equal(Array.from(values[0]!.threadTitle!).length, 80);
  assert.equal(Array.from(values[0]!.userMessage!).length, 160);
  assert.ok(values[0]!.userMessage!.endsWith("…")); assert.ok(!values[0]!.userMessage!.includes("\uFFFD"));
  f.remove("host-c"); const replacement = f.add("host-c"); replacement.emit(finished("completed", "other-turn"));
  assert.equal(values[1]!.threadTitle, undefined); assert.equal(values[1]!.userMessage, undefined);
  source.dispose();
});

test("message summaries reuse visible Chat text, hiding attachment instructions and rejecting unaccepted messages", () => {
  const hidden = 'Private attachment context'; const visible = '查看这个文件';
  const text = hidden + visible;
  const message = { ...userItem("file", text), content: [{ type: "text", text, text_elements: [{ byte_range: { start: 0, end: new TextEncoder().encode(hidden).length }, placeholder: "opencraft:staged-file:v1" }] }] };
  assert.equal(readUserMessageDisplayText(message), visible);
  assert.equal(readUserMessageDisplayText(userItem("request", "## Prior conversation with Codex:\ncontext\n## My request for Codex:\n真正的请求")), "真正的请求");
  assert.equal(readUserMessageDisplayText({ ...userItem("pending", "not accepted"), __opencraftMessageKind: "steering", __opencraftSteeringStatus: "pending" }), null);
  assert.equal(readUserMessageDisplayText({ ...userItem("accepted", "visible"), __opencraftMessageKind: "steering", __opencraftSteeringStatus: "accepted" }), "visible");
  assert.equal(readUserMessageDisplayText({ ...userItem("pending-new", "hidden"), __opencraftMessageKind: "steering", __opencraftSteeringStatus: "pending" }), null);
  assert.equal(readUserMessageDisplayText({ ...userItem("failed", "not sent"), deliveryStatus: "failed" }), null);
  assert.equal(readUserMessageDisplayText({ id: "answer", type: "agentMessage", text: "answer" }), null);
});

test("restored paginated history supplies context and never replaces newer live input", () => {
  for (const method of ["thread/resume", "thread/turns/list", "thread/items/list"]) {
    const f = sourceFixture(); const host = f.add("host-a"); const source = new TurnCompletionObserver(f.registry);
    const values: TurnCompletion[] = []; source.subscribe(value => values.push(value));
    const turn = { id: "turn", items: [userItem("one", "旧请求"), userItem("two", "分页恢复的请求")] };
    const result = method === "thread/resume" ? { thread: { id: "thread", turns: [] }, initialTurnsPage: { data: [turn] } }
      : method === "thread/turns/list" ? { data: [turn] }
      : { data: [...turn.items].reverse().map(item => ({ turnId: "turn", item })) };
    const params = { threadId: "thread", turnId: "turn", sortDirection: "desc" };
    host.response(method, result, undefined, params);
    assert.equal(values.length, 0);
    host.emit(finished()); assert.equal(values[0]?.userMessage, "分页恢复的请求", method);
    host.emit({ method: "item/started", params: { threadId: "thread", turnId: "next", item: userItem("live", "更新的实时请求") } });
    const late = method === "thread/resume" ? { thread: { id: "thread", turns: [] }, initialTurnsPage: { data: [{ ...turn, id: "next" }] } }
      : method === "thread/turns/list" ? { data: [{ ...turn, id: "next" }] }
      : { data: [{ turnId: "next", item: userItem("old", "过期历史") }] };
    host.response(method, late, undefined, { ...params, turnId: "next" });
    host.emit(finished("completed", "next")); assert.equal(values[1]?.userMessage, "更新的实时请求", method);
    source.dispose();
  }
});

test("multiple history pages retain the latest accepted steer in either pagination direction", () => {
  for (const sortDirection of ["asc", "desc"]) {
    const f = sourceFixture(); const host = f.add("host-a"); const source = new TurnCompletionObserver(f.registry);
    const values: TurnCompletion[] = []; source.subscribe(value => values.push(value));
    const pages = [userItem("original", "最初请求"), userItem("steer", "最新已接受请求")];
    if (sortDirection === "desc") pages.reverse();
    for (const [page, item] of pages.entries()) host.response("thread/items/list", { data: [{ turnId: "turn", item }] }, undefined,
      { threadId: "thread", turnId: "turn", sortDirection, cursor: page ? "next-page" : null });
    host.emit(finished()); assert.equal(values[0]?.userMessage, "最新已接受请求", sortDirection);
    host.response("thread/items/list", { data: [{ turnId: "next", item: userItem("seed", "已有历史") }] }, undefined,
      { threadId: "thread", turnId: "next", sortDirection });
    host.emit({ method: "item/started", params: { threadId: "thread", turnId: "next", item: userItem("live", "随后实时请求") } });
    host.response("thread/items/list", { data: [{ turnId: "next", item: userItem("stale", "迟到旧请求") }] }, undefined,
      { threadId: "thread", turnId: "next", sortDirection });
    host.emit(finished("completed", "next"));
    assert.equal(values[1]?.userMessage, "随后实时请求");
    source.dispose();
  }
});

test("reloading a descending tail preserves overlap order and accepts a newer tail", () => {
  for (const newTail of [false, true]) {
    const f = sourceFixture(); const host = f.add("host-a"); const source = new TurnCompletionObserver(f.registry);
    const values: TurnCompletion[] = []; source.subscribe(value => values.push(value));
    const page = (items: unknown[], cursor: string | null = null) => host.response("thread/items/list",
      { data: items.map(item => ({ turnId: "turn", item })) }, undefined,
      { threadId: "thread", turnId: "turn", sortDirection: "desc", cursor });
    page([userItem("steer", "已接受steer"), userItem("original", "原始请求")]);
    page([userItem("steer", "已接受steer")]);
    page([userItem("steer", "已接受steer"), userItem("original", "原始请求")], "older-overlapping-page");
    if (newTail) {
      page([userItem("new-steer", "重新恢复时更新的steer")]);
      page([userItem("steer", "已接受steer")], "older-page");
    }
    host.emit(finished()); assert.equal(values[0]?.userMessage, newTail ? "重新恢复时更新的steer" : "已接受steer");
    source.dispose();
  }
});

test("physical reconnect of the same Client recovers new steer from the real nonempty history cursor", async () => {
  for (const liveSeed of [false, true]) {
    const registry = new AppServerClientRegistry(); let peer: InMemoryAppServerPeer | undefined; let message = "原请求";
    const cursors: unknown[] = [];
    const thread = () => ({ id: "thread", name: "会话", cwd: "/synthetic", historyMode: "paginated", turns: [], status: { type: "active", activeFlags: [] } });
    const transport = new MemoryTransport({ connected(value) { peer = value; }, receive(frame, target) {
      const request = parseJsonRpcMessage(frame); if (!isJsonRpcRequest(request)) return;
      let result: unknown = {};
      if (request.method === "initialize") result = { codexHome: "/synthetic", platformFamily: "unix", platformOs: "linux", userAgent: "notification-reconnect-test" };
      if (request.method === "thread/read") result = { thread: thread() };
      if (request.method === "thread/resume") result = { thread: thread(), model: "fixture", modelProvider: "fixture", cwd: "/synthetic", approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, runtimeWorkspaceRoots: [], turnsBackwardsCursor: "turn-tail", itemsBackwardsCursor: "item-tail" };
      if (request.method === "thread/turns/list") result = { data: [{ id: "turn", status: "inProgress", items: [], itemsView: "notLoaded" }], nextCursor: null };
      if (request.method === "thread/items/list") {
        cursors.push((request.params as any).cursor);
        result = { data: [{ turnId: "turn", item: userItem(message, message) }], nextCursor: null };
      }
      target.send(encodeJsonRpcMessage({ id: request.id, result }));
    } });
    const client = registry.create({ hostId: "host-a", transport }); const source = new TurnCompletionObserver(registry);
    const values: TurnCompletion[] = []; source.subscribe(value => values.push(value));
    await client.connect({ clientInfo: { name: "notification-reconnect", version: "1" } });
    const runtime = await createCordisThreadSessionRuntime({ client, useTailHydration: true, supportsPaginatedHistory: true, historyModeHint: "paginated" });
    try {
      await runtime.resume.resume({ threadId: "thread" });
      if (liveSeed) { peer!.send(encodeJsonRpcMessage({ method: "item/started", params: { threadId: "thread", turnId: "turn", item: userItem("old-live", "原请求") } })); await new Promise(resolve => setImmediate(resolve)); }
      await transport.close(); message = "断线期间已接受的新steer";
      await client.connect({ clientInfo: { name: "notification-reconnect", version: "1" } });
      assert.equal(client.connectionGeneration, 2); assert.equal(registry.get("host-a"), client);
      await runtime.resume.resume({ threadId: "thread" });
      assert.deepEqual(cursors, ["item-tail", "item-tail"]);
      peer!.send(encodeJsonRpcMessage(finished())); await new Promise(resolve => setImmediate(resolve));
      assert.equal(values[0]?.userMessage, message, liveSeed ? "old live projection" : "old history projection");
      peer!.send(encodeJsonRpcMessage(finished())); await new Promise(resolve => setImmediate(resolve));
      assert.equal(values.length, 1, "completion dedup survives physical reconnect");
    } finally { source.dispose(); await runtime.dispose(); await registry.close(); }
  }
});

test("completion is terminal lifecycle evidence, not history, final text or running state", () => {
  for (const status of ["completed", "failed", "interrupted"]) assert.equal(readTurnCompletion("host", finished(status))?.status, status);
  for (const value of [finished("inProgress"), finished("unknown"), { ...finished(), method: "thread/read" }, { ...finished(), method: "item/completed" }, { ...finished(), params: null }, { ...finished(), params: { threadId: "t", turn: [] } }, finished("completed", "")]) {
    assert.equal(readTurnCompletion("host", value), null);
  }
});

test("source follows every Client, fences removed/replaced clients, deduplicates across reconnect and isolates Host/Thread", () => {
  const fixture = sourceFixture();
  const first = fixture.add("host-a");
  const observer = new TurnCompletionObserver(fixture.registry);
  const observed: TurnCompletion[] = [];
  observer.subscribe(() => { throw new Error("broken consumer"); });
  const stop = observer.subscribe(value => observed.push(value));
  first.emit(finished()); first.emit(finished());
  const retiredCallback = [...first.listeners][0]!;
  const replacement = fixture.add("host-a");
  assert.equal(first.listeners.size, 0);
  retiredCallback(finished("completed", "retired-turn"));
  replacement.emit(finished());
  replacement.emit(finished("failed", "turn", "other-thread"));
  const secondHost = fixture.add("host-b"); secondHost.emit(finished());
  fixture.remove("host-b"); assert.equal(secondHost.listeners.size, 0);
  assert.equal(observed.length, 3);
  stop(); replacement.emit(finished("interrupted", "next"));
  assert.equal(observed.length, 3);
  observer.dispose(); observer.dispose();
  assert.equal(replacement.listeners.size, 0); assert.equal(fixture.registryListeners.size, 0);
});

test("DSH adapter terminal events reach the same completion source exactly once", async () => {
  for (const [kind, status] of [["completed", "completed"], ["error", "failed"], ["interrupted", "interrupted"]]) {
    const fixture = sourceFixture(); const client = fixture.add("dsh");
    const source = new TurnCompletionObserver(fixture.registry);
    const observed: TurnCompletion[] = []; source.subscribe(event => observed.push(event));
    const adapter = new DshAppServerAdapter({} as DshClient);
    adapter.subscribe((method, params) => client.emit({ method, params }));
    const accept = (type: string, data: unknown, seq: number) => (adapter as any).onMuxFrame({ type: "session/event", sessionId: "dsh-session", event: { type, data, seq, time: seq * 1000 } });
    accept("turn/start", { turn: 1 }, 1);
    accept("assistant/chunk", { chunk: { type: "text-delta", index: 0, text: "synthetic reply" } }, 2);
    accept("turn/end", { reason: { kind } }, 3);
    await new Promise(resolve => setTimeout(resolve, 400));
    accept("turn/end", { reason: { kind } }, 4);
    assert.equal(observed.length, 1); assert.equal(observed[0]!.status, status);
    assert.equal(observed[0]!.hostId, "dsh"); assert.equal(observed[0]!.threadId, "dsh-session");
    source.dispose(); adapter.close();
  }
});

function browserFixture(permission: NotificationPermission = "granted", secure = true) {
  let prompts = 0; let focused = 0;
  const displayed: any[] = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission() { prompts++; return Promise.resolve(this.permission); }
    onclick: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly title: string, readonly options: NotificationOptions) { displayed.push(this); }
    close() { this.onclose?.(); }
  }
  const notifications = new BrowserTurnNotifications({ secure, notification: FakeNotification as unknown as typeof Notification,
    serviceWorkers: null, pageUrl: () => "https://example.test/local/thread", focus: () => { focused++; } });
  return { notifications, displayed, get prompts() { return prompts; }, get focused() { return focused; }, FakeNotification };
}
const completion: TurnCompletion = { hostId: "host", threadId: "thread", turnId: "turn", status: "completed" };

test("permission is only requested by the explicit action; disabled, denied, insecure and disposed do not notify", async () => {
  for (const [permission, secure] of [["default", true], ["denied", true], ["granted", false]] as const) {
    const f = browserFixture(permission, secure);
    await f.notifications.show(completion, "Complete", "Return", () => true, () => {});
    assert.equal(f.displayed.length, 0); assert.equal(f.prompts, 0);
  }
  const f = browserFixture();
  const request = f.notifications.requestPermission();
  assert.equal(f.prompts, 1, "prompt is called synchronously in the gesture"); await request;
  await f.notifications.show(completion, "Complete", "Return", () => false, () => {});
  f.notifications.dispose();
  await f.notifications.show(completion, "Complete", "Return", () => true, () => {});
  assert.equal(f.displayed.length, 0);
});

test("notification click focuses the original page and calls existing navigation; errors stay local", async () => {
  const f = browserFixture(); let opened = 0;
  await f.notifications.show(completion, "Complete", "Return", () => true, () => { opened++; });
  assert.equal(f.displayed.length, 1); assert.match(f.displayed[0].options.tag, /host.*thread.*turn/);
  f.displayed[0].onclick(); assert.equal(f.focused, 1); assert.equal(opened, 1);
  f.displayed[0].onerror(); assert.equal(f.notifications.getSnapshot().error, true);
  f.FakeNotification.permission = "denied"; f.notifications.refresh();
  assert.equal(f.notifications.getSnapshot().permission, "denied");
  f.notifications.dispose();
});

test("permission revocation/disable/disposal while preparing cannot emit a late notification", async () => {
  let settle!: (value: null) => void;
  const f = browserFixture(); let enabled = true;
  (f.notifications as any).prepareWorker = () => new Promise(resolve => { settle = resolve; });
  const show = f.notifications.show(completion, "Complete", "Return", () => enabled, () => {});
  enabled = false; settle(null); await show;
  assert.equal(f.displayed.length, 0);
  const showAgain = f.notifications.show(completion, "Complete", "Return", () => true, () => {});
  f.notifications.dispose(); settle(null); await showAgain;
  assert.equal(f.displayed.length, 0);
});

test("worker preserves other ServiceWorkers, clicks focus and message exact originating Client, fallback stays same origin", async () => {
  const listeners = new Map<string, (event: any) => void>();
  const messages: unknown[] = []; const opened: string[] = []; let focused = 0;
  let client: any = { type: "window", focus: async () => { focused++; }, postMessage: (value: unknown) => messages.push(value) };
  const worker = { addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    skipWaiting: async () => {}, location: { origin: "https://example.test" },
    clients: { get: async (id: string) => { assert.equal(id, "page-client"); return client; }, openWindow: async (url: string) => opened.push(url) } };
  vm.runInNewContext(readFileSync(new URL("../../apps/workbench-web/src/runtime/turn-notification-worker.js", import.meta.url), "utf8"), { self: worker, URL });
  assert.equal(listeners.has("fetch"), false); assert.equal(listeners.has("activate"), false);
  let replied: unknown;
  listeners.get("message")!({ data: { kind: "opencraft-turn-client" }, source: { id: "page-client" }, ports: [{ postMessage: (value: unknown) => { replied = value; } }] });
  assert.equal(replied, "page-client");
  const click = async (pageUrl: string) => {
    let pending: Promise<void> | undefined;
    listeners.get("notificationclick")!({ notification: { close() {}, data: { kind: "opencraft-turn", clientId: "page-client", ownerId: "owner", completion, pageUrl } }, waitUntil: (value: Promise<void>) => { pending = value; } });
    await pending;
  };
  await click("https://example.test/chat");
  assert.equal(focused, 1); assert.equal(messages.length, 1); assert.equal(opened.length, 0);
  client = null; await click("https://evil.test/phishing"); assert.equal(opened.length, 0);
  await click("https://example.test/chat"); assert.deepEqual(opened, ["https://example.test/chat"]);
});
