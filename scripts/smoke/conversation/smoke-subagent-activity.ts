import assert from "node:assert/strict";
import { createServer } from "vite";
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-activity-disclosure-smoke",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "activity-disclosure-smoke", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith("/?") && request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/subagent-activity.tsx"></script>');
    });
  } }] });
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const results = [];
  for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: touch ? 390 : 1000, height: 1000 }, hasTouch: touch,
      isMobile: touch, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}`);
    await page.waitForFunction(() => document.documentElement.dataset.conversationReady === "true");
    const toggle = page.locator(".thread-subagent-activity__toggle");
    assert.equal(await toggle.count(), 1);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".thread-subagent-details__row").count(), 0);
    if (touch) await toggle.tap(); else { await toggle.focus(); await page.keyboard.press("Enter"); }
    await page.locator(".thread-subagent-details__row").first().waitFor();
    assert.equal(await page.locator(".thread-subagent-details__row").count(), 4);
    assert.equal(await page.locator(".thread-subagent-details__meta").count(), 0);
    assert.equal(await page.getByText("检查静态资源与离线缓存，整理原因和修复方案。", {exact:true}).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({path: "/tmp/subagent-" + (touch ? "touch" : "desktop") + "-" + theme + ".png"});
    if (touch) await toggle.tap(); else await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector(".thread-subagent-details"));
    assert.deepEqual(errors, []);
    results.push({touch, theme, passed:true});
    await page.close();
  }
  console.log(JSON.stringify(results));
} finally { await browser?.close(); await vite.close(); }
