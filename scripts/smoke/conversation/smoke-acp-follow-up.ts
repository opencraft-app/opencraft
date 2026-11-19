import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { AcpEngine } from "../../../plugins/acp-engine/src/index.js";
import { startEngineHost } from "../../../apps/local-agent-host/src/engine-host.js";
import { createWorkbenchWebConfig } from "../../../apps/workbench-web/vite.config.js";

// Actual Workbench route, RPC Host, durable ACP owner and stdio transport.
// Only the external Agent process is a controlled peer; no user Host is touched.
const root = await mkdtemp(join(tmpdir(), "opencraft-acp-follow-up-"));
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? join(tmpdir(), "opencraft-acp-follow-up");
await mkdir(output, { recursive: true });
const trace = join(root, "calls.jsonl");
const screenshot = join(root, "screenshot.png");
await writeFile(screenshot, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
const completed = new Map<string, any[]>();
const historyTurns = (nativeId: string) => {
  const session = [...(engine as any).sessions.values()].find((entry: any) => entry.nativeId === nativeId) as any;
  if (!session) return [];
  const active = (engine as any).state(session.id).active;
  return [...completed.get(session.id) ?? [], ...(active?.status === "inProgress" ? [(engine as any).turn((engine as any).state(session.id))] : [])];
};
const engine = new AcpEngine({ id: "codex", command: process.execPath, args: [resolve("tests/fixtures/acp-engine-peer.mjs")],
  cwd: root, dataDirectory: join(root, "data"), permission: "allow-once",
  history: { async read(nativeId) { return { data: historyTurns(nativeId), nextCursor: null }; }, async snapshot(nativeId) { return historyTurns(nativeId); } },
  env: { ACP_TEST_PERMISSIONS: "1", ACP_TEST_TRACE: trace, ACP_TEST_MODELS: "1", ACP_TEST_IMAGES: "1", ACP_TEST_WAIT_MS: "30000" } });
engine.subscribe((method, params) => { if (method === "turn/completed") completed.set(params.threadId, [...completed.get(params.threadId) ?? [], structuredClone(params.turn)]); });
const originalRequest = engine.request.bind(engine);
engine.request = async (method, params, client) => {
  // In production the containing local Host supplies these shell catalogs.
  if (method === "config/read") return { config: { model: "codex:default-native" }, origins: {}, layers: null };
  if (method === "permissionProfile/list") return { data: [], nextCursor: null };
  if (method === "opencraft/thread-pins/list") return { supported: false, data: [] };
  if (method === "opencraft/agents/usage") return null;
  try { return await originalRequest(method, params, client); }
  catch (error) { console.error("ACP smoke rejected", method, Object.keys(params)); throw error; }
};
const host = await startEngineHost({ providers: [engine], defaultEngine: "codex", resources: { projectDirectory: root } });
process.env.OPENCRAFT_APPSERVER_URL = host.websocketUrl;
process.env.VITE_APPSERVER_HOSTS_JSON = JSON.stringify([{ hostId: "local", label: "Queue test device", kind: "local", url: "/appserver", workspaceBrowseRoots: [root] }]);
const config = createWorkbenchWebConfig({ mode: "development", command: "serve" }, { builtinAgents: false, hyperNode: false, tasks: false });
const vite = await createServer({ ...config, configFile: false, root: resolve("apps/workbench-web"),
  cacheDir: resolve("node_modules/.vite-acp-follow-up"), server: { ...config.server, host: "127.0.0.1", port: 0, strictPort: false, open: false } });
let browser: any;
const owner = { notify() {}, async request() { throw new Error("No browser tools"); } };
try {
  await vite.listen();
  const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  for (const touch of [false, true]) {
    const { thread } = await engine.request("thread/start", {}, owner);
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 900 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.addInitScript(() => localStorage.setItem("opencraft.onboarding.completedAt", new Date().toISOString()));
    await page.goto(`${origin}/local/${thread.id}?hostId=local`);
    const editor = page.locator(".opencraft-composer-editor[contenteditable=true]");
    await editor.waitFor({ timeout: 60000 });
    await editor.fill("Second queued task");
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("[data-composer-primary-action]")?.disabled);
    await engine.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "wait:first", text_elements: [] }] }, owner);
    const add = page.getByRole("button", { name: /^(Add|添加)$/, exact: true });
    if (touch) await add.tap(); else await add.click();
    const chooser = page.waitForEvent("filechooser");
    const attach = page.getByRole("menuitem", { name: /Attach files|添加附件/ });
    if (touch) await attach.tap(); else await attach.click();
    await (await chooser).setFiles(screenshot);
    await page.locator('.opencraft-composer-image-attachment[data-state="ready"]').waitFor();
    await page.getByRole("menu").waitFor({ state: "hidden" });
    const queue = page.locator('[data-composer-primary-action="queue"]');
    try { await queue.waitFor({ timeout: 15000 }); }
    catch (error) { await page.screenshot({ path: join(output, "failed.png") }); console.error(await page.locator('[data-composer-primary-action]').evaluateAll(nodes => nodes.map(node => ({ action: node.getAttribute("data-composer-primary-action"), label: node.getAttribute("aria-label"), disabled: (node as HTMLButtonElement).disabled })))); throw error; }
    assert.equal(await page.getByRole("button", { name: /Stop response|停止/ }).count(), 1);
    await page.screenshot({ path: join(output, `${touch ? "touch" : "desktop"}-draft.png`) });
    if (touch) await queue.tap(); else await queue.click();
    await page.waitForFunction(() => document.querySelector(".opencraft-composer-queue-item")?.textContent?.includes("Second queued task"));
    await editor.fill("Third queued task");
    if (touch) await queue.tap(); else await queue.click();
    await page.waitForFunction(() => document.querySelectorAll(".opencraft-composer-queue-item").length === 2);
    assert.equal((await engine.request("thread/queue/list", { threadId: thread.id }, owner)).data.length, 2);
    await page.screenshot({ path: join(output, `${touch ? "touch" : "desktop"}-queued.png`) });
    const session = (engine as any).sessions.get(thread.id);
    await (engine as any).native(session).request("fixture/finish", { sessionId: session.nativeId });
    await page.waitForFunction(() => !document.querySelector(".opencraft-composer-queue-item"));
    await page.getByText("done:Third queued task", { exact: true }).waitFor();
    const calls = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(calls.filter(call => call.method === "session/prompt" && call.sessionId === session.nativeId).map(call => call.prompt[0].text), ["wait:first", "Second queued task", "Third queued task"]);
    assert.equal(calls.filter(call => call.method === "session/prompt" && call.sessionId === session.nativeId)[1].prompt[1].type, "image");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ touch, realWorkbench: true, realHost: true, fifo: true, separateStop: true, errors }));
    await context.close();
  }
} finally { await browser?.close(); await vite.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
