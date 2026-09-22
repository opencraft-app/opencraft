import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { electronLaunchSpec } from "./start-electron.mjs";

// Actual repository Main + Preload + Renderer, isolated profile; no remote login.
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = await mkdtemp("/tmp/oc-connector-desktop-");
const config = { version: 1, connectors: [{ id: "desktop-fixture", hostId: "local-codex", server: "Desktop isolated fixture", title: "Desktop isolated fixture" }], selections: [] };
let child: ChildProcess | undefined, browser: any;
const evidence: string[] = [];
async function stop() {
  await browser?.close(); browser = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    const current = child;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => current.kill("SIGKILL"), 10000);
      current.once("exit", () => { clearTimeout(timer); resolve(); }); current.kill("SIGTERM");
    });
  }
  child = undefined;
}
async function launch() {
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const env = { ...process.env, OPENCRAFT_MODEL_STORAGE_DIRECTORY: join(root, "models"), OPENCRAFT_SKILLS_DIRECTORY: join(root, "skills"), DSH_AGENTS_HOME: join(root, "agents") };
  delete env.OPENCRAFT_DSH_URL; delete env.OPENCRAFT_DSH_REPOSITORY;
  const spec = electronLaunchSpec([`--user-data-dir=${join(root, "profile")}`, `--remote-debugging-port=${port}`], env);
  child = spawn(spec.executable, spec.args, { ...spec.options, stdio: "ignore" });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Isolated Electron exited before CDP became ready");
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!browser) throw new Error("Isolated Electron CDP deadline exceeded");
  const context = browser.contexts()[0];
  let page = context.pages().find((p: any) => p.url().startsWith("http://127.0.0.1:"));
  if (!page) page = await context.waitForEvent("page");
  await page.waitForFunction(() => !!(globalThis as any).opencraftDesktop?.connectorConfiguration);
  return page;
}
try {
  let page = await launch();
  const first = await page.evaluate(() => (globalThis as any).opencraftDesktop.connectorConfiguration.load());
  assert.deepEqual(first, { revision: 0, value: { version: 1, connectors: [], selections: [] } });
  const saved = await page.evaluate(async value => {
    const port = (globalThis as any).opencraftDesktop.connectorConfiguration;
    let notify!: () => void;
    const event = new Promise<void>(resolve => { notify = resolve; });
    const remove = port.subscribe(() => notify());
    const result = await port.compareAndSet(0, value);
    const changed = await Promise.race([event.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5000))]);
    remove(); return { result, changed };
  }, config);
  assert.equal(saved.result.updated, true); assert.equal(saved.changed, true);
  const conflict = await page.evaluate(value => (globalThis as any).opencraftDesktop.connectorConfiguration.compareAndSet(0, value), config);
  assert.equal(conflict.updated, false);
  const rejected = await page.evaluate(async () => {
    try { await (globalThis as any).opencraftDesktop.connectorConfiguration.compareAndSet(1, { version: 1, connectors: [], selections: [], token: "synthetic" }); return false; } catch { return true; }
  });
  assert.equal(rejected, true); evidence.push("actual Main/Preload IPC save + changed event + CAS conflict + strict whitelist");
  await stop(); page = await launch();
  assert.deepEqual(await page.evaluate(() => (globalThis as any).opencraftDesktop.connectorConfiguration.load()), { revision: 1, value: config });
  await page.getByRole("button", { name: /^(Add|添加)$/ }).click({ timeout: 45000 });
  const connectors = page.getByRole("menuitem", { name: /^(Connectors|连接器)$/ });
  await connectors.hover({ force: true });
  await page.locator('.connector-quick-menu__row[aria-label="Desktop isolated fixture，连接"]').waitFor();
  await page.screenshot({ path: join(root, "desktop-reopened.png") });
  evidence.push("native process restart retained configuration; real Composer Add submenu opens the saved unconnected connector without a Modal");
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await page.getByText("Skills", { exact: true }).click();
  await page.getByRole("radio", { name: "连接器", exact: true }).click({ timeout: 45000 });
  await page.getByRole("button", { name: "腾讯 IMA · 查看接入详情", exact: true }).click();
  const setup = page.getByRole("dialog", { name: "腾讯 IMA接入配置", exact: true }); await setup.waitFor();
  const apiKey = page.getByLabel("API Key", { exact: true });
  if (await apiKey.count() === 0) {
    await setup.getByText("所选设备暂不支持此服务。你可以先查看接入说明。", { exact: true }).waitFor();
    await page.screenshot({ path: join(root, "skills-connector-unsupported.png") });
    evidence.push("Skills connector setup reflects the selected Host capability instead of exposing unusable credential fields");
  } else {
    await apiKey.fill("synthetic-desktop-ima-key");
    await page.getByLabel("Client ID", { exact: true }).fill("synthetic-client");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("配置已保存", { exact: true }).waitFor();
    assert.equal(await apiKey.inputValue(), "");
    await page.getByRole("button", { name: "检查配置", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "仅检查了填写格式" }).waitFor();
    await page.screenshot({ path: join(root, "skills-connector-setup.png") });
    await page.getByRole("button", { name: "Close 腾讯 ima接入配置", exact: true }).click();
    await page.screenshot({ path: join(root, "skills-connector-tab.png") });
    await stop(); page = await launch();
    await page.getByText("Skills", { exact: true }).click();
    await page.getByRole("radio", { name: "连接器", exact: true }).click({ timeout: 45000 });
    await page.getByRole("radio", { name: "已配置 1", exact: true }).click();
    await page.getByRole("button", { name: "配置", exact: true }).click();
    await page.getByText("已保存，留空保留原值。", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
    evidence.push("real Skills header tab -> Host database save/probe -> process restart restores instance but never projects secret");
  }
  console.log(JSON.stringify({ root, evidence }, null, 2));
} finally { await writeFile(join(root, "report.json"), JSON.stringify({ evidence }, null, 2)); await stop(); }
