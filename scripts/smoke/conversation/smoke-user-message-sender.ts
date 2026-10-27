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
  cacheDir: "node_modules/.vite-user-message-sender-smoke",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "user-message-sender-smoke",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("content-type", "text/html");
        response.end('<!doctype html><html><body><div id="host"></div><script type="module" src="/tests/fixtures/user-message-sender.tsx"></script></body></html>');
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
  const host = page.locator("#host");
  await host.locator('[data-fixture="first"] .thread-user-message__sender').waitFor();
  assert.deepEqual(await host.locator('.thread-user-message__sender').allTextContents(), ["alice", "bob", "alice"]);
  assert.equal(await host.locator('[data-fixture="anonymous"] .thread-user-message__sender').count(), 0);
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const author = host.locator('[data-fixture="first"] .thread-user-message__sender');
    const bubble = host.locator('[data-fixture="first"] .thread-user-message__bubble');
    const labelBox = await author.boundingBox(); const bubbleBox = await bubble.boundingBox();
    assert.ok(labelBox && bubbleBox && labelBox.y + labelBox.height <= bubbleBox.y, "name is above the message");
    assert.ok(Math.abs(labelBox!.x + labelBox!.width - bubbleBox!.x - bubbleBox!.width) < 5, "name is right aligned");
    assert.equal(await author.evaluate(element => getComputedStyle(element).fontSize), "12px");
  }
  const name = host.locator('[data-fixture="first"] .thread-user-message__sender');
  assert.equal(await name.evaluate(element => getComputedStyle(element).color), "rgb(119, 129, 138)");
  await host.locator('.opencraft-embedded-workbench-root').evaluate(element => (element as HTMLElement).style.setProperty("--color-text-tertiary", "#a0a8b1"));
  assert.equal(await name.evaluate(element => getComputedStyle(element).color), "rgb(160, 168, 177)");
  await host.locator('.opencraft-embedded-workbench-root').evaluate(element => (element as HTMLElement).style.setProperty("--color-text-tertiary", "#77818a"));
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.screenshot({ path: process.env.OPENCRAFT_SENDER_SCREENSHOT ?? "/tmp/opencraft-user-message-sender.png" });
  assert.deepEqual(errors, []);
  console.log("PASS: per-message employee names, steering and attachment names, anonymous omission, desktop/mobile alignment");
} finally {
  await browser?.close();
  await vite.close();
}
