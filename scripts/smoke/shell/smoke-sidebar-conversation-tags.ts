import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const output = process.env.OPENCRAFT_TAG_SMOKE_OUTPUT ?? "/tmp/opencraft-conversation-tags";
const previewUrl = process.env.OPENCRAFT_TAG_SMOKE_URL ?? "http://127.0.0.1:5173/";

await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
  headless: true,
});

try {
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: touch ? 390 : 1360, height: 880 },
      isMobile: touch,
      hasTouch: touch,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));

    await page.goto(previewUrl, { waitUntil: "domcontentloaded" });
    const skip = page.getByRole("button", { name: /暂时跳过|Skip/i });
    if (await skip.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
      await skip.click();
    }

    if (touch) {
      const toggle = page.locator('.app-shell-touch-sidebar-toggle button, button[aria-label*="侧边栏"], button[aria-label*="Sidebar"]').first();
      await toggle.waitFor({ timeout: 10_000 });
      await toggle.tap();
    }

    const recentRows = page.locator('[data-row-scope="recent"]');
    await recentRows.first().waitFor({ timeout: 15_000 });
    const initialCount = await recentRows.count();
    assert(initialCount >= 2, `Expected at least 2 Recent rows, saw ${initialCount}`);

    // Before tagging anything, no tag filter toolbar appears next to Recent.
    assert.equal(await page.locator(".sidebar-recent-tag-filters").count(), 0);

    // 1. Tag row 0 with minimalist Cat icon via row menu (right-click on desktop, "..." on touch).
    const firstRow = recentRows.nth(0);
    if (touch) {
      await firstRow.locator(".sidebar-activity-item__menu-trigger").tap();
    } else {
      await firstRow.locator(".sidebar-activity-row__target").click({ button: "right" });
    }
    const palette = page.locator(".conversation-tag-palette");
    await palette.waitFor();
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-row-palette-light.png` });
    const catRadio = palette.getByRole("radio", { name: /猫咪|Cat/u });
    if (touch) await catRadio.tap(); else await catRadio.click();
    await palette.waitFor({ state: "hidden" });

    // Verify tag mark appears on row 0 AND quick filter chip appears next to Recent!
    await firstRow.locator(".sidebar-activity-item__tag").waitFor();
    const filterBar = page.locator(".sidebar-recent-tag-filters");
    await filterBar.waitFor();
    assert.equal(await filterBar.locator(".sidebar-recent-tag-chip").count(), 1);

    // 2. Tag row 1 with Blue color swatch via "..." menu.
    const secondRow = recentRows.nth(1);
    if (!touch) await secondRow.hover();
    const secondTrigger = secondRow.locator(".sidebar-activity-item__menu-trigger");
    if (touch) await secondTrigger.tap(); else await secondTrigger.click();
    await palette.waitFor();
    const blueRadio = palette.getByRole("radio", { name: /蓝色|Blue/u });
    if (touch) await blueRadio.tap(); else await blueRadio.click();
    await palette.waitFor({ state: "hidden" });
    await secondRow.locator(".sidebar-activity-item__tag").waitFor();
    assert.equal(await filterBar.locator(".sidebar-recent-tag-chip").count(), 2);

    // Tag row 2 (if present) with Fox icon so multiple animal + color tags are visible together!
    if (initialCount >= 3) {
      const thirdRow = recentRows.nth(2);
      if (!touch) await thirdRow.hover();
      const thirdTrigger = thirdRow.locator(".sidebar-activity-item__menu-trigger");
      if (touch) await thirdTrigger.tap(); else await thirdTrigger.click();
      await palette.waitFor();
      const foxRadio = palette.getByRole("radio", { name: /狐狸|Fox/u });
      if (touch) await foxRadio.tap(); else await foxRadio.click();
      await palette.waitFor({ state: "hidden" });
      await thirdRow.locator(".sidebar-activity-item__tag").waitFor();
      assert.equal(await filterBar.locator(".sidebar-recent-tag-chip").count(), 3);
    }

    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-sidebar-tags-light.png` });

    // 3. Select row 0 (Cat) so it is the active selected conversation, then filter by Cat -> switch to Blue!
    // Regression check: switching to a second tag filter while the first conversation is selected
    // must keep scroll anchored at Recent instead of jumping down to Devices/Projects!
    await page.setViewportSize({ width: touch ? 390 : 1360, height: 520 });
    const selectFirst = firstRow.locator(".sidebar-activity-item");
    if (touch) {
      await selectFirst.tap();
      const toggle = page.locator('.app-shell-touch-sidebar-toggle button, button[aria-label*="侧边栏"], button[aria-label*="Sidebar"]').first();
      await toggle.waitFor({ timeout: 10_000 });
      await toggle.tap();
      await recentRows.first().waitFor({ timeout: 10_000 });
    } else {
      await selectFirst.click();
    }
    await page.locator(".local-conversation-page").waitFor();

    const scrollContainer = page.locator(touch ? ".shell-sidebar__scroll" : ".sidebar-activity-list");
    await scrollContainer.evaluate(el => { el.scrollTop = 0; });

    const catChip = filterBar.getByRole("button", { name: /猫咪|Cat/u });
    if (touch) await catChip.tap(); else await catChip.click();
    assert.equal(await catChip.getAttribute("aria-pressed"), "true");
    await page.waitForFunction(() => document.querySelectorAll('[data-row-scope="recent"]').length === 1);

    // Now switch directly from Cat filter to Blue filter while the Cat conversation is still selected!
    const blueChip = filterBar.getByRole("button", { name: /蓝色|Blue/u });
    if (touch) await blueChip.tap(); else await blueChip.click();
    assert.equal(await blueChip.getAttribute("aria-pressed"), "true");
    assert.equal(await catChip.getAttribute("aria-pressed"), "false");
    await page.waitForFunction(() => document.querySelectorAll('[data-row-scope="recent"]').length === 1);
    const scrollAfterSwitch = await scrollContainer.evaluate(el => el.scrollTop);
    assert.equal(scrollAfterSwitch, 0, "Switching Recent tag filters must not scroll down to Devices section");

    await page.setViewportSize({ width: touch ? 390 : 1360, height: 880 });
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-filtered-cat-light.png` });

    // Dark theme check while filtered!
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-filtered-cat-dark.png` });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });

    // Clicking active Blue chip again clears filter and restores full Recent list!
    if (touch) await blueChip.tap(); else await blueChip.click();
    assert.equal(await blueChip.getAttribute("aria-pressed"), "false");
    await page.waitForFunction(expected => document.querySelectorAll('[data-row-scope="recent"]').length === expected, initialCount);
    assert.equal(await scrollContainer.evaluate(el => el.scrollTop), 0);

    // Verify no horizontal overflow in Recent heading!
    const headingFits = await page.locator(".sidebar-recent-heading").evaluate(el => {
      const parent = el.parentElement!;
      return el.scrollWidth <= parent.clientWidth + 1;
    });
    assert.equal(headingFits, true, "Recent heading with tag filter chips must fit within sidebar width");

    // 4. Open a conversation and verify the Conversation Page Header Tag button works!
    const openTarget = recentRows.nth(0).locator(".sidebar-activity-item");
    if (touch) await openTarget.tap(); else await openTarget.click();
    await page.locator(".local-conversation-page").waitFor();
    const headerTagBtn = page.locator('.conversation-header-actions button[aria-label*="标记"], .conversation-header-actions button[aria-label*="Tag"]').first();
    await headerTagBtn.waitFor();
    if (touch) await headerTagBtn.tap(); else await headerTagBtn.click();
    const headerPopover = page.locator(".conversation-tag-popover");
    await headerPopover.waitFor();
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-header-tag-popover.png` });
    const owlRadio = headerPopover.getByRole("radio", { name: /猫头鹰|Owl/u });
    if (touch) await owlRadio.tap(); else await owlRadio.click();
    await headerPopover.waitFor({ state: "hidden" });
    await page.waitForFunction(() => {
      const btn = document.querySelector('.conversation-header-actions button[aria-label*="标记"], .conversation-header-actions button[aria-label*="Tag"]');
      return /猫头鹰|Owl/u.test(btn?.getAttribute("aria-label") ?? "");
    });

    assert.deepEqual(errors, []);
    await context.close();
  }

  console.log("PASS sidebar & conversation tags: colors + minimalist animals, row menu + page header button, quick filter beside Recent, desktop + touch, light + dark. Screenshots: " + output);
} finally {
  await browser.close();
}
