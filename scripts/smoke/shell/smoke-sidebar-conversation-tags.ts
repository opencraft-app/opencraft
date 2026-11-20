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

    // 1. Tag row 0 with MULTIPLE tags simultaneously (Orange color + Cat + Rabbit + Owl + Whale) without menu closing!
    const firstRow = recentRows.nth(0);
    if (touch) {
      await firstRow.locator(".sidebar-activity-item__menu-trigger").tap();
    } else {
      await firstRow.locator(".sidebar-activity-row__target").click({ button: "right" });
    }
    const palette = page.locator(".conversation-tag-palette");
    await palette.waitFor();

    const activate = async (loc: ReturnType<typeof page.locator>) => (touch ? loc.tap() : loc.click());
    await activate(palette.getByRole("button", { name: /橙色|Orange/u }));
    await activate(palette.getByRole("button", { name: /猫咪|Cat/u }));
    await activate(palette.getByRole("button", { name: /兔子|Rabbit/u }));
    await activate(palette.getByRole("button", { name: /猫头鹰|Owl/u }));
    await activate(palette.getByRole("button", { name: /鲸鱼|Whale/u }));
    // Palette remains open for multi-select!
    assert.equal(await palette.isVisible(), true);
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-row-palette-multi-light.png` });
    await page.keyboard.press("Escape");
    await palette.waitFor({ state: "hidden" });

    // Verify row 0 has tags AND all 5 tags render directly in the filter bar (NO +N collapse!)
    await firstRow.locator(".sidebar-activity-item__tag").waitFor();
    const filterBar = page.locator(".sidebar-recent-tag-filters");
    await filterBar.waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".sidebar-recent-tag-chip").length === 5);

    // 2. Tag row 1 with Blue color + Fox icon via "..." menu -> now 7 distinct tags all shown directly!
    const secondRow = recentRows.nth(1);
    if (!touch) await secondRow.hover();
    await activate(secondRow.locator(".sidebar-activity-item__menu-trigger"));
    await palette.waitFor();
    await activate(palette.getByRole("button", { name: /蓝色|Blue/u }));
    await activate(palette.getByRole("button", { name: /狐狸|Fox/u }));
    await page.keyboard.press("Escape");
    await palette.waitFor({ state: "hidden" });
    await secondRow.locator(".sidebar-activity-item__tag").waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".sidebar-recent-tag-chip").length === 7);
    assert.doesNotMatch(await filterBar.innerText(), /\+\d+/u, "No +N collapse when >4 tags exist");

    // 3. Multi-select filtering + scroll continuity + one-click Clear All!
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
    const orangeChip = filterBar.getByRole("button", { name: /橙色|Orange/u });
    const blueChip = filterBar.getByRole("button", { name: /蓝色|Blue/u });
    // Select Cat filter -> row 0 matches!
    await activate(catChip);
    assert.equal(await catChip.getAttribute("aria-pressed"), "true");
    await page.waitForFunction(() => document.querySelectorAll('[data-row-scope="recent"]').length === 1);
    const clearAllBtn = filterBar.locator(".sidebar-recent-tag-clear");
    await clearAllBtn.waitFor();

    // Select Orange + Cat together -> row 0 has BOTH Orange AND Cat, so still 1 matching row!
    await activate(orangeChip);
    assert.equal(await catChip.getAttribute("aria-pressed"), "true");
    assert.equal(await orangeChip.getAttribute("aria-pressed"), "true");
    await page.waitForFunction(() => document.querySelectorAll('[data-row-scope="recent"]').length === 1);

    // Also select Blue (which row 0 does NOT have) -> intersection (AND) yields 0 rows + reversible empty feedback!
    await activate(blueChip);
    assert.equal(await blueChip.getAttribute("aria-pressed"), "true");
    await page.waitForFunction(() => document.querySelectorAll('[data-row-scope="recent"]').length === 0);
    assert.equal(await scrollContainer.evaluate(el => el.scrollTop), 0, "Multi-tag filtering keeps scroll anchored");

    await page.setViewportSize({ width: touch ? 390 : 1360, height: 880 });
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-multi-filter-light.png` });

    // One-click Clear All clears ALL active filters immediately and restores all rows!
    await activate(clearAllBtn);
    await clearAllBtn.waitFor({ state: "hidden" });
    assert.equal(await catChip.getAttribute("aria-pressed"), "false");
    assert.equal(await orangeChip.getAttribute("aria-pressed"), "false");
    assert.equal(await blueChip.getAttribute("aria-pressed"), "false");
    await page.waitForFunction(expected => document.querySelectorAll('[data-row-scope="recent"]').length === expected, initialCount);

    // Ensure Recent heading wraps cleanly with 7 tags without horizontal overflow!
    const headingFits = await page.locator(".sidebar-recent-heading").evaluate(el => {
      const parent = el.parentElement!;
      return el.scrollWidth <= parent.clientWidth + 1;
    });
    assert.equal(headingFits, true, "Recent heading with wrapped multi-tags must fit within sidebar width");

    assert.deepEqual(errors, []);
    await context.close();
  }

  console.log("PASS multi-tag & multi-filter: simultaneous color+animal tags, no +N collapse, multi-select filter, one-click Clear All, desktop + touch. Screenshots: " + output);
} finally {
  await browser.close();
}
