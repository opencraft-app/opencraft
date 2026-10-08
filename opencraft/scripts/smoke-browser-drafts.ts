import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const bundle = await build({ entryPoints: ["tests/fixtures/browser-chat-drafts.tsx"], bundle: true, write: false, outdir: "/tmp/draft-room-bundle", format: "esm", platform: "browser", jsx: "automatic", loader: { ".scss": "empty", ".css": "empty" } });
const assets = resolve("apps/workbench-web/dist/assets");
const css = Buffer.concat(await Promise.all((await readdir(assets)).filter(name => name.endsWith(".css")).map(name => readFile(join(assets, name)))));
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles.find(file => file.path.endsWith(".js"))!.contents); }
  else if (req.url === "/fixture.css") { res.setHeader("content-type", "text/css"); res.end(css); }
  else { res.setHeader("content-type", "text/html"); res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, headless: true, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  const roomOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const editorText = async (editor: import("playwright").Locator) => editor.evaluate(node => {
    const copy = node.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".codex-composer-placeholder").forEach(item => item.remove());
    return copy.textContent ?? "";
  });
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390, isMobile: width === 390 });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(roomOrigin);
    const editor = page.locator('.bot-chat-composer-dock [role="textbox"]'); await editor.waitFor();
    await editor.fill(`Bot local draft ${width}`);
    await page.reload(); await editor.waitFor();
    assert.equal(await editor.innerText(), `Bot local draft ${width}`);
    assert.equal(await page.evaluate(() => (window as any).__draftFixture.service.sends), 0, "refresh cannot send");
    await page.evaluate(() => (window as any).__draftFixture.navigate("b"));
    await page.waitForFunction(() => document.querySelector('.bot-chat-composer-dock .codex-composer-placeholder') !== null);
    await editor.fill("other room");
    await page.evaluate(() => (window as any).__draftFixture.navigate("a"));
    await page.waitForFunction(text => document.querySelector('.bot-chat-composer-dock [role="textbox"]')?.textContent === text, `Bot local draft ${width}`);
    await editor.fill(""); await page.reload(); await editor.waitFor(); assert.equal(await editorText(editor), "");
    assert.deepEqual(errors, []);
    await page.close();

    // Built complete application, not a simulated Composer or router.
    const appOrigin = process.env.OPENCRAFT_DRAFT_APP_ORIGIN;
    if (appOrigin) {
      const task = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390, isMobile: width === 390 });
      await task.route("**/*", route => new URL(route.request().url()).origin === appOrigin ? route.continue() : route.abort());
      await task.goto(appOrigin);
      const input = task.locator('[contenteditable="true"]').first(); await input.waitFor();
      await input.fill(`Task browser draft ${width}`);
      await task.reload(); await input.waitFor(); assert.equal(await input.innerText(), `Task browser draft ${width}`);
      await input.fill(""); await task.reload(); await input.waitFor(); assert.equal(await editorText(input), "");
      await task.close();
    }
    console.log(`PASS ${width}px local structured input: refresh, isolation, clear, no automatic send`);
  }
} finally { await browser?.close(); await new Promise<void>(ok => server.close(() => ok())); }
