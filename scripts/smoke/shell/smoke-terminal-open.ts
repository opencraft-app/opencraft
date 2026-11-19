import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/terminal-open";
await mkdir(output, { recursive: true });
const negative = process.env.OPENCRAFT_TERMINAL_OPEN_NEGATIVE === "1";
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-terminal-keyboard",
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "terminal-open",
      enforce: "pre",
      transform(code, id) {
        if (!negative || !id.endsWith("/plugins/terminal/src/index.tsx")) return;
        const next = code
          .replace(
            "useLayoutEffect(() => {\n      if (overviewPreview)",
            "useEffect(() => {\n      if (overviewPreview)",
          )
          .replace(
            "          fitAndPublish();\n          if (readyRef.current",
            "          scheduleFit();\n          if (readyRef.current",
          )
          .replace("(!activeRef.current && !previewRef.current && !readyRef.current)", "!activeRef.current")
          .replace(/\s*presentationReadiness: "renderer",/, "");
        assert.notEqual(next, code, "negative control must restore deferred activation fitting");
        return next;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/?")) return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/terminal-keyboard.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
const reports = [];
const variants = [
  { width: 402, placement: "atomic", motion: "no-preference", theme: "light" },
  { width: 402, placement: "popover", motion: "no-preference", theme: "dark" },
  { width: 320, placement: "popover", motion: "reduce", theme: "light" },
  { width: 600, placement: "atomic", motion: "reduce", theme: "dark" },
] as const;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const variant of negative ? variants.slice(0, 1) : variants) {
    const context = await browser.newContext({
      viewport: { width: variant.width, height: 690 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: variant.motion,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript((placement) => {
      (window as any).__name = (v: unknown) => v;
      if (placement === "popover")
        Object.defineProperty(Element.prototype, "moveBefore", { value: undefined, configurable: true });
      document.addEventListener("DOMContentLoaded", () => (document.documentElement.dataset.uiDensity = "touch"));
    }, variant.placement);
    await page.goto(vite.resolvedUrls!.local[0] + "?gesture&cold-overview");
    await page.locator('[data-testid="composer-panel-toggle"]').waitFor();
    await page.evaluate((theme) => (window as any).fixture.setThemePreference(theme), variant.theme);
    assert.equal(
      await page.locator(".xterm").count(),
      0,
      "inactive restored terminal does not initialize before its preview",
    );
    await page.locator('[data-testid="composer-panel-toggle"]').click();
    const host = page.locator(".terminal-panel__host");
    await host.locator(".xterm-screen").waitFor();
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    const terminal = await host.locator(".xterm").elementHandle();
    assert.deepEqual(
      await page.evaluate(() => (window as any).fixture.sizes),
      [],
      "overview never publishes PTY geometry",
    );
    if (!negative && variant.width === 402 && variant.placement === "atomic") {
      await page.locator('.panel-overview-card[data-tab-kind="terminal"] .ui-object-title-button').tap();
      await page.waitForFunction(() => document.querySelector('[data-overview-phase="preparing"]'));
      await page.keyboard.press("Escape");
      await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
      assert.deepEqual(
        await page.evaluate(() => (window as any).fixture.sizes),
        [],
        "cancelled preparation never resizes the PTY",
      );
      await page.locator('[data-testid="composer-panel-toggle"]').click();
      await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    }
    await page.evaluate(() => {
      const w = window as any;
      w.openSamples = [];
      w.recordOpen = true;
      const start = performance.now();
      const read = () => {
        if (!w.recordOpen) return;
        const host = document.querySelector<HTMLElement>(".terminal-panel__host"),
          rows = host?.querySelector<HTMLElement>(".xterm-rows"),
          viewport = host?.querySelector<HTMLElement>(".xterm-viewport");
        w.openSamples.push({
          t: Math.round(performance.now() - start),
          phase: document.querySelector("[data-overview-phase]")?.getAttribute("data-overview-phase"),
          preview: !!host?.closest('[data-retained-preview="true"]'),
          modal: !!document.querySelector(".panel-mobile-sheet--tabs"),
          rows: rows?.children.length,
          top: rows?.firstElementChild?.textContent,
          scroll: viewport?.scrollTop,
          grid: w.fixture.sizes.at(-1) ?? null,
          focus: document.activeElement?.className,
        });
        requestAnimationFrame(read);
      };
      read();
    });
    await page.locator('.panel-overview-card[data-tab-kind="terminal"] .ui-object-title-button').tap();
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    await page.waitForFunction(() => {
      const samples = (window as any).openSamples.filter((s: any) => !s.preview && !s.modal);
      return samples.length >= 6 && samples.at(-1).t - samples[0].t >= 200;
    });
    const samples = await page.evaluate(() => {
      const w = window as any;
      w.recordOpen = false;
      return w.openSamples;
    });
    const visible = samples.filter((s) => !s.preview && !s.modal);
    assert(visible.length > 2);
    const stale = visible.filter((s) => !s.grid || s.rows !== s.grid.rows);
    if (negative) {
      assert(stale.length > 0, "old deferred fitting must expose a stale 24-row grid");
      reports.push({ negative: true, staleFrames: stale, samples });
      await context.close();
      continue;
    }
    assert.deepEqual(stale, [], "first interactive frame already has its final terminal grid");
    const opening = samples.filter((s) => s.phase === "exiting" || (!s.preview && !s.modal));
    assert(
      opening.every((s) => s.rows === visible.at(-1).rows),
      "terminal grid is stable through the actual expansion",
    );
    assert(
      opening.every((s) => s.top === visible.at(-1).top),
      "opening does not jump between history lines after handback: " + JSON.stringify(visible),
    );
    assert(
      visible.every((s) => s.focus !== "xterm-helper-textarea"),
      "overview activation does not reopen the keyboard",
    );
    assert.equal(
      await page.evaluate(() => (window as any).fixture.sizes.length),
      1,
      "one authoritative activation resize",
    );
    assert.equal(await page.evaluate(() => (window as any).fixture.writes.length), 0);
    assert(
      await host.locator(".xterm-viewport").evaluate((n) => n.scrollHeight - n.clientHeight - n.scrollTop < 18),
      "a terminal following output still follows its tail",
    );
    await page.screenshot({
      path: output + "/" + variant.width + "-" + variant.placement + "-" + variant.motion + ".png",
    });
    // Returning to a previously read position keeps the same terminal and history.
    const viewport = host.locator(".xterm-viewport");
    await viewport.evaluate((n) => (n.scrollTop = n.scrollHeight / 3));
    await page.waitForTimeout(80);
    const reading = await viewport.evaluate((n) => n.scrollTop);
    const top = await host.locator(".xterm-rows > :first-child").textContent();
    await page.locator(".panel-mobile-dock__tabs").click();
    await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
    await page.locator('.panel-overview-card[data-tab-kind="terminal"] .ui-object-title-button').tap();
    await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
    await page.waitForTimeout(100);
    assert(
      Math.abs((await viewport.evaluate((n) => n.scrollTop)) - reading) < 18,
      "history returns to its anchored row, allowing native row alignment",
    );
    assert.equal(await host.locator(".xterm-rows > :first-child").textContent(), top);
    assert(await host.locator(".xterm").evaluate((n, old) => n === old, terminal));
    assert.equal(await page.evaluate(() => (window as any).fixture.sizes.length), 1);
    if (variant.width === 402 && variant.placement === "popover") {
      await page.evaluate(() => (window as any).fixture.emit("\x1b[?1049h\x1b[?1000h\x1b[2J\x1b[HAlternate screen"));
      await page.waitForFunction(
        () => document.querySelector(".terminal-panel__host")?.getAttribute("data-sidebar-gesture") === "ignore",
      );
      await page.locator(".panel-mobile-dock__tabs").click();
      await page.waitForFunction(() => !document.querySelector("[data-overview-phase]"));
      await page.locator('.panel-overview-card[data-tab-kind="terminal"] .ui-object-title-button').tap();
      await page.locator(".panel-mobile-sheet--tabs").waitFor({ state: "hidden" });
      assert((await host.locator(".xterm-rows").innerText()).includes("Alternate screen"));
      assert.equal(
        await page.evaluate(() => (window as any).fixture.writes.length),
        0,
        "alternate-screen preparation sends no key/mouse input",
      );
    }
    assert.deepEqual(errors, []);
    reports.push({
      ...variant,
      firstInteractiveGrid: true,
      noPostOpenJump: true,
      previewDoesNotResize: true,
      historyAndTerminalRetained: true,
      samples,
    });
    await context.close();
  }
  await writeFile(output + "/report.json", JSON.stringify(reports, null, 2));
  console.log(JSON.stringify({ ok: true, negative, reports: reports.map(({ samples, ...r }) => r) }));
} finally {
  await browser?.close();
  await vite.close();
}
