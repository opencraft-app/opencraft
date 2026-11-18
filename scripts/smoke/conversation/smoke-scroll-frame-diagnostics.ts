import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";

const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/scroll-frame-diagnostics";
const engine = process.env.OPENCRAFT_DIAGNOSTICS_ENGINE === "webkit" ? webkit : chromium;
fs.mkdirSync(output, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-scroll-frame-diagnostics", esbuild: { jsx: "automatic" },
  optimizeDeps: { entries: ["tests/fixtures/conversation-scroll-diagnostics.tsx"] },
  server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{
    name: "diagnostic-fixture", configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] !== "/") return next();
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-scroll-diagnostics.tsx"></script>');
    }); },
  }] });
let browser;
const results = [];
try {
  await vite.listen(); browser = await engine.launch({ headless: true });
  for (const touch of [true, false]) {
    const context = await browser.newContext({ viewport: { width: touch ? 402 : 1100, height: 750 }, hasTouch: touch, isMobile: touch });
    await context.addInitScript(() => {
      const w = window as any; w.__name = (value: unknown) => value;
      w.rangeReads = 0; w.caretReads = 0;
      const measure = Range.prototype.getBoundingClientRect;
      Range.prototype.getBoundingClientRect = function () { w.rangeReads++; return measure.call(this); };
      for (const name of ["caretRangeFromPoint", "caretPositionFromPoint"]) {
        const method = (document as any)[name];
        if (method) (document as any)[name] = function (...args: any[]) { w.caretReads++; return method.apply(this, args); };
      }
    });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => { if (!error.message.includes("ResizeObserver loop")) errors.push(error.message); });
    await page.goto(vite.resolvedUrls!.local[0]! + "?natural&longHistory");
    await page.waitForFunction(() => (window as any).owner && (window as any).captureDiagnostics);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      const w = window as any;
      // Actual text lines inside existing fixed-height blocks; no networking,
      // provider or additional scroll owner is substituted.
      for (const block of document.querySelectorAll<HTMLElement>("[data-probe]")) {
        block.replaceChildren();
        for (let i = 0; i < 18; i++) {
          const p = document.createElement("p"); p.textContent = `Private fixture paragraph ${i}`;
          p.style.cssText = "margin:0;line-height:24px"; block.append(p);
        }
      }
      w.owner.scrollController.scrollToDistanceFromBottomPx(2000, "instant", "user");
    });
    await page.waitForTimeout(400);
    const off = await page.evaluate(async () => {
      const w = window as any, root = document.querySelector<HTMLElement>(".thread-scroll")!;
      const start = { range: w.rangeReads, caret: w.caretReads };
      for (let i = 0; i < 12; i++) {
        root.scrollTop -= 2; await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      return { reads: { range: w.rangeReads - start.range, caret: w.caretReads - start.caret }, report: w.captureDiagnostics(),
        frameModuleRequests: performance.getEntriesByType("resource").filter(entry => entry.name.includes("/scroll-frame-diagnostics.ts")).length };
    });
    assert.deepEqual(off.reads, { range: 0, caret: 0 }, "off must not even measure text");
    assert.equal(off.frameModuleRequests, 0, "off must not load the optional sampler module");
    assert.equal(off.report.frames.samples.length, 0); assert.equal(off.report.samples.length, 0);
    await page.evaluate(() => (window as any).setDiagnostics(true));
    await page.waitForTimeout(80);
    const motion = await page.evaluate(async () => {
      const w = window as any, root = document.querySelector<HTMLElement>(".thread-scroll")!;
      const selection = getSelection();
      const beforeSelection = selection?.rangeCount;
      for (let i = 0; i < 20; i++) {
        root.scrollTop -= 4; await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      return { report: w.captureDiagnostics(), rangeReads: w.rangeReads, caretReads: w.caretReads,
        beforeSelection, afterSelection: getSelection()?.rangeCount };
    });
    const stable = motion.report.frames.samples.filter((sample: any) => sample.fields.sameAnchor && sample.fields.scrollDelta < 0);
    assert.ok(stable.length >= 2, "real visible text must be tracked across physical movement");
    assert.ok(stable.every((sample: any) => Math.abs(sample.fields.layoutDelta) < 1), "physical movement is not text reflow");
    assert.ok(motion.rangeReads > 0 && motion.caretReads > 0);
    assert.equal(motion.beforeSelection, motion.afterSelection, "read-only ranges must not change the selection");
    // Ensure an active point precedes the controlled text-only movement.
    await page.evaluate(() => document.querySelector(".thread-scroll")!.dispatchEvent(new Event("scroll")));
    await page.waitForTimeout(50);
    const beforeShift = await page.evaluate(() => document.querySelector<HTMLElement>(".thread-scroll")!.scrollTop);
    await page.evaluate(() => {
      for (const p of document.querySelectorAll<HTMLElement>("[data-probe] > p")) p.style.transform = "translateY(30px)";
    });
    await page.waitForTimeout(60);
    const shifted = await page.evaluate(() => ({ report: (window as any).captureDiagnostics(), scrollTop: document.querySelector<HTMLElement>(".thread-scroll")!.scrollTop }));
    assert.ok(shifted.report.frames.samples.some((sample: any) => sample.fields.textShift && Math.abs(sample.fields.layoutDelta - 30) < 1), "text movement must be observable even without scrollTop changing");
    assert.equal(shifted.scrollTop, beforeShift, "diagnostics cannot compensate the position");
    await page.evaluate(() => { const end = performance.now() + 90; while (performance.now() < end) { /* test-only main-thread stall */ } });
    await page.waitForTimeout(60);
    const delayed = await page.evaluate(() => (window as any).captureDiagnostics());
    assert.ok(delayed.frames.samples.some((sample: any) => sample.fields.frameGap && sample.fields.frameMs > 50));
    assert.ok(!JSON.stringify(delayed).includes("Private fixture paragraph"), "export contains geometry, not message content");
    assert.ok(delayed.bytes <= delayed.byteLimit);
    await page.evaluate(() => (window as any).setDiagnostics(false));
    const stopped = await page.evaluate(() => ({ report: (window as any).captureDiagnostics(), rangeReads: (window as any).rangeReads, caretReads: (window as any).caretReads }));
    await page.evaluate(async () => {
      const root = document.querySelector<HTMLElement>(".thread-scroll")!;
      for (let i = 0; i < 12; i++) { root.scrollTop -= 2; await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
    });
    const frozen = await page.evaluate(() => ({ report: (window as any).captureDiagnostics(), rangeReads: (window as any).rangeReads, caretReads: (window as any).caretReads }));
    assert.deepEqual(frozen, stopped, "off must detach activity listeners, freeze evidence and stop text reads");
    await page.evaluate(() => (window as any).setDiagnostics(true));
    await page.waitForTimeout(50);
    const fresh = await page.evaluate(() => (window as any).captureDiagnostics());
    assert.equal(fresh.frames.samples[0]!.fields.frameMs, null);
    assert.equal(fresh.frames.samples[0]!.fields.sameAnchor, false);
    await page.evaluate(() => (window as any).unmount()); await page.waitForTimeout(100);
    const retired = await page.evaluate(() => ({ report: (window as any).captureDiagnostics(), reads: (window as any).rangeReads }));
    await page.waitForTimeout(100);
    const retiredAgain = await page.evaluate(() => ({ report: (window as any).captureDiagnostics(), reads: (window as any).rangeReads }));
    assert.equal(retiredAgain.reads, retired.reads);
    assert.deepEqual(retiredAgain.report.frames, retired.report.frames);
    assert.deepEqual(errors, []);
    const result = { engine: engine.name(), touch, off: off.reads, stableFrames: stable.length, delayed,
      disabledFrozen: true, freshSession: fresh.session, retiredFrozen: true, errors };
    results.push(result);
    fs.writeFileSync(path.join(output, `${engine.name()}-${touch ? "touch" : "pointer"}.json`), JSON.stringify(result, null, 2));
    await context.close();
  }
  console.log(JSON.stringify(results.map(({ delayed, ...rest }) => ({ ...rest, frames: delayed.frames.samples.length }))));
} finally { await browser?.close(); await vite.close(); }
