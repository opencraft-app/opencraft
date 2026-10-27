import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const baseline = process.env.OPENCRAFT_TABLE_BASELINE === "1";
const output = ".local/markdown-table-scroll";
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-markdown-table-scroll", server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "markdown-table-scroll", configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/?")) return next();
      res.setHeader("content-type", "text/html");
      res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/markdown-table-scroll.tsx"></script>');
    });
  } }],
});
let browser: any;
const records: unknown[] = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const cases = baseline ? [{ width: 390, touch: true }] : [
    { width: 320, touch: true }, { width: 390, touch: true }, { width: 768, touch: true },
    { width: 1024, touch: true }, { width: 1366, touch: true }, { width: 1440, touch: false },
    { width: 1440, touch: false, narrow: true }, { width: 390, touch: true, embedded: true },
  ];
  for (const device of cases) for (const theme of baseline ? ["light"] : ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: device.width, height: 900 }, hasTouch: device.touch, isMobile: device.touch, reducedMotion: "reduce" });
    await context.addInitScript(() => { (window as any).__name = (fn: unknown) => fn; });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.route("https://example.test/**", (r: any) => r.fulfill({ status: 404, body: "" }));
    await page.route("https://www.google.com/**", (r: any) => r.fulfill({ status: 404, body: "" }));
    const query = new URLSearchParams({ theme, ...(device.narrow ? { narrow: "1" } : {}), ...(device.embedded ? { embedded: "1" } : {}) });
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/?${query}`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-table-case="0"] .chat-external-link').first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-table-case] .chat-table-scroller').length === 4);
    await page.evaluate(() => document.fonts.ready);
    const read = () => page.evaluate(() => [...document.querySelectorAll("[data-table-case]")].map(section => {
      const scroller = section.querySelector<HTMLElement>(".chat-table-scroller")!;
      const table = scroller.querySelector("table")!;
      return { index: section.getAttribute("data-table-case"), client: scroller.clientWidth, scroll: scroller.scrollWidth,
        left: scroller.scrollLeft, bounds: scroller.getBoundingClientRect().toJSON(),
        readingArea: document.querySelector(".thread-scroll")!.getBoundingClientRect().toJSON(),
        toolbar: section.querySelector(".chat-table-actions__bar")!.getBoundingClientRect().toJSON(),
        firstLink: section.querySelector(".chat-external-link")?.getBoundingClientRect().toJSON(),
        columns: [...table.rows[1]!.cells].map(c => c.getBoundingClientRect().width),
        rowHeight: table.rows[1]!.getBoundingClientRect().height,
        outer: document.documentElement.scrollWidth, viewport: innerWidth };
    }));
    const initial = await read();
    records.push({ device, theme, initial });
    await page.screenshot({ path: `${output}/${baseline ? "before" : "after"}-${device.width}-${theme}${device.narrow ? "-narrow" : ""}${device.embedded ? "-embedded" : ""}.png` });
    if (baseline) { await context.close(); continue; }
    assert.ok(initial[0].columns[0] >= 160, "Office plugin label must not collapse to a few letters per line");
    assert.ok(initial[0].scroll > initial[0].client + 30, "Long comparison is locally scrollable");
    assert.ok(initial[1].columns.every(width => width >= 80), "Many columns retain readable content widths");
    if (initial[1].client < 800) assert.ok(initial[1].scroll > initial[1].client + 30, "Many columns scroll locally when space is insufficient");
    assert.ok(initial[2].scroll <= initial[2].client + 1, "Short table must not gain unnecessary overflow");
    assert.ok(initial[3].columns[1] <= Math.max(600, initial[3].client), "Unbroken identifiers wrap instead of setting an unbounded table width");
    for (const table of initial) {
      assert.ok(table.outer <= table.viewport + 1, "Tables never widen the page");
      // A clipped viewport can hide overflow from document.scrollWidth. Verify
      // the real scrollport and controls against the owning reading surface.
      assert.ok(table.bounds.left >= table.readingArea.left + 15 && table.bounds.right <= table.readingArea.right - 15,
        "Table scrollports retain visible reading gutters on both sides");
      assert.ok(table.toolbar.left >= table.bounds.left - 1 && table.toolbar.right <= table.bounds.right + 1,
        "Table actions remain fully inside their own scrollport");
    }
    assert.ok(initial[0].firstLink!.left >= initial[0].bounds.left - 1 && initial[0].firstLink!.right <= initial[0].bounds.right + 1,
      "Initial Office link is completely reachable without clipping the first column");
    const scroller = page.locator('[data-table-case="0"] .chat-table-scroller');
    const box = await scroller.boundingBox();
    const x = box!.x + box!.width * 0.7, y = box!.y + 70;
    const cdp = await context.newCDPSession(page);
    const swipe = async (dx: number, dy: number) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let i = 1; i <= 8; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * i / 8, y: y + dy * i / 8 }] });
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    if (device.touch) {
      await swipe(-150, 0);
    } else {
      await page.mouse.move(x, y); await page.mouse.wheel(180, 0);
    }
    console.log(JSON.stringify({ device, theme, widths: initial.map(t => [t.client, t.scroll]) }));
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.chat-table-scroller')!.scrollLeft > 30);
    // Native touch flings continue after touchEnd; compare settled offsets,
    // rather than treating the browser's ongoing inertia as a streaming reset.
    await scroller.evaluate((e: HTMLElement) => new Promise<void>((resolve, reject) => {
      let previous = e.scrollLeft, stable = 0, frames = 0;
      const sample = () => { const next = e.scrollLeft; stable = Math.abs(next - previous) < 0.1 ? stable + 1 : 0; previous = next; if (stable >= 8) resolve(); else if (++frames > 180) reject(new Error("Touch scroll did not settle")); else requestAnimationFrame(sample); };
      requestAnimationFrame(sample);
    }));
    const offset = await scroller.evaluate((e: HTMLElement) => e.scrollLeft);
    const lastColumn = await scroller.evaluate((e: HTMLElement) => {
      e.scrollLeft = e.scrollWidth;
      const last = e.querySelector("tbody tr:last-child td:last-child")!.getBoundingClientRect();
      return { right: last.right, frameRight: e.getBoundingClientRect().right, left: e.scrollLeft, max: e.scrollWidth - e.clientWidth };
    });
    assert.ok(lastColumn.right <= initial[0].bounds.right + 1 && Math.abs(lastColumn.left - lastColumn.max) <= 1,
      "The final column is fully reachable within the visible scrollport");
    await scroller.evaluate((e: HTMLElement, left: number) => { e.scrollLeft = left; }, offset);
    const originalTable = await scroller.locator("table").elementHandle();
    await page.evaluate(() => (window as any).appendTableRow());
    await page.getByText("流式追加保留原表格与滚动位置").first().waitFor({ state: "attached" });
    assert.ok(await originalTable!.evaluate(e => e.isConnected), "Streaming append retains original table DOM");
    const updatedOffset = await scroller.evaluate((e: HTMLElement) => e.scrollLeft);
    assert.ok(Math.abs(updatedOffset - offset) <= 1, `Streaming append retains horizontal scroll: ${offset} -> ${updatedOffset}`);
    if (!device.touch) {
      await scroller.focus();
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction((previous: number) => document.querySelector<HTMLElement>(".chat-table-scroller")!.scrollLeft < previous - 5, updatedOffset);
    }
    // Return to the first column, then prove native text selection and link intent.
    await scroller.evaluate((e: HTMLElement) => { e.scrollLeft = 0; });
    const label = scroller.locator(".chat-external-link__label").first();
    await label.evaluate(e => { const r = document.createRange(); r.selectNodeContents(e); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); });
    assert.match(await page.evaluate(() => getSelection()?.toString() ?? ""), /omdsh-dev\/dsh-office/);
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await label.click();
    assert.equal(await page.evaluate(() => (window as any).opens.length), 1);
    const container = page.locator('[data-table-case="0"] .chat-table-container');
    await container.getByRole("button", { name: "Copy table", exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).copiedText === "string");
    assert.match(await page.evaluate(() => (window as any).copiedText), /^\| 插件 \| 能力 \| 主要区别 \|/);
    if (!device.embedded) {
      await container.getByRole("button", { name: "Expand table", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Table preview" }); await dialog.waitFor();
      assert.ok(await dialog.locator("td").count() >= 12);
      await dialog.getByRole("button", { name: "Close table preview" }).click();
      await dialog.waitFor({ state: "hidden" });
    }
    // A vertical gesture started over the table must still reach the timeline.
    await page.locator(".thread-scroll").evaluate((e: HTMLElement) => { e.scrollTop = 0; });
    if (device.touch) await swipe(0, -100);
    else { await page.mouse.move(x, y); await page.mouse.wheel(0, 180); }
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".thread-scroll")!.scrollTop > 30);
    if (device.width === 1024) {
      for (const width of [600, 1366]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => new Promise(requestAnimationFrame));
        assert.ok(await originalTable!.evaluate(e => e.isConnected), "Split view and rotation retain table DOM");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Resize does not widen the page");
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, baseline, cases: records.length }));
} finally {
  await writeFile(`${output}/${baseline ? "before" : "after"}.json`, JSON.stringify(records, null, 2));
  await browser?.close(); await server.close();
}
