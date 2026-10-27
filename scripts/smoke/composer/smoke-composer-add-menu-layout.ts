import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium, webkit } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const webkitMode = process.env.OPENCRAFT_SMOKE_ENGINE === "webkit";
const before = process.argv.includes("--record-before");
const durationOnly = process.argv.includes("--touch-duration-only");
const reopenOnly = process.argv.includes("--reopen-only");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/composer-add-menu";
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", cacheDir: `node_modules/.vite-add-menu-${webkitMode ? "webkit" : "chromium"}`, esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, optimizeDeps: { entries: ["tests/fixtures/touch-newera.tsx"] }, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "add-menu-layout", configureServer(server) { server.middlewares.use((req, res, next) => {
  if (!req.url?.startsWith("/?")) return next();
  res.setHeader("content-type", "text/html");
  res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/touch-newera.tsx"></script>');
}); } }] });
await vite.listen();
const browser = await (webkitMode ? webkit : chromium).launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: webkitMode ? [] : ["--no-sandbox"] });
const evidence: unknown[] = [];
const cases = reopenOnly ? [true, false].flatMap(touch => ["light", "dark"].map(mode => ({ width: touch ? 390 : 1280, touch, newera: true, mode, palette: "neutral", reduce: false }))) : durationOnly ? ["light", "dark"].map(mode => ({ width: 320, touch: true, newera: true, mode, palette: "neutral", reduce: false })) : before ? [{ width: 390, touch: true, newera: true, mode: "light", palette: "neutral", reduce: false }] : [
  ...[320, 390, 430].flatMap(width => ["light", "dark"].map(mode => ({ width, touch: true, newera: true, mode, palette: "neutral", reduce: false }))),
  ...["light", "dark"].flatMap(mode => [
    { width: 1280, touch: false, newera: true, mode, palette: "neutral", reduce: false },
    { width: 390, touch: true, newera: false, mode, palette: "neutral", reduce: false },
    { width: 390, touch: true, newera: true, mode, palette: "neutral", reduce: true },
    { width: 390, touch: true, newera: true, mode, palette: "lavender", reduce: false },
  ]),
];
try {
  for (const test of cases) {
    const label = Object.values(test).join("-");
    if (reopenOnly) console.log("CASE Add reopen", label);
    const context = await browser.newContext({ viewport: { width: test.width, height: 844 }, hasTouch: test.touch, isMobile: test.touch, reducedMotion: test.reduce ? "reduce" : "no-preference" });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    if (reopenOnly) await page.addInitScript(() => {
      const original = window.setTimeout.bind(window);
      (window as any).heldCloseFocus = [];
      (window as any).holdCloseFocus = false;
      (window as any).setTimeout = (callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if ((window as any).holdCloseFocus && typeof callback === "function" && String(callback).includes("onUnmountAutoFocus")) {
          (window as any).heldCloseFocus.push(() => callback(...args));
          return original(() => {}, 0);
        }
        return original(callback, delay, ...args);
      };
    });
    await page.goto(`${vite.resolvedUrls!.local[0]}?addMenu&pickerFocus&mode=${test.mode}&palette=${test.palette}`);
    await page.waitForFunction(() => typeof (window as any).setTouch === "function");
    await page.evaluate(async ({ touch, newera }) => { await (window as any).setTouch(touch && newera); }, test);
    const editor = page.locator(".opencraft-composer-editor"), shell = page.locator(".opencraft-composer-shell");
    const add = page.locator(".opencraft-composer-footer__attachment > button").first();
    const menu = page.locator(".opencraft-composer-add-menu"), outside = page.getByLabel("Outside input");
    const activate = async (target: any) => test.touch ? target.tap() : target.click();
    if (reopenOnly) {
      await outside.focus();
      await editor.evaluate(el => (window as any).keptEditor = el);
      const open = async () => { await activate(add); await menu.waitFor(); };
      await open();
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      assert.equal(await add.getAttribute("data-state"), "open", "window blur is not an outside Add contact");
      await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
      await open();
      // No grace period: a contact after blur still closes in the same task.
      await page.evaluate(() => {
        window.dispatchEvent(new Event("blur"));
        const surface = document.querySelector("[data-menu-dismiss-surface]")!;
        surface.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 31, isPrimary: true, button: 0 }));
        surface.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      });
      await menu.waitFor({ state: "hidden" });
      // Touch opens on release; retain Radix's existing eager mouse behavior
      // after its old exit surface has gone away.
      for (const delay of test.touch ? [0, 50, 80, 100, 120, 250] : [150]) {
        await open();
        const chooser = page.waitForEvent("filechooser");
        await activate(menu.getByText("添加附件", { exact: true })); await chooser;
        if (!test.touch) await menu.waitFor({ state: "hidden" });
        await page.waitForTimeout(delay);
        const bounds = (await add.boundingBox())!;
        if (test.touch) await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        else await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await menu.waitFor(); await page.waitForTimeout(180);
        assert.equal(await add.getAttribute("data-state"), "open", `reopen after ${delay}ms remains open`);
        await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
      }
      await open();
      await page.evaluate(() => { (window as any).holdCloseFocus = true; });
      const chooser = page.waitForEvent("filechooser");
      await activate(menu.getByText("添加附件", { exact: true })); await chooser;
      await page.waitForFunction(() => (window as any).heldCloseFocus.length > 0);
      await open();
      await page.evaluate(() => {
        (window as any).holdCloseFocus = false;
        for (const callback of (window as any).heldCloseFocus.splice(0)) callback();
      });
      await page.waitForTimeout(180);
      assert.equal(await add.getAttribute("data-state"), "open", "old menu cleanup cannot close a reopened menu");
      await page.screenshot({ path: `${output}/${label}-reopened.png` });
      const outsideBounds = (await outside.boundingBox())!;
      if (test.touch) await page.touchscreen.tap(outsideBounds.x + 10, outsideBounds.y + 10);
      else await page.mouse.click(outsideBounds.x + 10, outsideBounds.y + 10);
      await menu.waitFor({ state: "hidden" });
      await open();
      await activate(menu.getByText("连接器", { exact: true }));
      await activate(page.getByRole("menuitem", { name: "Fixture connector", exact: true }));
      await menu.waitFor({ state: "hidden" });
      await editor.fill("Menu continuity draft");
      await activate(page.locator(".opencraft-composer-mode--permissions"));
      await page.locator('[role="menu"]').waitFor();
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.locator('[role="menu"]').waitFor({ state: "hidden" });
      assert(await editor.evaluate(el => el === (window as any).keptEditor), "original editor retained");
      assert.equal(await editor.innerText(), "Menu continuity draft");
      assert.deepEqual(errors, []);
      evidence.push({ label, reopenPassed: true, windowBlurPassed: true, staleFocusPassed: true });
      console.log("PASS Add reopen/blur/focus ownership", label); await context.close(); continue;
    }
    if (!before && test.width === 320 && !webkitMode) {
      const cdp = await context.newCDPSession(page);
      const box = (await add.boundingBox())!;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await page.waitForTimeout(650);
      assert.equal(await menu.count(), 0, "held contact alone cannot open Add");
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await menu.waitFor();
      assert.equal(await menu.count(), 1, "a native click after a deliberate press opens Add once");
      if (durationOnly) await page.screenshot({ path: `${output}/${label}-duration-open.png` });
      await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
      for (const drift of [11, 13]) {
        const bounds = (await add.boundingBox())!;
        const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, x: point.x + drift }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await menu.waitFor(); assert.equal(await menu.count(), 1, "browser-accepted finger drift opens add once");
        await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
      }
      await cdp.detach();
    }
    if (durationOnly) {
      await page.screenshot({ path: `${output}/${label}-duration.png` });
      assert.deepEqual(errors, []); evidence.push({ label, durationTouchPassed: true });
      console.log("PASS completed native Add press", label); await context.close(); continue;
    }
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await outside.focus(); await settle();
    await editor.evaluate(el => (window as any).keptEditor = el);
    const initial = await shell.boundingBox(), anchor = await add.boundingBox(); assert(initial && anchor);
    const stable = async () => { await settle(); assert.deepEqual(await shell.boundingBox(), initial, `${label}: empty auxiliary menu must not resize composer`); assert.deepEqual(await add.boundingBox(), anchor, `${label}: menu anchor must not move`); };
    await activate(add); await menu.waitFor(); await settle();
    const opened = await shell.boundingBox();
    if (before) {
      assert(opened && opened.height > initial.height + 20, "baseline must reproduce empty Add expanding two rows");
      await page.screenshot({ path: `${output}/before.png` });
      evidence.push({ label, initial, opened, reproduced: true }); await context.close(); continue;
    }
    await stable();
    await activate(menu.getByText("连接器", { exact: true }));
    await page.getByRole("menuitem", { name: "Fixture connector", exact: true }).waitFor(); await stable();
    await page.keyboard.press("Escape"); await stable();
    await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" }); await stable();
    assert(await add.evaluate(el => el === document.activeElement), "Escape restores the original Add trigger");
    await add.focus(); await page.keyboard.press("Enter"); await menu.waitFor(); await stable();
    assert(await menu.evaluate(el => el.contains(document.activeElement)), "Radix retains keyboard menu focus");
    await page.keyboard.press("ArrowDown"); await stable();
    await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" }); await stable();
    await activate(add); await menu.waitFor(); await activate(outside); await menu.waitFor({ state: "hidden" }); await stable();
    // Existing dialog continuation runs after close; cleanup must not steal its focus.
    await activate(add); await menu.waitFor(); await activate(menu.getByText("设定持续目标", { exact: true }));
    await menu.waitFor({ state: "hidden" }); await stable();
    assert(await outside.evaluate(el => el === document.activeElement));
    // Empty editor focus stays compact; actual draft content owns expansion.
    await editor.focus(); await page.waitForTimeout(220);
    const editing = await shell.boundingBox(); assert(editing);
    assert.deepEqual(editing, initial);
    await activate(add); await menu.waitFor(); await settle(); assert.deepEqual(await shell.boundingBox(), editing);
    await activate(menu.getByText("连接器", { exact: true })); await page.getByRole("menuitem", { name: "Fixture connector", exact: true }).waitFor();
    assert.deepEqual(await shell.boundingBox(), editing, "nested menu retains the existing editing session");
    await activate(outside); await menu.waitFor({ state: "hidden" }); await stable();
    // An old edit must not make a later Add opening expand again.
    await activate(add); await menu.waitFor(); await stable(); await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" }); await stable();
    await editor.fill("保留当前草稿"); await page.waitForTimeout(220);
    await editor.evaluate(el => { const text = el.querySelector("p")!.firstChild!; const range = document.createRange(); range.setStart(text, 2); range.collapse(true); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
    const draft = await shell.boundingBox(); await activate(add); await menu.waitFor(); await settle(); assert.deepEqual(await shell.boundingBox(), draft);
    await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
    assert.equal(await editor.innerText(), "保留当前草稿");
    assert.equal(await editor.evaluate(el => el === (window as any).keptEditor), true);
    await editor.fill(""); await outside.focus(); await settle(); await stable();
    await activate(add); await menu.waitFor(); await stable();
    if (test.width === 390 && test.newera && !test.reduce) await page.screenshot({ path: `${output}/${label}.png` });
    await page.keyboard.press("Escape"); assert.deepEqual(errors, []);
    evidence.push({ label, initial, opened, editing, editorRetained: true, errors });
    console.log("PASS", label); await context.close();
  }
  await writeFile(`${output}/${before ? "before" : "after"}.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ baseline: before, cases: evidence.length, passed: true }));
} finally { await browser.close(); await vite.close(); }
