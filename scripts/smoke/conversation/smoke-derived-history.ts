import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { AppHostServer } from "@opencraft/app-host-server";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { WebSocketServer, WebSocket } from "ws";
import { chromium } from "playwright";
import { HISTORY_PREVIEW_CURSOR_EXPIRED } from "@opencraft/appserver-protocol/history-preview";
import { createWorkbenchWebServer } from "../../../apps/headless-server/src/serve-workbench-web.mjs";

const root = process.env.OPENCRAFT_HISTORY_WEB_ROOT;
if (!root) throw new Error("Set OPENCRAFT_HISTORY_WEB_ROOT to built or installed Web assets");
const output = process.env.OPENCRAFT_HISTORY_EVIDENCE ?? ".local/derived-history";
const snapshotOverlap = process.env.OPENCRAFT_HISTORY_SNAPSHOT_OVERLAP === "1";
const expiredCursor = process.env.OPENCRAFT_HISTORY_EXPIRED_CURSOR === "1";
const legacyItems = process.env.OPENCRAFT_HISTORY_LEGACY_ITEMS === "1";
await mkdir(output, { recursive: true });
const methods: string[] = [], errors: string[] = [];
const historyCursors: (string | null)[] = [];
const navigationCursors: (string | null)[] = [];
const itemCursors: [string, string | null][] = [];
const diagnostics: unknown[] = [];
const previewRecovery = Promise.withResolvers<void>();
let reads = 0, archiveListings = 0;
const currentText = "Current baseline fixture.", olderText = "Older history loaded on demand.";
const duplicateText = "Duplicate Turn fixture.";
const earliestItemText = "Older item in the current Turn.";
const turn = (id: string, text: string) => ({ id, status: "completed", itemsView: "full", error: null,
  items: [{ id: `item-${id}`, type: "agentMessage", text, phase: "final_answer" }] });
const thread = { id: "history-fixture", sessionId: "history-fixture", name: "Derived history fixture", preview: "", cwd: "/fixture", path: "/fixture/history",
  createdAt: 2, updatedAt: 2, historyMode: "paginated", status: { type: "idle" }, turns: [] };
const physical = new WebSocketServer({ host: "127.0.0.1", port: 0 });
physical.on("connection", socket => socket.on("message", frame => {
  const request = JSON.parse(String(frame)); if (request.id === undefined) return;
  methods.push(request.method);
  const reply = (body: object) => socket.send(JSON.stringify({ id: request.id, __opencraftClient: request.__opencraftClient, ...body }));
  const send = (result: unknown) => reply({ result });
  switch (request.method) {
    case "initialize": send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "derived-history-fixture",
      capabilities: { extensions: legacyItems ? { "opencraft/message-window-history": { version: 1 } }
        : { "opencraft/read-history": { version: 1 }, "opencraft/thread-lifecycle": { version: 1, archive: true, archiveStateInRead: true } } } }); break;
    case "thread/list":
      if (request.params.archived === true) archiveListings++;
      send({ data: request.params.archived === true ? [] : [thread], nextCursor: null });
      break;
    case "opencraft/server-spaces": send({ spaces: [], assignments: [], actorId: "fixture" }); break;
    case "thread/read":
      if (legacyItems) { send({ thread }); break; }
      if (++reads === 1 && snapshotOverlap) socket.send(JSON.stringify({ method: "item/started", params: {
        threadId: thread.id, turnId: "current", item: { id: "item-current", type: "agentMessage", text: "", phase: "final_answer" },
      }, __opencraftClient: request.__opencraftClient }));
      send({ thread, initialTurnsPage: { data: [turn("current", currentText), turn("current", duplicateText)], nextCursor: "older" } }); break;
    case "thread/resume":
      if (!legacyItems) { reply({ error: { code: -32601, message: "Resume is unavailable" } }); break; }
      send({ thread, model: "fixture", modelProvider: "fixture", cwd: "/fixture", approvalPolicy: "never",
        approvalsReviewer: "user", sandbox: { type: "readOnly" }, runtimeWorkspaceRoots: ["/fixture"], instructionSources: [],
        turnsBackwardsCursor: "head", itemsBackwardsCursor: null }); break;
    case "thread/turns/list": {
      const cursor = request.params.cursor as string | null;
      const cursors = request.params.itemsView === "notLoaded" ? navigationCursors : historyCursors;
      cursors.push(cursor);
      if (legacyItems) {
        send({ data: ["current", "older"].map(id => ({ id, status: "completed", itemsView: "notLoaded", items: [] })),
          nextCursor: null });
        break;
      }
      if (expiredCursor && cursor === "older") {
        reply({ error: { code: -32602, message: "History preview cursor expired",
          data: { code: HISTORY_PREVIEW_CURSOR_EXPIRED } } });
      } else if (cursor === null) {
        if (expiredCursor && cursors.includes("older"))
          void previewRecovery.promise.then(() => send({ data: [turn("current", "Repeated head")], nextCursor: "fresh" }));
        else send({ data: [turn("current", currentText)], nextCursor: "older" });
      } else send({ data: [turn("older", olderText), turn("older", duplicateText)], nextCursor: null });
      break;
    }
    case "thread/items/list": {
      const { turnId, cursor, limit } = request.params as { turnId: string; cursor: string | null; limit: number };
      itemCursors.push([turnId, cursor]);
      if (turnId === "older") {
        void previewRecovery.promise.then(() => send({ data: [{ turnId, item: turn("older", olderText).items[0] }], nextCursor: null }));
        break;
      }
      const start = Number(cursor);
      const end = Math.min(start + limit, 501);
      send({ data: Array.from({ length: end - start }, (_, index) => {
        const offset = start + index;
        const item = offset === 500 ? { id: "user-oldest", type: "userMessage",
          content: [{ type: "text", text: earliestItemText }] }
          : { id: `answer-${offset}`, type: "agentMessage", text: offset === 0 ? currentText : "", phase: "final_answer" };
        return { turnId, item };
      }), nextCursor: end < 501 ? String(end) : null });
      break;
    }
    case "model/list": send({ data: [{ id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true,
      inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null }], nextCursor: null }); break;
    case "config/read": send({ config: { model: "fixture", model_provider: "fixture" }, origins: {} }); break;
    case "thread/unsubscribe": send({ status: "unsubscribed" }); break;
    case "project/list":
    case "permissionProfile/list":
    case "thread/queue/list": send({ data: [], nextCursor: null }); break;
    default: reply({ error: { code: -32601, message: "Method unavailable in the history fixture" } });
  }
}));
await once(physical, "listening");
const url = `ws://127.0.0.1:${(physical.address() as { port: number }).port}`;
const appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server",
  createTransport: () => new WebSocketTransport({ url, createSocket: address => new WebSocket(address) as any }) });
const web = await createWorkbenchWebServer({
  appHostServer: appHost, root, loopbackOnly: true, appServerTarget: url,
  onAppHostDiagnostic: (entry: unknown) => diagnostics.push(entry),
});
const address = await web.listen({ host: "127.0.0.1", port: 0 });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  page.on("websocket", socket => {
    diagnostics.push({ websocket: socket.url() });
    socket.on("socketerror", error => diagnostics.push({ websocketError: error }));
  });
  await page.addInitScript(() => { (window as any).__name = (value: any) => value; localStorage.setItem("opencraft.appearance-theme", "light"); });
  const hostId = "history-fixture-host";
  const conversationUrl = `http://127.0.0.1:${address.port}/local/${thread.id}?hostId=${hostId}`;
  await page.context().grantPermissions(["local-network-access"], { origin: new URL(conversationUrl).origin });
  await page.route(conversationUrl, async route => {
    const response = await route.fetch();
    const config = { builtinAgents: false, hypernode: false, hosts: [
      { hostId, kind: legacyItems ? "remote-control" : "durable", label: "Fixture Host", url: "/apphost", appHost: true },
    ] };
    const html = (await response.text()).replace("</head>",
      `<script id="opencraft-deployment-config" type="application/json">${JSON.stringify(config)}</script></head>`);
    await route.fulfill({ status: response.status(), contentType: "text/html", body: html });
  });
  await page.goto(conversationUrl);
  const baseline = page.getByText(currentText, { exact: true });
  try { await baseline.waitFor({ timeout: 15_000 }); }
  catch (error) {
    console.error({ url: page.url(), methods, diagnostics, errors, body: (await page.locator("body").innerText()).slice(0, 2000) });
    throw error;
  }
  const baselineNode = await baseline.elementHandle();
  const editor = page.locator("[contenteditable=true]").first();
  await editor.fill("retained derived history draft");
  await page.locator(".thread-scroll").hover(); await page.mouse.wheel(0, legacyItems ? -100000 : -2000);
  previewRecovery.resolve();
  try { await page.getByText(olderText, { exact: true }).waitFor({ timeout: 30_000 }); }
  catch (error) {
    console.error({ methods, itemCursors, historyCursors, errors, body: (await page.locator("body").innerText()).slice(0, 2000) });
    throw error;
  }
  assert.equal(await page.getByText(duplicateText, { exact: true }).count(), 0);
  assert.equal(await baseline.evaluate((node, original) => node === original, baselineNode), true);
  assert.equal(await editor.textContent(), "retained derived history draft");
  if (expiredCursor) assert.deepEqual(historyCursors.slice(historyCursors.indexOf("older")), ["older", null, "fresh"]);
  assert.ok(methods.includes("thread/turns/list"));
  if (snapshotOverlap) assert.ok(reads >= 2, "the complete answer must survive the older buffered start");
  if (legacyItems) {
    await page.locator(".thread-scroll").hover();
    await page.mouse.wheel(0, -100000);
    try { await page.getByText(earliestItemText, { exact: true }).waitFor({ timeout: 15_000 }); }
    catch (error) {
      console.error({ itemCursors, errors, body: (await page.locator("body").innerText()).slice(0, 2000) });
      throw error;
    }
    assert.deepEqual(itemCursors, [
      ["current", null], ["current", "100"], ["current", "200"], ["current", "300"], ["current", "400"],
      ["older", null], ["current", "500"],
    ]);
  } else assert.deepEqual(itemCursors, []);
  assert.equal(methods.filter(method => method === "thread/resume").length, legacyItems ? 1 : 0);
  assert.equal(archiveListings, 0, "ordinary history never scans archive metadata when thread/read omits its state");
  assert.ok(!methods.some(method => ["thread/start", "turn/start", "turn/steer"].includes(method)));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${output}/history-page.png` });
  const result = { baselineVisible: true, olderHistoryVisible: true, draftRetained: true, noExecutionWrites: true,
    snapshotOverlap, expiredCursor, legacyItems, historyCursors, navigationCursors, itemCursors, reads, archiveListings,
    pageerrors: errors, methods, boundary: "full Web app with isolated AppHost and synthetic physical history endpoint" };
  await writeFile(`${output}/history-page.json`, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} finally {
  await browser.close(); await web.close(); for (const socket of physical.clients) socket.terminate();
  await new Promise<void>(resolve => physical.close(() => resolve()));
}
