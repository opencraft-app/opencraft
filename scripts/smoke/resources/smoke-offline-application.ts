import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AppHostServer } from "../../../packages/app-host-server/src/index";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";
import { createWorkbenchWebServer as createStaticServer } from "../../workbench-web-server.mjs";
import { createHeadlessBackendProxy } from "../../web-deployment/headless-backend.mjs";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = resolve(process.env.OPENCRAFT_OFFLINE_WEB_ROOT ?? "apps/workbench-web/dist");
const output = resolve(process.env.OPENCRAFT_OFFLINE_EVIDENCE ?? ".local/offline-application");
const version = JSON.parse(await readFile(join(root, "version.json"), "utf8"));
assert.equal(version.headlessServer, true, "Build the headless Web profile before this smoke");
await mkdir(output, { recursive: true });
const threadId = "offline-fixture";
const thread = { id: threadId, name: "Offline fixture", preview: "Previous question", cwd: "/fixture", path: null, historyMode: "paginated",
  modelProvider: "fixture", createdAt: 1, updatedAt: 1, status: { type: "idle" }, source: "appServer", turns: [] };
const turn = { id: "past-turn", status: "completed", error: null, itemsView: "full", startedAt: 1, completedAt: 2, items: [
  { type: "userMessage", id: "past-question", content: [{ type: "text", text: "Previous question", textElements: [] }] },
  { type: "agentMessage", id: "past-answer", text: "Previous answer", phase: "final_answer" },
] };
let online = true;
const cut = new Set<() => void>();
const requests: string[] = [], mutations: string[] = [];
const queued: any[] = [];
const appHost = new AppHostServer({ logicalClientRouting: true, createTransport() {
  let status: any = { state: "idle" };
  const messages = new Set<(frame: string) => void>(), statuses = new Set<(value: any) => void>();
  const close = () => { status = { state: "closed" }; for (const listener of statuses) listener(status); };
  cut.add(close);
  return { get status() { return status; },
    async connect() { if (!online) throw new Error("Synthetic Host offline"); status = { state: "open" }; for (const listener of statuses) listener(status); },
    subscribeMessage(listener) { messages.add(listener); return () => { messages.delete(listener); }; },
    subscribeStatus(listener) { statuses.add(listener); return () => { statuses.delete(listener); }; },
    async send(frame) {
      const rpc = JSON.parse(frame); if (rpc.id === undefined) return; requests.push(rpc.method);
      let result: any, error: any;
      switch (rpc.method) {
        case "initialize": result = { userAgent: "offline-fixture", codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", capabilities: { extensions: {
          "opencraft/resume-history": { version: 1, mode: "paginated", initialTurnsPage: true }, "opencraft/thread-queue": { version: 2, atomicSteer: true },
        } } }; break;
        case "thread/list": result = { data: [thread], nextCursor: null }; break;
        case "thread/read": result = { thread }; break;
        case "thread/resume": result = { thread, model: "fixture-model", modelProvider: "fixture", cwd: "/fixture", runtimeWorkspaceRoots: ["/fixture"],
          approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly" }, initialTurnsPage: { data: [turn], nextCursor: null } }; break;
        case "thread/turns/list": result = { data: [turn], nextCursor: null }; break;
        case "thread/items/list": result = { data: turn.items.map(item => ({ turnId: turn.id, item })), nextCursor: null }; break;
        case "thread/loaded/list": result = { data: [threadId] }; break;
        case "thread/queue/list": result = { data: queued, nextCursor: null }; break;
        case "thread/queue/add": {
          mutations.push(rpc.method);
          const row = { id: `server-${rpc.params.clientUserMessageId}`, clientUserMessageId: rpc.params.clientUserMessageId,
            input: rpc.params.input, createdAt: Date.now(), pausedReason: null };
          if (!queued.some(value => value.clientUserMessageId === row.clientUserMessageId)) queued.push(row);
          result = { queuedSubmission: row }; break;
        }
        case "model/list": result = { data: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture", description: "Synthetic", hidden: false,
          isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: "medium", inputModalities: ["text"], supportsPersonality: false }], nextCursor: null }; break;
        case "project/list": case "permissionProfile/list": result = { data: [], nextCursor: null }; break;
        case "config/read": result = { config: {}, origins: {} }; break;
        case "skills/list": result = { data: [] }; break;
        default: error = { code: -32601, message: "Synthetic operation unavailable" };
      }
      if (!online) return;
      const reply = JSON.stringify({ id: rpc.id, ...(error ? { error } : { result }), __opencraftClient: rpc.__opencraftClient });
      for (const listener of messages) listener(reply);
    }, async close() { cut.delete(close); close(); },
  };
} });
const backend = await createWorkbenchWebServer({ root, appHostServer: appHost, appServerTarget: null, loopbackOnly: true });
const backendAddress = await backend.listen({ host: "127.0.0.1", port: 0 });
const backendTarget = `http://127.0.0.1:${backendAddress.port}`;
const web = await createStaticServer({ root, appServerTarget: null, headlessServer: true, headlessBackendTarget: backendTarget });
web.server.removeAllListeners("upgrade");
const proxy = createHeadlessBackendProxy(backendTarget)!;
web.server.on("upgrade", (request, socket, head) => proxy.upgrade(request, socket, head, () => {}, new Set()));
const address = await web.listen({ host: "127.0.0.1", port: 0 });
const origin = `http://127.0.0.1:${address.port}`;
const fixturePath = process.env.OPENCRAFT_OFFLINE_ACCOUNT_FIXTURE_MODULE;
const accountFixture = fixturePath ? await import(pathToFileURL(resolve(fixturePath)).href) : null;
await accountFixture?.install(web.server);
const url = `${origin}/local/${threadId}?hostId=local-codex`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
const errors: string[] = [], proof: any[] = [];
const httpRequests: string[] = [];
let activePage: any;
const failedRequests: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript("window.__name = value => value");
  context.on("page", page => {
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  });
  context.on("requestfailed", request => failedRequests.push(request.url()));
  context.on("request", request => { if (!request.url().includes("/assets/")) httpRequests.push(request.url()); });
  let page = await context.newPage(); page.setDefaultTimeout(45000);
  activePage = page;
  page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  await page.goto(url);
  await page.locator(".app-shell-root").waitFor();
  await page.locator(".opencraft-composer-editor").first().waitFor();
  await page.waitForFunction(build => document.documentElement.dataset.offlineReady === build, version.buildId, { timeout: 90000 });
  proof.push({ stage: "prepared", buildId: version.buildId, cacheNames: await page.evaluate(() => caches.keys()) });
  await accountFixture?.waitUntilReady(page);
  online = false; for (const close of [...cut]) close(); await context.setOffline(true);
  await page.waitForTimeout(300);
  const editor = page.locator(".opencraft-composer-editor").first();
  await editor.fill("Waiting while offline");
  await page.locator("[data-composer-primary-action]").first().click();
  await page.waitForFunction(() => document.querySelector(".opencraft-composer-editor")?.textContent === "");
  await page.locator(".opencraft-composer-queue-item").filter({ hasText: "Waiting while offline" }).waitFor();
  await editor.fill("Draft survives airplane mode");
  await page.waitForFunction(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("opencraft-client-resources"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise<boolean>(resolve => { const r = db.transaction("resources").objectStore("resources").getAll(); r.onsuccess = () => resolve(r.result.some((row: any) => typeof row.value === "string" && row.value.includes("Draft survives airplane mode"))); }); }
    finally { db.close(); }
  });
  assert.equal(mutations.length, 0);
  console.log("original draft and queue accepted");
  await page.close(); page = await context.newPage(); activePage = page; page.setDefaultTimeout(45000);
  // navigator.onLine can stay true with an unreachable origin; the actual
  // worker-served document must also unblock nonessential remote admission.
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { get: () => true }));
  const response = await page.goto(url);
  assert.equal(response?.headers()["x-opencraft-offline-build"], version.buildId);
  await page.locator(".app-shell-root").waitFor();
  console.log("offline application shell mounted");
  await page.locator(".opencraft-composer-editor").first().waitFor();
  await page.waitForFunction(() => document.querySelector(".opencraft-composer-editor")?.textContent === "Draft survives airplane mode");
  await page.locator(".opencraft-composer-queue-item").filter({ hasText: "Waiting while offline" }).waitFor();
  const offlineEditor = page.locator(".opencraft-composer-editor").first();
  await offlineEditor.fill("New offline input after restart");
  await page.locator("[data-composer-primary-action]").first().click();
  const removable = page.locator(".opencraft-composer-queue-item").filter({ hasText: "New offline input after restart" });
  await removable.waitFor();
  await removable.getByRole("button", { name: "Delete queued message", exact: true }).click();
  await removable.waitFor({ state: "detached" });
  await offlineEditor.fill("Edited draft after offline restart");
  assert.equal(await page.evaluate(async () => { try { await fetch("/__opencraft_account/status"); return false; } catch { return true; } }), true);
  const cacheUrls = await page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith("opencraft-shell-v1:"));
    return (await Promise.all(names.map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat();
  });
  const manifest = JSON.parse(await readFile(join(root, "offline-shell.json"), "utf8"));
  const allowed = new Set([...manifest.files, "opencraft-offline-configuration"].map((file: string) => new URL(file, origin + "/").href));
  assert.deepEqual(cacheUrls.filter(value => !allowed.has(value)), [], "shell caches contain only declared public artifacts and sanitized configuration");
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".application-brand__mark")].every(image => image.complete && image.naturalWidth > 0));
  await page.screenshot({ path: join(output, "offline-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(output, "offline-narrow.png") });
  assert.equal(mutations.length, 0); proof.push({ stage: "new-document-fully-offline", restoredDraft: true, restoredQueue: true, offlineEditQueueAndDelete: true, sensitiveFetchFailed: true, cacheEntries: cacheUrls.length });
  online = true; await context.setOffline(false);
  await page.waitForFunction(() => !document.querySelector(".opencraft-composer-queue-item--local"), undefined, { timeout: 1000 }).catch(() => undefined);
  for (let n = 0; n < 600 && queued.length !== 1; n++) await page.waitForTimeout(100);
  assert.equal(queued.length, 1); assert.equal(mutations.length, 1);
  assert.deepEqual(errors, []);
  proof.push({ stage: "reconnected", sends: mutations.length });
  await writeFile(join(output, "proof.json"), JSON.stringify({ version, proof, errors, requests, mutations, accountFixture: !!accountFixture, boundary: "Full built Application, actual Service Worker/CacheStorage/IndexedDB, network-offline new document. Synthetic AppHost and account boundary; not physical iOS." }, null, 2));
  await context.close(); console.log(JSON.stringify({ proof, errors, mutations }));
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: join(output, "failure.png") }).catch(() => undefined);
    await writeFile(join(output, "failure.json"), JSON.stringify({ proof, errors, failedRequests, body: await activePage.locator("body").innerText(),
      html: await activePage.content(), httpRequests, localPartitions: await activePage.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(key => key.endsWith(".last-local-partition.v1")).map(key => [key, localStorage.getItem(key)]))), history: await activePage.evaluate(() => history.state), resources: await activePage.evaluate(async () => { const db = await new Promise<IDBDatabase>(resolve => { const r=indexedDB.open("opencraft-client-resources"); r.onsuccess=()=>resolve(r.result); }); try { return await new Promise(resolve => { const r=db.transaction("resources").objectStore("resources").getAll(); r.onsuccess=()=>resolve(r.result); }); } finally { db.close(); } }), requests, mutations }, null, 2));
  }
  throw error;
} finally { await browser.close(); await web.close(); await backend.close(); await appHost.close(); }
