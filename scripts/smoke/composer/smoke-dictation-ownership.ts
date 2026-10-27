import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const bundled = await build({ entryPoints: ["tests/fixtures/dictation-ownership.tsx"], bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic" });
const assets = resolve("apps/workbench-web/dist-electron/assets"), cssName = (await readdir(assets)).find(name => name.endsWith(".css"))!;
const css = await readFile(join(assets, cssName));
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); res.end(bundled.outputFiles[0]!.contents); }
  else if (req.url === "/fixture.css") { res.setHeader("content-type", "text/css"); res.end(css); }
  else { res.setHeader("content-type", "text/html"); res.end('<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
});
let browser: any;
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const load = async () => { await page.goto(url); await page.evaluate("window.__name=value=>value"); await page.locator(".ProseMirror").waitFor(); };
  const call = (name: string) => page.evaluate(name => (window as any).__ownershipFixture[name](), name);
  const editor = page.locator(".ProseMirror"), mic = page.locator(".opencraft-voice-input-action");
  await load(); await editor.click(); await page.keyboard.press("Meta+a"); await mic.click();
  await page.getByRole("button", { name: "停止并写入文字", exact: true }).click();
  await page.locator(".opencraft-composer-voice-footer").waitFor({ state: "hidden" });
  assert.equal(await editor.textContent(), "Original text voice result");
  await load(); await mic.click(); await call("replace"); await call("lateFinal");
  assert.equal(await editor.textContent(), "Replacement"); assert.equal(await page.locator(".opencraft-composer-voice-footer").count(), 0);
  for (const operation of ["resetViewState", "reentrantWrite"]) {
    await load(); await mic.click(); await call(operation);
    await page.getByRole("button", { name: "识别完成后发送", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal((await editor.textContent())?.includes("voice result"), false);
    assert.deepEqual(await page.evaluate(() => (window as any).__ownershipFixture.sent), []);
    await call("lateFinal"); assert.deepEqual(await page.evaluate(() => (window as any).__ownershipFixture.sent), []);
  }
  assert.deepEqual(errors, []);
  console.log("PASS actual OpenCraftComposer/Core/Voice components: selected text preserved and appended; replacement/late final, missing editor reservation and reentrant write reject without sending; only ASR boundary simulated");
} finally { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
