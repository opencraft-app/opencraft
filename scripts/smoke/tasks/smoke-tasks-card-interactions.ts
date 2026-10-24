import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TasksService } from "../../../plugins/tasks/src/server";
import { TASKS } from "@opencraft/appserver-protocol";
import { startHeadlessServer } from "../../headless-server.mjs";

// Real built Workbench and SQLite authority; synthetic fixtures only. Native
// pointer/keyboard/touch input verifies removal without weakening status edits.
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = process.cwd(), data = await mkdtemp(join(tmpdir(), "oc-tasks-card-interactions-"));
const artifacts = process.env.OPENCRAFT_TASKS_INTERACTION_ARTIFACTS ?? join(root, ".local/tasks-card-interactions");
await mkdir(artifacts, { recursive: true }); await mkdir(join(data, "agent"));
const service = new TasksService(join(data, "agent/tasks.sqlite"));
const snapshot = () => service.handle(TASKS.list, {}).tasks;
const task = (id: string) => snapshot().find(t => t.id === id)!;
for (let i = 0; i < 28; i++) service.handle(TASKS.create, {
  id: `item-${i}`, title: `Task ${i} / 产品协作事项`, description: "Retained original description",
  acceptanceCriteria: "Retained verifiable criteria", kind: "feature", status: "backlog",
  projectServerId: null, projectId: null,
});
const server = await startHeadlessServer({ root, dataDirectory: data, port: 0,
  webRoot: join(root, "apps/workbench-web/dist"),
  dshCapabilityPlugin: join(root, "apps/local-agent-host/src/dsh-capability-plugin.mjs"),
  codexExecutable: process.env.OPENCRAFT_CODEX_EXECUTABLE ?? "codex" });
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
const errors: string[] = [], cases: unknown[] = [];
try {
  for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 1680, height: 950 }, colorScheme: theme });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on("pageerror", e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem("opencraft.appearance-theme", "system"));
    await page.goto(server.url + "/views/opencraft.tasks.board");
    const card = page.locator('.tasks-card[data-task-id="item-0"]'); await card.waitFor();
    const before = JSON.stringify(snapshot());
    assert.equal(await page.locator('.tasks-card__handle, .tasks-card--overlay, .tasks-card [aria-roledescription="sortable"], .tasks-card [draggable="true"]').count(), 0);
    assert.equal(await card.locator('svg[data-action-glyph="list"], svg[data-action-glyph="checklist"]').count(), 0, "Description and criteria do not add presence glyphs");
    assert.equal(await card.locator('.tasks-conversation, .tasks-card__summary').count(), 0, "Unlinked cards have no conversation shortcut or empty summary gap");
    assert.equal(await card.getByText(task('item-0').description, { exact: true }).count(), 0);
    assert.equal(await card.getByText(task('item-0').acceptanceCriteria, { exact: true }).count(), 0);
    const close = async () => { await page.keyboard.press("Escape"); await page.locator('.tasks-editor').waitFor({ state: 'hidden' }); };
    for (const region of ['.tasks-kind', '.tasks-avatar']) {
      await card.locator(region).click(); await page.locator('.tasks-editor').waitFor(); await close();
      await page.waitForFunction(() => document.activeElement === document.querySelector('[data-task-id="item-0"] .tasks-card__title'));
    }
    await card.click({ position: { x: 5, y: 5 } }); await page.locator('.tasks-editor').waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Description', exact: true }).inputValue(), task('item-0').description);
    assert.equal(await page.getByRole('textbox', { name: 'Acceptance criteria', exact: true }).inputValue(), task('item-0').acceptanceCriteria);
    await close();
    await page.keyboard.press('Enter'); await page.locator('.tasks-editor').waitFor(); await close();
    await card.hover(); await card.locator('.tasks-card__quick').click(); await page.locator('.tasks-quick-form').waitFor();
    assert.equal(await page.locator('.tasks-editor').count(), 0); await page.keyboard.press('Escape');
    await card.locator('[aria-haspopup="menu"]').click(); await page.getByRole('menuitem', { name: 'Quick edit', exact: true }).click();
    await page.locator('.tasks-quick-form').waitFor(); assert.equal(await page.locator('.tasks-editor').count(), 0);
    const quickBounds=await page.locator('.tasks-quick-popover').boundingBox(), cardBounds=await card.boundingBox();
    assert.ok(quickBounds && cardBounds && quickBounds.x>=cardBounds.x+cardBounds.width
      && quickBounds.x-cardBounds.x-cardBounds.width<=16
      && quickBounds.y<cardBounds.y+cardBounds.height && quickBounds.y+quickBounds.height>cardBounds.y
      && quickBounds.y>=0 && quickBounds.y+quickBounds.height<=950, 'menu quick edit stays alongside its card and fits the viewport');
    await page.screenshot({ path: join(artifacts, `quick-${theme}.png`) });
    await page.keyboard.press('Escape');
    // Raw pointer input has no locator actionability wait. Let the dismissed
    // Radix layer finish releasing its pointer lock before native gestures.
    await page.locator('.tasks-quick-form').waitFor({ state: 'detached' });
    await page.waitForFunction(() => getComputedStyle(document.body).pointerEvents !== 'none');
    await card.locator('[aria-haspopup="menu"]').click(); await page.getByRole('menuitem', { name: 'Open full details', exact: true }).click();
    await page.locator('.tasks-editor').waitFor(); await close();
    // A gesture across columns, including title starts, never changes authority.
    for (const target of [card, card.locator('.tasks-card__title')]) {
      const from = await target.boundingBox(), to = await page.locator('.tasks-column[data-status="todo"]').boundingBox(); assert.ok(from && to);
      await page.mouse.move(from.x + 5, from.y + 5); await page.mouse.down();
      await page.mouse.move(to.x + 40, to.y + 90, { steps: 15 }); await page.mouse.up();
      assert.equal(await page.locator('.tasks-card--overlay, .tasks-card--dragging, .tasks-column--over').count(), 0);
      assert.equal(JSON.stringify(snapshot()), before, 'Pointer movement cannot reorder or change status/revision');
    }
    // Native text selection on a passive region must not activate detail.
    const kind = card.locator('.tasks-kind'), k = await kind.boundingBox(); assert.ok(k);
    await page.mouse.move(k.x + 3, k.y + k.height / 2); await page.mouse.down();
    await page.mouse.move(k.x + k.width - 2, k.y + k.height / 2, { steps: 8 }); await page.mouse.up();
    assert.ok(await page.evaluate(() => !!window.getSelection()?.toString()), 'Native card text can be selected');
    assert.equal(await page.locator('.tasks-editor').count(), 0, 'Selecting text is not opening detail');
    // Detail status is still an explicit, persistent command.
    await card.locator('.tasks-card__title').click(); await page.locator('.tasks-editor').waitFor();
    await page.getByRole('combobox', { name: 'Task status', exact: true }).selectOption('todo');
    await page.waitForFunction(() => document.querySelector('.tasks-editor select[aria-label="Task status"]')?.getAttribute('disabled') === null);
    await close(); await page.locator('.tasks-column[data-status="todo"] [data-task-id="item-0"]').waitFor();
    assert.equal(task('item-0').status, 'todo'); assert.equal(task('item-0').description, 'Retained original description');
    assert.equal(task('item-0').acceptanceCriteria, 'Retained verifiable criteria');
    await page.reload(); await page.locator('.tasks-column[data-status="todo"] [data-task-id="item-0"]').waitFor();
    await page.getByRole('radio', { name: 'List', exact: true }).click();
    const row = page.locator('.tasks-row[data-task-id="item-0"]'); await row.waitFor();
    assert.equal(await page.locator('.tasks-card__handle').count(), 0);
    await row.locator('.tasks-row__title').click(); await page.locator('.tasks-editor').waitFor(); await close();
    await row.getByRole('combobox').selectOption('backlog');
    await page.waitForFunction(() => (document.querySelector('.tasks-row[data-task-id="item-0"] select') as HTMLSelectElement)?.value === 'backlog');
    assert.equal(task('item-0').status, 'backlog');
    await page.screenshot({ path: join(artifacts, `list-${theme}.png`) });
    await page.getByRole('radio', { name: 'Board', exact: true }).click(); await card.waitFor();
    await page.screenshot({ path: join(artifacts, `board-${theme}.png`) });
    cases.push({ theme, noPresenceIconsOrDrag: true, detailAndKeyboard: true, selectionAndActions: true, explicitStatusAndReload: true, listStatus: true });
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.url + '/views/opencraft.tasks.board'); await page.getByRole('radio', { name: /^Backlog / }).click();
  const column = page.locator('.tasks-column[data-status="backlog"]'), first = column.locator('.tasks-card').first(); await first.waitFor();
  const beforeTouch = JSON.stringify(snapshot());
  await first.locator('.tasks-kind').tap(); await page.locator('.tasks-editor').waitFor(); await page.keyboard.press('Escape');
  await first.locator('[aria-haspopup="menu"]').tap(); await page.getByRole('menuitem', { name: 'Quick edit', exact: true }).tap();
  const quickForm=page.locator('.tasks-quick-form'); await quickForm.waitFor();
  await quickForm.getByRole('button', { name: 'Close', exact: true }).tap(); await quickForm.waitFor({ state: 'detached' });
  await page.waitForFunction(() => getComputedStyle(document.body).pointerEvents !== 'none');
  const cdp = await context.newCDPSession(page);
  const touch = (type: string, x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const b = await first.boundingBox(); assert.ok(b);
  await touch('touchStart', b.x + 8, b.y + b.height - 10);
  await new Promise(r => setTimeout(r, 350)); // Exceeds the removed long-press activation threshold.
  for (let i = 1; i <= 8; i++) await touch('touchMove', b.x + 8, b.y + b.height - 10 - 12 * i);
  await touch('touchEnd', 0, 0);
  await page.waitForFunction(() => document.querySelector('.tasks-column[data-status="backlog"]')!.scrollTop > 0);
  assert.equal(await page.locator('.tasks-card__handle, .tasks-card--overlay, .tasks-card--dragging').count(), 0);
  assert.equal(JSON.stringify(snapshot()), beforeTouch, 'Touch long press and scrolling do not write tasks');
  assert.equal(await page.locator('.tasks-editor').count(), 0);
  await page.screenshot({ path: join(artifacts, 'touch-390.png') });
  // A fresh document separates list input from the preceding OS scroll fling.
  await page.reload(); await page.locator('.tasks-toolbar').waitFor();
  await page.getByRole('radio', { name: 'List', exact: true }).tap();
  const row = page.locator('.tasks-row').first(); await row.waitFor();
  assert.equal(await page.locator('.tasks-card__handle').count(), 0);
  assert.ok(await row.evaluate(n => n.scrollWidth <= n.clientWidth + 1), 'Compact list has no overflowing handle column');
  await row.locator('.tasks-row__title').tap(); await page.locator('.tasks-editor').waitFor();
  await page.locator('.tasks-editor__close').tap(); await page.locator('.tasks-editor').waitFor({ state: 'hidden' });
  assert.equal(JSON.stringify(snapshot()), beforeTouch);
  await page.screenshot({ path: join(artifacts, 'list-touch-390.png') });
  cases.push({ width: 390, touchTap: true, longPressScrollWithoutSort: true, compactList: true }); await context.close();
  assert.deepEqual(errors, []);
  const receipt = { passed: true, cases, errors, paidInference: false };
  await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally { await browser.close(); await server.close(); service.close(); await rm(data, { recursive: true, force: true }); }
