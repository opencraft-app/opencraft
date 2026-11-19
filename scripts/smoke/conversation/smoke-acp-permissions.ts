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
const root = await mkdtemp(join(tmpdir(), "opencraft-acp-permissions-"));
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? join(tmpdir(), "opencraft-acp-permissions");
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
    const { thread } = await engine.request("thread/start", { permissions: "opencraft:permission-mode:full" }, owner);
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 900 }, locale: "zh-CN", hasTouch: touch, isMobile: touch, colorScheme: touch ? "dark" : "light" });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("opencraft.onboarding.completedAt", new Date().toISOString()));
    await page.goto(`${origin}/local/${thread.id}?hostId=local`);
    const editor = page.locator(".opencraft-composer-editor[contenteditable=true]");
    await editor.waitFor({ timeout: 60000 });
    const trigger = page.locator(".opencraft-composer-mode--permissions");
    const activate = async (locator: any) => touch ? locator.tap() : locator.click();
    if (touch) await editor.tap();
    await editor.fill("Permission draft");
    await trigger.filter({ hasText: /完全访问|Full access/ }).waitFor();
    for (const [mode, native, label] of [
      ["read-only", "read-only", /只读|Read only/],
      ["full", "agent-full-access", /完全访问|Full access/],
    ] as const) {
      await editor.fill(`Policy test ${mode}`);
      await activate(trigger);
      const menu = page.getByRole("menu");
      await menu.waitFor();
      await menu.evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity)
          .map(animation => animation.finished.catch(() => {})));
      });
      const text = await menu.innerText();
      assert.ok(!text.includes("Opencraft:permission"), "internal IDs must not become permission labels");
      for (const label of [/只读|Read only/, /允许编辑|Accept edits/, /自动审批|自动审核|Auto review/, /完全访问|Full access/]) assert.match(text, label);
      await page.screenshot({ path: join(output, `${touch ? "touch" : "desktop"}-${mode}-menu.png`), animations: "disabled" });
      const option = menu.getByRole("menuitem").filter({ hasText: label }).first();
      await activate(option);
      assert.equal(await editor.innerText(), `Policy test ${mode}`, "opening/selecting a mode preserves the draft");
      const send = page.locator('[data-composer-primary-action="send"]');
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-composer-primary-action="send"]')?.disabled);
      await activate(send);
      const deadline = Date.now()+15000;
      while (!(completed.get(thread.id)?.length === (mode === "read-only" ? 1 : 2))) { if(Date.now()>deadline)throw new Error("Permission smoke completion timeout");await new Promise(resolve=>setTimeout(resolve,20)); }
      const calls = (await readFile(trace,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
      const session = (engine as any).sessions.get(thread.id);
      assert.equal(calls.filter(call=>call.method==="session/prompt" && call.sessionId===session.nativeId).at(-1).permissionMode,native);
      assert.equal((await engine.request("thread/resume",{threadId:thread.id},owner)).activePermissionProfile.id,`opencraft:permission-mode:${mode}`);
    }
    await page.reload(); await editor.waitFor();
    if (touch) await editor.tap();
    await editor.fill("Restored permission");
    await trigger.filter({ hasText: /完全访问|Full access/ }).waitFor();
    await page.screenshot({ path: join(output, `${touch ? "touch" : "desktop"}-reloaded.png`) });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({touch,modeSelection:true,nativePromptPolicy:true,reloaded:true}));
    await context.close();
  }
} finally { await browser?.close(); await vite.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
