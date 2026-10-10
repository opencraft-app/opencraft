import assert from "node:assert/strict";
import { createServer } from "vite";
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-ordered-presentation-smoke",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "ordered-presentation-smoke", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith("/?") && request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<div id="root"></div><script type="module" src="/tests/fixtures/ordered-presentation.tsx"></script>');
    });
  } }] });
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const results = [];
  for (const mobile of [false, true]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1000, height: 1800 }, hasTouch: mobile, isMobile: mobile, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}`);
    await page.waitForFunction(() => document.documentElement.dataset.conversationReady === "true");
    const sourceOrder = () => page.locator("[data-source-item-id]").evaluateAll((nodes: Element[]) => nodes.map(n => n.getAttribute("data-source-item-id")));
    const expected = ["ask", "reply", "old", "answer1", "steer1", "answer2", "steer2", "answer3"];
    // Commentary lives inside its contiguous Activity rather than as a top-level answer.
    assert.deepEqual(await sourceOrder(), expected.filter(id => id !== "old"));
    const text = await page.locator(".thread-turn").innerText();
    const labels = ["Question boundary", "Question reply", "Older commentary", "First answer", "First follow-up", "Second answer", "Second follow-up", "Newest answer"];
    let previous = -1;
    for (const label of labels) { const at = text.indexOf(label); assert(at > previous, `${label} retains its chronological position`); previous = at; }
    await page.evaluate(() => { (window as any).originalAnswer = document.querySelector('[data-source-item-id="answer3"]'); });
    const update = async (action: string) => {
      const before = Number(await page.locator("[data-revision]").getAttribute("data-revision"));
      await page.evaluate((action: string) => (window as any).presentationUpdate(action), action);
      await page.waitForSelector(`[data-revision="${before + 1}"]`);
    };
    for (const action of ["stream", "prepend", "complete"]) {
      await update(action);
      assert.deepEqual(await sourceOrder(), expected.filter(id => id !== "old"));
      assert(await page.evaluate(() => (window as any).originalAnswer === document.querySelector('[data-source-item-id="answer3"]')), `${action} must retain the streamed DOM row`);
    }
    assert.equal(await page.locator("[data-assistant-copy-content]").count(), 1, "only the current response is copied as HTML");
    const activity = page.locator('[data-activity-id="turn:slot:activity-after:user-message:client:client:reply"]');
    const button = activity.locator(".thread-agent-activity__turn-toggle button");
    if (mobile) await button.tap(); else await button.click();
    await page.waitForFunction(() => document.querySelector('[data-activity-id="turn:slot:activity-after:user-message:client:client:reply"]')?.getAttribute("data-collapsed") === "true");
    assert.deepEqual(await sourceOrder(), expected.filter(id => id !== "old"));
    if (mobile) await button.tap(); else await button.click();
    await page.waitForFunction(() => !document.querySelector('[data-activity-id="turn:slot:activity-after:user-message:client:client:reply"]')?.hasAttribute("data-collapsed"));
    await update("await-work");
    const liveActivity = page.locator('[data-activity-id="turn:slot:activity-after:user-message:client:client:steer2"]');
    assert.equal(await liveActivity.locator(".is-shimmering").count() > 0, true);
    const earlierActivities = page.locator('.thread-agent-activity:not([data-activity-id="turn:slot:activity-after:user-message:client:client:steer2"])');
    assert.equal(await earlierActivities.locator(".is-shimmering").count(), 0, "no historical group becomes live");
    assert.equal(await page.locator(".thread-thinking-placeholder").count(), 0, "activity owns the live gap");
    await update("await-input");
    assert.equal(await page.locator(".thread-thinking-placeholder").count(), 1, "waiting for new work owns exactly one tail placeholder");
    assert.equal(await page.locator("[data-assistant-copy-content]").count(), 0);
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.conversationReady === "true");
    assert.deepEqual(await sourceOrder(), expected.filter(id => id !== "old"));
    assert.deepEqual(errors, []);
    results.push({ mobile, theme, ordered: true, collapsePreserved: true, retainedStreamingDOM: true, reload: true, singleLiveOwner: true });
    await page.close();
  }
  console.log(JSON.stringify({ passed: results }));
} finally { await browser?.close(); await vite.close(); }
