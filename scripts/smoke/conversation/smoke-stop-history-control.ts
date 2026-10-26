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
const output = process.env.OPENCRAFT_HISTORY_EVIDENCE ?? ".local/stop-history-control";
await mkdir(output, { recursive: true });
const methods: string[] = [], errors: string[] = [], stops: unknown[] = [];
let physicalConnections = 0, reads = 0, initialized = 0, releaseRead: (() => void) | undefined;
let markHeld!: () => void;
const heldRead = new Promise<void>(resolve => { markHeld = resolve; });
const thread = { id: "stop-history-fixture", sessionId: "stop-history-fixture", name: "Stop history fixture", preview: "", cwd: "/fixture", path: "/fixture/history", createdAt: 2, updatedAt: 2, historyMode: "paginated", status: { type: "active", activeFlags: [] }, turns: [] };
const turn = { id: "known-turn", status: "inProgress", itemsView: "full", error: null, items: [{ id: "answer", type: "agentMessage", text: "Retained running answer.", phase: "commentary" }] };
const physical = new WebSocketServer({ host: "127.0.0.1", port: 0 });
physical.on("connection", socket => { physicalConnections++; socket.on("message", frame => {
  const request = JSON.parse(String(frame)); if (request.id === undefined || request.method === undefined) return;
  methods.push(request.method);
  const send = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result }));
  if (request.method === "initialize") { initialized++; send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "stop-history-control", capabilities: { extensions: { "opencraft/read-history": { version: 1 } } } }); }
  else if (request.method === "thread/list") send({ data: [thread], nextCursor: null });
  else if (request.method === "thread/read") {
    reads++;
    const reply = () => send({ thread, initialTurnsPage: { data: [turn], nextCursor: null } });
    if (reads === 1) reply(); else { releaseRead = reply; markHeld(); }
  } else if (request.method === "turn/interrupt") {
    stops.push(request.params); send({});
    socket.send(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: thread.id, requestId: "stop-question" } }));
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
  await page.getByRole("button", { name: /^Stop history fixture(?:\s|$)/ }).click({ timeout: 30000 });
  await page.getByText("Retained running answer.", { exact: true }).waitFor({ timeout: 10000 });
  const stop = page.getByRole("button", { name: "Stop response", exact: true });
  await stop.waitFor({ timeout: 10000 });
  await page.evaluate(() => { for (const socket of (window as any).__fixtureSockets) socket.close(1000, "synthetic client reconnect"); });
  await Promise.race([heldRead, new Promise<never>((_, reject) => setTimeout(() => reject(Error("recovery Read was not admitted")), 15000))]);
  await page.screenshot({ path: `${output}/before-stop-held-history.png` });
  const physicalBeforeStop = physicalConnections, initializedBeforeStop = initialized;
  await stop.click();
  for (let i = 0; i < 100 && stops.length === 0; i++) await page.waitForTimeout(20);
  assert.deepEqual(stops, [{ threadId: thread.id, turnId: turn.id }], "Stop must reach the exact Turn before history is released");
  assert.equal(physicalConnections, physicalBeforeStop, "the stop must not reopen its current physical Host");
  assert.equal(initialized, initializedBeforeStop, "the stop must not initialize another client");
  assert.ok(reads >= 2); assert.ok(releaseRead);
  await page.getByRole("button", { name: "Stopping response…", exact: true }).waitFor({ state: "detached", timeout: 10000 });
  await page.screenshot({ path: `${output}/stopped-before-history.png` });
  releaseRead!();
  assert.ok(!methods.some(method => ["thread/start", "thread/resume", "turn/start", "turn/steer"].includes(method)));
  assert.deepEqual(errors, []);
  const result = { stoppedBeforeHistory: true, exactTarget: true, noReplay: true, physicalHostPreserved: true, reads, initialized, physicalConnections, stops, methods, errors, boundary: "full built Web with isolated AppHost and synthetic native endpoint; no real account, engine or model; prompt receipt faults covered by separate composed fixture" };
  await writeFile(`${output}/stop-history.json`, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} catch (error) { await writeFile(`${output}/failure.json`, JSON.stringify({ error: String(error), reads, initialized, stops, methods, errors }, null, 2)); throw error; }
finally { await browser.close(); await web.close(); for (const socket of physical.clients) socket.terminate(); await new Promise<void>(resolve => physical.close(() => resolve())); }
