import assert from "node:assert/strict";
import { createServer } from "vite";
import { assertBrowserRuntimeDependencies } from "./browser-smoke-preflight.mjs";
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
assertBrowserRuntimeDependencies(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath());
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-turn-resources-smoke",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "turn-resources-smoke", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith("/?") && request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/turn-resources.tsx"></script>');
    });
  } }] });
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const results = [];
  for (const mobile of [false, true]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1000, height: 1500 }, hasTouch: mobile, isMobile: mobile, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}`;
    await page.goto(url);
    await page.waitForFunction(() => document.documentElement.dataset.conversationReady === "true");
    const activity = page.locator("[data-activity-id]");
    const assertLive = async () => {
      assert.equal(await activity.count(), 1);
      assert.equal(await activity.getAttribute("data-collapsed"), null, "resource cannot fold active work, even with a saved collapsed choice");
      assert.equal(await page.locator(".thread-agent-activity__turn-toggle").count(), 0, "resource creates no disclosure boundary");
      assert.equal(await page.locator('[data-work-status="working"]').count(), 1, "work clock keeps its owner");
      assert.equal(await page.locator(".thread-thinking-placeholder").count(), 0, "active command owns Thinking");
      assert(await activity.innerText().then((text: string) => text.includes("Active progress")));
    };
    await assertLive();
    const initialLiveIndicators = await activity.locator(".is-shimmering").count();
    assert(initialLiveIndicators > 0);
    await page.evaluate(() => { (window as any).originalActivity = document.querySelector("[data-activity-id]"); });
    const update = async (action: string) => {
      const before = Number(await page.locator("[data-revision]").getAttribute("data-revision"));
      await page.evaluate((action: string) => (window as any).resourceUpdate(action), action);
      await page.waitForSelector(`[data-revision="${before + 1}"]`);
    };
    await update("diff");
    await assertLive();
    assert.equal(await activity.locator(".is-shimmering").count(), initialLiveIndicators, "resource preserves the current live indicator");
    assert.equal(await page.locator("[data-turn-resource-id]").count(), 1);
    await page.locator(".thread-turn-diff-live").click();
    assert.equal(await page.locator('.thread-live-changes .thread-turn-diff-live').count(), 1, "one Composer-owned live entry");
    assert.equal(await page.locator('.thread-frame .thread-turn-diff-live').count(), 0, "no inline duplicate");
    await page.waitForSelector(".thread-turn-diff-review");
    await update("diff-update");
    await page.waitForFunction(() => document.querySelector(".thread-turn-diff-review__diff")?.textContent?.includes("review-update"));
    await page.getByRole("button", { name: "Close review changed files" }).click();
    await assertLive();
    await update("new-work");
    await assertLive();
    assert((await activity.innerText()).includes("Later progress"));
    assert(await page.evaluate(() => (window as any).originalActivity === document.querySelector("[data-activity-id]")), "diff and new work retain the live DOM identity");
    await update("complete");
    assert.equal(await activity.getAttribute("data-collapsed"), "true", "real final answer may close the disclosure");
    assert.equal(await page.locator('.thread-turn-diff[data-status="complete"]').count(), 1);
    await page.getByRole("button", { name: "View changed files", exact: true }).click();
    await page.waitForSelector(".thread-turn-diff-review");
    await page.getByRole("button", { name: "Close review changed files" }).click();
    await update("clear");
    assert.equal(await page.locator("[data-turn-resource-id]").count(), 0);
    await page.goto(`${url}&restored=1`);
    await page.waitForFunction(() => document.documentElement.dataset.conversationReady === "true");
    await assertLive();
    assert.equal(await page.locator("[data-turn-resource-id]").count(), 1);
    if (process.env.OPENCRAFT_SMOKE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SMOKE_SCREENSHOT_DIR}/${mobile ? "mobile" : "desktop"}-${theme}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    results.push({ mobile, theme, liveWorkRetained: true, stableDOM: true, liveReviewUpdated: true, completedReview: true, restored: true });
    await page.close();
  }
  console.log(JSON.stringify({ passed: results }));
} finally { await browser?.close(); await vite.close(); }
