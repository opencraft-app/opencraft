import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.MERMAID_SMOKE_OUTPUT ?? ".local/mermaid-display";
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-markdown-wide-layout", server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "markdown-wide-layout", configureServer(vite) {
  vite.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith("/?")) return next();
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/mermaid-display.tsx"></script>');
  });
} }] });
let browser: any;
const records: unknown[] = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  for (const theme of ["light", "dark", "lavender"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", hasTouch: true });
    await context.addInitScript(() => { (window as any).__name = (fn: unknown) => fn; });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/?theme=${theme}`);
    for (const kind of ["login", "tall", "sequence"]) {
      await page.locator(`[data-diagram="${kind}"]`).scrollIntoViewIfNeeded();
      await page.locator(`[data-diagram="${kind}"] .chat-mermaid-surface[data-visible="true"] svg`).waitFor();
    }
    for (const width of [960, 390, 740, 320, 1280]) {
      await page.setViewportSize({width, height: 1000});
      await page.evaluate((width: number) => (window as any).setDiagramWidth(width), width);
      await page.waitForTimeout(150);
      const metrics = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-diagram]")].map(section => {
        const surface = section.querySelector<HTMLElement>(".chat-mermaid-surface")!;
        const shell = section.querySelector<HTMLElement>(".chat-mermaid-shell")!;
        const svg = surface.querySelector("svg")!;
        const code = section.querySelector<HTMLElement>("pre.sr-only")!;
        return { toolbar: section.querySelector(".chat-mermaid-actions")!.getBoundingClientRect().toJSON(), markup: svg.outerHTML, bbox: (() => { const b = svg.getBBox(); return {x:b.x, y:b.y, width:b.width, height:b.height}; })(), nodes: [...svg.querySelectorAll("g.node, rect.actor")].map(n => n.getBoundingClientRect().toJSON()), kind: section.dataset.diagram, shell: shell.getBoundingClientRect().toJSON(), surface: surface.getBoundingClientRect().toJSON(), svg: svg.getBoundingClientRect().toJSON(), viewBox: svg.getAttribute("viewBox"), code: code.getBoundingClientRect().toJSON(), overflow: surface.scrollWidth - surface.clientWidth};
      }));
      records.push({theme, width, metrics});
      await page.locator('[data-diagram="login"]').scrollIntoViewIfNeeded();
      await page.screenshot({path: `${output}/${theme}-${width}.png`});
      for (const m of metrics) {
        assert.ok(m.toolbar.bottom <= m.svg.top + 1, "Toolbar must not cover diagram content");
        assert.ok(m.code.width <= 1 && m.code.height <= 1, "Accessibility source must remain visually hidden");
        assert.ok(m.surface.bottom <= m.shell.bottom + 1 && m.svg.bottom <= m.shell.bottom + 1, `${m.kind}: full SVG height is inside shell`);
        const [x, y, w, h] = m.viewBox!.split(/\s+/).map(Number);
        assert.ok(m.bbox.x >= x - 0.1 && m.bbox.y >= y - 0.1 && m.bbox.x + m.bbox.width <= x + w + 0.1 && m.bbox.y + m.bbox.height <= y + h + 0.1, `${m.kind}: all graphics fit SVG viewBox`);
        for (const node of m.nodes) assert.ok(node.left >= m.svg.left - 1 && node.right <= m.svg.right + 1 && node.top >= m.svg.top - 1 && node.bottom <= m.svg.bottom + 1, `${m.kind}: nodes fit SVG viewBox`);
        assert.ok(m.svg.left >= m.surface.left && m.svg.right <= m.surface.right + 1, `${m.kind}: full SVG width fits surface`);
      }
    }
    await page.locator('[data-diagram="login"]').scrollIntoViewIfNeeded();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", {name: "Copy Mermaid source", exact:true}).first().click();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /```mermaid\nflowchart LR/);
    const expand = page.locator('[data-diagram="login"] [aria-label="Expand Mermaid diagram"]');
    await expand.click();
    await page.locator("dialog[open] .chat-mermaid-preview__diagram > svg").waitFor();
    await page.getByRole("button", {name:"Close Mermaid preview"}).click();
    // Closed diagrams survive prose updates and completion without a blank frame.
    await page.evaluate(() => {
      const svg = document.querySelector('[data-diagram="login"] .chat-mermaid-surface > svg');
      (window as any).originalDiagram = svg;
      (window as any).diagramRemovals = 0;
      new MutationObserver(records => {
        for (const record of records) {
          if ([...record.removedNodes].some(n => n === svg || n.contains(svg))) {
            (window as any).diagramRemovals++;
          }
        }
      }).observe(document.querySelector('[data-diagram="login"]')!, { childList: true, subtree: true });
    });
    for (let chunk = 0; chunk < 5; chunk++) {
      await page.evaluate(() => (window as any).appendDiagramTail());
      await page.waitForTimeout(80);
      assert.equal(await page.evaluate(() => document.querySelector('[data-diagram="login"] .chat-mermaid-surface > svg') === (window as any).originalDiagram), true, "Streaming prose must retain the diagram SVG");
    }
    await page.evaluate(() => (window as any).finishDiagramStream());
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => (window as any).diagramRemovals), 0, "Streaming and completion must never clear a closed diagram");
    await page.evaluate(() => { (window as any).diagramMeasurements = []; (window as any).setDiagramWidth(740); });
    await page.waitForTimeout(150);
    const measurements = await page.evaluate(() => (window as any).diagramMeasurements);
    assert.ok(measurements.length > 0, "Resizing still reports diagram geometry");
    assert.ok(measurements.every((event: any) => event.tail === 5 && event.generation === 6), "Measurement uses the latest streamed document generation and callback");
    const previousId = await page.locator('[data-diagram="login"] .chat-mermaid-surface > svg').getAttribute("id");
    await page.evaluate(() => (window as any).refreshDiagram());
    await page.waitForFunction((previousId: string) => document.querySelector('[data-diagram="login"] .chat-mermaid-surface > svg')?.id !== previousId, previousId);
    await page.locator('[data-diagram="login"] .chat-mermaid-surface[data-visible="true"] svg').waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, cases: records.length }));
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(records, null, 2));
  await browser?.close(); await server.close();
}
