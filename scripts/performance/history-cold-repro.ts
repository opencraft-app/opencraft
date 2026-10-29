/** Synthetic native/Core/AppHost regression. Never connects to an existing owner. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";

const value = (name: string, fallback = "") => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const fixture = JSON.parse(await readFile(value("--fixture"), "utf8"));
const root = await mkdtemp("/tmp/hc-");
const repo = resolve(value("--repo", process.cwd()));
const load = (path: string) => import(pathToFileURL(join(repo, path)).href);
const { startCodexCore } = await load("apps/codex-core/src/main.ts");
const { CodexEngineAdapter } = await load("apps/opencraft-daemon/src/codex-engine-adapter.ts");
const { CodexCoreReadIsolation } = await load("apps/opencraft-daemon/src/codex-core-read-isolation.ts");
const { CodexCoreControlClient } = await load("packages/account-pool-host/src/index.ts");
const { AppHostServer } = await load("packages/app-host-server/src/index.ts");
const { MessagePortAppHostClient } = await load("packages/app-host-client/src/index.ts");
const { JsonRpcAppServerClient } = await load("packages/appserver-client/src/client.ts");
const bandwidth = Number(value("--mib-per-second", "6")) * 1024 * 1024;
const token = "synthetic-history-regression-".repeat(3);
const traces: Record<string, any>[] = [], nativeCalls: Record<string, any>[] = [];
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "LANG", "USER", "SHELL", "TMPDIR"].includes(key)));
let core: any, engine: any, server: any, client: any, host: any, http: any, wss: any, backend: any, web: any, browser: any;
const sockets = new Set<WebSocket>();
let enterPreparation!: () => void, releasePreparation!: () => void;
const preparing = new Promise<void>(resolve => { enterPreparation = resolve; });
const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
let readAdmissionAt = 0, observeAdmission = false;
const { port1, port2 } = new MessageChannel();
try {
  const options = { endpoint: join(root, "c.sock"), authToken: token, executable: value("--native"),
    runtimeDirectory: root, dataDirectory: join(root, "owner"), nativeCodexHomeDirectory: fixture.home,
    fetch: async () => Response.json({ plan_type: "pro" }),
    spawnAppServer: ({ args, cwd, env }: any) => spawn(value("--native"), args, {
      cwd, env: { ...safeEnv, CODEX_HOME: fixture.home }, stdio: ["pipe", "pipe", "pipe"],
    }),
  };
  core = await startCodexCore(options);
  const control = new CodexCoreControlClient(core.endpoint, token);
  const health = await control.health();
  http = createServer(); wss = new WebSocketServer({ server: http, maxPayload: 0 });
  const proxy = join(root, "p.sock");
  await new Promise<void>(resolve => http.listen(proxy, resolve));
  wss.on("connection", (downstream: WebSocket) => {
    const upstream = new WebSocket(`ws+unix://${health.nativeSocket}:/`, { maxPayload: 0 });
    sockets.add(downstream); sockets.add(upstream);
    const ready = new Promise<void>((resolve, reject) => { upstream.once("open", resolve); upstream.once("error", reject); });
    void ready.catch(() => {});
    downstream.on("message", data => {
      const request = JSON.parse(data.toString());
      nativeCalls.push({ method: request.method, limit: request.params?.limit, itemsView: request.params?.itemsView, at: performance.now() });
      void ready.then(() => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString()); }).catch(() => {});
    });
    let output = Promise.resolve();
    upstream.on("message", data => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
      output = output.then(async () => {
        // Replay a bounded link's byte cost, not a fabricated fixed page delay.
        // A 50-MiB hidden body takes 8.3s on the default 6-MiB/s local link.
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          if (downstream.readyState !== WebSocket.OPEN) return;
          const chunk = bytes.subarray(offset, offset + 64 * 1024);
          await delay(chunk.length / bandwidth * 1000);
          if (downstream.readyState !== WebSocket.OPEN) return;
          await new Promise<void>((resolve, reject) => downstream.send(chunk, {
            binary: false, fin: offset + chunk.length === bytes.length,
          }, error => error ? reject(error) : resolve()));
        }
      }).catch(() => {});
    });
    const stop = () => { downstream.terminate(); upstream.terminate(); sockets.delete(downstream); sockets.delete(upstream); };
    downstream.on("close", stop); upstream.on("close", stop);
    downstream.on("error", stop); upstream.on("error", stop);
  });
  engine = new CodexEngineAdapter({ ...options, coreEndpoint: core.endpoint, coreAuthToken: token, coreHostOverlays: true,
    dataDirectory: join(root, "overlay"), sessionMcp: async () => { enterPreparation(); await preparation; throw new Error("synthetic tool preparation revoked before submission"); }, logDiagnostic: (entry: any) => {
      if (["history-native-rpc", "history-read-stages", "history-read-return"].includes(entry.event)) traces.push(entry);
    }, spawnAppServer: () => { throw new Error("Host must not spawn a native writer"); } });
  engine.nativeTransport.reads.close();
  engine.nativeTransport.reads = new CodexCoreReadIsolation(async () => ({ nativeSocket: proxy }));
  const sendWithContext = engine.sendWithContext.bind(engine);
  engine.sendWithContext = (frame: string, ...args: any[]) => {
    if (observeAdmission && JSON.parse(frame).method === "thread/read") readAdmissionAt = performance.now();
    return sendWithContext(frame, ...args);
  };
  server = new AppHostServer({ logicalClientRouting: true, createTransport: () => engine });
  server.accept({ postMessage: (message: unknown) => port1.postMessage(message), subscribe(listener: any) {
    port1.on("message", listener); return () => port1.off("message", listener);
  }, start: () => port1.start(), close: () => port1.close() }, "synthetic-history");
  host = new MessagePortAppHostClient(port2, "synthetic-history");
  client = new JsonRpcAppServerClient({ hostId: "local-codex", transport: host.createTransport("local-codex") });
  await client.connect({ clientInfo: { name: "synthetic-history", version: "1" }, capabilities: { experimentalApi: true } });
  const results: any[] = [];
  let firstRead: any;
  const read = async (label: string) => {
    const started = performance.now();
    try {
      const result = await client.request("thread/read", { threadId: fixture.threadId, includeTurns: true,
        initialTurnsPage: { limit: 1, itemsView: "presentation", sortDirection: "desc" } }, { timeoutMs: 30_000 });
      const ms = performance.now() - started;
      assert.equal(result.thread.historyTurnCount, fixture.turns);
      assert.equal(result.initialTurnsPage.data.length, 1);
      if (label === "cold-first-page") firstRead = result;
      results.push({ label, ms, outcome: "ok", turns: result.thread.historyTurnCount, bytes: Buffer.byteLength(JSON.stringify(result)), timing: result.__opencraftHistoryTiming });
    } catch (error) { results.push({ label, ms: performance.now() - started, outcome: "failed", error: String(error) }); }
  };
  const cold = read("cold-first-page");
  await delay(3_000);
  await Promise.all([cold, read("queued-first-page")]);
  if (firstRead) {
    const turn = firstRead.initialTurnsPage.data[0], item = turn.items[0];
    assert.ok(item.historyDetail?.cursor, "large tool body must be deferred");
    const full = await client.request("thread/turns/list", { threadId: fixture.threadId,
      cursor: item.historyDetail.cursor, detailItemId: item.id, limit: 1, itemsView: "full", sortDirection: "desc" });
    const native = await engine.requestPhysical("thread/items/list", { threadId: fixture.threadId, turnId: turn.id, limit: 100, sortDirection: "asc" });
    assert.deepEqual(full.data[0].items[0], native.data[0].item, "lazy expansion preserves the exact native Item");
  }
  // Metadata-only control isolates the Core-external FIFO from history work.
  const turn = client.request("turn/start", { threadId: fixture.threadId, clientUserMessageId: "synthetic-preparation", input: [{ type: "text", text: "synthetic; never sent" }] }).catch(() => {});
  await preparing;
  const releaseTimer = setTimeout(releasePreparation, 26_000);
  const admissionStarted = performance.now(); observeAdmission = true;
  let metadataResult: any;
  try {
    metadataResult = await client.request("thread/read", { threadId: fixture.threadId, includeTurns: false }, { timeoutMs: 30_000 });
    const ms = performance.now() - admissionStarted, coreMs = metadataResult.__opencraftHistoryTiming?.coreMs ?? 0;
    const admissionMs = readAdmissionAt - admissionStarted;
    results.push({ label: "Core-external-preparation", outcome: "ok", ms, appHostAdmissionMs: admissionMs, coreMs, remainderMs: Math.max(0, ms - admissionMs - coreMs) });
  } catch (error) { results.push({ label: "Core-external-preparation", outcome: "failed", error: String(error), ms: performance.now() - admissionStarted }); }
  finally { clearTimeout(releaseTimer); releasePreparation(); await turn; }
  if (value("--web-root")) {
    await engine.transcriptCache.invalidate(fixture.threadId);
    const webRoot = resolve(value("--web-root"));
    const { createWorkbenchWebServer } = await load("scripts/serve-workbench-web.mjs");
    const { createWorkbenchWebServer: createStaticWorker } = await load("scripts/workbench-web-server.mjs");
    const { createHeadlessBackendProxy } = await load("scripts/web-deployment/headless-backend.mjs");
    backend = await createWorkbenchWebServer({ root: webRoot, appHostServer: server, appServerTarget: null, loopbackOnly: true });
    const address = await backend.listen({ host: "127.0.0.1", port: 0 });
    const target = `http://127.0.0.1:${address.port}`;
    web = await createStaticWorker({ root: webRoot, appServerTarget: null, headlessServer: true, headlessBackendTarget: target });
    web.server.removeAllListeners("upgrade");
    const proxy = createHeadlessBackendProxy(target);
    web.server.on("upgrade", (request: any, socket: any, head: any) => proxy.upgrade(request, socket, head, () => {}, new Set()));
    const visible = await web.listen({ host: "127.0.0.1", port: 0 });
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch({ executablePath: value("--chromium") || undefined, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    await page.addInitScript(() => {
      new MutationObserver(() => {
        if ((window as any).historyFixturePaintMs !== undefined) return;
        if (![...document.querySelectorAll(".thread-frame")].some(element => element.textContent?.includes("synthetic"))) return;
        requestAnimationFrame(() => { (window as any).historyFixturePaintMs ??= performance.now(); });
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await page.goto(`http://127.0.0.1:${visible.port}/local/${fixture.threadId}?hostId=local-codex`);
    await page.waitForFunction(() => (window as any).historyFixturePaintMs !== undefined, { timeout: 15_000 });
    const ms = await page.evaluate(() => (window as any).historyFixturePaintMs);
    results.push({ label: "built-Application-DOM-first-paint", outcome: "ok", ms });
    if (value("--screenshot")) await page.screenshot({ path: value("--screenshot") });
  }
  console.log(JSON.stringify({ synthetic: true, nativeVersion: value("--native"), fixtureTurns: fixture.turns,
    transportMiBPerSecond: bandwidth / 1024 / 1024, results, nativeCalls, traces }));
  assert.ok(results.every(row => row.outcome === "ok" && row.ms < 10_000), "cold, queued and Core-external reads must finish below 10s");

} finally {
  await browser?.close(); await web?.close(); await backend?.close();
  await client?.close(); host?.close(); await server?.close();
  for (const socket of sockets) socket.terminate();
  if (wss) await new Promise<void>(resolve => wss.close(() => resolve()));
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await engine?.close(); await core?.close(); port1.close(); port2.close();
  await rm(root, { recursive: true, force: true });
}
