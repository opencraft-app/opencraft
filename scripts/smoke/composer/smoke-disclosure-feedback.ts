import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const url = process.env.OPENCRAFT_CONTROLS_LIVE_URL ?? "http://localhost:10000/";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "Use an isolated local preview");
const output = resolve(process.env.OPENCRAFT_DISCLOSURE_OUTPUT ?? ".local/disclosure-feedback-evidence");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
const evidence: unknown[] = [];
try {
  for (const mode of ["light", "dark", "blue", "touch-blue", "phone-blue"] as const) {
    if (process.env.OPENCRAFT_DISCLOSURE_MODE && process.env.OPENCRAFT_DISCLOSURE_MODE !== mode) continue;
    const narrow = mode === "phone-blue";
    const touch = mode === "touch-blue" || narrow;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: touch, locale: "zh-CN", colorScheme: "light" });
    const page = await context.newPage(); const errors: string[] = [];
    await page.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(url);
    await page.locator('.shell-navigation__entrance[data-surface="settings"]:visible').click();
    await page.getByRole("radio", { name: mode === "dark" ? "深色" : "浅色", exact: true }).click();
    if (mode.includes("blue")) await page.getByRole("radio", { name: /^Longing / }).click();
    const nav = page.locator('.settings-page__navigation--sidebar .ui-navigation-list');
    const row = nav.getByRole("button", { name: "聊天", exact: true });
    if (!touch) await row.hover();
    const gutter = narrow ? null : await row.evaluate(e => {
      const list = e.closest("nav")!, a = e.getBoundingClientRect(), b = list.getBoundingClientRect();
      return { left: a.left - b.left, right: b.right - a.right, height: a.height, padding: getComputedStyle(list).paddingInlineStart };
    });
    if (gutter) {
      assert.ok(gutter.left >= 8 && gutter.right >= 8, "Navigation row states keep the list gutter");
      if (touch) assert.ok(gutter.height >= 44, "Navigation retains touch targets");
      await nav.screenshot({ path: `${output}/navigation-${mode}.png` });
    }
    await page.locator('[data-action-id="shell.home"]:visible').click();
    if (narrow) await page.setViewportSize({ width: 390, height: 900 });
    const editor = page.locator('.opencraft-composer-editor[contenteditable="true"]').first();
    if (touch) await editor.tap();
    await editor.fill("Unsent disclosure feedback draft"); const original = await editor.elementHandle();
    // The empty touch composer changes its grid after typing. Observe the
    // measured footer's settled geometry before comparing menu-open geometry.
    await page.evaluate(async () => {
      await document.fonts.ready;
      let last = "", stable = 0;
      for (let frame = 0; stable < 4 && frame < 120; frame++) {
        await new Promise<void>(done => requestAnimationFrame(() => done()));
        const footer = document.querySelector('.opencraft-composer-footer')!;
        const value = JSON.stringify([footer.getAttribute('data-footer-density'), ...[...footer.querySelectorAll('button')].map(e => [e.clientWidth, e.clientHeight])]);
        stable = value === last ? stable + 1 : 0; last = value;
      }
      if (stable < 4) throw new Error("Composer footer geometry did not settle");
    });
    const colors = await page.evaluate(() => {
      const resolveColor = (name: string) => {
        const probe = document.createElement("i"); probe.style.cssText = `position:absolute;visibility:hidden;background:var(${name})`;
        document.body.append(probe); const value = getComputedStyle(probe).backgroundColor; probe.remove(); return value;
      };
      return { open: resolveColor("--color-background-button-tertiary-hover"), pressed: resolveColor("--color-background-navigation-pressed") };
    });
    const states: unknown[] = [];
    if (!narrow) {
      const sidebar = page.locator('[data-chrome-action-id="sidebar-toggle"]:visible').last();
      const quiet = async (expanded: string) => {
        await page.mouse.move(1100, 200);
        await page.waitForFunction(expanded => {
          const button = [...document.querySelectorAll('[data-chrome-action-id="sidebar-toggle"]')].find(e => e.getBoundingClientRect().width > 0);
          return button?.getAttribute('aria-expanded') === expanded && !button.matches(':hover')
            && getComputedStyle(button).backgroundColor === 'rgba(0, 0, 0, 0)';
        }, expanded);
      };
      await quiet('true');
      if (touch) await sidebar.tap();
      else {
        await sidebar.hover();
        await page.waitForFunction(color => {
          const button = document.querySelector('[data-chrome-action-id="sidebar-toggle"]:hover');
          return button && getComputedStyle(button).backgroundColor === color;
        }, colors.open);
        await page.mouse.down();
        await page.waitForFunction(color => {
          const button = document.querySelector('[data-chrome-action-id="sidebar-toggle"]:active');
          return button && getComputedStyle(button).backgroundColor === color;
        }, colors.pressed);
        await page.mouse.up();
      }
      await quiet('false');
      if (touch) await sidebar.tap(); else await sidebar.click();
      await quiet('true');
      await page.keyboard.press('Tab'); await sidebar.focus();
      const focus = await sidebar.evaluate(e => ({ visible: e.matches(':focus-visible'), outline: getComputedStyle(e).outlineWidth }));
      assert.equal(focus.visible, true); assert.equal(focus.outline, '2px');
      await editor.click(); await quiet('true');
      await page.screenshot({ path: `${output}/sidebar-rest-${mode}.png` });
      states.push({ name: 'sidebar', expandedIsNotSelected: true, collapseExpand: true, heldPress: !touch, keyboardFocus: true });
    }
    for (const [name, selector] of [
      ["permissions", ".opencraft-composer-mode--permissions"],
      ["model", ".opencraft-composer-mode--intelligence"],
      ["machine", ".new-thread-context-trigger"],
      ["project", '.new-thread-context-trigger[aria-label="选择项目文件夹"]'],
      ["add", ".opencraft-composer-icon-button[data-state]"],
    ]) {
      const trigger = page.locator(`button${selector}:visible`).first();
      await trigger.waitFor();
      assert.equal(await trigger.getAttribute("data-variant"), "ghost");
      assert.equal(await trigger.getAttribute("data-size"), "accessory");
      const geometry = await trigger.boundingBox(); assert.ok(geometry);
      const beforeDensity = await page.locator('.opencraft-composer-footer').getAttribute('data-footer-density');
      if (narrow) await page.screenshot({ path: `${output}/${name}-${mode}-before.png` });
      if (touch) assert.ok(geometry.width >= 44 && geometry.height >= 44);
      if (touch) await trigger.tap();
      else {
        await trigger.hover();
        await page.waitForFunction(({ selector, color }) => {
          const e = document.querySelector(selector); return !!e && getComputedStyle(e).backgroundColor === color;
        }, { selector: `button${selector}`, color: colors.open });
        await page.mouse.down();
        await page.waitForFunction(({ selector, color }) => {
          const e = document.querySelector(selector); return !!e && getComputedStyle(e).backgroundColor === color;
        }, { selector: `button${selector}`, color: colors.pressed });
        await page.mouse.up();
      }
      await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute("data-state") === "open", `button${selector}`);
      // Moving into the menu removes real :hover from its disclosure.
      const menu = page.getByRole("menu").last(); await menu.waitFor();
      if (!touch) { const box = await menu.boundingBox(); await page.mouse.move(box!.x + box!.width / 2, box!.y + 12); }
      await page.waitForFunction(({ selector, color }) => {
        const e = document.querySelector(selector); return !!e && getComputedStyle(e).backgroundColor === color;
      }, { selector: `button${selector}`, color: colors.open });
      const opened = await trigger.boundingBox();
      if (opened!.width !== geometry.width) {
        await page.screenshot({ path: `${output}/${name}-${mode}-unstable.png` });
        console.log({ mode, name, geometry, opened, beforeDensity, afterDensity: await page.locator('.opencraft-composer-footer').getAttribute('data-footer-density'), viewport: await page.evaluate(() => ({ innerWidth, density: document.documentElement.dataset.uiDensity, footer: document.querySelector('.opencraft-composer-footer')!.getBoundingClientRect().toJSON() })) });
      }
      assert.equal(opened!.width, geometry.width, `${mode}/${name} keeps its width`); assert.equal(opened!.height, geometry.height, `${mode}/${name} keeps its height`);
      await page.screenshot({ path: `${output}/${name}-${mode}-open.png` });
      await page.keyboard.press("Escape");
      await page.mouse.move(1100, 200);
      await page.waitForFunction(selector => {
        const e = document.querySelector(selector); return e?.getAttribute("data-state") === "closed" && getComputedStyle(e).backgroundColor === "rgba(0, 0, 0, 0)";
      }, `button${selector}`);
      if (!touch) {
        await trigger.focus(); await page.keyboard.press("Enter");
        await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute("data-state") === "open", `button${selector}`);
        await page.keyboard.press("Escape");
        await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute("data-state") === "closed", `button${selector}`);
      }
      assert.equal(await original!.evaluate(e => e === document.querySelector('.opencraft-composer-editor[contenteditable="true"]')), true);
      assert.equal(await editor.innerText(), "Unsent disclosure feedback draft");
      states.push({ name, stableGeometry: true, openPersistsOutsideHover: true, closesToRest: true, heldPress: !touch, keyboardReopen: !touch });
    }
    assert.deepEqual(errors, []);
    evidence.push({ mode, touch, gutter, colors, states, originalEditorRetained: true, pageErrors: errors });
    await context.close();
  }
  await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ output, evidence }));
} finally { await browser.close(); }
