import assert from "node:assert/strict";
import { createServer } from "vite";
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "diff-counter", configureServer(server) { server.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith("/?")) return next();
    res.setHeader("content-type", "text/html");
    res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/turn-diff-counter.tsx"></script>');
  }); } }],
});
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  for (const width of [390, 1280]) for (const theme of ["light", "dark"]) for (const reducedMotion of ["reduce", "no-preference"]) {
    const page = await browser.newPage({ viewport: { width, height: 600 }, hasTouch: width === 390, reducedMotion });
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`${vite.resolvedUrls!.local[0]}?theme=${theme}`);
    await page.locator('.thread-turn-diff__digit').first().waitFor();
    const measure = () => page.locator('.thread-turn-diff__digit').evaluateAll((columns: Element[]) => columns.map(column => {
      const track = column.firstElementChild as HTMLElement;
      const match = /-?(\d+)/.exec(track.style.transform);
      const index = Number(match?.[1]);
      const row = track.children[index]!;
      if (!row) throw new Error(`Missing digit ${index}: ${track.style.transform}`);
      const range = document.createRange(); range.selectNodeContents(row);
      const glyph = range.getBoundingClientRect(), clip = column.getBoundingClientRect(), cell = row.getBoundingClientRect();
      return { index, glyphTop: glyph.top, glyphBottom: glyph.bottom, clipTop: clip.top, clipBottom: clip.bottom,
        cellTop: cell.top, cellBottom: cell.bottom, lineHeight: Number.parseFloat(getComputedStyle(column).lineHeight), height: clip.height };
    }));
    // A real glyph must fit the clipping viewport, not merely the numeric transform.
    const verify = async () => {
      for (const g of await measure()) {
        assert(g.glyphTop >= g.clipTop - 1 && g.glyphBottom <= g.clipBottom + 1, JSON.stringify(g));
        assert(Math.abs(g.cellTop - g.clipTop) < 0.6 && Math.abs(g.cellBottom - g.clipBottom) < 0.6, JSON.stringify(g));
      }
    };
    await page.waitForTimeout(260); await verify();
    for (const counts of [[99, 9], [100, 10], [1234, 0], [8, 7]]) {
      await page.evaluate((counts: number[]) => (window as any).updateCounts(counts), counts);
      await page.waitForTimeout(260); await verify();
    }
    // Interrupt rolling repeatedly, then background/restore the surface.
    for (const n of [999, 42, 55, 66]) {
      await page.evaluate((n: number) => (window as any).updateCounts([n, 0]), n);
      await page.waitForTimeout(25);
    }
    await page.evaluate(() => document.body.style.visibility = "hidden");
    await page.waitForTimeout(300);
    await page.evaluate(() => document.body.style.visibility = "visible");
    await verify();
    assert.deepEqual(await page.locator('.thread-turn-diff__number').evaluateAll((nodes: Element[]) => nodes.map(n => n.getAttribute('aria-label'))), ['66', '0']);
    if (width === 390 && reducedMotion === 'no-preference') await page.screenshot({ path: `/tmp/turn-diff-counter-${theme}.png` });
    if (width === 390 && theme === 'light') {
      // Published geometry used 1em cells while inheriting a taller line box.
      const old = await page.addStyleTag({ content: '.thread-turn-diff__digit{height:1em}.thread-turn-diff__digit>span>span{height:1em;flex-basis:1em}' });
      await page.locator('.thread-turn-diff__digit>span').evaluateAll((tracks: Element[]) => tracks.forEach(track => {
        const t = track as HTMLElement; const digit = Number(/-?(\d+)/.exec(t.style.transform)?.[1]); t.style.transform = `translateY(-${digit}em)`;
      }));
      assert((await measure()).some(g => g.glyphBottom > g.clipBottom + 1), 'negative control reproduces clipped resting digits');
      await old.evaluate((node: Element) => node.remove());
    }
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('PASS: live diff digits settle fully visible; cold/update/carry/shrink/rapid interruption/hidden restore; desktop/mobile light/dark normal/reduced motion; old geometry fails');
} finally { await browser?.close(); await vite.close(); }
