import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { AppHostServer } from "@opencraft/app-host-server";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { WebSocketServer, WebSocket } from "ws";
import { chromium } from "playwright";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";

const root = process.env.OPENCRAFT_HISTORY_WEB_ROOT;
if (!root) throw Error("Set OPENCRAFT_HISTORY_WEB_ROOT to built or installed Web assets");
const output = process.env.OPENCRAFT_HISTORY_EVIDENCE ?? ".local/resource-notification-ownership";
await mkdir(output, { recursive: true });
const methods: string[] = [], errors: string[] = [];
let physicalConnections = 0, reads = 0, initialized = 0, restored = false, readSocket: WebSocket | undefined, releaseRead: (() => void) | undefined;
let markHeld!: () => void;
const heldRead = new Promise<void>(resolve => { markHeld = resolve; });
const thread = { id: "resource-notification-fixture", sessionId: "resource-notification-fixture", name: "Resource notification fixture", preview: "", cwd: "/fixture", path: "/fixture/history", createdAt: 2, updatedAt: 2, historyMode: "paginated", status: { type: "active", activeFlags: [] }, turns: [] };
const turn = { id: "known-turn", status: "inProgress", itemsView: "full", error: null, items: [{ id: "answer", type: "agentMessage", text: "Retained running answer.", phase: "commentary" }] };
const physical = new WebSocketServer({ host: "127.0.0.1", port: 0 });
physical.on("connection", socket => { physicalConnections++; socket.on("message", frame => {
  const request = JSON.parse(String(frame)); if (request.id === undefined || request.method === undefined) return;
  methods.push(request.method);
  const send = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result }));
  if (request.method === "initialize") { initialized++; send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "resource-notification-ownership", capabilities: { extensions: { "opencraft/read-history": { version: 1 }, "opencraft/thread-lifecycle": { version: 1, archive: true } } } }); }
  else if (request.method === "thread/list") send({ data: [thread], nextCursor: null });
  else if (request.method === "thread/read") {
    reads++; readSocket = socket;
    const captured = restored ? { ...turn, status: "completed", items: [{ ...turn.items[0], text: "Restored current answer.", phase: "final_answer" }] } : turn;
    const reply = () => send({ thread, initialTurnsPage: { data: [captured], nextCursor: null } });
    if (reads === 2) { releaseRead = reply; markHeld(); } else reply();
  } else if (request.method === "thread/unarchive") {
    restored = true; send({ thread }); socket.send(JSON.stringify({ method: "thread/unarchived", params: { threadId: thread.id } }));
  } else if (request.method === "model/list") send({ data: [{ id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true, inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null }], nextCursor: null });
  else if (request.method === "config/read") send({ config: { model: "fixture", model_provider: "fixture" }, origins: {} });
  else send(request.method.endsWith("/list") ? { data: [], nextCursor: null } : {});
}); });
await once(physical, "listening");
const url = `ws://127.0.0.1:${(physical.address() as { port: number }).port}`;
const appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server", createTransport: () => new WebSocketTransport({ url, createSocket: address => new WebSocket(address) as any }) });
const web = await createWorkbenchWebServer({ appHostServer: appHost, root, loopbackOnly: true, appServerTarget: url });
const address = await web.listen({ host: "127.0.0.1", port: 0 });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    (window as any).__name = (value: any) => value;
    localStorage.setItem("opencraft.appearance-theme", "light");
    const NativeSocket = window.WebSocket, sockets: WebSocket[] = [];
    (window as any).__fixtureSockets = sockets;
    window.WebSocket = new Proxy(NativeSocket, { construct(target, args) { const socket = Reflect.construct(target, args); sockets.push(socket); return socket; } });
  });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole("button", { name: /^Resource notification fixture(?:\s|$)/ }).click({ timeout: 30000 });
  await page.getByText("Retained running answer.", { exact: true }).waitFor({ timeout: 10000 });
  const stop = page.getByRole("button", { name: "Stop response", exact: true });
  await stop.waitFor({ timeout: 10000 });
  await page.evaluate(() => { for (const socket of (window as any).__fixtureSockets) socket.close(1000, "synthetic client reconnect"); });
  await Promise.race([heldRead, new Promise<never>((_, reject) => setTimeout(() => reject(Error("recovery Read was not admitted")), 15000))]);
  readSocket!.send(JSON.stringify({ method: "thread/archived", params: { threadId: thread.id } }));
  await page.getByText("Conversation archived", { exact: true }).waitFor({ timeout: 7000 });
  assert.equal(await page.locator("[contenteditable=true]").count(), 0, "archived resource must hide the Composer before history replies");
  await page.screenshot({ path: `${output}/archived-before-history.png` });
  assert.ok(releaseRead); const readsAtArchive = reads;
  await page.getByRole("button", { name: "Restore conversation", exact: true }).click();
  await page.getByText("Restored current answer.", { exact: true }).waitFor({ timeout: 10000 });
  assert.ok(reads > readsAtArchive, "the explicit restore must obtain a current Read while the old reply stays held");
  releaseRead!(); await page.waitForTimeout(100);
  assert.equal(await page.getByText("Restored current answer.", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Retained running answer.", { exact: true }).count(), 0, "a retired Read cannot overwrite the restored resource");
  assert.equal(methods.filter(method => method === "thread/unarchive").length, 1);
  assert.ok(!methods.some(method => ["thread/start", "thread/resume", "turn/start", "turn/steer", "turn/interrupt"].includes(method)));
  assert.deepEqual(errors, []); await page.screenshot({ path: `${output}/restored-before-late-history.png` });
  const result = { archivedBeforeHistory: true, composerHidden: true, explicitRestoreBeforeOldReply: true, lateReadFenced: true, reads, initialized, physicalConnections, methods, errors,
    boundary: "full built Web with isolated AppHost and synthetic native endpoint; no real account, model or physical device" };
  await writeFile(`${output}/resource-notification.json`, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} catch (error) { await writeFile(`${output}/failure.json`, JSON.stringify({ error: String(error), reads, initialized, methods, errors }, null, 2)); throw error; }
finally { await browser.close(); await web.close(); for (const socket of physical.clients) socket.terminate(); await new Promise<void>(resolve => physical.close(() => resolve())); }
