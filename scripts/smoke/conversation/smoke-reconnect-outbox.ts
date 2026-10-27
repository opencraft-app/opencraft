import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { WebSocketServer } from "ws";
import type { Browser } from "playwright";

// Real browser storage, Composer, Runtime, AppServer client and WebSocket.
// Only the remote AppServer/engine response boundary is a deterministic fixture.
const calls: { method: string; params: any }[] = [];
let online = true;
let holdAck = false;
let rows: any[] = [];
const thread = { id: "thread-one", name: "Outbox fixture", cwd: "/fixture", status: { type: "active" },
  turns: [{ id: "active", status: "inProgress", items: [], params: { input: [] } }] };
const sockets = new WebSocketServer({ noServer: true });
const vite = await createServer({ root: process.cwd(), configFile: false, logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] }, cacheDir: "node_modules/.vite-reconnect-outbox",
  optimizeDeps: { entries: ["tests/fixtures/reconnect-outbox-browser.tsx"] }, esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{ name: "outbox-fixture", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next(); res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/reconnect-outbox-browser.tsx"></script>');
    });
  } }],
});
let browser: Browser | undefined;
let activePage: import("playwright").Page | undefined;
const output = process.env.OPENCRAFT_OUTBOX_EVIDENCE ?? ".local/reconnect-outbox";
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  vite.httpServer!.on("upgrade", (req, socket, head) => {
    if (req.url !== "/fixture-rpc") return;
    if (!online) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit("connection", ws, req));
  });
  sockets.on("connection", ws => ws.on("message", frame => {
    const request = JSON.parse(frame.toString()); if (request.id === undefined) return;
    calls.push(request);
    const { method, params } = request;
    let result: any;
    if (method === "initialize") result = { userAgent: "fixture", codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", capabilities: { extensions: { "opencraft/thread-queue": { version: 2, atomicSteer: true } } } };
    else if (method === "thread/resume" || method === "thread/read") result = { thread, model: "fixture", modelProvider: "fixture", cwd: "/fixture", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly" },
      runtimeWorkspaceRoots: ["/fixture"], instructionSources: [], serviceTier: null, disabledPluginIds: [],
      activePermissionProfile: null, reasoningEffort: null, collaborationMode: null, multiAgentMode: "explicitRequestOnly", initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
    else if (method === "thread/turns/list") result = { data: thread.turns, nextCursor: null, hasMore: false };
    else if (method === "thread/items/list") result = { data: [], nextCursor: null };
    else if (method === "thread/queue/list") result = { data: rows, nextCursor: null };
    else if (method === "thread/queue/add") {
      const entry = { id: `server-${params.clientUserMessageId}`, clientUserMessageId: params.clientUserMessageId,
        input: params.input, createdAt: Date.now(), pausedReason: null };
      if (!rows.some(row => row.clientUserMessageId === entry.clientUserMessageId)) rows.push(entry);
      result = { queuedSubmission: entry };
      if (holdAck) { online = false; ws.close(1012, "ack lost"); return; }
    } else if (method === "model/list") result = { data: [{ id: "fixture", model: "fixture", displayName: "Fixture", description: "Synthetic", hidden: false, isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: "medium", inputModalities: ["text"], supportsPersonality: false, additionalSpeedTiers: [], serviceTiers: [] }], nextCursor: null };
    else if (method === "thread/dynamicTools/register") result = { registered: 0 };
    else result = {};
    ws.send(JSON.stringify({ id: request.id, result }));
  }));
  const { chromium } = await import("playwright"); browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const origin = vite.resolvedUrls!.local[0]!;
  const results = [];
  for (const width of [390, 1100]) for (const theme of ["light", "dark"] as const) {
    rows = []; holdAck = false; online = true;
    const page = await browser.newPage({ viewport: { width, height: 840 }, hasTouch: width === 390, isMobile: width === 390 });
    activePage = page;
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name = value => value"); await page.goto(origin);
    await page.waitForFunction(() => (window as any).fixture?.snapshot().authoritative || (window as any).fixture?.snapshot().error);
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().error?.message ?? null), null);
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    const editor = page.locator(".opencraft-composer-editor"); const send = page.locator("[data-composer-primary-action]");
    online = false; for (const ws of sockets.clients) ws.close(1012, "server restarting");
    await page.waitForSelector('[data-authoritative="false"]');
    const before = calls.filter(call => call.method === "thread/queue/add").length;
    for (const message of ["first offline message", "cancel this", "second offline message"]) {
      await editor.fill(message); await send.click();
      await page.waitForFunction(() => (window as any).fixture.draft().lifecycle.phase === "editing");
      assert.equal(await editor.textContent(), "");
    }
    assert.equal(await page.locator(".opencraft-composer-queue-item").count(), 3);
    const cancelled = page.locator(".opencraft-composer-queue-item").filter({ hasText: "cancel this" });
    await cancelled.getByRole("button", { name: "Delete queued message", exact: true }).click();
    assert.equal(await page.locator(".opencraft-composer-queue-item").count(), 2);
    assert.equal(calls.filter(call => call.method === "thread/queue/add").length, before);
    assert.equal(await page.getByRole("button", { name: "Resume", exact: true }).count(), 0);
    await page.screenshot({ path: `${output}/${width}-${theme}-waiting.png` });
    // Cover both same-tab reload and an uninterrupted automatic reconnect.
    online = true; if (theme === "light") await page.reload(); await page.waitForSelector('[data-authoritative="true"]');
    await page.waitForFunction(() => (window as any).fixture.snapshot().queuedSubmissions.every((row: any) => !row.local));
    const adds = calls.filter(call => call.method === "thread/queue/add").slice(before);
    assert.deepEqual(adds.map(call => call.params.input[0].text), ["first offline message", "second offline message"]);
    assert.equal(rows.length, 2);
    // A rejected storage write must retain input even with a running Turn.
    online = false; for (const ws of sockets.clients) ws.close(1012, "storage test");
    await page.waitForSelector('[data-authoritative="false"]');
    await page.evaluate(() => (window as any).fixture.failStorage());
    await editor.fill("keep this draft"); await send.click();
    await page.waitForFunction(() => (window as any).fixture.draft().lifecycle.phase === "failed");
    assert.equal(await editor.innerText(), "keep this draft");
    assert.deepEqual(errors, []); results.push({ width, theme, queuedOffline: true, cancelled: true, reloadFIFO: theme === "light", automaticReconnectFIFO: theme === "dark", quotaKeepsDraft: true });
    await page.screenshot({ path: `${output}/${width}-${theme}-storage-error.png` }); await page.close();
  }
  // Lose the ACK after the server has accepted a message: the receipt restored
  // from queue/list must retire local uncertainty without a second queue/add.
  online = true; rows = []; holdAck = false;
  const page = await browser.newPage(); activePage = page; await page.addInitScript("window.__name = value => value"); await page.goto(origin);
  await page.waitForSelector('[data-authoritative="true"]'); online = false;
  for (const ws of sockets.clients) ws.close(1012, "restart"); await page.waitForSelector('[data-authoritative="false"]');
  await page.locator(".opencraft-composer-editor").fill("lost ack message"); await page.locator("[data-composer-primary-action]").click();
  const before = calls.filter(call => call.method === "thread/queue/add").length;
  holdAck = true; online = true;
  await page.waitForFunction(() => (window as any).fixture.snapshot().queuedSubmissions.some((row: any) => row.local && row.state === "unknown"));
  await page.locator(".opencraft-composer-editor").fill("after lost ack");
  await page.locator("[data-composer-primary-action]").click();
  await page.waitForFunction(() => (window as any).fixture.snapshot().queuedSubmissions.filter((row: any) => row.local).length === 2);
  holdAck = false; online = true; await page.waitForSelector('[data-authoritative="true"]');
  // Queue proof arrives after baseline recovery. No reload, unrelated timeline
  // update, or extra message may be required to wake the second input.
  await page.waitForFunction(() => (window as any).fixture.snapshot().queuedSubmissions.every((row: any) => !row.local));
  assert.deepEqual(calls.filter(call => call.method === "thread/queue/add").slice(before).map(call => call.params.input[0].text),
    ["lost ack message", "after lost ack"]);
  await page.reload(); await page.waitForSelector('[data-authoritative="true"]');
  await page.waitForFunction(() => (window as any).fixture.snapshot().queuedSubmissions.every((row: any) => !row.local));
  assert.equal(calls.filter(call => call.method === "thread/queue/add").length, before + 2);
  await page.close();
  await writeFile(`${output}/results.json`, JSON.stringify({ results, lostAckReconciled: true, actualEngine: false }, null, 2));
  console.log(JSON.stringify({ results, lostAckReconciled: true }));
} catch (error) { console.error(JSON.stringify({ snapshot: await activePage?.evaluate(() => ({ text: document.body.innerText, message: (window as any).fixture?.snapshot().error?.message, queueErrors: (window as any).fixture?.snapshot().queuedSubmissions.map((row: any) => row.error?.message), state: (window as any).fixture?.snapshot(), host: (window as any).fixture?.runtime() })).catch(() => null), error: String(error), methods: calls.map(call => call.method) })); throw error; }
finally { await browser?.close(); for (const ws of sockets.clients) ws.terminate(); await new Promise<void>(resolve => sockets.close(() => resolve())); await vite.close(); }
