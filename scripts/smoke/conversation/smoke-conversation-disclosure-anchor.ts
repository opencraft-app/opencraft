import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";

const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/disclosure-anchor");
const baseline = process.env.OPENCRAFT_DISCLOSURE_BASELINE;
const engine = process.env.OPENCRAFT_SMOKE_BROWSER === "webkit" ? webkit : chromium;
const files = [
  "packages/timeline-host-web/src/reflow.ts",
  "packages/timeline-host-web/src/conversation-viewport-owner.ts",
  "apps/workbench-web/src/components/conversation/virtualized-conversation-turns.tsx",
];
await mkdir(output, { recursive: true });
const vite = await createServer({
  root: process.cwd(),
  configFile: false,
  logLevel: "error",
  cacheDir: `${output}/vite-cache`,
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "disclosure-anchor",
      enforce: "pre",
      load(id) {
        const file = baseline && files.find((file) => id.split("?")[0]!.endsWith("/" + file));
        return file ? execFileSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8" }) : null;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-disclosure-anchor.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
const results: unknown[] = [];
try {
  await vite.listen();
  browser = await engine.launch({ headless: true });
  for (const touch of [true, false])
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      const page = await browser.newPage({
        viewport: { width: touch ? 402 : 1100, height: 690 },
        hasTouch: touch,
        isMobile: touch,
        reducedMotion,
      });
      const errors: string[] = [],
        observerWarnings: string[] = [];
      page.on("pageerror", (e) =>
        (e.message.includes("ResizeObserver loop") ? observerWarnings : errors).push(e.message),
      );
      await page.addInitScript(() => {
        (window as any).__name = (value: unknown) => value;
      });
      const settle = () => page.waitForTimeout(450);
      const button = page.locator(".thread-agent-activity__turn-toggle button");
      const tap = async () => {
        const box = await button.boundingBox();
        assert.ok(
          box && box.y >= 0 && box.y + box.height <= 620,
          "clicked header must remain visible, without auto-scrolling",
        );
        if (touch) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      };
      for (const diagnosticsOff of [false, true]) {
        await page.goto(
          vite.resolvedUrls!.local[0]! +
            `?longHistory&longDisclosure&locale=zh-CN${diagnosticsOff ? "&diagnosticsOff" : ""}`,
        );
        await page.waitForFunction(() => typeof (window as any).update === "function");
        await page.evaluate(() => (window as any).update("long-empty-clock", "codex"));
        await button.waitFor();
        await page.evaluate(() => document.fonts.ready);
        await settle();
        await button.evaluate((node) => {
          const root = node.closest<HTMLElement>(".thread-scroll")!;
          root.scrollTop += node.getBoundingClientRect().top - 250;
          root.dispatchEvent(new Event("scroll"));
        });
        await settle();
        const original = await button.elementHandle();
        assert.ok(original);
        const measure = () =>
          button.evaluate((node) => ({
            top: node.getBoundingClientRect().top,
            scroll: node.closest(".thread-scroll")!.scrollTop,
            expanded: node.getAttribute("aria-expanded"),
          }));
        const before = await measure();
        assert.ok(Math.abs(before.top - 250) <= 1);
        await page.evaluate((node) => {
          const w = window as any;
          w.disclosureDiagnostics = [];
          w.disclosureFrames = [];
          w.disclosureSampling = true;
          const sample = () => {
            if (!w.disclosureSampling) return;
            requestAnimationFrame(() => {
              setTimeout(() => {
                if (w.disclosureSampling)
                  w.disclosureFrames.push({ connected: node!.isConnected, top: node!.getBoundingClientRect().top });
              }, 0);
              sample();
            });
          };
          sample();
        }, original);
        await tap();
        await settle();
        const survived = await original.evaluate((node) => node.isConnected);
        if (!survived) {
          await writeFile(
            `${output}/failure.json`,
            JSON.stringify(
              await page.evaluate(() => ({
                diagnostics: (window as any).disclosureDiagnostics,
                frames: (window as any).disclosureFrames,
              })),
              null,
              2,
            ),
          );
          await page.screenshot({ path: `${output}/failure.png` });
        }
        assert.equal(survived, true, "expansion cannot virtualize its own clicked row away");
        const opened = await measure();
        assert.equal(opened.expanded, "true");
        assert.ok(Math.abs(opened.top - before.top) <= 1, JSON.stringify({ before, opened }));
        assert.ok(
          before.scroll - opened.scroll > (touch ? 6000 : 3000),
          `expanded prose must exercise a multi-screen height change: ${JSON.stringify({ touch, before, opened })}`,
        );
        await tap();
        await settle();
        const closed = await measure();
        assert.equal(closed.expanded, "false");
        assert.ok(Math.abs(closed.top - before.top) <= 1);
        assert.ok(Math.abs(closed.scroll - before.scroll) <= 1);
        await tap();
        await page.waitForTimeout(35);
        await tap();
        await page.waitForTimeout(25);
        await tap();
        await settle();
        assert.equal(await original.evaluate((node) => node.isConnected), true);
        const reversed = await measure();
        assert.equal(reversed.expanded, "true");
        assert.ok(Math.abs(reversed.top - before.top) <= 1);
        const evidence = await page.evaluate(() => {
          const w = window as any;
          w.disclosureSampling = false;
          return { diagnostics: w.disclosureDiagnostics, frames: w.disclosureFrames };
        });
        assert.ok(evidence.frames.length > 0);
        assert.ok(
          evidence.frames.every((f: any) => f.connected && Math.abs(f.top - before.top) <= 1),
          "post-layout samples must retain the clicked anchor throughout transitions",
        );
        const competing = evidence.diagnostics.filter(
          (e: any) => e.kind === "scroll-write" && e.fields.reason !== "reflow-anchor",
        );
        assert.equal(competing.length, 0, `disclosure must be the sole compensator: ${JSON.stringify(competing)}`);
        // Pointer uses browser wheel input. Controlled DOM touch samples exercise
        // cancellation without pretending Playwright can generate WebKit inertia.
        await tap();
        await page.waitForTimeout(25);
        if (touch)
          await page.evaluate(() => {
            const root = document.querySelector<HTMLElement>(".thread-scroll")!;
            for (const [type, y] of [
              ["touchstart", 350],
              ["touchmove", 390],
              ["touchend", 390],
            ] as const) {
              const event = new Event(type, { bubbles: true });
              Object.defineProperty(event, "touches", {
                value: type === "touchend" ? [] : [{ identifier: 1, clientX: 180, clientY: y }],
              });
              root.dispatchEvent(event);
            }
            root.scrollTop -= 100;
            root.dispatchEvent(new Event("scroll"));
          });
        else {
          await page.mouse.move(500, 350);
          await page.mouse.wheel(0, -100);
        }
        await settle();
        assert.equal(
          await page.evaluate(() => (window as any).disclosureOwner.synchronizeReflowAnchor()),
          null,
          "new scrolling input revokes disclosure ownership",
        );
        const afterInput = await measure();
        await settle();
        const later = await measure();
        assert.ok(Math.abs(later.top - afterInput.top) <= 1, "late completion cannot pull back a reader who scrolled");
        const name = `${engine.name()}-${touch}-${reducedMotion}-${diagnosticsOff}`;
        await writeFile(
          `${output}/${name}.json`,
          JSON.stringify(
            { before, opened, closed, reversed, afterInput, later, evidence, errors, observerWarnings },
            null,
            2,
          ),
        );
        await page.screenshot({ path: `${output}/${name}.png` });
        results.push({ name, before, opened, closed, reversed, observerWarnings });
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ engine: engine.name(), cases: results.length, results }));
} finally {
  await browser?.close();
  await vite.close();
}
