import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";
import { AppHostServer } from "../../../packages/app-host-server/src/index.ts";

// Isolated protocol fixture; no account, SSH, model or user data.
const bundle = process.env.OPENCRAFT_LIFECYCLE_MODULE
  ? await readFile(process.env.OPENCRAFT_LIFECYCLE_MODULE, "utf8")
  : (await build({ stdin: { contents: 'export { JsonRpcAppServerClient } from "./packages/appserver-client/src/client.ts"; export { WebSocketTransport } from "./packages/appserver-transport-websocket/src/websocket-transport.ts"; export { installBrowserDynamicToolHandler } from "./packages/browser-appserver/src/dynamic-tools.ts";', resolveDir: resolve(".") }, bundle: true, format: "esm", platform: "browser", write: false })).outputFiles[0]!.text;
const artifactAssets = new Map<string, string>();
if (process.env.OPENCRAFT_LIFECYCLE_ASSETS) {
  const directory = join(process.env.OPENCRAFT_LIFECYCLE_ASSETS, "assets");
  for (const filename of await readdir(directory)) {
    if (/^[A-Za-z0-9._-]+\.js$/.test(filename)) artifactAssets.set(`/assets/${filename}`, join(directory, filename));
  }
}
const server = createServer(async (req, res) => {
  if (req.url === "/module.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle); return; }
  const assetFile = artifactAssets.get(req.url ?? "");
  if (assetFile !== undefined) {
    res.setHeader("content-type", "text/javascript"); res.end(await readFile(assetFile)); return;
  }
  res.setHeader("content-type", "text/html"); res.end('<!doctype html><title>Connection lifecycle</title><textarea aria-label="Draft">retained draft</textarea>');
});
const sockets = new WebSocketServer({ server });
const frames: Array<{ connection: number; message: any }> = [];
let connections = 0, pendingReuse: string | number | undefined;
sockets.on("connection", socket => {
  const connection = ++connections;
  socket.on("message", raw => {
    const message = JSON.parse(String(raw));
    if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: { codexHome: "/tmp/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "fixture" } }));
    else if (message.method === "fixture/start") {
      socket.send(JSON.stringify({ id: 11, method: "item/tool/call", params: { namespace: "opencraft_browser", tool: "browser_use", arguments: { action: "wait", text: "fixture" }, threadId: "old-thread", turnId: "u", callId: "c" } }));
      socket.send(JSON.stringify({ method: "serverRequest/resolved", params: { requestId: 7, threadId: "old-thread" } }));
      socket.send(JSON.stringify({ id: message.id, result: null }));
    } else if (message.method === "fixture/reuse") {
      pendingReuse = message.id;
      socket.send(JSON.stringify({ id: 7, method: "fixture/instant", params: { threadId: "new-thread" } }));
    } else if (message.method === "fixture/fence") socket.send(JSON.stringify({ id: message.id, result: null }));
    else {
      frames.push({ connection, message });
      if (message.id === 7 && pendingReuse !== undefined) { socket.send(JSON.stringify({ id: pendingReuse, result: "new reply delivered" })); pendingReuse = undefined; }
    }
  });
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); assert.ok(address && typeof address === "object");
const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage(); const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript("window.__name = fn => fn");
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.evaluate(async () => {
    const m = await import(/* @vite-ignore */ "/module.js");
    const transport = new m.WebSocketTransport({ url: location.origin.replace("http", "ws") });
    const client = new m.JsonRpcAppServerClient({ hostId: "browser-lifecycle", transport, requestTimeoutMs: 3000 });
    let release!: (value: unknown) => void;
    const gate = new Promise(resolve => { release = resolve; });
    const fixture = (window as any).fixture = { client, transport, release, module: m, started: false, draft: document.querySelector("textarea") };
    m.installBrowserDynamicToolHandler(client, { open() { throw new Error("unused"); }, getTabContext() { throw new Error("unused"); }, browserUse() { fixture.started = true; return gate; } }, { hostId: "browser-lifecycle" });
    client.handleServerRequest("fixture/instant", () => ({ current: true }));
    fixture.params = { clientInfo: { name: "browser-lifecycle", version: "1" }, capabilities: { experimentalApi: true } };
    await client.connect(fixture.params); await client.requestRaw("fixture/start", {});
  });
  await page.waitForFunction(() => (window as any).fixture.started);
  for (const socket of sockets.clients) socket.close(1012, "fixture reconnect");
  await page.waitForFunction(() => (window as any).fixture.transport.status.state === "closed");
  const result = await page.evaluate(async () => {
    const f = (window as any).fixture;
    await f.client.connect(f.params); f.release({ old: true });
    await f.client.requestRaw("fixture/fence", {});
    const reused = await f.client.requestRaw("fixture/reuse", {});
    let allocated = 0;
    const abort = new AbortController();
    const cancelled = new f.module.WebSocketTransport({ url: location.origin.replace("http", "ws"), createSocket: (url: string) => { allocated++; return new WebSocket(url); } });
    cancelled.subscribeStatus((s: any) => { if (s.state === "connecting") abort.abort(); });
    const cancellation = await cancelled.connect(abort.signal).then(() => "unexpected-open", (e: Error) => e.name);
    await cancelled.close();
    const result = { generation: f.client.connectionGeneration, reused, allocated, cancellation, sameDraft: document.querySelector("textarea") === f.draft, draft: f.draft.value };
    await f.client.close(); return result;
  });
  assert.deepEqual(result, { generation: 2, reused: "new reply delivered", allocated: 0, cancellation: "AbortError", sameDraft: true, draft: "retained draft" });
  assert.equal(connections, 2); assert.deepEqual(frames.map(f => ({ connection: f.connection, id: f.message.id })), [{ connection: 2, id: 7 }]);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: "Chromium", ...result, connections, staleReplies: 0, pageErrors: errors.length, module: process.env.OPENCRAFT_LIFECYCLE_MODULE ? "provided artifact" : "current source bundle" }));
} finally {
  await browser.close(); for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>(resolve => sockets.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
}

// Exercise the real browser bridge and Workbench recovery policy. Only the
// physical Host is synthetic: activation 2 loses its connection before ACK.
const recoveryBundle = process.env.OPENCRAFT_LIFECYCLE_RECOVERY_MODULE
  ? await readFile(process.env.OPENCRAFT_LIFECYCLE_RECOVERY_MODULE, "utf8")
  : (await build({ stdin: { contents: 'export { createAppServerWorkbenchRuntime } from "./packages/workbench-runtime/src/appserver-runtime.ts"; export { connectWebSocketAppHost } from "./apps/workbench-web/src/runtime/websocket-app-host.ts";', resolveDir: resolve(".") }, bundle: true, format: "esm", platform: "browser", write: false })).outputFiles[0]!.text;
class PhysicalHost {
  status: any = { state: "idle" };
  statuses = new Set<(status: any) => void>();
  messages = new Set<(frame: string) => void>();
  constructor(readonly loseBeforeAck: boolean) {}
  async connect() {
    this.publish({ state: "open" });
    if (this.loseBeforeAck) queueMicrotask(() => this.publish({ state: "closed", reason: "fixture activation loss" }));
  }
  async send(frame: string) {
    assert.equal(this.status.state, "open");
    const message = JSON.parse(frame);
    if (message.method === "initialize") queueMicrotask(() => {
      for (const listener of this.messages) listener(JSON.stringify({ id: message.id, result: { codexHome: "/tmp/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "fixture" } }));
    });
  }
  publish(status: any) { this.status = status; for (const listener of this.statuses) listener(status); }
  subscribeStatus(listener: (status: any) => void) { this.statuses.add(listener); return () => this.statuses.delete(listener); }
  subscribeMessage(listener: (frame: string) => void) { this.messages.add(listener); return () => this.messages.delete(listener); }
  async close() { this.publish({ state: "closed" }); }
}
const physicals: PhysicalHost[] = [];
const host = new AppHostServer({ createTransport: () => {
  const physical = new PhysicalHost(physicals.length === 1); physicals.push(physical); return physical;
} });
const recoveryServer = createServer((req, res) => {
  const assetFile = artifactAssets.get(req.url ?? "");
  if (assetFile !== undefined) { res.setHeader("content-type", "text/javascript"); void readFile(assetFile).then(contents => res.end(contents)); return; }
  res.setHeader("content-type", req.url === "/module.js" ? "text/javascript" : "text/html");
  res.end(req.url === "/module.js" ? recoveryBundle : '<!doctype html><title>Activation recovery</title><textarea>retained draft</textarea>');
});
const recoverySockets = new WebSocketServer({ server: recoveryServer });
let recoveryConnections = 0;
recoverySockets.on("connection", (socket, request) => {
  recoveryConnections++;
  const listeners = new Set<(message: any) => void>();
  socket.on("message", raw => { const message = JSON.parse(String(raw)); for (const listener of listeners) listener(message); });
  const connection = host.accept({
    postMessage(message) { socket.send(JSON.stringify(message)); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    start() {}, close() { socket.close(); },
  }, new URL(request.url!, "http://fixture").searchParams.get("attempt")!);
  socket.on("close", () => { void connection.close(); });
});
recoveryServer.listen(0, "127.0.0.1"); await once(recoveryServer, "listening");
const recoveryAddress = recoveryServer.address(); assert.ok(recoveryAddress && typeof recoveryAddress === "object");
const recoveryBrowser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, headless: true, args: ["--no-sandbox"] });
try {
  const page = await recoveryBrowser.newPage(); const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript("window.__name = fn => fn");
  await page.goto(`http://127.0.0.1:${recoveryAddress.port}`);
  await page.evaluate(async () => {
    const m = await import(/* @vite-ignore */ "/module.js");
    const bridge = m.connectWebSocketAppHost(undefined, { reportFailure: () => undefined });
    const fixture = (window as any).recovery = { bridge, runtime: null as any, draft: document.querySelector("textarea") };
    fixture.runtime = m.createAppServerWorkbenchRuntime({ hostId: "fixture", createTransport: () => bridge.createTransport("fixture"), autoReconnect: true, reconnectDelaysMs: [20], requestTimeoutMs: 1000 });
    await fixture.runtime.connect();
    if (fixture.runtime.getSnapshot().phase !== "ready") throw new Error("Cold connection was not ready");
  });
  assert.equal(physicals.length, 1);
  physicals[0]!.publish({ state: "closed", reason: "fixture initial connection loss" });
  await page.waitForFunction(() => {
    const runtime = (window as any).recovery.runtime;
    return runtime.getSnapshot().phase === "ready" && runtime.getSnapshot().connectionGeneration >= 2;
  }, {}, { timeout: 5000 });
  assert.equal(physicals.length, 3); assert.equal(physicals[2]!.status.state, "open");
  const result = await page.evaluate(() => {
    const f = (window as any).recovery;
    return { phase: f.runtime.getSnapshot().phase, sameDraft: document.querySelector("textarea") === f.draft, draft: f.draft.value };
  });
  assert.deepEqual(result, { phase: "ready", sameDraft: true, draft: "retained draft" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ scenario: "activation loss before ACK", browser: "Chromium", physicalActivations: physicals.length, webSockets: recoveryConnections, ...result, pageErrors: errors.length, module: process.env.OPENCRAFT_LIFECYCLE_RECOVERY_MODULE ? "provided artifact" : "current source bundle", boundary: "synthetic physical Host, real AppHost and Workbench Runtime" }));
  await page.evaluate(async () => { const f = (window as any).recovery; await f.runtime.dispose(); f.bridge.close(); });
} finally {
  await recoveryBrowser.close(); await host.close(); for (const socket of recoverySockets.clients) socket.terminate();
  await new Promise<void>(resolve => recoverySockets.close(() => resolve()));
  await new Promise<void>(resolve => recoveryServer.close(() => resolve()));
}
