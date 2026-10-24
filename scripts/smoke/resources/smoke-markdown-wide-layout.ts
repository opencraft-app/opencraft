import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = ".local/markdown-wide-layout";
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-markdown-wide-layout", server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "markdown-wide-layout", configureServer(vite) {
  vite.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith("/?")) return next();
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/markdown-wide-layout.tsx"></script>');
  });
} }] });
let browser: any;
const records: unknown[] = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  for (const theme of ["light", "dark"]) for (const viewport of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width: viewport, height: 1000 }, hasTouch: viewport === 390, reducedMotion: "reduce" });
    await context.addInitScript(() => { (window as any).__name = (fn: unknown) => fn; });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/?theme=${theme}`);
    await page.waitForFunction(() => document.querySelectorAll("[data-case] .chat-table-scroller").length === 4);
    await page.locator('[data-diagram="main"] .chat-mermaid-surface[data-visible="true"] svg').waitFor();
    await page.locator('[data-diagram="preview"] .chat-mermaid-surface[data-visible="true"] svg').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const original = await page.locator('[data-case="wide"] .chat-table-scroller table').elementHandle();
    const dimensions = viewport === 390 ? [[390, 0], [320, 0], [390, 0]] : [[1440, 0], [960, 0], [740, 0], [380, 0], [1100, 40], [1440, 0]];
    for (const [width, shift] of dimensions) {
      await page.evaluate(([width, shift]: number[]) => (window as any).setWideLayout(width, shift), [width, shift]);
      await page.waitForFunction((width: number) => Math.abs(document.querySelector(".thread-scroll")!.getBoundingClientRect().width - width) < 1, width);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const measure = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>(".thread-scroll")!;
        const prose = document.querySelector<HTMLElement>("[data-prose]")!;
        const ownerless = document.querySelector<HTMLElement>("[data-ownerless]")!;
        const isolated = ownerless.querySelector<HTMLElement>(".chat-table-scroller")!;
        return { ownerless: { frame: ownerless.getBoundingClientRect().toJSON(), table: isolated.getBoundingClientRect().toJSON() }, diagrams: [...document.querySelectorAll<HTMLElement>("[data-diagram]")].map(e => ({ kind: e.dataset.diagram, bounds: e.querySelector(".chat-mermaid-block")!.getBoundingClientRect().toJSON(), frame: (e.closest("[data-case=preview]") ?? root).getBoundingClientRect().toJSON() })), root: root.getBoundingClientRect().toJSON(), prose: prose.getBoundingClientRect().toJSON(), pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          tables: [...document.querySelectorAll<HTMLElement>("[data-case]")].map(section => {
            const scroller = section.querySelector<HTMLElement>(".chat-table-scroller")!;
            const toolbar = section.querySelector<HTMLElement>(".chat-table-actions__bar")!;
            return { kind: section.dataset.case, section: section.getBoundingClientRect().toJSON(), bounds: scroller.getBoundingClientRect().toJSON(), toolbar: toolbar.getBoundingClientRect().toJSON(), client: scroller.clientWidth, scroll: scroller.scrollWidth };
          }) };
      });
      records.push({ viewport, width, shift, theme, ...measure });
      if (viewport > width + 280) assert.ok(measure.ownerless.table.left >= measure.ownerless.frame.left - 1 && measure.ownerless.table.right <= measure.ownerless.frame.right + 1, "Ownerless documents use local space, not the window");
      for (const diagram of measure.diagrams) assert.ok(diagram.bounds.left >= diagram.frame.left - 1 && diagram.bounds.right <= diagram.frame.right + 1, `${diagram.kind}: Mermaid shares the safe width contract`);
      assert.equal(measure.pageOverflow, false, "Wide blocks never widen the application");
      for (const item of measure.tables) {
        assert.ok(item.bounds.left >= measure.root.left + 15, `${item.kind}: no clipping or navigation overlap on the left`);
        assert.ok(item.bounds.right <= measure.root.right - 15, `${item.kind}: no clipping or side-panel overlap on the right`);
        assert.ok(item.toolbar.left >= item.bounds.left - 1 && item.toolbar.right <= item.bounds.right + 1, `${item.kind}: actions remain inside their own reading area`);
        if (item.kind === "preview" || item.kind === "embedded") assert.ok(item.bounds.left >= item.section.left - 1 && item.bounds.right <= item.section.right + 1, `${item.kind}: no borrowing space from an ancestor conversation`);
      }
      if (width === 1440) assert.ok(measure.tables[0].bounds.width > measure.prose.width + 40, "Automatic expansion still borrows prose gutters");
      assert.ok(measure.tables[1].scroll <= measure.tables[1].client + 1, "Short tables do not acquire artificial overflow");
      assert.ok(await original!.evaluate(e => e.isConnected), "Panel changes retain table identity");
      const scroller = page.locator('[data-case="wide"] .chat-table-scroller');
      await scroller.evaluate((e: HTMLElement) => { e.scrollLeft = e.scrollWidth; });
      const end = await scroller.evaluate((e: HTMLElement) => {
        const last = e.querySelector("tbody tr:last-child td:last-child")!.getBoundingClientRect();
        return { lastRight: last.right, frameRight: e.getBoundingClientRect().right, left: e.scrollLeft, max: e.scrollWidth - e.clientWidth };
      });
      assert.ok(end.lastRight <= end.frameRight + 1 && Math.abs(end.left - end.max) <= 1, "Last column is fully reachable");
    }
    const scroller = page.locator('[data-case="wide"] .chat-table-scroller');
    const offset = await scroller.evaluate((e: HTMLElement) => { e.scrollLeft = 50; return e.scrollLeft; });
    await page.evaluate(() => (window as any).appendWideRow());
    await page.locator('[data-case="wide"] .chat-table-scroller').getByText("流式内容", { exact: true }).waitFor();
    assert.ok(await original!.evaluate(e => e.isConnected));
    assert.ok(Math.abs(await scroller.evaluate((e: HTMLElement) => e.scrollLeft) - offset) <= 1, "Streaming retains horizontal position");
    await scroller.evaluate((e: HTMLElement) => { e.scrollLeft = 0; });
    await page.locator('[data-case="wide"] .chat-table-container').hover();
    await page.screenshot({ path: `${output}/${viewport}-${theme}.png` });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, geometries: records.length }));
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(records, null, 2));
  await browser?.close(); await server.close();
}
