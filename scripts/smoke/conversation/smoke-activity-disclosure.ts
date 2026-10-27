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
      response.end('<div id="root"></div><script type="module" src="/tests/fixtures/activity-disclosure.tsx"></script>');
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
    // The lazy document renderer first exposes a raw-text fallback. Identity
    // assertions must start after the actual prose node has been committed.
    await page.locator(".opencraft-chat-document p").filter({ hasText: /^Earlier visible prose$/ }).waitFor();
    await page.getByText("Earlier visible prose", { exact: true }).evaluate((node: Element) => {
      (window as any).earlierNode = node;
    });
    const update = async (action: string) => {
      const before = Number(await page.locator("[data-revision]").getAttribute("data-revision"));
      await page.evaluate((action: string) => (window as any).disclosureUpdate(action), action);
      await page.waitForSelector(`[data-revision="${before + 1}"]`);
    };
    for (const action of ["steer1", "steer2", "complete", "prepend"]) {
      await update(action);
      assert.equal(await page.getByText("Earlier visible prose", { exact: true }).isVisible(), true, action);
      assert.equal(await page.evaluate(() => (window as any).earlierNode?.isConnected), true, `${action}: existing prose DOM retained`);
      assert.equal(await page.locator(".thread-agent-activity[data-collapsed]").count(), 0, `${action}: no final, no fold`);
      assert.equal(await page.locator(".thread-agent-activity__turn-toggle").count(), 0);
    }
    const text = await page.locator(".thread-turn").innerText();
    const sequence = ["Earlier visible prose", "Follow-up one", "Later visible prose", "Follow-up two", "Newest visible prose"];
    let prior = -1;
    for (const label of sequence) { const index = text.indexOf(label); assert(index > prior, label); prior = index; }
    await update("final");
    assert.equal(await page.getByText("Final answer stays visible", { exact: true }).isVisible(), true);
    assert.equal(await page.getByText("Earlier visible prose", { exact: true }).isVisible(), true);
    assert.equal(await page.getByText("Later visible prose", { exact: true }).isVisible(), true);
    assert.equal(await page.getByText("Newest visible prose", { exact: true }).count(), 0, "only answered task activity defaults folded");
    const toggle = page.locator(".thread-agent-activity__turn-toggle button");
    assert.equal(await toggle.count(), 1);
    if (touch) await toggle.tap(); else await toggle.click();
    await page.getByText("Newest visible prose", { exact: true }).waitFor();
    await update("stream");
    assert.equal(await page.getByText("Newest visible prose", { exact: true }).isVisible(), true, "explicit expand survives streaming");
    assert.equal(await page.getByText("Final answer stays visible and grows", { exact: true }).isVisible(), true);
    assert.equal(await page.evaluate(() => (window as any).earlierNode?.isConnected), true);
    if (touch) await toggle.tap(); else await toggle.click();
    assert.equal(await page.getByText("Newest visible prose", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Final answer stays visible and grows", { exact: true }).isVisible(), true);
    await page.reload();
    await page.getByText("Earlier visible prose", { exact: true }).waitFor();
    assert.equal(await page.locator(".thread-agent-activity__turn-toggle").count(), 0);
    assert.deepEqual(errors, []);
    results.push({ touch, theme, steerDoesNotFold: true, retainedProseDOM: true, explicitChoice: true, reload: true });
    await page.close();
  }
  console.log(JSON.stringify({ passed: results }));
} finally { await browser?.close(); await vite.close(); }
