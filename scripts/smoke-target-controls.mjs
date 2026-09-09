// Run after the web build. Exercises shipped CSS in a real browser, offline.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { buildCodexThemeCssProperties } from '../packages/design-system/src/theme-engine.ts';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const assets = new URL('../apps/workbench-web/dist/assets/', import.meta.url);
const css = (await Promise.all((await readdir(assets)).filter(name => name.endsWith('.css'))
  .map(name => readFile(new URL(name, assets), 'utf8')))).join('\n');
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
try {
  for (const touch of [false, true]) {
    const context = await browser.newContext({ hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    await page.setContent(`<style>${css}</style><aside style="width:275px">
      <section class="sidebar-target-group"><div class="sidebar-target-heading-row">
      <button class="sidebar-target-heading"><span>My Hermes</span><span class="workbench-connection-status" data-phase="ready"></span></button>
      <button class="sidebar-target-new">+</button></div>
      <button class="sidebar-thread is-selected"><span></span><span>Task</span></button>
      <button class="sidebar-target-more">Show more</button></section></aside>
      <button class="new-thread-context-trigger"><span>My Hermes</span><span class="workbench-connection-status" data-phase="ready"></span></button>`);
    await page.evaluate(properties => {
      for (const [name, value] of Object.entries(properties)) document.documentElement.style.setProperty(name, value);
    }, buildCodexThemeCssProperties('light'));
    for (const selector of ['.sidebar-target-heading', '.sidebar-target-new', '.sidebar-target-more']) {
      assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).borderTopWidth), '0px');
    }
    assert.equal(await page.locator('.sidebar-thread').evaluate(el => el.getBoundingClientRect().height), 34);
    const dots = await page.locator('.workbench-connection-status').evaluateAll(els => els.map(el => ({
      width: el.getBoundingClientRect().width, color: getComputedStyle(el).backgroundColor,
    })));
    assert.deepEqual(dots[0], dots[1]);
    assert.equal(dots[0].width, 7);
    if (!touch) {
      await page.mouse.move(700, 500);
      assert.equal(await page.locator('.sidebar-target-new').evaluate(el => getComputedStyle(el).opacity), '0');
      await page.locator('.sidebar-target-heading').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('.sidebar-target-new').evaluate(el => getComputedStyle(el).opacity), '1');
      assert.equal(await page.locator('.sidebar-target-new').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    } else {
      assert.equal(await page.locator('.sidebar-target-new').evaluate(el => getComputedStyle(el).opacity), '1');
    }
    await context.close();
  }
  console.log('Target controls: borderless, shared status, row height, keyboard and touch passed');
} finally { await browser.close(); }
