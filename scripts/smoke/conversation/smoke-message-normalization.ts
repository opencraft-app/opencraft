import assert from "node:assert/strict";
import { createServer } from "vite";
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-message-normalization-smoke", server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "message-normalization-smoke", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/message-normalization.tsx"></script>');
    });
  } }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const errors: string[] = [];
  for (const width of [390, 1200]) {
    const page = await browser.newPage({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
    const primary = page.locator('[data-client="primary"]');
    const bubble = primary.locator("[data-user-message-bubble]");
    await bubble.getByText("Inspect the file", { exact: true }).waitFor();
    await primary.evaluate(element => { (window as any).primaryNode = element; });
    await bubble.evaluate(element => { (window as any).primaryBubble = element; });
    const select = async (phase: string) => {
      await page.getByRole("button", { name: phase, exact: true }).click();
      await page.locator(`main[data-phase="${phase}"]`).waitFor();
    };
    for (const phase of ["acknowledged", "staged"]) {
      await select(phase);
      assert.equal(await primary.evaluate(element => element === (window as any).primaryNode), true);
      assert.equal(await bubble.evaluate(element => element === (window as any).primaryBubble), true);
      await bubble.getByText("Inspect the file", { exact: true }).waitFor();
      assert.equal(await bubble.innerText(), "Inspect the file");
      assert.doesNotMatch(await primary.innerText(), /ordinary echo|readable path|user-provided data/);
    }
    assert.equal(await primary.getAttribute("data-sources"), '["primary-server"]');
    await primary.getByRole("button", { name: /受众😀.md/ }).click();
    await page.waitForFunction(() => document.documentElement.dataset.opened === "file:///host/attachments/file/content-note.md");
    await select("steering-pending");
    const steering = page.locator('[data-client="steer"]');
    await steering.locator("[data-user-message-bubble]").waitFor();
    await steering.evaluate(element => { (window as any).steeringNode = element; });
    for (const phase of ["steering-accepted", "duplicate-echo"]) {
      await select(phase);
      assert.equal(await steering.evaluate(element => element === (window as any).steeringNode), true);
      assert.equal(await steering.count(), 1);
      await steering.locator("[data-user-message-bubble]").getByText("Also check mobile", { exact: true }).waitFor();
      assert.equal(await steering.locator("[data-user-message-bubble]").innerText(), "Also check mobile");
      assert.doesNotMatch(await steering.innerText(), /readable path|user-provided data/);
      assert.equal(await primary.evaluate(element => element === (window as any).primaryNode), true);
    }
    assert.equal(await steering.getAttribute("data-sources"), '["local-steer","steer-server-latest"]');
    const anchors = await page.evaluate(() => (window as any).messageAnchors as string[]);
    for (const id of ["primary-server", "local-steer", "steer-server-latest"]) assert.ok(anchors.includes(`item:${id}`), id);
    assert.equal(await page.locator("main [data-client]").count(), 2);
    await steering.getByRole("button", { name: /受众😀.md/ }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.opened), "file:///host/attachments/file/content-note.md");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `/tmp/opencraft-message-normalization-${width}.png`, fullPage: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("PASS: narrow/wide actual UserMessage components, params/server/staged/steering identity continuity, deduplication, anchors and file navigation");
} finally { await browser?.close(); await vite.close(); }
