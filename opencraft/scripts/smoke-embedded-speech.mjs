import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");

// Real browser capture, product transport and Composer; only the external ASR response is synthetic.
const bundle = await build({ entryPoints: ["tests/fixtures/embedded-speech.tsx"], bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic" });
const assets = "apps/workbench-web/dist/assets";
let css = "";
for (const name of await readdir(assets)) if (name.endsWith(".css")) css += await readFile(`${assets}/${name}`, "utf8");
assert.ok(css.includes("codex-composer-voice-footer"), "Build this checkout's Web CSS first");
const server = createServer((req, res) => {
  const content = req.url === "/fixture.js" ? bundle.outputFiles[0].contents : req.url === "/fixture.css" ? css : '<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
  res.setHeader("content-type", req.url === "/fixture.js" ? "application/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(content);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  for (const width of [1280, 390]) for (const colorScheme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, hasTouch: width === 390 });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/speech/capabilities", route => route.fulfill({ json: { available: true, model: "ep-hyasr3", max_duration_ms: 120000, max_audio_bytes: 3840044 } }));
    let release, held = false, calls = 0;
    await page.route("**/api/speech/transcriptions", async route => {
      calls++;
      assert.equal(route.request().headers().authorization, "Bearer synthetic-session");
      assert.match(route.request().headers()["content-type"], /^multipart\/form-data; boundary=/u);
      assert.ok(route.request().postDataBuffer().includes(Buffer.from("RIFF")), "canonical in-memory WAV");
      if (held) await new Promise(resolve => { release = resolve; });
      await route.fulfill({ json: { text: "测试语音" } }).catch(() => undefined);
    });
    const load = async () => { await page.goto(origin); await page.waitForFunction(() => document.querySelector(".opencraft-voice-input-action")?.disabled === false); };
    const start = async () => { await page.locator(".opencraft-voice-input-action").click(); await page.locator('[data-voice-phase="listening"]').waitFor(); await page.waitForTimeout(500); };
    await load(); await start();
    await page.getByRole("button", { name: "停止并写入文字", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ProseMirror")?.textContent === "Original text 测试语音");
    assert.deepEqual(await page.evaluate(() => window.embeddedSpeechFixture.sent), []);
    assert.equal(calls, 1);
    for (const action of ["cancel", "replace", "logout"]) {
      await load(); held = true; release = null; const before = calls; await start();
      await page.getByRole("button", { name: "停止并写入文字", exact: true }).click();
      for (let tries = 0; tries < 50 && calls === before; tries++) await page.waitForTimeout(50);
      assert.equal(calls, before + 1); assert.ok(release);
      if (action === "cancel") await page.getByRole("button", { name: "取消语音输入", exact: true }).click();
      else await page.evaluate(value => window.embeddedSpeechFixture[value](), action);
      release(); held = false; await page.waitForTimeout(100);
      assert.equal(await page.locator(".ProseMirror").textContent(), action === "replace" ? "Replacement" : "Original text");
      assert.deepEqual(await page.evaluate(() => window.embeddedSpeechFixture.sent), []);
    }
    assert.deepEqual(errors, []); await context.close();
    console.log(`Embedded speech browser passed: ${width}px ${colorScheme}`);
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
