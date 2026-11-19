import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";

const output = process.env.OPENCRAFT_TIMELINE_SCROLL_OUTPUT ?? "/tmp/opencraft-message-timeline-scroll";
await mkdir(output, { recursive: true });
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-message-timeline-scroll",
  optimizeDeps: { entries: ["tests/fixtures/message-timeline-scroll.tsx"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "timeline-scroll-fixture",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/favicon.ico") {
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/message-timeline-scroll.tsx"></script>',
          );
        });
      },
    },
  ],
});
await vite.listen();
const browser = await chromium.launch({
  executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
  args: ["--no-sandbox"],
});
const results: unknown[] = [];
try {
  for (const touch of [false, true])
    for (const theme of ["light", "dark", "frost"]) {
      if (
        process.env.OPENCRAFT_TIMELINE_SCROLL_CASE &&
        process.env.OPENCRAFT_TIMELINE_SCROLL_CASE !== `${touch ? "touch" : "desktop"}-${theme}`
      )
        continue;
      const context = await browser.newContext({
        viewport: { width: touch ? 402 : 960, height: 750 },
        hasTouch: touch,
        isMobile: touch,
      });
      await context.addInitScript(() => {
        (window as any).__name = (v: unknown) => v;
        const native = Element.prototype.scrollTo;
        (window as any).scrollWrites = [];
        Element.prototype.scrollTo = function (...args: any[]) {
          if (this.hasAttribute("data-message-timeline"))
            (window as any).scrollWrites.push({ top: this.scrollTop, target: args[0]?.top });
          return (native as any).apply(this, args);
        };
      });
      const page = await context.newPage(),
        errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?theme=${theme}`);
      await page.locator("[data-message-timeline]").waitFor({ timeout: 60000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const w = window as any;
        w.timelineFrames = [];
        w.record = true;
        w.scrollWrites = [];
        const tick = () => {
          const root = document.querySelector<HTMLElement>("[data-message-timeline]")!,
            bounds = root.getBoundingClientRect();
          w.timelineFrames.push({
            scrollTop: root.scrollTop,
            top: bounds.top,
            bottom: bounds.bottom,
            rows: [...root.querySelectorAll<HTMLElement>("[data-timeline-entry]")].map((row) => ({
              key: row.dataset.timelineEntry,
              top: row.getBoundingClientRect().top,
              height: row.offsetHeight,
            })),
          });
          if (w.record) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      if (touch) {
        const client = await context.newCDPSession(page);
        for (let gesture = 0; gesture < 28; gesture++) {
          await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 180, y: 200 }] });
          for (let step = 1; step <= 5; step++) {
            await client.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: 180, y: 200 + 85 * step }],
            });
            await page.waitForTimeout(16);
          }
          await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await page.waitForTimeout(45);
        }
      } else {
        await page.mouse.move(200, 330);
        for (let i = 0; i < 40; i++) {
          await page.mouse.wheel(0, -700);
          await page.waitForTimeout(45);
        }
      }
      await page.waitForTimeout(250);
      const frames = await page.evaluate(() => {
        (window as any).record = false;
        return (window as any).timelineFrames;
      });
      await writeFile(
        `${output}/${touch ? "touch" : "desktop"}-${theme}-frames.json`,
        JSON.stringify({ frames, writes: await page.evaluate(() => (window as any).scrollWrites) }),
      );
      let jumps = 0,
        maximumJump = 0;
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1],
          b = frames[i];
        for (const row of a.rows.filter((r: any) => r.top < a.bottom && r.top + r.height > a.top)) {
          const next = b.rows.find((r: any) => r.key === row.key);
          if (!next) continue;
          const shift = Math.abs(next.top - row.top + b.scrollTop - a.scrollTop);
          if (shift > 1) {
            jumps++;
            maximumJump = Math.max(maximumJump, shift);
          }
        }
      }
      assert(frames.at(-1).scrollTop < -4000, "exercise virtualization beyond the initial window");
      assert.equal(jumps, 0, `visible rows shifted independently of scrolling (${maximumJump}px)`);
      // A read refresh and history prepend preserve the visible message and do
      // not issue a no-op scroll command that would cancel native momentum.
      await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>("[data-message-timeline]")!;
        root.scrollTo({ top: root.scrollTop, behavior: "instant" });
      });
      // Touch momentum may still be active after scrollTo; wait for a stable native position.
      await page.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            const root = document.querySelector<HTMLElement>("[data-message-timeline]")!;
            let last = root.scrollTop,
              stable = 0;
            const start = performance.now();
            const tick = () => {
              stable = Math.abs(root.scrollTop - last) < 0.1 ? stable + 1 : 0;
              last = root.scrollTop;
              if (stable >= 12) resolve();
              else if (performance.now() - start > 5000) reject(new Error("native scroll did not settle"));
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );
      const anchor = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>("[data-message-timeline]")!;
        const row = [...root.querySelectorAll<HTMLElement>("[data-timeline-entry]")].find(
          (r) => r.getBoundingClientRect().bottom > root.getBoundingClientRect().top,
        )!;
        (window as any).scrollWrites = [];
        (window as any).refresh();
        return { key: row.dataset.timelineEntry, top: row.getBoundingClientRect().top };
      });
      await page.waitForTimeout(100);
      assert.equal(
        await page.evaluate(() => (window as any).scrollWrites.length),
        0,
        "refresh must not interrupt momentum",
      );
      await page.evaluate(() => (window as any).prepend());
      await page.waitForTimeout(200);
      const top = await page
        .locator(`[data-timeline-entry="${anchor.key}"]`)
        .evaluate((e) => e.getBoundingClientRect().top);
      assert(Math.abs(top - anchor.top) <= 1, "history prepend preserves the reading anchor");
      // iOS touch-to-stop: the platform moves before its scroll event is delivered.
      // A commit landing in between must not rewind that unreported movement.
      const unreported = await page.evaluate(async () => {
        const root = document.querySelector<HTMLElement>("[data-message-timeline]")!,
          frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
        root.scrollTop = -Math.round((root.scrollHeight - root.clientHeight) / 2);
        await frame();
        await frame();
        await frame();
        const expected = root.scrollTop - 40;
        root.scrollTop = expected;
        (window as any).refresh();
        await frame();
        await frame();
        await frame();
        return { expected, actual: root.scrollTop };
      });
      assert(
        Math.abs(unreported.actual - unreported.expected) <= 1,
        `a commit before the scroll event rewound the platform position (${unreported.actual} vs ${unreported.expected})`,
      );
      // The same movement followed by a scrollport resize (keyboard, browser chrome).
      const resized = await page.evaluate(async () => {
        const root = document.querySelector<HTMLElement>("[data-message-timeline]")!,
          section = root.closest<HTMLElement>("section")!,
          frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
        const expected = root.scrollTop - 40;
        root.scrollTop = expected;
        section.style.height = "calc(100dvh - 120px)";
        await frame();
        await frame();
        await frame();
        const actual = root.scrollTop;
        section.style.height = "100dvh";
        await frame();
        await frame();
        return { expected, actual };
      });
      assert(
        Math.abs(resized.actual - resized.expected) <= 1,
        `a viewport resize rewound the platform position (${resized.actual} vs ${resized.expected})`,
      );
      await page.screenshot({ path: output + "/" + (touch ? "touch" : "desktop") + "-" + theme + "-reading.png" });
      await page.getByRole("button", { name: "Back to latest" }).click();
      await page.waitForFunction(() => Math.abs(document.querySelector("[data-message-timeline]")!.scrollTop) < 1);
      assert.equal(
        await page.getByRole("button", { name: "Back to latest" }).count(),
        0,
        "latest action leaves tab/accessibility order at bottom",
      );
      const geometry = await page.evaluate(() => {
        const root = document.querySelector("[data-message-timeline]")!,
          dock = document.querySelector(".message-timeline-dock")!,
          shell = document.querySelector(".opencraft-composer-shell")!;
        return {
          bottom: root.getBoundingClientRect().bottom,
          dockTop: dock.getBoundingClientRect().top,
          material: getComputedStyle(shell, "::before").backdropFilter,
        };
      });
      assert(geometry.dockTop < geometry.bottom, "dock overlays the same reading surface");
      if (touch) assert.notEqual(geometry.material, "none", "touch composer retains shared material");
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-${theme}.png` });
      results.push({ touch, theme, passed: true, frames: frames.length, jumps, maximumJump });
      await context.close();
    }
  await writeFile(`${output}/browser-results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
  await vite.close();
}
