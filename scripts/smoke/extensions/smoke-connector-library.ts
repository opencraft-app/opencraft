import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { createServer } from "vite";
import { ManagedConnectorService } from "../../../packages/connector-host/src/service";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = await mkdtemp("/tmp/oc-connector-library-"); let calls = 0, failProbe = false, failSaveAfterCommit = false, oauthStarts = 0, oauthPollFails = true, oauthStatus = "pending";
const service = new ManagedConnectorService(join(output, "connectors.sqlite"), async (input, init) => {
  assert.match(String(input), /ima.qq.com\/openapi\/note\/v1\/import_doc$/);
  assert.equal(new Headers(init?.headers).get("ima-openapi-apikey"), "synthetic-ima-key");
  assert.equal(JSON.parse(String(init?.body)).content, "isolated note"); calls++; return Response.json({ code: 0, note_id: "isolated-note" });
});
const host = createHttpServer(), sockets = new WebSocketServer({ server: host });
await new Promise<void>(resolve => host.listen(0, "127.0.0.1", resolve));
service.subscribe(id => { for (const socket of sockets.clients) socket.send(JSON.stringify({ jsonrpc: "2.0", method: "connectors/managed/changed", params: { id } })); });
sockets.on("connection", socket => socket.on("message", frame => {
  const message = JSON.parse(frame.toString()); if (!Object.hasOwn(message, "id")) return;
  void (async () => {
    try {
      if (message.method === "connectors/managed/probe" && failProbe) { failProbe = false; throw new Error("isolated probe failure"); }
      if (message.method === "connectors/managed/oauth/status" && oauthPollFails) throw new Error("isolated polling failure");
      if (message.method === "connectors/managed/oauth/start") oauthStarts++;
      const result = message.method === "connectors/managed/oauth/start" ? { id: "ui-oauth-fixture", status: "pending", authorizationUrl: `http://127.0.0.1:${(host.address() as any).port}/authorize` }
        : message.method === "connectors/managed/oauth/status" ? { id: "ui-oauth-fixture", status: oauthStatus }
        : message.method === "connectors/managed/oauth/cancel" ? (oauthStatus = "cancelled", {})
        : message.method === "initialize" ? { userAgent: "isolated-host", codexHome: "/tmp/isolated", platformFamily: "unix", platformOs: "linux" }
        : await service.handle(message.method, message.params);
      if (message.method === "connectors/managed/save" && failSaveAfterCommit) { failSaveAfterCommit = false; throw new Error("isolated lost acknowledgement"); }
      if (message.method === "connectors/managed/oauth/cancel") throw new Error("isolated lost cancellation acknowledgement");
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch { socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Connector unavailable" } })); }
  })();
}));
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", cacheDir: "node_modules/.vite-connector-library",
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-alert-dialog"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "connector-library", configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url?.split("?")[0] !== "/") return next();
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end('<div id="root"></div><script type="module" src="/scripts/fixtures/connector-library-controls.tsx"></script>');
  }); } }],
});
let browser: any; const errors: string[] = [], evidence: string[] = [];
try {
  await vite.listen(); browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }); page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?host=ws://127.0.0.1:${(host.address() as any).port}`);
  await page.getByRole("button", { name: "腾讯 IMA · 查看接入详情", exact: true }).waitFor();
  const initialCards = await page.locator('.connector-service-card').evaluateAll((cards: HTMLElement[]) => cards.slice(0, 4).map(card => ({ x: card.offsetLeft, y: card.offsetTop })));
  assert.ok(new Set(initialCards.map(card => card.x)).size >= 3, "wide catalog uses compact columns instead of full-width settings rows");
  await page.getByRole("textbox", { name: "搜索连接器" }).fill("IMA");
  const card = page.getByRole("button", { name: "腾讯 IMA · 查看接入详情", exact: true });
  await card.focus(); await page.keyboard.press("Enter");
  const setup = page.getByRole("dialog", { name: "腾讯 IMA接入配置", exact: true }); await setup.waitFor();
  assert.equal(await setup.getAttribute("data-presentation"), "inspector");
  const inspectorBox = await setup.boundingBox(); assert.ok(inspectorBox.x > 450 && inspectorBox.width <= 560);
  await page.getByRole("textbox", { name: "连接名称", exact: true }).fill("IMA 工作账号");
  await page.getByLabel("API Key", { exact: true }).fill("synthetic-ima-key");
  await page.getByLabel("Client ID", { exact: true }).fill("synthetic-client");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("配置已保存", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
  failProbe = true;
  await page.getByRole("button", { name: "检查配置", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "未能完成配置检查，请重试。" }).waitFor();
  await page.getByRole("button", { name: "检查配置", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "仅检查了填写格式，尚未验证访问权限。" }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  await page.getByLabel("Client ID", { exact: true }).fill("changed-client");
  await page.getByText("已修改“Client ID”，请重新填写“API Key”。", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("API Key", { exact: true }).getAttribute("required"), "");
  await page.getByLabel("Client ID", { exact: true }).fill("synthetic-client");
  await page.getByText("已保存，留空保留原值。", { exact: true }).waitFor();
  assert.equal(calls, 0); await page.screenshot({ path: join(output, "setup.png") });
  await page.getByRole("button", { name: "Close 腾讯 ima接入配置", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "腾讯 IMA · 查看接入详情");
  assert.equal(await page.getByRole("textbox", { name: "搜索连接器" }).inputValue(), "IMA");
  await page.getByRole("textbox", { name: "搜索连接器" }).fill("");
  assert.equal(await page.locator('.connector-service-card .connector-icon svg').count(), 23);
  assert.equal(await page.locator('.connector-icon img, .connector-icon image, .connector-icon use').count(), 0);
  await page.screenshot({ path: join(output, "library.png") });
  assert.deepEqual(await page.evaluate(() => (window as any).connectorProbe.available()), []);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("menuitem", { name: "连接器", exact: true }).hover();
  await page.locator('.connector-quick-surface--submenu .connector-quick-menu__row').filter({ hasText: "IMA 工作账号" }).click();
  await page.locator('.connector-quick-surface--submenu').waitFor({ state: "hidden" });
  await page.waitForFunction(async () => (await (window as any).connectorProbe.available()).some((tool: any) => tool.name === "create_note"));
  await page.evaluate(() => { void (window as any).connectorProbe.write(); });
  await page.waitForFunction(() => (window as any).connectorProbe.result !== "pending" || document.querySelector('[role="alertdialog"]'));
  assert.equal(await page.evaluate(() => (window as any).connectorProbe.error), "");
  await page.getByRole("button", { name: "拒绝", exact: true }).click(); await page.waitForFunction(() => (window as any).connectorProbe.result === "denied"); assert.equal(calls, 0);
  await page.evaluate(() => { void (window as any).connectorProbe.write(); });
  await page.getByRole("button", { name: "仅允许这一次", exact: true }).click(); await page.waitForFunction(() => (window as any).connectorProbe.result === "allowed"); assert.equal(calls, 1);
  await page.reload(); await page.getByRole("radio", { name: "已配置 1", exact: true }).click(); await page.getByText("IMA 工作账号", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => (window as any).connectorProbe.available()), []);
  evidence.push("real UI -> WebSocket -> Host database; secret not projected; format-only probe; scope selection and one-shot write; reload without grants");
  await page.evaluate(() => (window as any).connectorProbe.setThemePreference("dark")); await page.setViewportSize({ width: 420, height: 720 }); await page.waitForTimeout(300);
  await page.screenshot({ path: join(output, "narrow-dark.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.ok(await page.locator('.connector-instance__copy').first().evaluate((el: HTMLElement) => el.clientWidth > 180));
  await page.getByRole("radio", { name: "全部服务", exact: true }).click();
  await page.getByRole("button", { name: "腾讯 IMA · 查看接入详情", exact: true }).click();
  const narrowSetup = page.getByRole("dialog", { name: "腾讯 IMA接入配置", exact: true });
  const narrowBox = await narrowSetup.boundingBox(); assert.ok(narrowBox.x === 0 && narrowBox.width <= 421 && narrowBox.height <= 721);
  await page.screenshot({ path: join(output, "inspector-dark-narrow.png") });
  await page.keyboard.press("Escape"); await narrowSetup.waitFor({ state: "detached" });
  await page.getByRole("radio", { name: "已配置 1", exact: true }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "删除配置和凭据", exact: true }).click();
  await page.getByText("IMA 工作账号", { exact: true }).waitFor({ state: "detached" }); assert.equal(service.list().instances.length, 0);
  await page.getByRole("radio", { name: "全部服务", exact: true }).click();
  await page.getByRole("button", { name: "Notion · 查看接入详情", exact: true }).click();
  failSaveAfterCommit = true;
  await page.getByRole("button", { name: "登录授权", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "未能确认配置是否保存" }).waitFor();
  assert.equal(oauthStarts, 0, "save-stage failure is not mislabeled as an OAuth failure");
  await page.getByRole("button", { name: "查看已配置", exact: true }).click();
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await page.getByRole("button", { name: "测试连接", exact: true }).waitFor();
  assert.equal(service.list().instances.length, 1, "uncertain save recovery does not duplicate the connector");
  await page.getByRole("button", { name: "登录授权", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "暂时无法获取授权结果，正在继续检查。" }).waitFor();
  oauthPollFails = false;
  await page.getByRole("status").filter({ hasText: "请在授权页面完成登录，并保持此窗口打开。" }).waitFor();
  assert.equal(await page.getByText("暂时无法获取授权结果，正在继续检查。你也可以取消等待。", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "取消等待", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "未能确认授权是否取消" }).waitFor();
  await page.getByRole("status").filter({ hasText: "已停止等待授权结果" }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0, "confirmed cancellation clears the old uncertain-result error");
  evidence.push("check failure/retry; Client ID guidance; unconfirmed save inspected without duplicate or mislabeled OAuth; polling warning clears; cancellation does not claim revocation");
  evidence.push("compact catalog with 23 local category icons; inspector keyboard/focus; search retained; configured view; narrow dark layout and delete confirmation");
  assert.deepEqual(errors, []); console.log(JSON.stringify({ output, evidence, calls }));
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify({ evidence, errors, calls })); await browser?.close(); await vite.close();
  for (const socket of sockets.clients) socket.terminate(); await new Promise<void>(resolve => sockets.close(() => host.close(() => resolve()))); service.close();
}
