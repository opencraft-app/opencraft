import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { typographyRole } from "@opencraft/design-system/typography";
import { assertBrowserRuntimeDependencies } from "../../browser-smoke-preflight.mjs";

const { chromium } = await import("playwright");
assertBrowserRuntimeDependencies(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath());
const output = resolve(process.env.OPENCRAFT_ACTIVITY_METRICS_REPORT ?? ".local/activity-metrics/after");
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-reasoning-disclosure", server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "activity-metrics-fixture", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== "/" && !req.url?.startsWith("/?")) return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/reasoning-disclosure.tsx"></script>');
    });
  } }],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results = [];
try {
  await vite.listen();
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const width of [390, 1024]) for (const dpr of [1, 2]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: dpr,
      hasTouch: width < 600, isMobile: width < 600, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&locale=en`);
    await page.waitForFunction(() => typeof (window as any).update === "function", null, { timeout: 90_000 });
    await page.evaluate(() => (window as any).update("activity-metrics", "codex"));
    await page.locator('.thread-compaction').first().waitFor();
    // Observe the text itself, including the pre-fix shimmer span. No assertion
    // depends on the new wrapper being present to reproduce the old failure.
    const compaction = await page.locator('.thread-compaction').evaluateAll(rows => rows.map(row => {
      const text = row.querySelector('.thread-activity-item__summary') ?? row.lastElementChild!;
      const font = getComputedStyle(text);
      return { completed: row.getAttribute('data-completed'), size: parseFloat(font.fontSize), weight: font.fontWeight, iconWidth: row.querySelector('svg')!.getBoundingClientRect().width };
    }));
    await writeFile(join(output, `${width}-${dpr}-${theme}-compaction.json`), JSON.stringify(compaction));
    assert.equal(compaction.length, 2, "actual timeline includes active and historical compaction");
    const summaryType = typographyRole("body", "web");
    for (const row of compaction) {
      assert.equal(row.size, summaryType.fontSize, "compaction must share the process-summary role, not inherit chat");
      assert.equal(row.weight, summaryType.fontWeight);
    }
    for (const toggle of await page.locator('.thread-agent-activity__group').getByRole('button').all()) {
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    }
    await page.locator('[data-opencraft-activity-icon="read"]').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    const measure = () => page.locator('.thread-activity-item__icon > svg').evaluateAll(elements => elements.map(svg => {
      const icon = svg as SVGSVGElement, rail = icon.parentElement!;
      const header = rail.closest('.thread-activity-item__header')!;
      const label = header.querySelector('.thread-activity-item__summary')!;
      const style = getComputedStyle(label), box = icon.getBBox(), rect = icon.getBoundingClientRect(), slot = rail.getBoundingClientRect();
      const scale = rect.width / icon.viewBox.baseVal.width;
      return { glyph: icon.getAttribute('data-activity-glyph') ?? icon.getAttribute('data-opencraft-activity-icon') ?? icon.getAttribute('data-action-glyph'),
        paths: icon.innerHTML, fontSize: parseFloat(style.fontSize), family: style.fontFamily, weight: style.fontWeight,
        lineHeight: parseFloat(style.lineHeight), width: rect.width, visibleWidth: box.width * scale,
        stroke: parseFloat(getComputedStyle(icon).strokeWidth) * scale,
        centerX: Math.abs(rect.x + rect.width / 2 - slot.x - slot.width / 2),
        centerY: Math.abs(rect.y + rect.height / 2 - slot.y - slot.height / 2),
        textGap: label.getBoundingClientRect().x - slot.right };
    }));
    const subagent = page.locator('.thread-subagent-activity__toggle');
    assert.ok(await subagent.count() > 0, "actual collaboration process headers must be in the metrics corpus");
    const wasExpanded = await subagent.first().getAttribute('aria-expanded');
    await subagent.first().click();
    assert.notEqual(await subagent.first().getAttribute('aria-expanded'), wasExpanded, "shared visual header preserves native collaboration toggle");
    await subagent.first().click();
    assert.equal(await subagent.first().getAttribute('aria-expanded'), wasExpanded);
    const subagentStatus = await page.locator('.thread-subagent-activity__status').evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node);
      return { size: parseFloat(style.fontSize), weight: style.fontWeight };
    }));
    for (const status of subagentStatus) {
      assert.equal(status.size, summaryType.fontSize, "collaboration state must not inherit reading size");
      assert.equal(status.weight, summaryType.fontWeight);
    }
    const normal = await measure();
    assert.ok(normal.every(row => typeof row.glyph === "string" && row.glyph.length > 0), "Every measured icon exposes its shared artwork identity");
    const kinds = new Set(normal.map(row => row.glyph));
    for (const glyph of ["terminal", "read", "thinking", "image", "checklist"]) assert.ok(kinds.has(glyph), glyph);
    assert.ok(kinds.size >= 14, "include every tool glyph and supplemental file/interaction/web consumer");
    await writeFile(join(output, `${width}-${dpr}-${theme}-all-glyphs.json`), JSON.stringify(normal));
    for (const row of normal) {
      assert.equal(row.fontSize, summaryType.fontSize);
      assert.equal(row.weight, summaryType.fontWeight);
      assert.equal(row.lineHeight, summaryType.lineHeight);
      assert.equal(row.family, normal[0].family);
      assert.ok(row.visibleWidth / row.fontSize >= 1.0 && row.visibleWidth / row.fontSize <= 1.12,
        `${row.glyph}: painted silhouette balances process copy (${row.visibleWidth}/${row.fontSize})`);
      assert.ok(row.centerX < .1 && row.centerY < .1, `${row.glyph}: centered rail`);
      assert.ok(Math.abs(row.textGap - normal[0].textGap) < .1, `${row.glyph}: shared label gap`);
      if (row.glyph && !["terminal", "read", "thinking", "files", "patch", "browser", "agent", "search"].includes(row.glyph)) assert.ok(Math.abs(row.stroke - 1.2) < .01);
    }
    // Essential reading preferences must change returned text only. Process
    // labels, including compaction and shimmer, retain their semantic scale.
    await page.evaluate(() => document.documentElement.style.setProperty('--opencraft-chat-font-size', '20px'));
    const enlarged = await measure();
    assert.deepEqual(enlarged, normal, "reading preference cannot change summary metrics or glyph identity");
    assert.deepEqual(await page.locator('.thread-subagent-activity__status').evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node);
      return { size: parseFloat(style.fontSize), weight: style.fontWeight };
    })), subagentStatus, "collaboration state stays on body when reading size changes");
    await page.getByRole('button', { name: /Thought/ }).first().click();
    await page.locator('.thread-reasoning .thread-activity-item__prose').waitFor();
    assert.equal(await page.locator('.thread-reasoning .thread-activity-item__prose').evaluate(node => parseFloat(getComputedStyle(node).fontSize)), 20);
    await page.waitForFunction(() => {
      const prose = document.querySelector('.thread-reasoning .thread-activity-item__prose');
      const clip = prose?.closest('.thread-activity-item__body-clip');
      return prose && clip && clip.getBoundingClientRect().height >= prose.getBoundingClientRect().height;
    });
    await page.screenshot({ path: join(output, `${width}-${dpr}-${theme}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator("[data-activity-metrics-gallery]").evaluate(node => Object.assign((node as HTMLElement).style,
      { position: "fixed", inset: "0", zIndex: "1000", padding: "16px", background: "var(--color-background-surface)" }));
    await page.locator("[data-activity-metrics-gallery]").screenshot({ path: join(output, `${width}-${dpr}-${theme}-glyphs.png`) });
    assert.deepEqual(errors, []);
    results.push({ width, dpr, theme, compaction, rows: normal.map(({ paths, ...row }) => row) });
    await page.close();
  }
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: results.length, output }));
} finally { await browser?.close(); await vite.close(); }
