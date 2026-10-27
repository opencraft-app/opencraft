import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { ActorStore } from "../../../packages/access-control/src/actors";
import { ActorAccess } from "../../../packages/access-control/src/actor-access";
import { HeadlessConnectors } from "../../../packages/connector-host/src/headless";
import { ManagedConnectorService } from "../../../packages/connector-host/src/service";
import { SessionCapabilities } from "../../../packages/session-capabilities/src/index";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = await mkdtemp(join(tmpdir(), "headless-connectors-ui-"));
const actors = new ActorStore(join(output, "actors.sqlite")), capabilities = new SessionCapabilities();
const principal = { provider: "fixture", subject: "alice", displayName: "Alice", expiresAt: Date.now() + 600000 };
const access = new ActorAccess(actors, { authenticateHuman: () => principal, admitted: () => true, administrator: () => false });
let calls = 0;
const service = new HeadlessConnectors(join(output, "connectors"), access, { "connector-host": "server:ui:connectors" }, capabilities, () => true,
  path => new ManagedConnectorService(path, async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("ima-openapi-apikey"), "synthetic-ui-key"); calls++; return Response.json({ code: 0, note_id: "fixture-note" });
  }));
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", cacheDir: "node_modules/.vite-headless-connectors",
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "headless-connectors-fixture", configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url === "/__opencraft_connectors") { void service.handle(req, res); return; }
    if (req.url !== "/") return next();
    res.setHeader("content-type", "text/html"); res.end('<div id="root"></div><script type="module" src="/scripts/fixtures/headless-connector-controls.tsx"></script>');
  }); } }],
});
let browser: any; const errors: string[] = [];
try {
  await vite.listen(); browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  let page = await browser.newPage({ viewport: { width: 1100, height: 850 } }); page.on("pageerror", (e: Error) => errors.push(e.message));
  const origin = vite.resolvedUrls!.local[0]; await page.goto(origin);
  await page.getByRole("button", { name: "腾讯 IMA · 查看接入详情", exact: true }).click();
  await page.getByRole("textbox", { name: "连接名称", exact: true }).fill("Headless IMA");
  await page.getByLabel("API Key", { exact: true }).fill("synthetic-ui-key");
  await page.getByLabel("Client ID", { exact: true }).fill("synthetic-ui-client");
  await page.getByRole("button", { name: "保存", exact: true }).click(); await page.getByText("配置已保存", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "添加", exact: true }).click(); await page.getByRole("menuitem", { name: "连接器", exact: true }).hover();
  await page.locator('.connector-quick-surface--submenu .connector-quick-menu__row').filter({ hasText: "Headless IMA" }).click();
  await page.waitForFunction(() => (window as any).connectorProbe.selected() === 1);
  assert.equal(await page.evaluate(() => (window as any).connectorProbe.localProviders()), 0, "the browser never owns this connector execution");
  await page.locator(".connector-status-chip").waitFor();
  await page.screenshot({ path: join(output, "selected.png") });
  const session = { serverId: "server:ui:connectors", threadId: "library-thread" };
  const model = async (name: string, args: unknown) => JSON.parse((await capabilities.call(session, name, args, new AbortController().signal)).contentItems[0].text);
  const handle = async (name: string) => {
    const page = await model("connectors_search_tools", { query: name });
    const ref = page.items.find((item: any) => item.name === name).toolRef;
    return (await model("connectors_get_tool", { toolRefs: [ref] })).items[0].handle;
  };
  const read = await handle("list_notebooks"); await page.close();
  await model("connectors_call_tool", { handle: read, arguments: {} }); assert.equal(calls, 1);
  const write = await handle("create_note");
  const pending = model("connectors_call_tool", { handle: write, arguments: { content: "isolated note" } });
  page = await browser.newPage({ viewport: { width: 420, height: 760 } }); page.on("pageerror", (e: Error) => errors.push(e.message)); await page.goto(origin);
  await page.getByRole("button", { name: "仅允许这一次", exact: true }).waitFor();
  assert.equal(calls, 1); await page.screenshot({ path: join(output, "reconnected-approval.png") });
  await page.getByRole("button", { name: "仅允许这一次", exact: true }).click(); await pending; assert.equal(calls, 2);
  await page.waitForFunction(() => (window as any).connectorProbe.selected() === 1);
  assert.equal(await page.evaluate(() => (window as any).connectorProbe.localProviders()), 0);
  await page.locator(".connector-status-chip").waitFor();
  assert.deepEqual(errors, []);
  await writeFile(join(output, "result.json"), JSON.stringify({ calls, errors, checks: ["existing-setup-http-sqlite", "headless-only-owner", "browser-closed-read", "reconnect-same-approval", "session-selection-survives-browser"] }, null, 2));
  console.log("PASS", output);
} finally { await browser?.close(); await vite.close(); await service.close(); actors.close(); }
