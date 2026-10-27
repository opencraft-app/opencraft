import assert from "node:assert/strict";
import { createServer } from "vite";

const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-realtime-transcript-smoke", server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "realtime-transcript-smoke", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/realtime-transcript.tsx"></script>');
    });
  } }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const errors: string[] = [];
  for (const width of [390, 1200]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
    const transcripts = page.locator(".thread-realtime-transcript");
    await transcripts.nth(1).waitFor();
    assert.equal(await transcripts.count(), 2);
    assert.doesNotMatch(await page.locator("main").innerText(), /<realtime_delegation>|<TrAnScRiPt_DeLtA>|<InPuT>/);
    assert.equal(await transcripts.nth(0).getAttribute("data-handoff-id"), null);
    assert.equal(await transcripts.nth(1).getAttribute("data-handoff-id"), "next");
    assert.deepEqual(await transcripts.nth(0).locator("p > span").allTextContents(), ["Assistant", "You"]);
    assert.match(await transcripts.nth(0).innerText(), /Use <main> & tests/);
    assert.equal(await transcripts.nth(0).locator('[data-role="user"]').count(), 1);
    assert.match(await transcripts.nth(1).innerText(), /<img src=x onerror=/);
    assert.equal(await transcripts.locator("img").count(), 0);
    assert.equal(await page.evaluate(() => (window as any).transcriptExecuted), undefined);
    assert.doesNotMatch(await transcripts.allTextContents().then(values => values.join("\n")), /Codex/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `/tmp/opencraft-realtime-transcript-${width}.png`, fullPage: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("PASS: narrow/wide actual voice renderer, projected leading/followup handoff, generic speaker, deduplication and literal markup safety");
} finally {
  await browser?.close();
  await vite.close();
}
