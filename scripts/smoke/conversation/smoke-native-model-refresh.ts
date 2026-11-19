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
const agent = process.env.OPENCRAFT_REFRESH_AGENT === "cursor" ? "cursor" : "codex";
const modelId = (name: string) => agent === "cursor" ? `cursor-model-${name}` : `gpt-${name}-sol[high]`;
const modelLabel = (name: string) => agent === "cursor" ? `Cursor ${name}` : `GPT ${name} Sol (high)`;
const root = await mkdtemp(join(tmpdir(), "opencraft-model-refresh-route-"));
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? join(tmpdir(), "opencraft-model-refresh-route");
await mkdir(output, { recursive: true });
const trace = join(root, "calls.jsonl");
const nativeModels = join(root, "models.json");
const publishModels = (name: string) => writeFile(nativeModels, JSON.stringify([{ modelId: modelId(name), name: modelLabel(name) }]));
await publishModels("6.1");
const screenshot = join(root, "screenshot.png");
await writeFile(screenshot, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
const completed = new Map<string, any[]>();
const historyTurns = (nativeId: string) => {
  const session = [...(engine as any).sessions.values()].find((entry: any) => entry.nativeId === nativeId) as any;
  if (!session) return [];
  const active = (engine as any).state(session.id).active;
  return [...completed.get(session.id) ?? [], ...(active?.status === "inProgress" ? [(engine as any).turn((engine as any).state(session.id))] : [])];
};
const engine = new AcpEngine({ id: agent, command: process.execPath, args: [resolve("tests/fixtures/acp-engine-peer.mjs")],
  cwd: root, dataDirectory: join(root, "data"), permission: "allow-once",
  history: { async read(nativeId) { return { data: historyTurns(nativeId), nextCursor: null }; }, async snapshot(nativeId) { return historyTurns(nativeId); } },
  env: { ACP_TEST_MODEL_CATALOG_FILE: nativeModels, ACP_TEST_PERMISSIONS: "1", ACP_TEST_TRACE: trace, ACP_TEST_MODELS: "1", ACP_TEST_IMAGES: "1", ACP_TEST_WAIT_MS: "30000" } });
engine.subscribe((method, params) => { if (method === "turn/completed") completed.set(params.threadId, [...completed.get(params.threadId) ?? [], structuredClone(params.turn)]); });
const originalRequest = engine.request.bind(engine);
engine.request = async (method, params, client) => {
  // In production the containing local Host supplies these shell catalogs.
  if (method === "config/read") return { config: { model: "codex:default-native" }, origins: {}, layers: null };
  if (method === "opencraft/thread-pins/list") return { supported: false, data: [] };
  if (method === "opencraft/agents/usage") return null;
  try { return await originalRequest(method, params, client); }
  catch (error) { console.error("ACP smoke rejected", method, Object.keys(params)); throw error; }
};
const host = await startEngineHost({ providers: [engine], defaultEngine: agent, resources: { projectDirectory: root } });
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
    await publishModels("6.1");
    const { thread } = await engine.request("thread/start", { permissions: "opencraft:permission-mode:full" }, owner);
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 900 }, locale: "zh-CN", hasTouch: touch, isMobile: touch });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("opencraft.onboarding.completedAt", new Date().toISOString()));
    await page.goto(`${origin}/local/${thread.id}?hostId=local`);
    const editor = page.locator(".opencraft-composer-editor[contenteditable=true]"); await editor.waitFor({ timeout: 60000 });
    if(touch)await editor.tap(); await editor.fill("刷新期间保留这份草稿");
    await editor.evaluate(element => { (window as any).originalRefreshEditor = element; });
    const trigger = page.locator(".opencraft-composer-mode--intelligence");
    if (agent === "codex") await trigger.filter({hasText:"6.1 Sol"}).waitFor(); else await trigger.waitFor();
    if (agent === "codex") assert.doesNotMatch(await trigger.textContent() ?? "", /codex:|\[high\]/i);
    if(touch)await trigger.tap();else await trigger.click();
    const menu = page.getByRole("menu");await menu.waitFor();
    const refresh=menu.getByRole("button",{name:/刷新模型|Refresh models/,exact:true});
    try { await refresh.waitFor({timeout:15000}); } catch(error) {
      console.error(JSON.stringify({menu:await menu.innerText(),buttons:await menu.getByRole("button").allTextContents()}));
      await page.screenshot({path:join(output,"refresh-missing.png"),animations:"disabled"});throw error;
    }
    await publishModels("6.2");
    if(touch)await refresh.tap();else await refresh.click();
    const fresh=menu.getByRole("menuitem",{name:agent === "cursor" ? "Cursor 6.2" : "GPT 6.2 Sol",exact:true});await fresh.waitFor({timeout:30000});
    assert.equal(await menu.getByRole("menuitem",{name:agent === "cursor" ? "Cursor 6.1" : "GPT 6.1 Sol",exact:true}).count(),0);
    assert.equal(await editor.innerText(),"刷新期间保留这份草稿");
    assert.equal(await editor.evaluate(element=>element===(window as any).originalRefreshEditor),true);
    await page.screenshot({path:join(output,`${touch?'touch':'desktop'}-refreshed.png`),animations:"disabled"});
    if(touch)await fresh.tap();else await fresh.click();
    await page.keyboard.press("Escape");await menu.waitFor({state:"hidden"});
    await trigger.filter({hasText:agent === "cursor" ? "Cursor 6.2" : "6.2 Sol"}).waitFor();
    const send=page.locator('[data-composer-primary-action="send"]');await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('[data-composer-primary-action="send"]')?.disabled);
    if(touch)await send.tap();else await send.click();
    await page.getByText("done:刷新期间保留这份草稿",{exact:true}).waitFor();
    assert.equal((await engine.request("thread/read",{threadId:thread.id},owner)).thread.model,`${agent}:${modelId("6.2")}`);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({agent,touch,realWorkbench:true,refreshed:true,newModelApplied:true}));
    await context.close();
  }
} finally { await browser?.close(); await vite.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
