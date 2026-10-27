import assert from "node:assert/strict";
import { createServer } from "vite";
import { assertBrowserRuntimeDependencies } from "../../browser-smoke-preflight.mjs";
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
assertBrowserRuntimeDependencies(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath());
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  optimizeDeps: { entries: ["tests/fixtures/conversation-scroll.tsx"] },
  cacheDir: "node_modules/.vite-conversation-hidden-reading",
  resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "hidden-reading", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<div id="root"></div><script type="module" src="/tests/fixtures/conversation-scroll.tsx"></script>');
    });
  } }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const policy of ["natural", "response-placement"]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors: string[] = []; page.on("pageerror", (e: Error) => { errors.push(e.message); console.error(e.stack); });
    page.on("console", (m: any) => { if (m.type() === "error") console.error(m.text()); });
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?submissions${policy === "natural" ? "&natural" : ""}`);
    await page.waitForFunction(() => (window as any).owner && document.querySelector('[data-probe="text-5"]'), undefined, { timeout: 60000 });
    const settle = () => page.evaluate(async () => { for (let n = 0; n < 12; n++) await new Promise(requestAnimationFrame); });
    await settle();
    const viewport = page.locator(".thread-scroll");
    await viewport.hover(); await page.mouse.wheel(0, -800); await settle();
    const before = await page.evaluate(() => ({ distance: (window as any).owner.scrollController.getLastScrollDistanceFromBottomPx(),
      anchor: document.querySelector('[data-probe="text-3"]')!.getBoundingClientRect().top }));
    assert.ok(before.distance > 500, "native wheel must establish a nonzero reading position");
    const original = await viewport.elementHandle();
    await page.evaluate(() => (window as any).setHidden(true)); await settle();
    assert.equal(await original!.evaluate(e => e.clientHeight), 0);
    assert.equal(await page.evaluate(() => (window as any).owner.scrollController.getLastScrollDistanceFromBottomPx()), before.distance,
      `${policy}: zero-sized parked DOM cannot overwrite the reading checkpoint`);
    await page.evaluate(() => (window as any).setHidden(false)); await settle();
    assert.equal(await original!.evaluate(e => e.isConnected), true);
    const after = await page.evaluate(() => ({ distance: (window as any).owner.scrollController.getLastScrollDistanceFromBottomPx(),
      anchor: document.querySelector('[data-probe="text-3"]')!.getBoundingClientRect().top }));
    assert.equal(after.distance, before.distance, `${policy}: showing the retained viewport preserves its reading position`);
    assert.ok(Math.abs(after.anchor - before.anchor) < 2, `${policy}: reading anchor stays in place`);
    await page.evaluate(() => (window as any).setHidden(true)); await settle();
    await page.evaluate(() => (window as any).unmount());
    await page.waitForFunction(e => !e.isConnected, original);
    assert.equal(await page.evaluate(() => (window as any).restoreSnapshot.distanceFromBottomPx), before.distance,
      `${policy}: unmounting a parked View serializes its durable reading position`);
    await page.evaluate(() => { (window as any).setHidden(false); (window as any).remountFromSnapshot(); });
    await page.waitForFunction(() => !!document.querySelector('[data-probe="text-3"]')); await settle();
    const restored = await page.evaluate(() => ({ distance: (window as any).owner.scrollController.getLastScrollDistanceFromBottomPx(),
      anchor: document.querySelector('[data-probe="text-3"]')!.getBoundingClientRect().top }));
    assert.equal(restored.distance, before.distance, `${policy}: replacement View restores the parked checkpoint`);
    assert.ok(Math.abs(restored.anchor - before.anchor) < 2, `${policy}: replacement retains the reading anchor`);
    await page.evaluate(() => (window as any).api.scrollToBottom()); await settle();
    assert.equal(await viewport.evaluate(e => e.scrollTop), 0, "explicit bottom intent still applies");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ policy, before, after, restored, sameViewport: true }));
    await page.close();
  }
} finally { await browser?.close(); await vite.close(); }
