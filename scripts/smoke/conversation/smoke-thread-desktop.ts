import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
const executablePath = process.env.OPENCRAFT_THREAD_DESKTOP_EXECUTABLE;
if (!executablePath) throw new Error("Set OPENCRAFT_THREAD_DESKTOP_EXECUTABLE to the verified desktop binary");
const { _electron } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const directory = await mkdtemp("/tmp/oc-thread-ui-");
let desktop: any;
try {
  desktop = await _electron.launch({ executablePath, args: [`--user-data-dir=${join(directory, "profile")}`], env: { ...process.env, OPENCRAFT_MODEL_STORAGE_DIRECTORY: join(directory, "models") } });
  const page = await desktop.firstWindow(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.locator(".app-shell-root").waitFor();
  await page.locator('.workbench-connection-status[data-phase="ready"]').first().waitFor({ state: "attached" });
  await page.evaluate("window.__name=value=>value");
  const parent = await page.evaluate(async (cwd: string) => {
    const channel = new MessageChannel(), rendererId = "thread-ui-fixture", leaseId = rendererId + ":lease", outer = new Map(), rpc = new Map();
    let sequence = 0, generation = 0;
    const port = channel.port1;
    port.onmessage = event => {
      const message = event.data;
      if (message.type === "response") {
        const pending = outer.get(message.requestId); outer.delete(message.requestId);
        message.ok ? pending?.resolve(message.result) : pending?.reject(new Error(message.error.message));
      } else if (message.type === "host/frame") {
        const frame = JSON.parse(message.frame), pending = rpc.get(frame.id);
        if (pending) { rpc.delete(frame.id); frame.error ? pending.reject(new Error(frame.error.message)) : pending.resolve(frame.result); }
      } else if (message.type === "ready") outer.get("ready")?.resolve();
    };
    port.start();
    const ready = new Promise<void>((resolve, reject) => outer.set("ready", { resolve, reject }));
    window.postMessage({ type: "opencraft:connect-app-host", protocolVersion: 2, rendererId }, window.location.origin, [channel.port2]);
    port.postMessage({ type: "hello", protocolVersion: 2, rendererId }); await ready;
    const envelope = (body: any) => new Promise<any>((resolve, reject) => {
      const requestId = "fixture-envelope:" + ++sequence; outer.set(requestId, { resolve, reject }); port.postMessage({ ...body, requestId });
    });
    generation = (await envelope({ type: "host/connect", hostId: "local", leaseId })).generation;
    const request = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
      const id = "fixture-rpc:" + ++sequence; rpc.set(id, { resolve, reject });
      void envelope({ type: "host/send", hostId: "local", leaseId, generation, frame: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).catch(reject);
    });
    (window as any).__threadFixture = { request };
    await request("initialize", { clientInfo: { name: "desktop-lifecycle-fixture", version: "1" }, capabilities: { experimentalApi: true } });
    const providers = await request("runtime/providers/list");
    const saved = await request("runtime/providers/apply", { target: { kind: "create", id: "desktop-fixture" }, expectedRevision: providers.creation.revision,
      displayName: "Desktop fixture", baseURL: "http://127.0.0.1:1/v1", api: "openai-completions", models: [{ id: "desktop-local-model", contextWindow: 8192, maxTokens: 1024 }],
      credential: { kind: "replace", value: "synthetic-desktop-fixture" } });
    await request("runtime/providers/setEnabled", { provider: "desktop-fixture", enabled: true, expectedRevision: saved.revision });
    const model = (await request("model/list")).data.find((model: any) => model.displayName === "desktop-local-model").model;
    const thread = (await request("thread/start", { cwd, model })).thread;
    await request("thread/name/set", { threadId: thread.id, name: "Lifecycle desktop fixture" });
    return thread.id;
  }, directory);
  await page.waitForFunction(() => document.querySelector(".opencraft-composer-mode__model-label")?.textContent?.trim() === "Model");
  const row = page.locator(".sidebar-activity-item").filter({ hasText: "Lifecycle desktop fixture" }); await row.waitFor();
  await row.click({ button: "right" }); await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await page.getByRole("textbox", { name: "会话名称" }).fill("Desktop renamed fixture");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const renamed = page.locator(".sidebar-activity-item").filter({ hasText: "Desktop renamed fixture" }); await renamed.waitFor();
  await renamed.click({ button: "right" }); await page.getByRole("menuitem", { name: "新建分支", exact: true }).click();
  try {
    await page.waitForFunction((parent: string) => location.pathname.startsWith("/local/") && location.pathname.split("/").at(-1) !== parent, parent);
  } catch (error) {
    console.log("UI_FORK_DIAGNOSTIC", { parent, url: page.url() }, await page.locator("body").innerText());
    throw error;
  }
  await renamed.click({ button: "right" }); await page.getByRole("menuitem", { name: "归档", exact: true }).click();
  await renamed.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "已归档会话", exact: true }).click();
  await page.getByRole("dialog", { name: "已归档会话" }).waitFor();
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await page.getByRole("button", { name: "Close 已归档会话", exact: true }).click();
  await page.locator(".sidebar-activity-item").filter({ hasText: "Desktop renamed fixture" }).waitFor();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/tmp/opencraft-thread-desktop.png" });
  console.log("PASS: signed desktop actual AppHost/DSH rename, fork navigation, archive and persistent restore UI; no model inference");
} finally { await desktop?.close(); await rm(directory, { recursive: true, force: true }); }
