import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Read-only interaction probe against a real built workbench. No seeded user
// state, task writes, model requests or synthetic DOM events.
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.OPENCRAFT_TASKS_URL;
if (!base) throw new Error('Set OPENCRAFT_TASKS_URL to the verified workbench origin');
const artifacts = process.env.OPENCRAFT_TASKS_ACTION_ARTIFACTS ?? '.local/tasks-card-actions';
await mkdir(artifacts, { recursive: true });
const version = await fetch(base + '/version.json').then(r => r.json());
if (process.env.OPENCRAFT_EXPECTED_SOURCE) assert.equal(version.sourceRevision, process.env.OPENCRAFT_EXPECTED_SOURCE);
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
const errors = [], writes = [], cases = [];
const writeMethods = new Set(['archive', 'unarchive', 'create', 'update', 'move', 'remove', 'restore', 'properties/update', 'members/upsert', 'progress/append', 'conversations/attach', 'conversations/detach'].map(s => 'opencraft/tasks/' + s));
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('websocket', ws => ws.on('framesent', ({ payload }) => {
      const envelope = JSON.parse(String(payload)), frame = envelope.frame ? JSON.parse(envelope.frame) : envelope;
      if (writeMethods.has(frame.method)) writes.push(frame.method);
    }));
    await page.addInitScript(() => localStorage.setItem('opencraft.appearance-theme', 'system'));
    await page.goto(base + '/views/opencraft.tasks.board');
    const card = page.locator('.tasks-card:visible').first(); await card.waitFor();
    const id = await card.getAttribute('data-task-id');
    const tools = card.locator('.tasks-card__tools'), more = tools.locator('[aria-haspopup="menu"]');
    const off = async () => { const r = await page.locator('.tasks-page-heading').boundingBox(); await page.mouse.move(r.x + r.width / 2, r.y + 8); };
    const visible = async value => page.waitForFunction(({ id, value }) => {
      const card = document.querySelector(`[data-task-id="${id}"]`);
      return ['.tasks-card__tools'].every(s => Number(getComputedStyle(card.querySelector(s)).opacity) === value);
    }, { id, value });
    try {
      await off(); await visible(0);
      await card.hover(); await visible(1); await off(); await visible(0);
      // Mouse dismissal preserves return focus without keeping actions pinned.
      await card.click({ position: { x: 5, y: 5 } });
      await page.locator('.tasks-editor').waitFor(); await page.locator('.tasks-editor__close').click();
      await page.locator('.tasks-editor').waitFor({ state: 'hidden' });
      await page.waitForFunction(id => document.activeElement === document.querySelector(`[data-task-id="${id}"] .tasks-card__title`), id);
      assert.equal(await card.locator('.tasks-card__title').evaluate(n => getComputedStyle(n).outlineStyle), 'none', 'pointer detail return retains focus without outline');
      await off(); await visible(0);
      // A modal menu removes physical hover/focus; its real open state owns the anchor.
      for (let i = 0; i < 3; i++) {
        await card.hover(); await more.click(); await page.getByRole('menu').waitFor();
        const rect = await page.getByRole('menu').boundingBox(); await page.mouse.move(rect.x + 20, rect.y + 12);
        await visible(1); assert.equal(await more.getAttribute('data-state'), 'open');
        assert.equal(await page.locator('.tasks-editor').count(), 0);
        if (!i) await card.screenshot({ path: join(artifacts, `menu-open-${theme}.png`) });
        // Real pointer outside dismissal must not leave focus-within pinning it.
        const heading = await page.locator('.tasks-page-heading').boundingBox();
        await page.mouse.click(heading.x + heading.width / 2, heading.y + 8);
        await page.getByRole('menu').waitFor({ state: 'hidden' }); await off(); await visible(0);
      }
      // Pointer-opened menus must not inherit Escape's native keyboard ring.
      await card.hover(); await more.click(); await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({ state: 'hidden' });
      await page.waitForFunction(id => document.activeElement === document.querySelector(`[data-task-id="${id}"] [aria-haspopup="menu"]`), id);
      assert.equal(await more.evaluate(n => getComputedStyle(n).outlineStyle), 'none');
      await card.screenshot({ path: join(artifacts, `pointer-return-${theme}.png`) });
      await off(); await visible(0);
      const headingMore = page.locator('.tasks-heading-actions [aria-haspopup="menu"]');
      await headingMore.click(); await page.getByRole('menu').waitFor();
      await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement === document.querySelector('.tasks-heading-actions [aria-haspopup="menu"]'));
      assert.equal(await headingMore.evaluate(n => getComputedStyle(n).outlineStyle), 'none');
      // Programmatic focus alone is not the keyboard test: Tab enters the title.
      await card.hover(); await more.click(); await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({ state: 'hidden' }); await page.keyboard.press('Tab'); await off();
      assert.ok(await card.locator('.tasks-card__title').evaluate(n => document.activeElement === n && n.matches(':focus-visible')));
      await visible(1);
      await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter');
      await page.getByRole('menu').waitFor(); await off(); await visible(1);
      await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'hidden' });
      await page.waitForFunction(id => document.activeElement === document.querySelector(`[data-task-id="${id}"] [aria-haspopup="menu"]`), id);
      await visible(1);
      assert.equal(await more.evaluate(n => getComputedStyle(n).outlineStyle), 'solid');
      await page.emulateMedia({ forcedColors: 'active' });
      assert.equal(await more.evaluate(n => getComputedStyle(n).outlineStyle), 'solid');
      await page.emulateMedia({ forcedColors: 'none' });
      // Return to pointer input without clearing focus manually.
      await card.locator('.tasks-card__title').click(); await page.locator('.tasks-editor').waitFor();
      await page.locator('.tasks-editor__close').click(); await page.locator('.tasks-editor').waitFor({ state: 'hidden' }); await off(); await visible(0);
      cases.push({ theme, hoverLeave: true, mouseFocusDoesNotPin: true, menuAnchorRetained: true, repeatedMouseDismissal: true, keyboardTabAndMenuReturn: true, pointerCardAndToolbarReturnQuiet: true, forcedColorsKeyboard: true });
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `failure-${theme}.png`) });
      console.error(await card.evaluate(n => ({ hover: n.matches(':hover'), focus: document.activeElement?.outerHTML, tools: getComputedStyle(n.querySelector('.tasks-card__tools')).opacity })));
      throw error;
    } finally { await context.close(); }
  }
  // Touch remains discoverable without hover, including a coarse tablet layout.
  for (const width of [390, 1024]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    page.on('websocket', ws => ws.on('framesent', ({ payload }) => {
      const envelope = JSON.parse(String(payload)), frame = envelope.frame ? JSON.parse(envelope.frame) : envelope;
      if (writeMethods.has(frame.method)) writes.push(frame.method);
    }));
    await page.goto(base + '/views/opencraft.tasks.board');
    await page.locator('.tasks-toolbar').waitFor();
    const backlog = page.getByRole('radio', { name: /^Backlog / });
    if (await backlog.count()) await backlog.click();
    const card = page.locator('.tasks-card:visible').first(); await card.waitFor();
    for (const selector of ['.tasks-card__tools']) assert.equal(await card.locator(selector).evaluate(n => Number(getComputedStyle(n).opacity)), 1);
    await card.locator('[aria-haspopup="menu"]').tap(); await page.getByRole('menu').waitFor();
    assert.equal(await card.locator('.tasks-card__tools').evaluate(n => Number(getComputedStyle(n).opacity)), 1);
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'hidden' });
    assert.equal(await card.locator('[aria-haspopup="menu"]').evaluate(n => getComputedStyle(n).outlineStyle), 'none');
    cases.push({ width, touchAlwaysVisible: true, touchReturnQuiet: true }); await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  assert.equal((await fetch(base + '/version.json').then(r => r.json())).sourceRevision, version.sourceRevision);
  const receipt = { passed: true, version, cases, errors, writes, paidInference: false };
  await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
} finally { await browser.close(); }
