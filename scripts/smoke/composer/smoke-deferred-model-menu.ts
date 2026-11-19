import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

const output = process.env.OPENCRAFT_DEFERRED_MENU_OUTPUT ?? "/tmp/opencraft-deferred-model-menu";
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  optimizeDeps: { entries: ["tests/fixtures/composer-model-browser.tsx"] },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-deferred-model-menu", esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "deferred-model-menu-fixture", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== "/" && !req.url?.startsWith("/?")) return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="width:min(700px,calc(100vw - 32px));margin:520px auto 20px"></div><script type="module" src="/tests/fixtures/composer-model-browser.tsx"></script>');
    });
  } }] });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const base = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1200, height: 900 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    let requested = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(/composer-model-menu\.tsx(?:\?.*)?$/, async route => { requested = true; await gate; await route.continue(); });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.evaluate(theme => (window as unknown as { modelBrowserFixture: { setThemePreference(value: string): void } }).modelBrowserFixture.setThemePreference(theme), theme);
    const editor = page.locator(".opencraft-composer-editor"), trigger = page.locator(".opencraft-composer-mode--intelligence");
    const menu = page.locator(".opencraft-composer-model-browser-surface");
    const draft = "Keep my draft while model tools load";
    await editor.fill(draft);
    const originalEditor = await editor.elementHandle();
    assert.equal(requested, false, "ordinary composing does not fetch model browsing");
    const response = page.waitForResponse(value => /composer-model-menu\.tsx(?:\?.*)?$/.test(value.url()));
    const open = async () => { if (touch) await trigger.tap(); else { await trigger.focus(); await page.keyboard.press("Enter"); } };
    try {
      await open(); await menu.locator('.deferred-view[role="status"]').waitFor();
      assert.equal(await editor.innerText(), draft);
      await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" }); await editor.focus();
    } finally { release(); }
    await response;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await menu.count(), 0, "late loading cannot reopen a dismissed picker");
    assert.equal(await editor.evaluate(el => el === document.activeElement), true, "late loading cannot take editor focus");
    await open(); await menu.getByRole("searchbox").waitFor();
    assert.equal(await editor.evaluate((el, original) => el === original, originalEditor), true, "editor identity survives loading");
    assert.equal(await editor.innerText(), draft);
    if (touch) assert.equal(await editor.evaluate(el => el === document.activeElement), true, "touch preserves the editing lease");
    else assert.equal(await menu.getByRole("searchbox").evaluate(el => el === document.activeElement), true, "keyboard focuses the loaded search");
    const model = menu.getByRole("menuitem", { name: "Model One", exact: true });
    if (touch) await model.tap(); else await model.click();
    const slider = menu.getByRole("slider", { name: "Reasoning", exact: true }); await slider.waitFor();
    if (touch) { const box = await slider.boundingBox(); assert.ok(box && box.height > 0); }
    else { await slider.focus(); await page.keyboard.press("End"); }
    assert.equal(await menu.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), true);
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-${theme}.png` });
    await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
    assert.equal(await editor.innerText(), draft);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ touch, theme, delayedImport: true, cancelledImport: true, draftPreserved: true, modelAndReasoningReady: true }));
    await context.close();
  }
} finally { await browser?.close(); await vite.close(); }
