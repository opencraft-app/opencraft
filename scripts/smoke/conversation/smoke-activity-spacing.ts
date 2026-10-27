import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { assertBrowserRuntimeDependencies } from "../../browser-smoke-preflight.mjs";

assertBrowserRuntimeDependencies(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath());
const output = await mkdtemp("/tmp/opencraft-activity-spacing-");
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-activity-spacing",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "activity-spacing", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/" && !request.url?.startsWith("/?")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/reasoning-disclosure.tsx"></script>');
    });
  } }] });
const results: unknown[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const theme of ["light", "dark"]) for (const mode of ["mouse", "touch", "touch-reduced"]) {
    const touch = mode !== "mouse";
    const page = await browser.newPage({ viewport: { width: touch ? 390 : 1024, height: 900 },
      deviceScaleFactor: touch ? 2 : 1, hasTouch: touch, isMobile: touch,
      reducedMotion: mode === "touch-reduced" ? "reduce" : "no-preference" });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}`);
    await page.locator(".thread-reasoning").waitFor();
    await page.evaluate(() => (window as any).update("spacing-contract", "codex"));
    await page.locator('.thread-reasoning').nth(2).waitFor();
    await page.locator('.thread-agent-activity__unit').filter({ hasText: "Independent prose boundary" })
      .locator('.opencraft-chat-document').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const initialBoundaries = await page.locator(".thread-agent-activity__content").evaluateAll(lists => lists.flatMap(list => {
      const rows = [...list.children];
      return rows.slice(1).map((row, index) => ({
        prose: row.textContent === "Independent prose boundary",
        gap: row.getBoundingClientRect().top - rows[index]!.getBoundingClientRect().bottom,
      }));
    }));
    assert.ok(initialBoundaries.some(boundary => boundary.prose), "fixture retains a real prose boundary");
    for (const boundary of initialBoundaries) assert.ok(Math.abs(boundary.gap - (boundary.prose ? 16 : 4)) < 0.5,
      "activity rhythm and prose boundaries have separate stable owners");

    // Keep actual DOM references and record geometric boundaries, rather than
    // treating constant absolute coordinates as correct while content grows.
    const start = async (toggle: ReturnType<typeof page.locator>) => toggle.evaluate(target => {
      const lists = [...document.querySelectorAll<HTMLElement>(
        ".thread-frame--assistant,.thread-agent-activity__content,.thread-agent-activity__rows")];
      const disclosure = target.closest<HTMLElement>(".thread-activity-item")!;
      const header = target.closest<HTMLElement>(".thread-activity-item__header")!;
      const rect = header.getBoundingClientRect();
      const boundaries = lists.flatMap(list => [...list.children].map((row, index, rows) => {
        const previous = rows[index - 1];
        const box = row.getBoundingClientRect();
        return { row, previous, margin: getComputedStyle(row).marginBlockStart,
          gap: previous ? box.top - previous.getBoundingClientRect().bottom : null,
          width: box.width, height: box.height,
          removableDetail: row !== disclosure && disclosure.contains(row),
          unaffected: !row.contains(target) && !disclosure.contains(row) };
      }));
      const trace = { boundaries, disclosure, header, headerHeight: rect.height,
        initialHeight: disclosure.getBoundingClientRect().height, samples: 0, violations: [] as unknown[], active: true };
      (window as any).__spacingTrace = trace;
      const sample = () => {
        if (!trace.active) return;
        trace.samples++;
        for (const boundary of trace.boundaries) {
          const { row, previous } = boundary;
          if (!row.isConnected) {
            if (!boundary.removableDetail) trace.violations.push({ kind: "replaced-row" });
            continue;
          }
          const now = row.getBoundingClientRect();
          const margin = getComputedStyle(row).marginBlockStart;
          if (margin !== boundary.margin) trace.violations.push({ kind: "external-margin", before: boundary.margin, after: margin });
          if (previous && previous.isConnected && row.previousElementSibling === previous) {
            const gap = now.top - previous.getBoundingClientRect().bottom;
            if (Math.abs(gap - boundary.gap!) > 0.5) trace.violations.push({ kind: "sibling-gap", before: boundary.gap, after: gap });
          }
          if (boundary.unaffected && (Math.abs(now.height - boundary.height) > 0.5 || Math.abs(now.width - boundary.width) > 0.5)) {
            trace.violations.push({ kind: "unrelated-size", row: row.className, text: row.textContent?.slice(0, 90), before: [boundary.width, boundary.height], after: [now.width, now.height] });
          }
        }
        const now = header.getBoundingClientRect();
        if (Math.abs(now.height - trace.headerHeight) > 0.5) trace.violations.push({ kind: "header-height", before: trace.headerHeight, after: now.height });
        requestAnimationFrame(sample);
      };
      sample();
    });
    const finish = async (name: string, growth?: "grow" | "restore") => {
      // Samples include real animation frames, not only the endpoint.
      await page.waitForTimeout(450);
      const trace = await page.evaluate(() => {
        const trace = (window as any).__spacingTrace;
        trace.active = false;
        return { samples: trace.samples, violations: trace.violations,
          initialHeight: trace.initialHeight, finalHeight: trace.disclosure.getBoundingClientRect().height };
      });
      assert.ok(trace.samples >= 2, `${name}: sampled intermediate frames`);
      assert.deepEqual(trace.violations, [], `${name}: stable outer spacing and unaffected siblings`);
      if (growth === "grow") assert.ok(trace.finalHeight > trace.initialHeight + 5, `${name}: details grow naturally`);
      if (growth === "restore") assert.ok(Math.abs(trace.finalHeight - trace.initialHeight) < 0.5, `${name}: close restores geometry`);
      results.push({ theme, mode, name, ...trace });
    };
    const activate = async (toggle: ReturnType<typeof page.locator>) => touch ? toggle.tap() : toggle.click();
    for (const id of ["spacing-first", "spacing-middle", "spacing-last"]) {
      const reason = page.locator(`.thread-reasoning[data-reasoning-id$="${id}"]`);
      const toggle = reason.getByRole("button").first();
      const closedHeight = await reason.evaluate(node => node.getBoundingClientRect().height);
      await start(toggle);
      await activate(toggle);
      await reason.locator(".opencraft-chat-document").waitFor();
      await finish(`open-${id}`, "grow");
      if (id === "spacing-middle") {
        await start(toggle);
        await page.evaluate(() => (window as any).update("spacing-grow"));
        await finish("streaming-growth", "grow");
        await page.screenshot({ path: join(output, `${theme}-${mode}-expanded.png`), fullPage: true });
      }
      await start(toggle);
      await activate(toggle);
      await activate(toggle);
      await finish(`reverse-${id}`, "restore");
      await start(toggle);
      await activate(toggle);
      await finish(`close-${id}`);
      assert.ok(Math.abs(await reason.evaluate(node => node.getBoundingClientRect().height) - closedHeight) < 0.5, "closing restores the original activity height");
    }
    const image = page.locator(".thread-activity-item").filter({ has: page.locator('[data-action-glyph="image"], [data-opencraft-activity-icon="image"], [data-activity-glyph="image"]') });
    const imageToggle = image.getByRole("button").first();
    await start(imageToggle); await activate(imageToggle); await finish("open-image", "grow");
    await start(imageToggle); await activate(imageToggle); await finish("close-image");
    assert.ok(await page.locator(".thread-agent-activity__group").count() > 0, "fixture includes a nested tool group");
    let expandableGroups = 0;
    for (const group of await page.locator(".thread-agent-activity__group").all()) {
      const toggle = group.locator(':scope > .thread-agent-activity__group-disclosure > .thread-activity-item__header > button');
      // Standalone activity units expose their own row disclosure, without a
      // second group header. Exercise nesting only on actual grouped units.
      if (await toggle.count() === 0) continue;
      expandableGroups++;
      if (await toggle.getAttribute("aria-expanded") === "true") { await activate(toggle); await page.waitForTimeout(450); }
      await start(toggle); await activate(toggle); await finish("open-tool-group", "grow");
      const command = group.locator('.thread-agent-activity__rows > .thread-activity-item > .thread-activity-item__header > button').first();
      await command.waitFor();
      if (await command.getAttribute("aria-expanded") === "true") { await activate(command); await page.waitForTimeout(450); }
      await start(command); await activate(command); await finish("open-nested-command", "grow");
      await start(command); await activate(command); await finish("close-nested-command");
      await start(toggle); await activate(toggle); await finish("close-tool-group");
    }
    assert.ok(expandableGroups > 0, "fixture exercises an actual collapsible tool group");
    await page.screenshot({ path: join(output, `${theme}-${mode}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
  await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, checks: results.length }));
} finally {
  await browser?.close();
  await vite.close();
}
