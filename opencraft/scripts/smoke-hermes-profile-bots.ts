import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const bundle = await build({ entryPoints: ["tests/fixtures/hermes-profile-ui.tsx"], bundle: true, write: false,
  outdir: "/tmp/opencraft-hermes-profile-ui-bundle", format: "esm", platform: "browser", jsx: "automatic",
  // Load the actual Vite-built product stylesheet below (including renderer
  // SCSS and KaTeX). The JS-only fixture must not compile a second style graph.
  loader: { ".scss": "empty", ".css": "empty" } });
const assets = resolve("apps/workbench-web/dist/assets");
const cssNames = (await readdir(assets)).filter(name => name.endsWith(".css"));
const css = Buffer.concat(await Promise.all(cssNames.map(name => readFile(join(assets, name)))));
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles.find(file => file.path.endsWith(".js"))!.contents); }
  else if (req.url === "/fixture.css") { res.setHeader("content-type", "text/css"); res.end(css); }
  else { res.setHeader("content-type", "text/html"); res.end('<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
});
let browser: any;
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.getByRole("button", { name: "Sales Bot", exact: true }).click();
  const editor = page.locator(".ProseMirror"); await editor.waitFor();
  await editor.fill("sales message"); await page.keyboard.press("Enter");
  await page.getByText("Reply from sales: sales message", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Main Bot", exact: true }).click();
  await page.getByText("Main Bot", { exact: true }).last().waitFor();
  await editor.fill("main message"); await page.keyboard.press("Enter");
  await page.getByText("Reply from default: main message", { exact: true }).waitFor();
  assert.equal(await page.getByText("Reply from sales: sales message", { exact: true }).count(), 0);
  await page.evaluate(() => (window as any).__hermesFixture.reconnect());
  await page.getByRole("button", { name: "Sales Bot", exact: true }).click();
  await page.getByText("Reply from sales: sales message", { exact: true }).waitFor();
  assert.equal(await page.getByText("Reply from default: main message", { exact: true }).count(), 0);
  const submits = await page.evaluate(() => (window as any).__hermesFixture.calls.filter((call: any) => call.method === "prompt.submit").map((call: any) => call.params.session_id));
  assert.deepEqual(submits.map((id: string) => id.split(":")[1]), ["sales", "default"]);
  assert.deepEqual(errors, []);
  const avatarSize = await page.locator(".bot-chat-header__identity svg").first().boundingBox();
  assert.ok(avatarSize && avatarSize.width <= 64, "Built Bot stylesheet must be loaded; unstyled DOM is not UI acceptance");
  const evidence = resolve("design/hermes-profile-bots/evidence"); await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, "profile-restored.png") });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: join(evidence, "profile-restored-dark.png") });
  console.log("PASS real Bridge + AppServer client + Cordis directory/source/resolver + Bot View: two profiles route separately; generation replacement restores original persisted history; native Hermes/control plane simulated, no live inference.");
} finally { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
