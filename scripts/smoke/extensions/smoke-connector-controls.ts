import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_CONNECTOR_REPORT ?? "/tmp/opencraft-connector-controls";
let authenticated = false, writes = 0, logins = 0;
const host = createHttpServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === "/authorize" && req.method === "POST") {
    authenticated = true;
    for (const client of sockets.clients) client.send(JSON.stringify({ jsonrpc: "2.0", method: "mcpServer/oauthLogin/completed", params: { name: "Isolated Documents", success: true } }));
    res.end("<h1>隔离授权已完成</h1><p>请返回工作台确认连接。</p>"); return;
  }
  res.end('<h1>隔离授权服务</h1><p>无真实账号、无第三方连接。</p><form method="post" action="/authorize"><button>批准隔离授权</button></form>');
});
const sockets = new WebSocketServer({ server: host });
await new Promise<void>(resolve => host.listen(0, "127.0.0.1", resolve));
const hostPort = (host.address() as { port: number }).port;
sockets.on("connection", socket => socket.on("message", frame => {
  const message = JSON.parse(frame.toString()); if (!Object.hasOwn(message, "id")) return;
  let result: unknown;
  if (message.method === "initialize") result = { userAgent: "isolated-host", codexHome: "/tmp/isolated", platformFamily: "unix", platformOs: "linux" };
  if (message.method === "mcpServerStatus/list") result = { data: [{ name: "Isolated Documents", authStatus: authenticated ? "oAuth" : "notLoggedIn", tools: {
    read: { name: "read", description: "读取隔离文档", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    write: { name: "write", description: "更新隔离文档", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
  } }], nextCursor: null };
  if (message.method === "mcpServer/oauth/login") { logins++; result = { authorizationUrl: `http://127.0.0.1:${hostPort}/` }; }
  if (message.method === "config/mcpServer/reload") result = {};
  if (message.method === "mcpServer/tool/call" && authenticated) { if (message.params.tool === "write") writes++; result = { content: [{ type: "text", text: "isolated result" }] }; }
  socket.send(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported fixture method" } } : { jsonrpc: "2.0", id: message.id, result }));
}));
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", cacheDir: "node_modules/.vite-connector-controls",
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-alert-dialog"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "connector-controls", configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url?.split("?")[0] !== "/") return next();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<div id="root"></div><script type="module" src="/scripts/fixtures/connector-controls.tsx"></script>');
  }); } }],
});
let browser: any;
const errors: string[] = [], evidence: string[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext(), page = await context.newPage();
  await page.setViewportSize({ width: 1100, height: 850 });
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?host=ws://127.0.0.1:${hostPort}`);
  const open = async (targetPage = page) => {
    await targetPage.locator(".opencraft-composer-add-menu").waitFor({ state: "hidden" }).catch(() => undefined);
    await targetPage.getByRole("button", { name: "Add", exact: true }).click({ force: true });
    await targetPage.locator(".opencraft-composer-add-menu").waitFor();
    const trigger = targetPage.getByRole("menuitem", { name: "Connectors", exact: true });
    await trigger.hover({ force: true });
    await targetPage.locator(".connector-quick-surface--submenu").waitFor();
  };
  const addNative = async (targetPage = page) => {
    await targetPage.getByText("已有 MCP 服务？", { exact: true }).click();
    await targetPage.getByRole("button", { name: "读取 MCP 服务", exact: true }).click();
    await targetPage.getByRole("button", { name: "添加连接器", exact: true }).click();
    await targetPage.getByRole("button", { name: "已添加", exact: true }).waitFor();
  };
  await addNative();
  await open();
  await page.screenshot({ path: `${output}/add-menu-light.png` });
  await page.locator('.connector-quick-menu__row[aria-label="Isolated Documents，Connect"]').click();
  await page.locator(".opencraft-composer-add-menu").waitFor({ state: "hidden" });
  await page.waitForFunction(() => Object.values((window as any).connectorProbe.snapshot().states).some((state: any) => state.phase === "authorizing"));
  await open();
  await page.evaluate(() => {
    (window as any).__connectorOpenedUrls = [];
    window.open = ((url?: string | URL) => { (window as any).__connectorOpenedUrls.push(String(url)); return null; }) as typeof window.open;
  });
  await page.locator('.connector-quick-menu__row[aria-label="Isolated Documents，Open authorization"]').click();
  await page.waitForFunction(() => (window as any).__connectorOpenedUrls.length === 1);
  const authorizationUrl = await page.evaluate(() => (window as any).__connectorOpenedUrls[0]);
  assert.equal(await page.evaluate(() => Object.values((window as any).connectorProbe.snapshot().states).some((state: any) => state.phase === "authorizing")), true,
    "closing Add/Connector popovers after an action must not cancel the scope-owned authorization");
  const authPage = await context.newPage(); await authPage.goto(authorizationUrl);
  await authPage.getByRole("button", { name: "批准隔离授权", exact: true }).click();
  await open();
  await page.locator('.connector-quick-menu__row[aria-label="Isolated Documents，Confirm"]').waitFor();
  assert.deepEqual(await page.evaluate(() => (window as any).connectorProbe.available()), []);
  await authPage.close(); await page.locator('.connector-quick-menu__row[aria-label="Isolated Documents，Confirm"]').click();
  await page.waitForFunction(async () => (await (window as any).connectorProbe.available()).length === 2);
  const chip = page.getByRole("button", { name: "Conversation connectors: Isolated Documents", exact: true });
  await chip.waitFor();
  evidence.push("real Add submenu -> scope-owned authorization survives close -> explicit connect+selection -> active connector chip");
  await chip.click();
  await page.screenshot({ path: `${output}/connected-light.png` });
  await page.evaluate(() => { void (window as any).connectorProbe.write(); });
  const approval = page.getByRole("alertdialog", { name: "确认连接器写操作", exact: true }); await approval.waitFor();
  assert.equal(writes, 0);
  assert.ok(!(await approval.innerText()).includes("synthetic-private-value"));
  assert.equal(await page.getByRole("button", { name: "拒绝", exact: true }).evaluate((el: Element) => document.activeElement === el), true);
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await page.waitForFunction(() => (window as any).connectorProbe.result === "denied"); assert.equal(writes, 0);
  await page.evaluate(() => { void (window as any).connectorProbe.write(); }); await approval.waitFor();
  await page.screenshot({ path: `${output}/write-approval.png` });
  await page.getByRole("button", { name: "仅允许这一次", exact: true }).click();
  await page.waitForFunction(() => (window as any).connectorProbe.result === "allowed"); assert.equal(writes, 1);
  await page.evaluate(() => { void (window as any).connectorProbe.write(); }); await approval.waitFor();
  await page.keyboard.press("Escape"); await page.waitForFunction(() => (window as any).connectorProbe.result === "denied"); assert.equal(writes, 1);
  evidence.push("write waits; deny/Escape no effect; approve once one effect; redacted parameters; safe default focus");
  await page.evaluate(() => (window as any).connectorProbe.setThemePreference("dark"));
  await page.setViewportSize({ width: 420, height: 620 });
  await page.waitForTimeout(300); // Let the shared button color transition settle before measuring.
  const popover = page.locator(".connector-quick-surface--chip");
  if (!(await popover.isVisible())) await chip.click();
  await popover.waitFor();
  await page.screenshot({ path: `${output}/connected-dark-narrow.png` });
  await popover.screenshot({ path: `${output}/connector-popover-dark-narrow.png` });
  const box = await popover.boundingBox(); assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 421 && box.y + box.height <= 621);
  assert.equal(await popover.evaluate((e: HTMLElement) => e.scrollWidth <= e.clientWidth + 1), true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Conversation connectors: Isolated Documents");
  assert.equal(await chip.evaluate((el: Element) => document.activeElement === el), true);
  await page.reload(); await open();
  await page.locator('.connector-quick-menu__row[aria-label="Isolated Documents，Connect"]').waitFor();
  assert.deepEqual(await page.evaluate(() => (window as any).connectorProbe.available()), []);
  await page.locator('.connector-quick-menu__row[aria-label="Isolated Documents，Connect"]').click();
  await page.getByRole("button", { name: "Conversation connectors: Isolated Documents", exact: true }).waitFor();
  assert.equal(logins, 1);
  await page.waitForFunction(async () => (await (window as any).connectorProbe.available()).length === 2);
  evidence.push("light/dark narrow Popover; trigger focus restoration; IDB remembers intent without restoring authority; cached auth reconnect avoids a second login");
  await context.close();
  // A fresh Application has no persisted selection or Host login. Keep its
  // Manager/Runtime alive while the real hook owner leaves and is recreated.
  authenticated = false;
  const ownerContext = await browser.newContext(), ownerPage = await ownerContext.newPage();
  ownerPage.on("pageerror", (error: Error) => errors.push(error.message));
  await ownerPage.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?host=ws://127.0.0.1:${hostPort}`);
  await addNative(ownerPage); await open(ownerPage);
  await ownerPage.locator('.connector-quick-menu__row[aria-label="Isolated Documents，Connect"]').click();
  await ownerPage.waitForFunction(() => Object.values((window as any).connectorProbe.snapshot().states).some((state: any) => state.phase === "authorizing"));
  assert.equal(logins, 2);
  await ownerPage.evaluate(() => (window as any).connectorProbe.unmountPresentation());
  await ownerPage.getByRole("button", { name: "Add", exact: true }).waitFor({ state: "hidden" });
  await ownerPage.waitForFunction(() => Object.values((window as any).connectorProbe.snapshot().states).some((state: any) => state.phase === "cancelled"), null, { timeout: 10000 });
  const lateAuth = await ownerContext.newPage(); await lateAuth.goto(`http://127.0.0.1:${hostPort}/`);
  await lateAuth.getByRole("button", { name: "批准隔离授权", exact: true }).click();
  await ownerPage.waitForFunction(() => (window as any).connectorProbe.oauthCompletions() === 1);
  assert.deepEqual(await ownerPage.evaluate(() => (window as any).connectorProbe.available()), [], "late Host authentication cannot grant tools to the retired presentation");
  await lateAuth.close();
  await ownerPage.evaluate(() => (window as any).connectorProbe.mountPresentation());
  await ownerPage.getByRole("button", { name: "Add", exact: true }).waitFor();
  assert.deepEqual(await ownerPage.evaluate(() => (window as any).connectorProbe.available()), [], "remount cannot inherit a cancelled owner's grant");
  await open(ownerPage);
  await ownerPage.locator('.connector-quick-menu__row[aria-label="Isolated Documents，Connect"]').click();
  await ownerPage.waitForFunction(async () => (await (window as any).connectorProbe.available()).length === 2);
  assert.equal(logins, 2, "fresh explicit connect may reuse current Host authentication");
  assert.equal(writes, 1, "lifetime verification performs no additional write");
  await ownerContext.close();
  evidence.push("actual hook owner teardown cancels pending OAuth; late native completion and remount grant nothing; fresh explicit connect succeeds");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ evidence, writes, logins }, null, 2));
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify({ evidence, errors, writes, logins }, null, 2));
  await browser?.close(); await vite.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>(resolve => sockets.close(() => host.close(() => resolve())));
}
