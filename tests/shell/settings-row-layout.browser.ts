import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const url = new URL("/settings/appearance", process.env.OPENCRAFT_CONTROLS_LIVE_URL ?? "http://localhost:10000");
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
const output = resolve(".local/settings-layout-evidence");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
const evidence: unknown[] = [];
try {
  for (const locale of ["en-US", "zh-CN"]) for (const touch of [false, true]) {
    const context = await browser.newContext({ locale, hasTouch: touch, viewport: { width: 1280, height: 1100 } });
    const page = await context.newPage();
    await page.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(url.href);
    const groups = page.locator('.settings-control-row .segmented-control[data-appearance="inset"]');
    await groups.nth(1).waitFor({ timeout: 60000 });
    const touchGroup = groups.first();
    const original = await touchGroup.elementHandle();
    const measure = () => groups.evaluateAll(nodes => nodes.map(node => {
      const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const value = node.closest('.settings-control-row__value')!;
      const row = node.closest('.settings-control-row')!;
      return { row: rect(row), copy: rect(row.querySelector('.settings-control-row__copy')!), value: rect(value), group: rect(node),
        overflow: node.scrollWidth - node.clientWidth,
        buttons: [...node.children].map(button => {
          const range = document.createRange(); range.selectNodeContents(button);
          return { box: rect(button), text: rectFromRange(range) };
        }) };
      function rectFromRange(range: Range) { const r = range.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }
    }));
    const contained = (rows: Awaited<ReturnType<typeof measure>>, density: string | null) => {
      for (const row of rows) {
        assert.ok(row.value.left >= row.row.left && row.value.right <= row.row.right, "value stays inside its row");
        assert.ok(row.group.left >= row.value.left - 1 && row.group.right <= row.value.right + 1);
        assert.ok(row.overflow <= 1, `grid tracks cannot overflow their frame: ${JSON.stringify({ locale, touch, row })}`);
        for (const { box, text } of row.buttons) {
          assert.ok(box.left >= row.group.left && box.right <= row.group.right, "every option remains reachable inside the frame");
          assert.ok(text.left >= box.left - 1 && text.right <= box.right + 1 && text.top >= box.top - 1 && text.bottom <= box.bottom + 1, "complete label fits its hit area");
          assert.ok(box.height >= (density === "touch" ? 44 : 28));
          assert.ok(Math.abs(box.height - row.buttons[0]!.box.height) < 1, "wrapped labels keep equal hit-area heights");
        }
      }
    };
    const density = () => page.locator('html').getAttribute('data-ui-density');
    const settle = () => groups.first().evaluate(async node => {
      let previous = -1, stable = 0;
      for (let frame = 0; frame < 180; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const width = node.closest('.settings-control-row')!.getBoundingClientRect().width;
        stable = Math.abs(width - previous) < 0.1 ? stable + 1 : 0;
        previous = width;
        if (stable >= 6) return;
      }
      throw new Error('Settings container did not settle after viewport resize');
    });
    // Negative control reproduces the incompatible outer shrink / fixed inner tracks.
    const card = page.locator('.settings-control-group').first();
    await card.evaluate(node => { node.style.width = '320px'; });
    const old = await page.addStyleTag({ content: '.settings-control-row{flex-wrap:nowrap!important}.settings-control-row__copy{flex:1 1 auto!important}.settings-control-row__value--compact{flex:0 1 auto!important;width:auto!important}.segmented-control[data-appearance="inset"]{width:auto!important;max-width:none!important;grid-auto-columns:minmax(68px,1fr)!important}' });
    const negative = await measure();
    assert.throws(() => contained(negative, "compact"));
    await old.evaluate(node => node.remove());
    await card.evaluate(node => { node.style.removeProperty('width'); });

    for (const mode of ["off", "on", "auto"]) {
      const option = touchGroup.locator(`[data-value="${mode}"]`);
      if (touch) await option.tap(); else await option.click();
      await page.waitForFunction(expected => document.documentElement.dataset.uiDensity === expected, mode === "on" || (mode === "auto" && touch) ? "touch" : "compact");
      contained(await measure(), await density());
      assert.equal(await original!.evaluate(node => node === document.querySelector('.settings-control-row .segmented-control')), true);
    }
    const samples: unknown[] = [];
    for (const width of [1280, 1000, 820, 740, 520, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      await settle();
      const rows = await measure(); contained(rows, await density()); samples.push({ width, rows });
    }
    await page.setViewportSize({ width: 1280, height: 1100 });
    await settle();
    await card.evaluate(node => { node.style.width = '320px'; });
    const narrow = await measure(); contained(narrow, await density());
    assert.ok(narrow.every(row => row.value.top >= row.copy.bottom), "wide windows with narrow containers wrap independently of viewport breakpoints");
    const themeLayout = await card.locator('.settings-theme-card').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(), copy = node.querySelector('.settings-theme-card__copy')!.getBoundingClientRect();
      return { left: box.left, right: box.right, copyWidth: copy.width };
    }));
    assert.ok(themeLayout.every(theme => theme.left === themeLayout[0]!.left && theme.right === themeLayout[0]!.right && theme.copyWidth > 80), 'theme choices use one readable column in a narrow container');
    await card.screenshot({ path: `${output}/${locale}-${touch ? "touch" : "pointer"}-narrow.png` });
    await card.evaluate(node => { node.style.removeProperty('width'); });
    await page.locator('html').evaluate(node => { node.style.zoom = '1.5'; });
    contained(await measure(), await density());
    await page.locator('html').evaluate(node => { node.style.removeProperty('zoom'); });
    await groups.nth(1).locator('[data-value="dark"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    contained(await measure(), await density());
    await card.screenshot({ path: `${output}/${locale}-${touch ? "touch" : "pointer"}-dark.png` });
    await groups.nth(1).locator('[data-value="light"]').click();
    await page.getByRole('radio', { name: /^Longing / }).click();
    await card.screenshot({ path: `${output}/${locale}-${touch ? "touch" : "pointer"}-blue.png` });
    await touchGroup.locator('[data-value="auto"]').focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.querySelector('.settings-control-row .segmented-control [data-value="off"]')?.getAttribute('aria-checked') === 'true');
    assert.equal(await touchGroup.locator('[data-value="off"]').evaluate(node => node === document.activeElement), true);
    assert.deepEqual(errors, []);
    evidence.push({ locale, touch, samples, narrowContainer: narrow, zoom: 1.5, keyboard: true, retainedControl: true, pageErrors: errors });
    await context.close();
  }
  await writeFile(`${output}/report.json`, JSON.stringify(evidence, null, 2));
  console.log(`Settings layout passed: ${evidence.length} locale/input combinations; ${output}`);
} finally { await browser.close(); }
