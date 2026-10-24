import assert from "node:assert/strict";
import { createServer } from "vite";
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-conversation-history-order-smoke",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "history-order-smoke", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<div id="root"></div><script type="module" src="/tests/fixtures/conversation-history-order.tsx"></script>');
    });
  } }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const results = [];
  for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1000, height: 1800 }, hasTouch: mobile,
      isMobile: mobile, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
    await page.waitForSelector('[data-turn-key="live"]');
    await page.waitForFunction(() => document.documentElement.dataset.conversationReady === "true");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => { (window as any).originalLiveRow = document.querySelector('[data-turn-key="live"]'); });
    const update = async (action: string) => {
      const revision = await page.evaluate((action: string) => (window as any).historyOrder(action), action);
      await page.waitForSelector(`[data-test-revision="${revision}"]`);
    };
    const order = () => page.locator("[data-turn-key]").evaluateAll((elements: Element[]) => elements.map(element => element.getAttribute("data-turn-key")));
    await update("hydrate");
    assert.equal(await page.evaluate(() => (window as any).originalLiveRow === document.querySelector('[data-turn-key="live"]')), true,
      "history hydration preserves the settled live DOM row");
    const expected = ["older-unindexed", "a", "b", "c", "live"];
    assert.deepEqual(await order(), expected);
    for (let index = 0; index < 8; index += 1) {
      await update("stream");
      await update("snapshot");
      await update("hydrate");
      assert.deepEqual(await order(), expected, "history/live alternation must not move established DOM rows");
      assert.equal(await page.evaluate(() => (window as any).originalLiveRow === document.querySelector('[data-turn-key="live"]')), true,
        "the live row is not remounted to hide bad ordering");
      assert.match(await page.locator('[data-turn-key="live"]').textContent(), /Answer live ·/);
    }
    await update("complete");
    assert.deepEqual(await order(), expected);
    const live = page.locator('[data-turn-key="live"]');
    assert.equal(await live.getAttribute("data-turn-status"), "complete");
    assert.match(await live.textContent(), /Answer live(?: ·){8}/);
    await update("late-complete");
    assert.deepEqual(await order(), expected);
    const blocks = await page.evaluate(() => (window as any).historyOrderBlocks());
    const commandIndex = blocks.findIndex((block: any) => block.type === "command-execution");
    const answerIndex = blocks.findIndex((block: any) => block.type === "text");
    assert.ok(commandIndex >= 0 && commandIndex < answerIndex, "late completion projects before the existing answer");
    assert.equal(blocks[commandIndex].exitCode, 137);
    assert.equal(blocks[commandIndex].output, "Delayed failure retained");
    assert.match(await live.textContent(), /Answer live/);
    assert.deepEqual(errors, []);
    results.push({ surface: mobile ? "touch-sized Chromium" : "desktop Chromium", order: await order(), iterations: 8, retainedLiveDOM: true });
    await page.close();
  }
  console.log(JSON.stringify({ passed: results }));
} finally { await browser?.close(); await vite.close(); }
