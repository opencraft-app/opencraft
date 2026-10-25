import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { AppHostServer } from "@opencraft/app-host-server";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { WebSocketServer, WebSocket } from "ws";
import { chromium } from "playwright";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";

const root = process.env.OPENCRAFT_HISTORY_WEB_ROOT;
if (!root) throw new Error("Set OPENCRAFT_HISTORY_WEB_ROOT to built or installed Web assets");
const output = process.env.OPENCRAFT_HISTORY_EVIDENCE ?? ".local/derived-history";
await mkdir(output, { recursive: true });
const methods: string[] = [], errors: string[] = [];
const currentText = "Current baseline fixture.", olderText = "Older history loaded on demand.";
const turn = (id: string, text: string) => ({ id, status: "completed", itemsView: "full", error: null,
  items: [{ id: `item-${id}`, type: "agentMessage", text, phase: "final_answer" }] });
const thread = { id: "history-fixture", sessionId: "history-fixture", name: "Derived history fixture", preview: "", cwd: "/fixture", path: "/fixture/history",
  createdAt: 2, updatedAt: 2, historyMode: "paginated", status: { type: "idle" }, turns: [] };
const physical = new WebSocketServer({ host: "127.0.0.1", port: 0 });
physical.on("connection", socket => socket.on("message", frame => {
  const request = JSON.parse(String(frame)); if (request.id === undefined) return;
  methods.push(request.method);
  const send = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result }));
  switch (request.method) {
    case "initialize": send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "derived-history-fixture",
      capabilities: { extensions: { "opencraft/read-history": { version: 1 } } } }); break;
    case "thread/list": send({ data: [thread], nextCursor: null }); break;
    case "thread/read": send({ thread, initialTurnsPage: { data: [turn("current", currentText)], nextCursor: "older" } }); break;
    case "thread/turns/list": send({ data: [turn("older", olderText)], nextCursor: null }); break;
    case "model/list": send({ data: [{ id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true,
      inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null }], nextCursor: null }); break;
    case "config/read": send({ config: { model: "fixture", model_provider: "fixture" }, origins: {} }); break;
    case "thread/unsubscribe": send({ status: "unsubscribed" }); break;
    default: send(request.method.endsWith("/list") ? { data: [], nextCursor: null } : {});
  }
}));
await once(physical, "listening");
const url = `ws://127.0.0.1:${(physical.address() as { port: number }).port}`;
const appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server",
  createTransport: () => new WebSocketTransport({ url, createSocket: address => new WebSocket(address) as any }) });
const web = await createWorkbenchWebServer({ appHostServer: appHost, root, loopbackOnly: true, appServerTarget: url });
const address = await web.listen({ host: "127.0.0.1", port: 0 });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { (window as any).__name = (value: any) => value; localStorage.setItem("opencraft.appearance-theme", "light"); });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole("button", { name: /^Derived history fixture(?:\s|$)/ }).click({ timeout: 30_000 });
  await page.getByText(currentText, { exact: true }).waitFor({ timeout: 30_000 });
  await page.locator(".thread-scroll").hover(); await page.mouse.wheel(0, -2000);
  await page.getByText(olderText, { exact: true }).waitFor({ timeout: 30_000 });
  const editor = page.locator("[contenteditable=true]").first(); await editor.fill("retained derived history draft");
  assert.equal(await editor.textContent(), "retained derived history draft");
  assert.ok(methods.includes("thread/turns/list"));
  assert.ok(!methods.some(method => ["thread/start", "thread/resume", "turn/start", "turn/steer"].includes(method)));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${output}/history-page.png` });
  const result = { baselineVisible: true, olderHistoryVisible: true, draftRetained: true, noExecutionWrites: true,
    pageerrors: errors, methods, boundary: "full Web app with isolated AppHost and synthetic physical history endpoint" };
  await writeFile(`${output}/history-page.json`, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} finally {
  await browser.close(); await web.close(); for (const socket of physical.clients) socket.terminate();
  await new Promise<void>(resolve => physical.close(() => resolve()));
}
