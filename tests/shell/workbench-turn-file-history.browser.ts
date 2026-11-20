import assert from "node:assert/strict";
import { createServer } from "vite";

const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-turn-diff-layout",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "turn-diff-layout", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/" && !request.url?.startsWith("/?")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/turn-diff-layout.tsx"></script>');
    });
  } }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const results = [];
  const base = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  for (const width of [390, 1200]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 1200 }, hasTouch: width === 390, reducedMotion: "reduce" });
    await context.addInitScript("window.__name=value=>value");
    const first = await context.newPage(), second = await context.newPage();
    const errors: string[] = [];
    for (const page of [first, second]) page.on("pageerror", (error: Error) => errors.push(error.message));
    const open = async (page: any, mode: string) => {
      await page.goto(`${base}/?history=${mode}&theme=${theme}&review=1`);
      await page.locator(".thread-turn-diff").waitFor();
    };
    const activate = async (button: any) => width === 390 ? button.tap() : button.click();
    const expand = async (page: any) => {
      await activate(page.locator(".thread-turn-diff__more"));
      assert.equal(await page.locator(".thread-turn-diff__files>button[aria-label^='Open ']").count(), 14);
    };
    await Promise.all([open(first, "full"), open(second, "full")]);
    const text = await first.locator(".thread-turn-diff").innerText();
    assert.match(text, /Edited 14 files/u);
    assert.equal(text, await second.locator(".thread-turn-diff").innerText());
    await second.reload();
    await second.locator(".thread-turn-diff").waitFor();
    assert.equal(text, await second.locator(".thread-turn-diff").innerText());
    await expand(second);
    await activate(second.locator(".thread-turn-diff__files>button[aria-label^='Open ']").nth(13));
    await second.getByRole("dialog").waitFor();
    assert.match(await second.locator(".thread-turn-diff-review__diff").innerText(), /file 13/u);
    assert.doesNotMatch(await second.locator(".thread-turn-diff-review__diff").innerText(), /large content/u);
    await second.keyboard.press("Escape");
    // Same surface with presentation-only history: paths are immediate; absent
    // bytes are never presented as a complete review or false zero statistics.
    await open(first, "deferred");
    assert.equal(await first.locator(".thread-turn-diff .thread-turn-diff__stats").first().getAttribute("aria-hidden"), "true");
    assert.equal(await first.locator("html").getAttribute("data-detail-calls"), null);
    await activate(first.getByRole("button", { name: "View changes", exact: true }));
    await first.getByRole("dialog").waitFor();
    await first.getByRole("status").waitFor();
    await first.waitForFunction(() => document.querySelector(".thread-turn-diff-review__diff .thread-unified-diff") !== null);
    assert.equal(await first.locator("html").getAttribute("data-detail-ids"), '["historical-patch"]');
    assert.equal(await first.locator("html").getAttribute("data-detail-calls"), "1");
    assert.equal(await first.locator(".thread-turn-diff .thread-turn-diff__stats").first().getAttribute("aria-hidden"), null);
    assert.match(await first.locator(".thread-turn-diff-review__diff").innerText(), /large content/u);
    await first.keyboard.press("Escape");
    if (process.env.OPENCRAFT_HISTORY_SCREENSHOTS) await first.screenshot({ path: `${process.env.OPENCRAFT_HISTORY_SCREENSHOTS}/history-${width}-${theme}.png`, fullPage: true });
    await open(first, "multiple");
    await activate(first.getByRole("button", { name: "View changes", exact: true }));
    await first.waitForFunction(() => document.querySelector(".thread-turn-diff-review__diff .thread-unified-diff") !== null);
    assert.equal(await first.locator("html").getAttribute("data-detail-calls"), "1", "partial hydration must not abort/restart remaining Item reads");
    assert.equal(await first.locator("html").getAttribute("data-detail-ids"), '["historical-0","historical-1","historical-2"]');
    await first.keyboard.press("Escape");
    await open(first, "failure");
    await activate(first.getByRole("button", { name: "View changes", exact: true }));
    await first.getByRole("button", { name: "Try again", exact: true }).waitFor();
    assert.equal(await first.locator(".thread-turn-diff").count(), 1);
    assert.equal(await first.locator(".thread-turn-diff-review__diff .thread-unified-diff").count(), 0);
    await activate(first.getByRole("button", { name: "Try again", exact: true }));
    await first.waitForFunction(() => document.querySelector(".thread-turn-diff-review__diff .thread-unified-diff") !== null);
    assert.equal(await first.locator("html").getAttribute("data-detail-calls"), "2");
    await first.keyboard.press("Escape");
    await open(first, "slow");
    await activate(first.getByRole("button", { name: "View changes", exact: true }));
    await first.getByRole("status").waitFor();
    await first.keyboard.press("Escape");
    await first.waitForFunction(() => document.documentElement.dataset.detailAborted === "true");
    assert.equal(await first.getByRole("dialog").count(), 0);
    assert.equal(await first.locator(".thread-turn-diff").count(), 1);
    assert.deepEqual(errors, []);
    results.push({ width, theme, twoTabs: true, reload: true, files: 14, review: true, deferred: true, sequentialDetails: true, retry: true, cancelled: true });
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally { await browser?.close(); await vite.close(); }
