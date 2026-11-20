import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";

const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/history-commit";
const baseline = process.env.OPENCRAFT_HISTORY_BASELINE === "1";
const engine = process.env.OPENCRAFT_HISTORY_ENGINE === "webkit" ? webkit : chromium;
fs.mkdirSync(output, { recursive: true });
// Only the existing natural-flow layout contract is needed for this isolated
// commit test. Full Conversation behavior is checked by the momentum/diagnostic
// smokes; these fixed dimensions reproduce the recorded intermediate clamp.
const css = `
* { box-sizing: border-box; } body { margin: 0; }
.thread-scroll { height: 690px; display: flex; flex-direction: column-reverse;
  overflow: auto; overflow-anchor: none; overscroll-behavior: none; }
.thread-scroll-surface { position: relative; flex: none; min-height: 100%;
  padding-top: 176px; display: flex; flex-direction: column; }
.thread-content { display: flex; min-height: 0; flex: 1 0 auto;
  flex-direction: column; padding-bottom: 32px; }
.thread-virtualizer-spacer { position: relative; min-height: 1px; flex: none; }
.thread-virtualizer-window { display: flex; flex-direction: column; }
.thread-virtualizer-row { min-width: 0; flex: none; }
p { margin: 0; height: 22px; }
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: `node_modules/.vite-history-commit-${baseline ? "baseline" : "fixed"}`,
  optimizeDeps: { entries: ["tests/fixtures/conversation-history-commit.tsx"] },
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "history-commit", enforce: "pre", load(id) {
    const file = "packages/timeline-host-web/src/conversation-viewport-owner.ts";
    if (baseline && id.split("?")[0]!.endsWith("/" + file))
      return execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" });
    return null;
  }, configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] !== "/") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script type="module" src="/tests/fixtures/conversation-history-commit.tsx"></script>`);
    });
  } }],
});
let browser;
try {
  await vite.listen(); browser = await engine.launch({ headless: true });
  const summaries = [];
  for (const touch of [true, false]) for (const diagnostics of [false, true]) for (const unreportedMovement of [0, 40]) {
    const page = await browser.newPage({ viewport: { width: touch ? 402 : 1100, height: 750 }, hasTouch: touch, isMobile: touch });
    await page.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
    const errors: string[] = [];
    page.on("pageerror", error => { if (!error.message.includes("ResizeObserver loop")) errors.push(error.message); });
    await page.goto(vite.resolvedUrls!.local[0]!);
    await page.waitForFunction(() => (window as any).api, undefined, { timeout: 15000 });
    const result = await page.evaluate(async ({ diagnostics, unreportedMovement }) => {
      const probe = window as any, owner = probe.owner, root = owner.scrollElementRef.current as HTMLElement;
      const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      probe.setDiagnostics(diagnostics);
      for (let i = 0; i < 65; i++) { root.scrollTop -= 250; await frame(); await frame(); }
      // Let the activity-bounded sampler go idle, matching a reader waiting
      // for the next page. It must not decide whether the commit is safe.
      for (let i = 0; i < 25; i++) await frame();
      owner.captureReadingAnchor(owner.measureMountedTurns());
      const bounds = root.getBoundingClientRect();
      const text = [...root.querySelectorAll("p")].find(p => {
        const rect = p.getBoundingClientRect(); return rect.top > bounds.top + 180 && rect.bottom < bounds.bottom;
      })!;
      const sample = () => ({ scrollTop: root.scrollTop, scrollHeight: root.scrollHeight,
        textTop: text.getBoundingClientRect().top, mounted: [...owner.turnElementsRef.current.keys()] });
      const anchorText = text.textContent;
      // Model physical movement before its native scroll receipt reaches JS.
      // Correcting a layout must not rewind this legitimate user movement.
      root.scrollTop += unreportedMovement;
      const before = sample(); probe.events = [];
      probe.prependHistory(); const immediate = sample();
      for (let i = 0; i < 8; i++) await frame();
      return { diagnostics, before, immediate, after: sample(), sameText: text.isConnected && text.textContent === anchorText,
        events: probe.events };
    }, { diagnostics, unreportedMovement });
    const name = `${engine.name()}-${touch ? "touch" : "pointer"}-${diagnostics ? "on" : "off"}-motion${unreportedMovement}`;
    fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(result, null, 2));
    const drift = result.after.scrollTop - result.before.scrollTop;
    const textDrift = result.after.textTop - result.before.textTop;
    assert.ok(result.before.mounted.length >= 9, "replace a wide previously mounted window, not just append new rows");
    assert.ok(result.after.scrollHeight > result.before.scrollHeight + 5000, "grow estimated historical rows substantially");
    assert.ok(result.sameText, "the original visible paragraph must survive the history transaction");
    if (baseline && diagnostics) {
      assert.ok(drift > 1900 && drift < 2100, `old diagnostic must reproduce the recorded ~2028px native clamp: ${drift}`);
    } else {
      assert.ok(Math.abs(drift) <= 1, `${name}: native position moved by ${drift}px`);
      assert.ok(Math.abs(textDrift) <= 1, `${name}: visible reading text moved by ${textDrift}px`);
      assert.ok(Math.abs(result.immediate.scrollTop - result.before.scrollTop) <= 1, "no transient native clamp before paint");
      const writes = result.events.filter((event: any) => event.kind === "scroll-write");
      assert.equal(writes.length, 0, "a prepend needs no restoration write that could interrupt momentum");
    }
    assert.deepEqual(errors, []);
    summaries.push({ name, baseline, drift, textDrift, sameText: result.sameText, errors });
    await page.close();
  }
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summaries, null, 2));
  console.log(JSON.stringify(summaries));
} finally { await browser?.close(); await vite.close(); }
