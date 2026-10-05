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
  for (const width of [320, 390, 768, 1200]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1600 }, hasTouch: width < 768, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}`);
    const card = page.locator(".thread-turn-diff");
    await card.waitFor();
    const rows = card.locator("button[aria-label^='Open ']");
    assert.equal(await rows.count(), 3);
    await card.locator(".thread-turn-diff__more").click();
    assert.equal(await rows.count(), 5);
    const geometries = await rows.evaluateAll((nodes: Element[]) => nodes.map(row => {
      const path = row.querySelector(".thread-turn-diff__path")!;
      const name = path.querySelector("b")!;
      const stats = row.querySelector(".thread-turn-diff__stats")!;
      const a = path.getBoundingClientRect(), b = name.getBoundingClientRect(), c = stats.getBoundingClientRect();
      return { label: row.getAttribute("aria-label"), text: name.textContent,
        pathLeft: a.left, pathRight: a.right, nameRight: b.right, statsLeft: c.left,
        statsRight: c.right, rowRight: row.getBoundingClientRect().right,
        statsWidth: c.width, statsScrollWidth: stats.scrollWidth,
        basenameOverflow: getComputedStyle(name).overflowX,
        clipped: name.scrollWidth > name.clientWidth };
    }));
    for (const g of geometries) {
      assert(g.nameRight <= g.pathRight + 0.5, `${g.text} stays within the path slot`);
      assert(g.pathRight + 7 <= g.statsLeft, `${g.text} retains the gap before counts`);
      assert(g.statsRight <= g.rowRight, "counts remain inside the row");
      assert(g.statsScrollWidth <= Math.ceil(g.statsWidth), "counts remain complete");
      assert.equal(g.basenameOverflow, "hidden");
      assert(g.label?.endsWith(g.text!), "accessible label preserves the full basename");
    }
    assert(geometries[3]!.clipped, "extreme basename is truncated rather than overflowing");
    if (width === 390) {
      const oldRules = await page.addStyleTag({ content: ".thread-turn-diff__path>b{max-width:none;overflow:visible;text-overflow:clip;white-space:normal}" });
      assert(await rows.first().evaluate(row => row.querySelector(".thread-turn-diff__path>b")!.getBoundingClientRect().right > row.querySelector(".thread-turn-diff__stats")!.getBoundingClientRect().left), "negative control reproduces original overlap");
      await oldRules.evaluate(node => node.remove());
    }
    await rows.nth(3).click();
    assert.equal(await page.locator("html").getAttribute("data-review-path"), geometries[3]!.label!.slice(5));
    await card.locator(".thread-turn-diff__more").click();
    assert.equal(await rows.count(), 3);
    assert.deepEqual(errors, []);
    results.push({ width, theme, files: geometries.length, countsIntact: true, fullPathReview: true });
    await page.close();
  }
  console.log(JSON.stringify({ passed: results }));
} finally {
  await browser?.close();
  await vite.close();
}
