import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const bundle = await build({ entryPoints: ["tests/fixtures/hermes-profile-ui.tsx"], bundle: true, write: false,
  format: "esm", platform: "browser", jsx: "automatic", loader: { ".scss": "empty", ".css": "empty" } });
const assets = resolve("apps/workbench-web/dist/assets");
const css = Buffer.concat(await Promise.all((await readdir(assets)).filter(name => name.endsWith(".css")).map(name => readFile(join(assets, name)))));
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0]!.contents); }
  else if (req.url === "/fixture.css") { res.setHeader("content-type", "text/css"); res.end(css); }
  else { res.setHeader("content-type", "text/html"); res.end('<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
});
let browser: any;
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 780 } }); page.setDefaultTimeout(12000);
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?management`);
  assert.equal(await page.getByRole("combobox").count(), 0);
  assert.equal(await page.getByText("Local", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /连接/u }).count(), 0);
  await page.getByRole("button", { name: "新建 Bot", exact: true }).click();
  await page.getByRole("textbox", { name: "Bot 名称" }).fill("新助理");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("button", { name: "新助理", exact: true }).waitFor();
  await page.getByRole("button", { name: "新助理 的操作" }).click();
  await page.getByRole("menuitem", { name: "克隆", exact: true }).click();
  await page.getByRole("textbox", { name: "Bot 名称" }).fill("克隆助理");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("button", { name: "克隆助理", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await page.getByRole("textbox", { name: "Bot 名称" }).fill("研究助理");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "研究助理", exact: true }).waitFor();
  await page.getByRole("button", { name: "Main Bot 的操作" }).click();
  assert.equal(await page.getByRole("menuitem", { name: "删除", exact: true }).getAttribute("aria-disabled"), "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "研究助理 的操作" }).click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole("alertdialog").waitFor();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "研究助理", exact: true }).count(), 1);
  await page.getByRole("button", { name: "研究助理 的操作" }).click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "研究助理", exact: true }).waitFor({ state: "hidden" });
  const writes = await page.evaluate(() => (window as any).__hermesFixture.controlCalls.filter((call: any) => call.method !== "GET"));
  assert.deepEqual(writes.map((call: any) => call.method), ["POST", "POST", "PUT", "DELETE"]);
  assert.equal(writes[0].body.create_mode, "blank"); assert.equal(writes[1].body.create_mode, "clone");
  assert.equal(writes[1].body.source_bot_id, "new-profile-1");
  const evidence = resolve("design/hermes-profile-bots/evidence"); await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, "management-light.png") });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: join(evidence, "management-dark.png") });
  assert.deepEqual(errors, []);
  console.log("PASS real management UI/Radix dialogs+menus/AppServer/Bridge/control-plane adapter: blank, clone, rename, delete, cancel deletion and protected root; remote API is simulated.");
} finally { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
