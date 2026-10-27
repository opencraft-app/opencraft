import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const url = process.env.OPENCRAFT_CONTROLS_LIVE_URL ?? "http://localhost:10000/";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname));
const output = resolve(".local/menu-row-state-evidence");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const evidence: unknown[] = [];
try {
  for (const touch of [false, true]) {
    for (const theme of touch ? ["longing"] : ["neutral", "longing", "lavender"]) {
      for (const mode of ["light", "dark"]) {
        const context = await browser.newContext({
          viewport: { width: touch ? 390 : 1280, height: 900 },
          hasTouch: touch, isMobile: touch, locale: "zh-CN",
          reducedMotion: touch ? "reduce" : "no-preference",
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error: Error) => errors.push(error.message));
        await page.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
        await page.goto(url);
        const editor = page.locator('.opencraft-composer-editor[contenteditable="true"]').first();
        await editor.waitFor();
        await page.evaluate(async ([theme, mode]) => {
          // This is the real preview's appearance owner, in an isolated profile.
          const appearance = await import(/* @vite-ignore */ "/src/appearance-theme.ts");
          appearance.setThemePreference(mode);
          appearance.setAppearanceThemeId(theme === "neutral" ? appearance.coreThemeId : appearance[`${theme}ThemeId`]);
        }, [theme, mode]);
        await editor.fill("Unsent menu spacing draft");
        const original = await editor.elementHandle();
        const trigger = page.locator("button.opencraft-composer-mode--permissions:visible").first();
        if (touch) await trigger.tap(); else await trigger.click();
        const menu = page.locator('.opencraft-composer-selection-menu--permissions[data-state="open"]');
        await menu.waitFor();
        await menu.evaluate(async element => {
          getComputedStyle(element).backgroundColor;
          await Promise.all(element.getAnimations().map(animation => animation.finished));
        });
        const selected = menu.locator('[data-selected="true"]');
        await selected.waitFor();
        const selectedText = await selected.innerText();
        assert.ok(await selected.locator(".opencraft-composer-selection-menu__trailing svg").count());
        const options = menu.getByRole("menuitem");
        assert.ok(await options.count() >= 3);
        const selectedIndex = await options.evaluateAll(elements => elements.findIndex(e => e.getAttribute("data-selected") === "true"));
        const adjacent = options.nth(selectedIndex > 0 ? selectedIndex - 1 : 1);
        if (!touch) {
          await adjacent.hover();
          await page.waitForFunction(() => !!document.querySelector('.opencraft-composer-selection-menu--permissions [data-highlighted]'));
        } else {
          // Keyboard focus and touch density are independent capabilities.
          await adjacent.focus();
        }
        await adjacent.evaluate(async element => {
          getComputedStyle(element).backgroundColor;
          await Promise.all(element.getAnimations().map(animation => animation.finished));
        });
        assert.equal(await selected.getAttribute("data-selected"), "true", "Highlight must not change the saved choice");
        const geometry = await menu.evaluate(element => {
          const selected = element.querySelector<HTMLElement>('[data-selected="true"]')!;
          const highlighted = element.querySelector<HTMLElement>('[data-highlighted]')!;
          const a = selected.getBoundingClientRect(), b = highlighted.getBoundingClientRect();
          const list = selected.parentElement!;
          return {
            gap: a.top > b.top ? a.top - b.bottom : b.top - a.bottom,
            token: parseFloat(getComputedStyle(list).getPropertyValue("--menu-item-gap")),
            selectedFill: getComputedStyle(selected).backgroundColor,
            highlightedFill: getComputedStyle(highlighted).backgroundColor,
            heights: [...element.querySelectorAll('[role="menuitem"]')].map(row => row.getBoundingClientRect().height),
          };
        });
        assert.ok(geometry.token > 0);
        assert.ok(Math.abs(geometry.gap - geometry.token) < 0.1, "Selected and highlighted surfaces retain the shared list gap");
        assert.notEqual(geometry.selectedFill, "rgba(0, 0, 0, 0)");
        assert.notEqual(geometry.highlightedFill, "rgba(0, 0, 0, 0)");
        if (touch) assert.ok(geometry.heights.every(height => height >= 44));
        const scene = `${touch ? "touch" : "pointer"}-${theme}-${mode}`;
        await menu.screenshot({ path: `${output}/${scene}.png` });
        if (scene === "pointer-longing-light") await page.screenshot({ path: `${output}/workbench.png` });
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "hidden" });
        await page.locator('.opencraft-composer-selection-menu--permissions').waitFor({ state: "detached" });
        assert.equal(await editor.innerText(), "Unsent menu spacing draft");
        assert.ok(await original!.evaluate(e => e === document.querySelector('.opencraft-composer-editor[contenteditable="true"]')));
        if (touch) await trigger.tap(); else { await trigger.focus(); await page.keyboard.press("Enter"); }
        await menu.waitFor();
        assert.equal(await menu.locator('[data-selected="true"]').innerText(), selectedText);
        // Commit through the actual item; moving focus alone above did not commit.
        const next = menu.getByRole("menuitem").nth(selectedIndex > 0 ? selectedIndex - 1 : 1);
        const nextText = await next.innerText();
        if (touch) await next.tap(); else { await next.focus(); await page.keyboard.press("Enter"); }
        await menu.waitFor({ state: "hidden" });
        await page.locator('.opencraft-composer-selection-menu--permissions').waitFor({ state: "detached" });
        if (touch) await trigger.tap(); else await trigger.click();
        await menu.waitFor();
        assert.equal(await menu.locator('[data-selected="true"]').innerText(), nextText);
        await page.keyboard.press("Escape");
        assert.deepEqual(errors, []);
        evidence.push({ scene, geometry, draftRetained: true, selectionAndHighlightIndependent: true, selectionCommit: true });
        await context.close();
      }
    }
  }
  await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ output, evidence }, null, 2));
} finally { await browser.close(); }
