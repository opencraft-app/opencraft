import assert from "node:assert/strict";
import { createServer } from "vite";

// Run with an installed Playwright module and Chrome/Chromium binary; use
// OPENCRAFT_PLAYWRIGHT_MODULE and OPENCRAFT_CHROMIUM_EXECUTABLE when external.
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-sent-image-preview-smoke",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "sent-image-preview-smoke",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("content-type", "text/html");
        response.end('<!doctype html><html><body><div id="host"></div><script type="module" src="/tests/fixtures/sent-image-preview.tsx"></script></body></html>');
      });
    },
  }],
});

let browser;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  const thumbnail = page.locator("#host").getByRole("button", { name: "Open attached image" });
  await thumbnail.click();
  const dialog = page.locator("#host").getByRole("dialog", { name: "Attached image 1 of 1" });
  await dialog.waitFor({ timeout: 5_000 });
  assert.equal(await dialog.locator("img").count(), 1);
  const thumbnailBox = await thumbnail.boundingBox();
  const previewBox = await dialog.locator("img").boundingBox();
  assert.ok(thumbnailBox !== null && previewBox !== null && previewBox.width > thumbnailBox.width);
  assert.equal(await page.evaluate(() => document.body.querySelectorAll('[role="dialog"]').length), 0);
  await page.screenshot({ path: "/tmp/cn-opencraft-sent-image-preview.png" });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log("PASS: sent image opens and closes inside the embedded presentation root");
} finally {
  await browser?.close();
  await vite.close();
}
