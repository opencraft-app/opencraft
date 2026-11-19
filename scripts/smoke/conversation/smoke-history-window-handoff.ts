import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";

const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/history-window-handoff";
const baseline = process.env.OPENCRAFT_HISTORY_HANDOFF_BASELINE === "1";
const engine = process.env.OPENCRAFT_HISTORY_ENGINE === "webkit" ? webkit : chromium;
fs.mkdirSync(output, { recursive: true });
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  cacheDir: path.join(output, "vite"),
  resolve: { dedupe: ["react", "react-dom"] },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "history-window-handoff",
      enforce: "pre",
      load(id) {
        if (baseline && id.endsWith("/apps/workbench-web/src/components/conversation/turn-window.tsx")) {
          // Negative control: preserve the real component/CSS, disable only the lease.
          const source = fs.readFileSync(id, "utf8");
          const call = "return this.handoff = next.viewportOwner.protectWindowHandoff(next.elementRef.current);";
          assert.ok(source.includes(call));
          return source.replace(call, "return null;");
        }
        return null;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-cold-history.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
try {
  await vite.listen();
  browser = await engine.launch({ headless: true });
  const summaries = [];
  for (const touch of baseline ? [true] : [true, false])
    for (const diagnostics of [false, true])
      for (const movement of baseline ? [0] : [0, 40]) {
        const page = await browser.newPage({
          viewport: { width: touch ? 402 : 1100, height: 690 },
          deviceScaleFactor: touch ? 3 : 1,
          hasTouch: touch,
          isMobile: touch,
          locale: "zh-CN",
        });
        await page.addInitScript(() => {
          const probe = window as any;
          probe.__name = (value: unknown) => value;
          probe.observerWarnings = [];
          probe.testPhase = "preparing";
          window.addEventListener("error", (event) => {
            if (event.message.includes("ResizeObserver loop"))
              probe.observerWarnings.push({ phase: probe.testPhase, message: event.message });
          });
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => {
          if (!error.message.includes("ResizeObserver loop")) errors.push(error.message);
        });
        await page.goto(vite.resolvedUrls!.local[0]! + "?noOlder");
        await page.waitForFunction(() => typeof (window as any).prependBatch === "function", undefined, {
          timeout: 45000,
        });
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => {
          const probe = window as any;
          probe.complete();
          // Exported dimensions, not private message content/identifiers. The fixture
          // contributes38px per Turn. Remaining unobserved rows are synthetic.
          const heights = [
            1666.71875,
            951.40625,
            1682.6875,
            1287.8125,
            1717.25,
            1628.71875,
            913.40625,
            1644.6875,
            1249.8125,
            1679.25,
            ...Array(10).fill(146.225),
          ];
          probe.prependBatch(heights.map((height, i) => ({ id: `existing-${i}`, height })));
        });
        await page.waitForTimeout(200);
        await page.evaluate(async () => {
          const root = document.querySelector<HTMLElement>(".thread-scroll")!;
          for (let i = 0; i < 90; i++) {
            root.scrollTop -= 300;
            root.dispatchEvent(new Event("scroll"));
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
          }
        });
        for (let i = 0; i < 4; i++) {
          await page.evaluate(() => {
            const root = document.querySelector<HTMLElement>(".thread-scroll")!;
            root.scrollTop = -100000;
            root.dispatchEvent(new Event("scroll"));
          });
          await page.waitForTimeout(100);
        }
        await page.evaluate(async (enabled) => {
          const probe = window as any;
          probe.diagnosticEvents = [];
          const modulePath = "/packages/timeline-host-web/src/diagnostics.ts";
          const { setTimelineDiagnosticObserver } = await import(/* @vite-ignore */ modulePath);
          setTimelineDiagnosticObserver(
            enabled ? (kind: string, fields: unknown) => probe.diagnosticEvents.push({ kind, fields }) : undefined,
          );
        }, diagnostics);
        await page.waitForTimeout(500); // Activity sampler is idle before the commit.
        const name = `${engine.name()}-${touch ? "touch" : "pointer"}-${diagnostics ? "on" : "off"}-motion${movement}`;
        if (diagnostics && movement === 0) await page.screenshot({ path: path.join(output, name + "-before.png") });
        const result = await page.evaluate(async (movement) => {
          const probe = window as any,
            root = document.querySelector<HTMLElement>(".thread-scroll")!;
          const bounds = root.getBoundingClientRect();
          const text = [...root.querySelectorAll("p")].find((p) => {
            const r = p.getBoundingClientRect();
            return r.top > bounds.top + 56 && r.bottom < bounds.bottom - 100;
          })!;
          const spacer = () => root.querySelector<HTMLElement>(".thread-virtualizer-spacer");
          const sample = () => ({
            scrollTop: root.scrollTop,
            scrollHeight: root.scrollHeight,
            y: text.getBoundingClientRect().top,
            minHeight: spacer()?.style.minHeight ?? "",
            connected: text.isConnected,
          });
          // Model physical motion before its native scroll receipt reaches JS.
          probe.testPhase = "prepend";
          root.scrollTop += movement;
          const before = sample();
          probe.diagnosticEvents = [];
          probe.prependBatch(
            [100, 100, 100, 100, 100, 1260, 645, 149, 29, 980].map((height, i) => ({ id: `older-${i}`, height })),
          );
          const immediate = sample();
          const painted = [];
          for (let i = 0; i < 8; i++) {
            await new Promise(requestAnimationFrame);
            painted.push(sample());
          }
          return {
            before,
            immediate,
            after: sample(),
            painted,
            events: probe.diagnosticEvents,
            containerType: getComputedStyle(root).containerType,
            pageScroll: window.scrollY,
          };
        }, movement);
        if (diagnostics && movement === 0) await page.screenshot({ path: path.join(output, name + "-after.png") });
        fs.writeFileSync(path.join(output, name + ".json"), JSON.stringify(result, null, 2));
        const drift = result.after.scrollTop - result.before.scrollTop;
        assert.equal(result.containerType, "inline-size", "retain the query-container width contract");
        assert.equal(result.pageScroll, 0);
        assert.equal(result.after.connected, true);
        assert.deepEqual(errors, []);
        if (baseline && engine.name() === "webkit") {
          assert.equal(drift, 4446, "negative control must reproduce the uploaded displacement");
        } else {
          assert.ok(Math.abs(drift) <= 1, `${name}: drift=${drift}`);
          for (const sample of [result.immediate, ...result.painted]) {
            assert.ok(Math.abs(sample.scrollTop - result.before.scrollTop) <= 1);
            assert.ok(Math.abs(sample.y - result.before.y) <= 1);
            assert.equal(sample.minHeight, "", "handoff reservation must retire before paint");
          }
          assert.equal(
            result.events.filter((event: any) => event.kind === "scroll-write").length,
            0,
            "never rewind native momentum to repair a window handoff",
          );
        }
        if (touch && movement === 0) {
          assert.equal(result.before.scrollHeight, 17208);
          assert.equal(result.after.scrollHeight, 21981);
        }
        // Subsequent real shrink must not inherit a previous window's minimum.
        await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>(".thread-scroll")!;
          (window as any).testPhase = "tail";
          root.scrollTop = 0;
          root.dispatchEvent(new Event("scroll"));
        });
        await page.waitForTimeout(250);
        const shrink = await page.evaluate(async () => {
          const root = document.querySelector<HTMLElement>(".thread-scroll")!;
          (window as any).testPhase = "shrink";
          const before = root.scrollHeight;
          (window as any).resizeRow("tail", 40);
          for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
          return {
            delta: root.scrollHeight - before,
            scrollTop: root.scrollTop,
            minHeight: root.querySelector<HTMLElement>(".thread-virtualizer-spacer")?.style.minHeight ?? "",
          };
        });
        assert.equal(shrink.delta, -80);
        assert.equal(shrink.scrollTop, 0);
        assert.equal(shrink.minHeight, "");
        await page.evaluate(() => {
          (window as any).testPhase = "clear";
          (window as any).clearRows();
        });
        await page.waitForTimeout(100);
        const cleared = await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>(".thread-scroll")!;
          return { scrollTop: root.scrollTop, height: root.scrollHeight, viewport: root.clientHeight };
        });
        assert.equal(cleared.scrollTop, 0);
        assert.equal(cleared.height, cleared.viewport);
        await page.evaluate(() => (window as any).leave());
        await page.waitForTimeout(50);
        assert.deepEqual(errors, []);
        const observerWarnings = await page.evaluate(() => (window as any).observerWarnings);
        summaries.push({ name, baseline, drift, shrink, cleared, observerWarnings, errors });
        console.log(JSON.stringify(summaries.at(-1)));
        await page.close();
      }
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summaries, null, 2));
} finally {
  await browser?.close();
  await vite.close();
}
