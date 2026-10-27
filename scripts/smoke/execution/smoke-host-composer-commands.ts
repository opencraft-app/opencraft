import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const bundle = await build({ entryPoints: ["tests/fixtures/host-composer-commands.tsx"], bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic", loader: { ".scss": "empty", ".css": "empty" } });
const assets = resolve("apps/workbench-web/dist/assets");
const cssNames = (await readdir(assets)).filter(name => name.endsWith(".css"));
const css = (await Promise.all(cssNames.map(name => readFile(join(assets, name), "utf8")))).join("\n");
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0]!.contents); }
  else if (req.url === "/fixture.css") { res.setHeader("content-type", "text/css"); res.end(css); }
  else { res.setHeader("content-type", "text/html"); res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root" style="max-width:850px;margin:60px auto"></div><script type="module" src="/fixture.js"></script></body></html>'); }
});
let browser: any;
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ ...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE } : {}), headless: true });
  for (const width of [1100, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const editor = page.locator(".ProseMirror"), send = page.locator(".opencraft-composer-submit"); await editor.waitFor();
    const calls = () => page.evaluate(() => (window as any).__commandsFixture.calls);
    await page.locator(".opencraft-composer-shortcut-trigger").click();
    await page.getByRole("menuitem").filter({ hasText: "/status" }).click();
    await assert.doesNotReject(() => editor.waitFor({ state: "visible" }));
    assert.equal((await editor.textContent())?.trim(), "/status"); assert.deepEqual(await calls(), []);
    await send.click(); await page.waitForFunction(() => (window as any).__commandsFixture.calls.length === 1);
    assert.deepEqual(await calls(), [["prompt", "/status"]]);
    await page.locator(".opencraft-composer-shortcut-trigger").click();
    await page.getByRole("menuitem").filter({ hasText: "/stop" }).click();
    assert.equal((await editor.textContent())?.trim(), "/stop"); assert.equal((await calls()).length, 1);
    if (process.env.OPENCRAFT_COMMAND_SMOKE_OUTPUT) await page.screenshot({ path: `${process.env.OPENCRAFT_COMMAND_SMOKE_OUTPUT}/composer-${width}.png` });
    await send.click(); await page.waitForFunction(() => (window as any).__commandsFixture.calls.length === 2);
    assert.deepEqual((await calls())[1], ["stop", "fixture-host", "fixture-thread", "captured-turn"]);
    await page.evaluate(() => (window as any).__commandsFixture.retire());
    await page.locator(".opencraft-composer-shortcut-trigger").click();
    await page.getByRole("menuitem").filter({ hasText: "/stop" }).click(); await send.click();
    await page.getByRole("alert").waitFor();
    assert.equal((await calls()).length, 2); assert.equal((await editor.textContent())?.trim(), "/stop");
    assert.deepEqual(errors, []); await page.close();
  }
  console.log("PASS actual OpenCraftComposer: wide/narrow menu inserts without execution, explicit send routes prompt/action, captured target preserved, retired provider fails without consuming draft; engine/network simulated");
} finally { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
