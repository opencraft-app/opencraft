import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-image-metadata-preview";
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: { entries: ["tests/fixtures/sent-image-preview.tsx"] },
  cacheDir: "node_modules/.vite-image-metadata-preview",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "image-metadata-preview", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="host"></div><script type="module" src="/tests/fixtures/sent-image-preview.tsx"></script></body></html>');
    });
  } }],
});
let browser;
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1200, height: 844 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name = value => value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?metadata-only${touch ? "&touch" : ""}`);
    const thumbnail = page.getByRole("button", { name: "Open attached image", exact: true });
    await thumbnail.waitFor();
    await page.waitForFunction(() => (window as any).metadataLoads === 1);
    assert.equal(await thumbnail.getAttribute("data-state"), "loading");
    assert.equal(await page.locator(".thread-user-message__file-attachment").count(), 0);
    const initialBox = await thumbnail.boundingBox();
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-loading.png` });
    await thumbnail.evaluate(element => { (window as any).metadataThumbnail = element; });
    // Late history content must reuse the mounted image and its in-flight read.
    await page.evaluate(() => (window as any).hydrateImageContent());
    await page.waitForFunction(() => document.querySelector("#host")!.shadowRoot!.querySelector(".thread-user-message__image") === (window as any).metadataThumbnail);
    await page.evaluate(() => (window as any).completeMetadataMedia());
    await thumbnail.locator("img").evaluate(async image => { await (image as HTMLImageElement).decode(); });
    assert.equal(await page.evaluate(() => (window as any).metadataLoads), 1);
    assert.deepEqual(await thumbnail.boundingBox(), initialBox);
    if (touch) await thumbnail.tap(); else { await thumbnail.focus(); await page.keyboard.press("Enter"); }
    await page.getByRole("dialog", { name: "Attached image 1 of 1" }).waitFor();
    await page.evaluate(() => (window as any).completeMetadataMedia());
    await page.getByRole("dialog").locator("[data-motion-page=current] img").evaluate(async image => { await (image as HTMLImageElement).decode(); });
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-preview.png` });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#host")!.shadowRoot!.querySelector('[role="dialog"]'));
    assert.deepEqual(errors, []);
    console.log(`PASS metadata preview: ${touch ? "touch" : "keyboard"}, held load, hydration, open, close`);
    await context.close();
  }
} finally { await browser?.close(); await vite.close(); }
