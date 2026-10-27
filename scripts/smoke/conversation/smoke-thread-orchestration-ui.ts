import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppHostServer } from "@opencraft/app-host-server";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { WebSocketServer, WebSocket } from "ws";
import { chromium, type Page } from "playwright";
import { ActorStore } from "../../../packages/access-control/src/actors";
import { Collaboration, type ConversationExecutionPort } from "../../../packages/access-control/src/collaboration";
import type { ThreadRelation } from "../../../packages/access-control/src/orchestration-ledger";
import { projectThreadTopologyResult } from "../../../apps/opencraft-daemon/src/thread-orchestration-projection";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";

// Full built Web/AppHost UI with synthetic Native history and real, isolated
// collaboration storage. No external identity, user conversation or model call.
const root = await realpath(resolve(process.env.OPENCRAFT_ORCHESTRATION_WEB_ROOT ?? "apps/workbench-web/dist"));
const output = resolve(process.env.OPENCRAFT_ORCHESTRATION_UI_EVIDENCE ?? ".local/thread-orchestration-ui");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "oc-orchestration-ui-"));
const actors = new ActorStore(join(directory, "actors.sqlite"));
const human = actors.resolveHuman({ provider: "local", subject: "orchestration-ui-smoke", displayName: "合成验收用户", expiresAt: Date.now() + 3_600_000 })!;
const forbiddenWrites: string[] = [];
const nativeMethods: string[] = [], reads: string[] = [], controlReads: unknown[] = [];
const execution: ConversationExecutionPort = {
  hostId: "local-codex", serverId: "smoke-server", async validate() {}, async receipt() { return null; },
  async add() { throw new Error("Smoke never starts a model"); }, async steer() { throw new Error("Smoke never steers"); }, async cancel() { return false; },
};
const collaboration = new Collaboration(join(directory, "actor-collaboration.sqlite"), actors, execution);
const parentId = "orchestration-parent", childId = "orchestration-child", hiddenId = "orchestration-hidden", turnId = "orchestration-parent-turn";
const names: Record<string, string> = { [parentId]: "编排验收父会话", [childId]: "可见协作测试", [hiddenId]: "隐藏协作测试" };
const relation = (threadId: string, parentThreadId: string | null, visibility: ThreadRelation["visibility"]): ThreadRelation => ({
  threadId, parentThreadId, visibility, lifecycleOwnerThreadId: parentThreadId, forkedFromId: null, driverKind: "codex", serverId: "smoke-server",
  ownerActorId: human.actorId, engineHostGeneration: null, nativeSessionId: threadId, runtimeStatus: parentThreadId ? "active" : "idle",
  rootTurnId: parentThreadId ? `${threadId}-root` : turnId, turnId: parentThreadId ? `${threadId}-turn` : turnId,
  delegationRevision: 1, autoExchangeDepth: parentThreadId ? 1 : 0, hasDirectUserInput: false, userInputExcerpt: null,
});
for (const row of [relation(parentId, null, "visible"), relation(childId, parentId, "visible"), relation(hiddenId, parentId, "hidden")]) collaboration.orchestration.createThread(row);
const receipts: Record<string, unknown> = {
  "spawn-visible": { threadId: childId, status: "starting", delivery: "sent" },
  "spawn-hidden": { threadId: hiddenId, status: "starting", delivery: "sent" },
  "wait-timeout": { settled: false, waitTicketId: "synthetic-wait-ticket", threads: [{ threadId: childId, state: "active" }, { threadId: hiddenId, state: "active" }] },
};
const calls = [
  { id: "spawn-visible", tool: "thread_spawn", arguments: { title: names[childId], prompt: "独立的合成子任务", visibility: "visible" }, target: childId },
  { id: "spawn-hidden", tool: "thread_spawn", arguments: { title: names[hiddenId], prompt: "隐藏子任务仍可从父卡片打开", visibility: "hidden" }, target: hiddenId },
  { id: "wait-timeout", tool: "thread_wait", arguments: { threadIds: [childId, hiddenId], timeoutMs: 0 }, target: null },
];
for (const call of calls) {
  const key = `synthetic-host:${parentId}:${turnId}:${call.id}`;
  collaboration.orchestration.accept({ toolCallKey: key, delegationId: "synthetic-delegation", issuerActorId: human.actorId,
    kind: call.tool.slice(7), senderThreadId: parentId, targetThreadId: call.target, clientMessageId: null,
    mode: call.target ? "start" : "wait", arguments: call.arguments });
  const delivery = call.target ? collaboration.sendConversation(human,{reference:{serverId:"smoke-server",threadId:call.target},
    content:"合成排队输入；本 smoke 不启动执行",idempotencyKey:`smoke-${call.id}`,execution:{mode:"queue"}}) : null;
  collaboration.orchestration.finish(key, receipts[call.id], "completed", call.target,delivery ? `actor-input:${delivery.requestId}` : null);
}
const parentTurn = {
  id: turnId, status: "completed", itemsView: "full", error: null,
  items: [
    { id: "question", type: "userMessage", content: [{ type: "text", text: "等待子任务；超时后继续显示真实进度。", text_elements: [] }] },
    {id:"earlier-failed-create",type:"dynamicToolCall",namespace:null,tool:"thread_spawn",arguments:{prompt:"合成创建拒绝"},
      status:"completed",success:false,contentItems:[{type:"inputText",text:'{"status":403}'}]},
    ...calls.map(call => ({ id: call.id, type: "dynamicToolCall", namespace: null, tool: call.tool, arguments: call.arguments,
      status: "completed", success: true, contentItems: [{ type: "inputText", text: JSON.stringify(receipts[call.id]) }], durationMs: 1 })),
    { id: "parent-answer", type: "agentMessage", text: "等待调用已经返回；子任务仍在独立执行。", phase: "final_answer" },
  ],
};
const nativeThread = (id: string) => ({
  id, sessionId: id, name: names[id], preview: "合成验收会话", cwd: "/synthetic", path: `/synthetic/${id}`,
  createdAt: 1, updatedAt: id === parentId ? 100 : 200, recencyAt: id === parentId ? 100 : 200,
  parentThreadId: null, forkedFromId: null, historyMode: "paginated",
  status: { type: collaboration.orchestration.relation(id)?.runtimeStatus === "active" ? "active" : "idle", activeFlags: [] }, turns: [],
});
const turnsFor = (id: string) => id === parentId ? [parentTurn] : [{ id: `${id}-history`, status: "completed", itemsView: "full", error: null,
  items: [...(id === hiddenId ? [{id:"failed-create",type:"dynamicToolCall",namespace:null,tool:"thread_spawn",
    arguments:{prompt:"创建被拒绝的合成子任务"},status:"completed",success:false,contentItems:[{type:"inputText",text:'{"status":403}'}]}] : []),
    { id: `${id}-answer`, type: "agentMessage", text: id === hiddenId ? "隐藏会话的只读历史已打开。" : "可见子会话的只读历史。", phase: "final_answer" }] }];
const physical = new WebSocketServer({ host: "127.0.0.1", port: 0 });
physical.on("connection", socket => socket.on("message", async frame => {
  const request = JSON.parse(String(frame));
  if (request.id === undefined) return;
  nativeMethods.push(request.method);
  const respond = (result: unknown) => socket.send(JSON.stringify({ id: request.id, [LOGICAL_CLIENT_FIELD]: request[LOGICAL_CLIENT_FIELD],
    result: projectThreadTopologyResult(request.method, result, id => collaboration.threadTopology(id)) }));
  try {
    switch (request.method) {
      case "initialize": respond({ codexHome: "/synthetic", platformFamily: "unix", platformOs: "linux", userAgent: "orchestration-ui-smoke",
        capabilities: { extensions: { "opencraft/read-history": { version: 1 }, "opencraft/thread-orchestration-view": { version: 1 },
          "opencraft/collaboration": { version: 1, read: true, queue: true, steer: true } } } }); break;
      case "thread/list": respond({ data: [nativeThread(hiddenId), nativeThread(childId), nativeThread(parentId)], nextCursor: null }); break;
      case "thread/read": {
        const id = String(request.params.threadId); reads.push(id);
        respond({ thread: nativeThread(id), initialTurnsPage: { data: turnsFor(id), nextCursor: null } }); break;
      }
      case "thread/turns/list": respond({ data: turnsFor(String(request.params.threadId)), nextCursor: null }); break;
      case "opencraft/collaboration": {
        const value = await collaboration.command(human, request.params); controlReads.push(value); respond(value); break;
      }
      case "model/list": respond({ data: [{ id: "synthetic", model: "synthetic", displayName: "合成只读模型", isDefault: true,
        inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null }], nextCursor: null }); break;
      case "config/read": respond({ config: { model: "synthetic", model_provider: "synthetic" }, origins: {} }); break;
      case "thread/unsubscribe": respond({ status: "unsubscribed" }); break;
      case "thread/start": case "thread/resume": case "turn/start": case "turn/steer":
        forbiddenWrites.push(request.method); throw new Error("Execution write is forbidden in this read-only smoke");
      default: respond(request.method.endsWith("/list") ? { data: [], nextCursor: null } : {});
    }
  } catch (error) { socket.send(JSON.stringify({ id: request.id, [LOGICAL_CLIENT_FIELD]: request[LOGICAL_CLIENT_FIELD], error: { code: -32000, message: String(error) } })); }
}));
await once(physical, "listening");
const target = `ws://127.0.0.1:${(physical.address() as { port: number }).port}`;
const appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server",
  createTransport: () => new WebSocketTransport({ url: target, createSocket: address => new WebSocket(address) as any }) });
const web = await createWorkbenchWebServer({ appHostServer: appHost, root, loopbackOnly: true, appServerTarget: target,
  onAppHostDiagnostic: () => {}, identityService: { admissionStatus: () => 204, connectionContext: () => ({ sender: null, actorContext: human }), handle: () => false } });
const address = await web.listen({ host: "127.0.0.1", port: 0 });
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
const evidence: unknown[] = [];
async function waitForControlRead(previous: number) {
  const deadline = Date.now() + 15_000;
  while (controlReads.length <= previous) {
    if (Date.now() >= deadline) throw new Error("The reloaded/reconnected app did not read the control ledger");
    await delay(20);
  }
}
async function sidebar(page: Page, open: boolean) {
  const toggle = page.locator('[data-app-shell-sidebar-trigger]:visible').first();
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-expanded") === "true") !== open) {
    const mobileDismiss = page.locator(".app-shell-mobile-page-dismiss:visible");
    if (!open && await mobileDismiss.count()) await mobileDismiss.click();
    else await toggle.click();
  }
}
async function treeSnapshot(page: Page) {
  return page.locator(".sidebar-thread-tree__node").evaluateAll(elements => elements.map(element => ({
    id: element.getAttribute("data-thread-id"), parent: element.parentElement?.closest(".sidebar-thread-tree__node")?.getAttribute("data-thread-id") ?? null,
  })));
}
async function assertWorking(page: Page) {
  await page.getByText("等待调用已经返回；子任务仍在独立执行。", { exact: true }).waitFor({ timeout: 30_000 });
  const history = page.locator('.thread-agent-activity__turn-toggle > button').first();
  await history.waitFor();
  if (await history.getAttribute('aria-expanded') === 'false') await history.click();
  await page.locator('.thread-subagent-activity[data-status="failed"]').waitFor({ timeout: 30_000 });
  await page.getByRole("button",{name:"创建会话",exact:true}).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.thread-subagent-chip[data-status="working"]').length === 2);
  assert.equal(await page.locator('.thread-subagent-activity__status').innerText(), '失败');
  assert.equal(await page.locator('.thread-subagent-activity__toggle').innerText(), '创建会话');
  assert.equal(await page.locator('.thread-subagent-chip[data-status="done"]').count(), 0);
}
try {
  for (const viewport of [{ name: "desktop", width: 1440, height: 1000, mobile: false }, { name: "mobile", width: 390, height: 844, mobile: true }]) {
    for (const id of [childId, hiddenId]) collaboration.orchestration.runtime(id, { runtimeStatus: "active", rootTurnId: `${id}-root`, turnId: `${id}-turn` });
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, locale: "zh-CN", isMobile: viewport.mobile, hasTouch: viewport.mobile, reducedMotion: "reduce" });
    await context.addInitScript(() => {
      (window as any).__name = (value: unknown) => value;
      localStorage.setItem("opencraft.appearance-theme", "light");
      const NativeWebSocket = window.WebSocket;
      (window as any).__smokeSockets = [];
      (window as any).WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); (window as any).__smokeSockets.push(this); }
      };
    });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(origin);
      await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
      await sidebar(page, true);
      await page.locator(`.sidebar-thread-tree__node[data-thread-id="${childId}"]`).waitFor();
      const initialTree = await treeSnapshot(page);
      assert.deepEqual(initialTree, [{ id: parentId, parent: null }, { id: childId, parent: parentId }]);
      const rootRow = page.locator(`.sidebar-thread-tree__node[data-thread-id="${parentId}"] > .sidebar-activity-row .sidebar-activity-item`).first();
      await rootRow.click();
      await assertWorking(page);
      await page.locator('.thread-subagent-activity__toggle[aria-expanded="false"]').click();
      await page.locator('[data-tool-call-status="complete"][data-child-runtime-status="working"]').first().waitFor();
      await page.locator('[data-tool-call-status="complete"][data-delivery-status="accepted"][data-child-runtime-status="working"]').first().waitFor();
      await page.waitForFunction(() => {
        const details = document.querySelector<HTMLElement>(".thread-subagent-details");
        return details && details.clientHeight >= (details.firstElementChild?.scrollHeight ?? Infinity);
      });
      const dispatches = page.locator('.thread-subagent-details__meta[data-tool-call-status]');
      assert.equal(await dispatches.count(), 4);
      for (const dispatch of await dispatches.all()) {
        assert.doesNotMatch(await dispatch.innerText(), /调用：|投递：|子任务：/);
        assert.match(await dispatch.getAttribute('title') ?? '', /调用：.*投递：.*子任务：/);
      }
      assert.match(await dispatches.last().innerText(), /运行中/,'timed-out wait has one working status');
      await page.screenshot({ path: join(output, `${viewport.name}-working.png`) });
      await sidebar(page, true);
      await page.screenshot({ path: join(output, `${viewport.name}-tree.png`) });
      if (viewport.mobile) await sidebar(page, false);
      const controlReadsBeforeReload = controlReads.length;
      await page.reload();
      await assertWorking(page);
      await waitForControlRead(controlReadsBeforeReload);
      await sidebar(page, true);
      assert.deepEqual(await treeSnapshot(page), initialTree);
      if (viewport.mobile) await sidebar(page, false);
      await page.screenshot({ path: join(output, `${viewport.name}-refreshed.png`) });
      await page.getByRole("button", { name: /^打开\s*隐藏协作测试\s*会话$/ }).click();
      await page.getByText("隐藏会话的只读历史已打开。", { exact: true }).waitFor();
      assert.ok(reads.includes(hiddenId));
      const hiddenHistory = page.locator('.thread-agent-activity__turn-toggle > button[aria-expanded="false"]').first();
      if (await hiddenHistory.count()) await hiddenHistory.click();
      await page.getByRole("button",{name:"创建会话",exact:true}).waitFor();
      assert.equal(await page.locator(".thread-subagent-chip").count(),0,"failed creation must not invent a child link");
      const failureToggle = page.getByRole("button",{name:"创建会话",exact:true});
      if (await failureToggle.getAttribute("aria-expanded") === "false") await failureToggle.click();
      await page.locator('[data-tool-call-status="failed"]').waitFor();
      await page.screenshot({ path: join(output, `${viewport.name}-hidden-open.png`) });
      await page.goBack();
      await assertWorking(page);
      const readsBeforeReconnect = controlReads.length;
      await page.evaluate(() => (window as any).__smokeSockets.filter((socket: WebSocket) => socket.readyState === 1).forEach((socket: WebSocket) => socket.close(4000, "synthetic reconnect smoke")));
      await page.waitForFunction(() => (window as any).__smokeSockets.some((socket: WebSocket) => socket.readyState === 1));
      await assertWorking(page);
      await waitForControlRead(readsBeforeReconnect);
      await sidebar(page, true);
      assert.deepEqual(await treeSnapshot(page), initialTree);
      if (viewport.mobile) await sidebar(page, false);
      assert.ok(controlReads.length > readsBeforeReconnect);
      for (const id of [childId, hiddenId]) collaboration.orchestration.runtime(id, { runtimeStatus: "idle", rootTurnId: `${id}-root`, turnId: `${id}-turn` });
      await page.waitForFunction(() => document.querySelectorAll('.thread-subagent-chip[data-status="done"]').length === 2, undefined, { timeout: 15_000 });
      await page.screenshot({ path: join(output, `${viewport.name}-completed.png`) });
      assert.deepEqual(errors, []);
      evidence.push({ viewport, locale: "zh-CN", initialTree, timeoutRemainsWorking: true, refreshedWorkingAndSameTree: true,
        hiddenExcludedAndParentChipOpenedReadOnly: true, reconnectSameTree: true, ledgerTerminalUpdatesCard: true, pageerrors: errors });
    } catch (error) {
      await page.screenshot({ path: join(output, `${viewport.name}-failure.png`) }).catch(() => {});
      await writeFile(join(output, `${viewport.name}-failure.json`), JSON.stringify({ error: String(error), pageerrors: errors, body: await page.locator("body").innerText(), nativeMethods, controlReads }, null, 2));
      throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(forbiddenWrites, []);
  assert.ok(controlReads.length > 0);
  const report = { passed: true, boundary: "Full built Web and AppHost with synthetic Native history, isolated real ActorStore/Collaboration ledger and its authorized command projection; no real model or shared service", root,
    evidence, noExecutionWrites: true, nativeMethods, controlReads, waitReceipt: receipts["wait-timeout"] };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, output, cases: evidence.length, noExecutionWrites: true }));
} finally {
  await browser.close(); await web.close(); await appHost.close();
  for (const socket of physical.clients) socket.terminate();
  await new Promise<void>(resolveClose => physical.close(() => resolveClose()));
  await collaboration.close(); actors.close(); await rm(directory, { recursive: true, force: true });
}
