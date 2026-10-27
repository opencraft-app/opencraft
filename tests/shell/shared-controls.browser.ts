import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
const { chromium, webkit } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = resolve(process.env.OPENCRAFT_CONTROLS_OUTPUT ?? ".local/control-refactor-evidence");
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-shared-controls",
  esbuild: { jsx: "automatic", target: "esnext" },
  optimizeDeps: { include: ["react", "react-dom", "react-dom/client", "react-intl", "@tanstack/react-query", "motion/react", "sonner", "tslib", "marked", "mermaid", "@deepseek-ai/cordis", "@radix-ui/react-dialog", "@radix-ui/react-alert-dialog", "@radix-ui/react-tooltip", "@radix-ui/react-popover", "@radix-ui/react-dropdown-menu", "@radix-ui/react-context-menu", "@opencraft/remote-interaction", "@opencraft/remote-interaction/touch", "@opencraft/remote-interaction/websocket"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "shared-controls-fixture", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>.fixture-fixed-control { position: fixed; right: 24px; bottom: 24px; }</style><div id="root"></div><script type="module" src="/tests/fixtures/shared-controls.tsx"></script>');
    });
  } }],
});
let browser: any;
const evidence: unknown[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await (process.env.OPENCRAFT_SMOKE_ENGINE === "webkit" ? webkit : chromium).launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: touch });
    const page = await context.newPage(); const errors: string[] = [];
    await page.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
    page.on("pageerror", (error: Error) => { errors.push(error.message); console.error(error.stack); });
    page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
    await page.goto(vite.resolvedUrls!.local[0]!);
    await page.getByLabel("Retained draft").waitFor({ timeout: 60000 });
    await page.waitForFunction(() => Boolean((window as any).controlsFixture));
    const density = () => page.locator("html").getAttribute("data-ui-density");
    assert.equal(await density(), touch ? "touch" : "compact", "auto follows input capability on a wide viewport");
    const positioned = page.getByRole("button", { name: "Positioned scroll action", exact: true });
    const geometry = await positioned.evaluate(button => {
      const rect = button.getBoundingClientRect(), anchor = button.parentElement!.getBoundingClientRect();
      return { position: getComputedStyle(button).position, center: rect.x + rect.width / 2,
        anchorCenter: anchor.x + anchor.width / 2, inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
        hit: button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
    });
    assert.equal(geometry.position, "absolute", "material cannot override the scroll action's layout owner");
    assert.ok(Math.abs(geometry.center - geometry.anchorCenter) < 1, "scroll action stays centered on its anchor");
    assert.ok(geometry.inViewport && geometry.hit, "a visible scroll action stays onscreen and can be hit");
    await positioned.click();
    assert.equal(await page.evaluate(() => (window as any).positionClicks), 1);
    const arrowBox = await positioned.boundingBox();
    await page.evaluate(() => (window as any).controlsFixture.setWorking(true));
    await positioned.locator("i").first().waitFor();
    assert.deepEqual(await positioned.boundingBox(), arrowBox, "working dots retain the same positioned hit region");
    await positioned.click();
    assert.equal(await page.evaluate(() => (window as any).positionClicks), 2);
    await page.evaluate(() => (window as any).controlsFixture.setWorking(false));

    assert.equal(await page.getByRole("button", { name: "Fixed floating action" }).evaluate(el => getComputedStyle(el).position), "fixed", "early consumer CSS retains fixed placement");
    assert.equal(await page.getByRole("button", { name: "Save changes", exact: true }).evaluate(el => getComputedStyle(el).position), "relative", "ordinary controls retain a backdrop host");

    const navigation = page.getByRole("navigation", { name: "Workspace navigation" });
    const navigationGeometry = () => navigation.evaluate(node => {
      const list = node.getBoundingClientRect(), style = getComputedStyle(node);
      return { gutter: parseFloat(style.paddingInlineStart), rows: [...node.querySelectorAll('button.ui-navigation-item')].map(row => {
        const rect = row.getBoundingClientRect();
        return { start: rect.left - list.left, end: list.right - rect.right, width: rect.width, height: rect.height };
      }) };
    });
    const initialNavigation = await navigationGeometry();
    assert.equal(initialNavigation.gutter, 8);
    for (const row of initialNavigation.rows) {
      assert.equal(row.start, initialNavigation.gutter); assert.equal(row.end, initialNavigation.gutter);
      assert.ok(row.height >= (touch ? 44 : 34));
    }
    await navigation.getByRole("button", { name: "Tasks", exact: true }).click();
    assert.equal(await navigation.getByRole("button", { name: "Tasks", exact: true }).getAttribute("aria-current"), "page");
    assert.deepEqual(await navigationGeometry(), initialNavigation, "selection changes paint without changing the row box");
    const original = await page.getByLabel("Retained draft").elementHandle();
    await page.getByLabel("Retained draft").fill("Unsaved draft stays here");
    const toggle = page.locator('[data-chrome-action-id="sidebar-toggle"]:visible').last();
    const group = page.locator('.app-shell-header__end-slot .ui-control-surface');
    const lensDisplay = async () => {
      const expected = await density() === "touch" ? "block" : "none";
      // Density changes can move this action into/out of a portal. Return the
      // checked value atomically instead of reading a just-retired DOM handle.
      const rendered = await page.waitForFunction(expected => {
        const buttons = [...document.querySelectorAll('[data-chrome-action-id="sidebar-toggle"]')].filter(e => e.getBoundingClientRect().width > 0);
        const lens = buttons.at(-1)?.querySelector('.ui-liquid-glass');
        const display = lens && getComputedStyle(lens).display;
        return display === expected ? { display } : false;
      }, expected);
      return (await rendered.jsonValue()).display;
    };
    assert.equal(await lensDisplay(), touch ? "block" : "none");
    assert.equal(await group.getAttribute("data-control-surface"), touch ? "floating" : "integrated");
    for (const mode of ["off", "on", "auto"] as const) {
      await page.evaluate(mode => (window as any).controlsFixture.setTouch(mode), mode);
      assert.equal(await density(), mode === "on" || (mode === "auto" && touch) ? "touch" : "compact");
      assert.equal(await original!.evaluate(e => e === document.querySelector('[aria-label="Retained draft"]')), true);
      assert.equal(await page.getByLabel("Retained draft").inputValue(), "Unsaved draft stays here");
    }
    await page.evaluate(() => (window as any).controlsFixture.setTouch("off"));
    await page.setViewportSize({ width: 520, height: 900 });
    assert.equal(await density(), "compact", "narrow width cannot turn on touch presentation");
    const narrowNavigation = await navigationGeometry();
    for (const row of narrowNavigation.rows) { assert.equal(row.start, 8); assert.equal(row.end, 8); }
    assert.equal(await lensDisplay(), "none");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => (window as any).controlsFixture.setTouch("on"));
    assert.equal(await lensDisplay(), "block", "wide touch presentation keeps its floating action");
    const touchNavigation = await navigationGeometry();
    for (const row of touchNavigation.rows) { assert.equal(row.start, 8); assert.equal(row.end, 8); assert.ok(row.height >= 44); }
    const before = await toggle.boundingBox(); await toggle.click(); await toggle.click();
    await page.getByLabel("Open preview panel", { exact: true }).click();
    await page.getByText("Preview content", { exact: true }).waitFor();
    await page.getByLabel("Close preview panel", { exact: true }).click();
    await page.getByText("Preview content", { exact: true }).waitFor({ state: "hidden" });
    assert.ok(before && before.width >= 44 && before.height >= 44);
    await page.evaluate(() => (window as any).controlsFixture.setTouch("off"));
    await page.mouse.move(600, 500);
    for (const mode of ["light", "dark"] as const) for (const blue of [false, true]) {
      await page.evaluate(({ mode, blue }) => (window as any).controlsFixture.setTheme(mode, blue), { mode, blue });
      await page.mouse.move(1100, 800);
      await page.waitForFunction(() => {
        const toggle = [...document.querySelectorAll('[data-chrome-action-id="sidebar-toggle"]')].find(e => e.getBoundingClientRect().width > 0);
        return toggle?.getAttribute('aria-expanded') === 'true' && getComputedStyle(toggle).backgroundColor === 'rgba(0, 0, 0, 0)';
      });
      const semantics = page.getByRole('group', { name: 'Disclosure semantics' });
      assert.equal(await semantics.getByRole('button', { name: 'Expanded region', exact: true }).evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', 'expanded content and aria-haspopup=false never imply selection');
      for (const name of ['Open popup', 'Open disclosure', 'Open Radix popup']) {
        assert.notEqual(await semantics.getByRole('button', { name, exact: true }).evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', 'popup owners retain open feedback');
      }
      const row = page.locator('.sidebar-new-chat:visible');
      assert.equal(await row.getAttribute("data-control-surface"), "integrated");
      assert.equal(await row.locator(".ui-liquid-glass").evaluate(e => getComputedStyle(e).display), "none");
      assert.equal(await group.locator(":scope > .ui-liquid-glass").evaluate(e => getComputedStyle(e).display), "none");
      await page.screenshot({ path: `${output}/${touch ? "hybrid" : "pointer"}-${mode}${blue ? "-blue" : ""}.png` });
    }
    const save = page.getByRole("button", { name: "Save configuration", exact: true });
    const idle = await save.boundingBox(); await save.click();
    await page.waitForFunction(() => document.querySelector('.settings-control-button')?.getAttribute('aria-busy') === 'true');
    assert.equal(await save.isDisabled(), true);
    const pending = await save.boundingBox();
    assert.equal(pending?.width, idle?.width); assert.equal(pending?.height, idle?.height);
    assert.equal(await save.getAttribute("aria-label"), null, "visible text remains the accessible name");
    await page.evaluate(() => (window as any).controlsFixture.finish());
    await save.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector('.settings-control-button')?.hasAttribute('disabled'));
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => { const e = document.activeElement!; const s = getComputedStyle(e); return { visible: e.matches(":focus-visible"), outline: s.outlineStyle, width: s.outlineWidth }; });
    assert.equal(focus.visible, true); assert.notEqual(focus.outline, "none");
    await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
    assert.equal(await page.getByLabel("Retained draft").inputValue(), "Unsaved draft stays here");
    assert.deepEqual(errors, []);
    evidence.push({ placement: { absolute: true, fixed: true, relativeDefault: true, centeredHit: true, stableWorkingDots: true }, touchCapability: touch, auto: true, manualOverride: true, narrowPointer: true, wideTouch: true, stableEditor: true, stablePendingBox: true, expandedRegionQuiet: true, popupOpenFeedback: true, navigation: { gutter: 8, stableSelection: true, narrowPointer: true, touchHitTarget: true }, focus, themes: 4 });
    await context.close();
  }
  if (process.env.OPENCRAFT_CONTROLS_LIVE_URL) {
    const url = new URL(process.env.OPENCRAFT_CONTROLS_LIVE_URL);
    assert.ok(["localhost", "127.0.0.1"].includes(url.hostname), "Live acceptance targets an isolated local preview");
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
    const page = await context.newPage(); const errors: string[] = [];
    page.on("pageerror", (error: Error) => { errors.push(error.message); console.error(error.stack); });
    page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
    await page.goto(url.href);
    const row = page.locator('.sidebar-new-chat:visible');
    await row.waitFor({ timeout: 60000 }).catch(async error => {
      await page.screenshot({ path: `${output}/workbench-live-error.png` });
      console.error((await page.locator('body').innerText()).slice(0, 2000));
      throw error;
    });
    const toggle = page.locator('[data-chrome-action-id="sidebar-toggle"]:visible').last();
    assert.equal(await row.getAttribute("data-control-surface"), "integrated");
    assert.equal(await toggle.getAttribute("data-control-surface"), "integrated");
    await page.mouse.move(1100, 800);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await page.waitForFunction(() => {
      const toggle = [...document.querySelectorAll('[data-chrome-action-id="sidebar-toggle"]')].find(e => e.getBoundingClientRect().width > 0);
      return toggle && !toggle.matches(':hover') && getComputedStyle(toggle).backgroundColor === 'rgba(0, 0, 0, 0)';
    });
    await page.screenshot({ path: `${output}/sidebar-toggle-rest.png` });
    assert.equal(await row.locator('.ui-liquid-glass').evaluate(e => getComputedStyle(e).display), "none");
    await page.screenshot({ path: `${output}/workbench-live-light.png` });
    await page.locator('.shell-navigation__entrance[data-surface="settings"]').click();
    const settingsNavigation = page.locator('.settings-page__navigation .ui-navigation-list:visible');
    const chat = settingsNavigation.getByRole("button", { name: "聊天", exact: true });
    const selected = settingsNavigation.locator('button[aria-current="page"]');
    const settingsGeometry = await settingsNavigation.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return [...node.querySelectorAll('button.ui-navigation-item')].map(row => {
        const box = row.getBoundingClientRect(); return { start: box.left - rect.left, end: rect.right - box.right, height: box.height };
      });
    });
    for (const row of settingsGeometry) { assert.equal(row.start, 8); assert.equal(row.end, 8); }
    const selectedBox = await selected.boundingBox(); await chat.hover();
    await page.waitForFunction(() => {
      const row = [...document.querySelectorAll('.settings-page__navigation button.ui-navigation-item')].find(e => e.textContent?.trim() === '聊天');
      return row && getComputedStyle(row).backgroundColor !== 'rgba(0, 0, 0, 0)';
    });
    assert.equal((await chat.boundingBox())?.width, selectedBox?.width, "hover and selection share their inset box");
    await page.screenshot({ path: `${output}/settings-navigation-hover-light.png` });
    const blue = page.getByRole("radio", { name: /^Longing / });
    await blue.waitFor(); await blue.click();
    await chat.hover(); await page.screenshot({ path: `${output}/settings-navigation-hover-blue.png` });
    await settingsNavigation.screenshot({ path: `${output}/settings-navigation-hover-blue-detail.png` });
    await page.getByRole("radio", { name: "深色", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await chat.hover(); await settingsNavigation.screenshot({ path: `${output}/settings-navigation-hover-dark.png` });
    await page.getByRole("radio", { name: "浅色", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await page.goto(url.href); await row.waitFor();
    await page.mouse.move(800, 700);
    await page.screenshot({ path: `${output}/workbench-live-blue.png` });
    assert.deepEqual(errors, []);
    evidence.push({ liveWorkbench: url.origin, integratedHeader: true, quietNewChat: true, settingsNavigationInset: 8, consistentHoverAndSelection: true, themes: ["light", "blue"], pageErrors: errors });
    await context.close();

    const touchContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true, locale: "zh-CN" });
    const touchPage = await touchContext.newPage(); const touchErrors: string[] = [];
    touchPage.on("pageerror", (error: Error) => touchErrors.push(error.message));
    await touchPage.goto(url.href);
    await touchPage.locator('.shell-navigation__entrance[data-surface="settings"]:visible').tap();
    const touchNavigation = touchPage.locator('.settings-page__navigation .ui-navigation-list:visible');
    const touchChat = touchNavigation.getByRole("button", { name: "聊天", exact: true });
    const appearance = touchNavigation.getByRole("button", { name: "外观", exact: true });
    await touchChat.tap(); await appearance.tap();
    assert.equal(await touchPage.locator('html').getAttribute('data-ui-density'), 'touch');
    assert.equal(await touchPage.locator('html').evaluate(e => e.hasAttribute('data-touch-interaction')), true);
    await touchPage.waitForFunction(() => {
      const row = [...document.querySelectorAll('.settings-page__navigation button.ui-navigation-item')].find(e => e.textContent?.trim() === '聊天');
      return row && !row.hasAttribute('aria-current') && getComputedStyle(row).backgroundColor === 'rgba(0, 0, 0, 0)';
    });
    assert.equal(await touchChat.evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', "touch does not leave a hovered previous destination");
    const touchRows = await touchNavigation.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return [...node.querySelectorAll('button.ui-navigation-item')].map(row => {
        const box = row.getBoundingClientRect(); return { start: box.left - rect.left, end: rect.right - box.right, height: box.height };
      });
    });
    for (const row of touchRows) { assert.equal(row.start, 8); assert.equal(row.end, 8); assert.ok(row.height >= 44); }
    await touchPage.getByRole("radio", { name: /^Longing / }).tap();
    await touchChat.focus(); await touchPage.keyboard.press('Tab');
    const navigationFocus = await appearance.evaluate(e => {
      const style = getComputedStyle(e), row = e.getBoundingClientRect(), clip = e.closest('.ui-navigation-group')!.getBoundingClientRect();
      const extent = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      return { visible: e.matches(':focus-visible'), width: style.outlineWidth,
        unclipped: row.left - extent >= clip.left && row.right + extent <= clip.right && row.top - extent >= clip.top && row.bottom + extent <= clip.bottom };
    });
    assert.equal(navigationFocus.visible, true); assert.equal(navigationFocus.width, '2px'); assert.equal(navigationFocus.unclipped, true);
    await touchNavigation.screenshot({ path: `${output}/settings-navigation-touch-blue.png` });
    assert.deepEqual(touchErrors, []);
    evidence.push({ liveTouchSettings: url.origin, navigationInset: 8, hitTargetMin: 44, noStickyHover: true, navigationFocus, pageErrors: touchErrors });
    await touchContext.close();
    await import("./settings-row-layout.browser");
  }
  await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ output, evidence }));
} finally { await browser?.close(); await vite.close(); }
