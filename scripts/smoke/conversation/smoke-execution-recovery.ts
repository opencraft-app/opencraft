import assert from "node:assert/strict";
import {mkdir, writeFile} from "node:fs/promises";
import {createServer} from "vite";
import {WebSocketServer} from "ws";
import {chromium} from "playwright";
const calls: any[] = [], rows: any[] = [];
const thread = {id: "one", cwd: "/fixture", historyMode: "legacy", createdAt: 1, updatedAt: 1, status: {type: "idle"}, turns: [
  {id: "old-turn", status: "completed", items: [{type: "userMessage", id: "old-user", content: [{type: "text", text: "Preserved history"}]},
    {type: "agentMessage", id: "old-answer", text: "Previous work remains readable."}]}]};
const vite = await createServer({root: process.cwd(), configFile: false, logLevel: "error", resolve: {dedupe: ["react", "react-dom", "react-intl"]},
  optimizeDeps: {entries: ["tests/fixtures/execution-recovery-browser.tsx"]}, esbuild: {jsx: "automatic", target: "esnext"},
  server: {host: "127.0.0.1", port: 0, hmr: false}, plugins: [{name: "execution-recovery-fixture", configureServer(server) {
    server.middlewares.use((req, res, next) => {if (req.url?.split("?")[0] !== "/") return next();
      res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/execution-recovery-browser.tsx"></script>');});
  }}]});
const sockets = new WebSocketServer({noServer: true});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let activePage: import("playwright").Page | undefined;
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/execution-recovery-browser";
try {
  await mkdir(output, {recursive: true}); await vite.listen();
  vite.httpServer!.on("upgrade", (req, socket, head) => {if (req.url === "/fixture-rpc") sockets.handleUpgrade(req, socket, head, ws => sockets.emit("connection", ws, req));});
  sockets.on("connection", ws => ws.on("message", frame => {
    const request = JSON.parse(String(frame)); if (request.id === undefined) return; calls.push(request);
    let result: any = {};
    if (request.method === "initialize") result = {userAgent: "fixture", capabilities: {extensions: {"opencraft/thread-queue": {version: 2, atomicSteer: true}}}};
    else if (request.method === "thread/resume" || request.method === "thread/read") result = {thread, model: "fixture", modelProvider: "fixture", cwd: "/fixture", approvalPolicy: "never", approvalsReviewer: "user", sandbox: {type: "readOnly"},
      runtimeWorkspaceRoots: ["/fixture"], instructionSources: [], serviceTier: null, disabledPluginIds: [], activePermissionProfile: null, reasoningEffort: null, collaborationMode: null, multiAgentMode: "explicitRequestOnly", initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null};
    else if (request.method === "thread/queue/list") result = {data: rows, nextCursor: null};
    else if (request.method === "thread/queue/add") {const entry = {id: request.params.clientUserMessageId, clientUserMessageId: request.params.clientUserMessageId, input: request.params.input, createdAt: 1, pausedReason: "execution-recovering"}; rows.push(entry); result = {queuedSubmission: entry};}
    else if (request.method.endsWith("/list")) result = {data: [], nextCursor: null};
    ws.send(JSON.stringify({id: request.id, result}));
    if (request.method === "thread/queue/add") ws.send(JSON.stringify({method: "thread/queue/changed", params: {threadId: "one"}}));
  }));
  browser = await chromium.launch({headless: true, args: ["--no-sandbox"]});
  const results = [];
  for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
    calls.length = 0; rows.length = 0;
    const page = await browser.newPage({viewport: {width: touch ? 390 : 1280, height: 850}, hasTouch: touch});
    activePage = page;
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`${vite.resolvedUrls!.local[0]}?theme=${theme}`);
    await page.getByText("Preserved history", {exact: true}).waitFor();
    const editor = page.locator('.opencraft-composer-editor[contenteditable="true"]');
    await editor.fill("New explicit message");
    await page.evaluate(() => {(window as any).oldRow = document.querySelector('[data-turn-key]'); (window as any).fixture.recover(true);});
    await page.getByText("Execution is recovering. New messages will wait in the queue.", {exact: true}).waitFor();
    assert.equal((await editor.innerText()).trim(), "New explicit message");
    if (touch) await page.getByRole("button", {name: "Send message", exact: true}).tap(); else await editor.press("Enter");
    await page.getByText("Waiting for execution to recover", {exact: true}).waitFor();
    assert.equal(await page.getByRole("button", {name: "Resume", exact: true}).count(), 0, "automatic recovery does not ask users to restart the queue");
    assert.equal(calls.filter(call => call.method === "thread/queue/add").length, 1);
    assert.equal(calls.filter(call => call.method === "turn/start").length, 0);
    await editor.fill("Keep this unsent draft");
    await page.screenshot({path: `${output}/${touch ? "touch" : "desktop"}-${theme}-recovering.png`});
    await page.evaluate(() => (window as any).fixture.recover(false));
    // The remote boundary now confirms delivery; old fault waiting state leaves
    // the same Composer while its unsent draft remains in place.
    rows.length = 0;
    for (const socket of sockets.clients) socket.send(JSON.stringify({method: "thread/queue/changed", params: {threadId: "one"}}));
    await page.locator(".opencraft-composer-queue-tray").waitFor({state: "hidden"});
    await page.getByText("Execution restored. Queued messages will continue.", {exact: true}).waitFor();
    assert.equal((await editor.innerText()).trim(), "Keep this unsent draft");
    assert.equal(await page.evaluate(() => document.querySelector('[data-turn-key]') === (window as any).oldRow), true);
    assert.equal(await page.getByText("Preserved history", {exact: true}).count(), 1);
    assert.deepEqual(errors, []);
    await page.screenshot({path: `${output}/${touch ? "touch" : "desktop"}-${theme}-recovered.png`});
    results.push({touch, theme, historyPreserved: true, draftPreserved: true, newInputQueuedOnce: true});
    await page.close();
  }
  await writeFile(`${output}/report.json`, JSON.stringify(results, null, 2)); console.log(JSON.stringify({passed: true, results}));
} catch (error) {
  await activePage?.screenshot({path: `${output}/failure.png`});
  console.error(JSON.stringify({text: await activePage?.locator('body').innerText(), snapshot: await activePage?.evaluate(() => (window as any).fixture.snapshot()), methods: calls.map(call => call.method)}));
  throw error;
} finally {await browser?.close(); for (const socket of sockets.clients) socket.terminate(); await new Promise<void>(resolve => sockets.close(() => resolve())); await vite.close();}
