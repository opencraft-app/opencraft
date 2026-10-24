import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { assertBrowserRuntimeDependencies } from "../../browser-smoke-preflight.mjs";

const executablePath = process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath();
assertBrowserRuntimeDependencies(executablePath);
const output = await mkdtemp("/tmp/opencraft-measurement-restore-");
const vite = await createServer({
  root: process.cwd(), configFile: false, logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-measurement-restore",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "measurement-restore", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/" && !request.url?.startsWith("/?")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/reasoning-disclosure.tsx"></script>');
    });
  } }],
});
await vite.listen();
const browser = await chromium.launch({ headless: true, executablePath });
const results: unknown[] = [];
try {
  for (const boundary of ["control", "before", "after"] as const)
    for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width: touch ? 390 : 1280, height: 900 },
        hasTouch: touch, isMobile: touch, reducedMotion: touch ? "reduce" : "no-preference" });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript("window.__name=value=>value");
      await page.addInitScript(boundary => {
        const probe = window as any;
        probe.measurementRestore = { armed: false, restored: false, warnings: [] };
        const NativeObserver = window.ResizeObserver;
        window.ResizeObserver = class extends NativeObserver {
          constructor(callback: ResizeObserverCallback) {
            super((entries, observer) => {
              const state = probe.measurementRestore;
              const restore = () => { state.armed = false; state.restored = true; probe.update("restore"); };
              const matches = state.armed && entries.some(entry => entry.target.hasAttribute("data-virtualized-turn-content"));
              if (matches && boundary === "before") restore();
              callback(entries, observer);
              if (matches && boundary === "after") restore();
            });
          }
        };
        // Keep browser delivery visible; an existing observer-loop warning is
        // separate from this strict reading-position and disclosure regression.
        window.addEventListener("error", event => {
          if (event.message.startsWith("ResizeObserver")) probe.measurementRestore.warnings.push(event.message);
        });
      }, boundary);
      await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?longHistory&theme=${theme}&locale=en-US`);
      await page.locator('[data-revision="0"]').waitFor();
      await page.evaluate(() => (window as any).update("long-empty-clock", "codex"));
      await page.locator('[data-revision="1"]').waitFor();
      const toggle = page.locator(".thread-agent-activity__turn-toggle button");
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await toggle.click();
      const groups = page.locator(".thread-agent-activity__group-disclosure > .thread-activity-item__header button");
      for (let index = 0; index < await groups.count(); index++)
        if (await groups.nth(index).getAttribute("aria-expanded") === "false") await groups.nth(index).click();
      await page.waitForFunction(() => document.querySelectorAll(".thread-agent-activity__content .thread-activity-item[data-status]").length === 60);
      const frames = (count: number) => page.evaluate(count => new Promise<void>(resolve => {
        const sample = () => { if (--count <= 0) resolve(); else requestAnimationFrame(sample); };
        requestAnimationFrame(sample);
      }), count);
      const measure = () => page.evaluate(() => {
        const scroll = document.querySelector<HTMLElement>(".thread-scroll")!;
        const toggle = scroll.querySelector<HTMLElement>(".thread-agent-activity__turn-toggle button");
        return { distance: -scroll.scrollTop, headerY: toggle?.getBoundingClientRect().top ?? null,
          expanded: toggle?.getAttribute("aria-expanded") ?? null,
          rows: scroll.querySelectorAll(".thread-agent-activity__content .thread-activity-item[data-status]").length };
      });
      const viewport = await page.locator(".thread-scroll").boundingBox();
      const initial = await toggle.boundingBox(); assert(viewport && initial);
      await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
      await page.mouse.wheel(0, initial.y - 250); await frames(24);
      const before = await measure();
      assert(before.distance > 500 && before.headerY !== null && Math.abs(before.headerY - 250) <= 1);
      const old = await page.locator(".thread-scroll").elementHandle();
      await page.evaluate(boundary => { (window as any).measurementRestore.armed = boundary !== "control"; }, boundary);
      const hit = await toggle.boundingBox(); assert(hit);
      const point = { x: hit.x + hit.width / 2, y: hit.y + hit.height / 2 };
      assert(await toggle.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), point));
      if (touch) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
      let settled: Awaited<ReturnType<typeof measure>> | null = null;
      if (boundary === "control") { await frames(24); settled = await measure(); await page.evaluate(() => (window as any).update("restore")); }
      else await page.waitForFunction(() => (window as any).measurementRestore.restored);
      await page.waitForFunction(element => !element!.isConnected, old);
      await page.locator(".thread-scroll").waitFor(); await frames(60);
      const after = await measure();
      const diagnostics = await page.evaluate(() => (window as any).measurementRestore);
      results.push({ boundary, touch, theme, before, settled, after, diagnostics, errors });
      await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2));
      await page.screenshot({ path: join(output, `${boundary}-${touch}-${theme}.png`) });
      assert.equal(after.expanded, "false"); assert.equal(after.rows, 0);
      assert(after.headerY !== null && Math.abs(after.headerY - before.headerY!) <= 1,
        JSON.stringify({ boundary, touch, theme, before, after }));
      assert.deepEqual(errors, []);
      await page.close();
    }
  console.log(JSON.stringify({ verified: true, cases: results.length, output }));
} finally { await browser.close(); await vite.close(); }
