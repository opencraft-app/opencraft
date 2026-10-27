import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Opt-in, read-only production smoke: check only, never install or roll back.
// Trace/video are disabled because the site may use a real gateway login.
const url = process.env.OPENCRAFT_WEB_TEST_URL;
const expected = process.env.OPENCRAFT_WEB_EXPECTED_LATEST;

test('deployed website checks the company registry and shows the expected release result', async ({ page }) => {
  test.skip(!url, 'Set OPENCRAFT_WEB_TEST_URL to opt into a deployed-site check');
  expect(expected, 'Set OPENCRAFT_WEB_EXPECTED_LATEST to an exact version or none').toBeTruthy();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('/settings/updates', url).href);
  const username = page.locator('input[name="username"]');
  if (await username.count()) {
    const password = process.env.OPENCRAFT_PREVIEW_PASSWORD
      || (process.env.OPENCRAFT_PREVIEW_PASSWORD_FILE ? (await readFile(process.env.OPENCRAFT_PREVIEW_PASSWORD_FILE, 'utf8')).trim() : null);
    expect(password, 'Preview gateway requires a login credential supplied through the environment').toBeTruthy();
    await username.fill(process.env.OPENCRAFT_PREVIEW_USERNAME || 'preview');
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await page.goto(new URL('/settings/updates', url).href);
  }
  const check = page.getByRole('button', { name: /^(Check updates|检查更新)$/ });
  await expect(check).toBeVisible();
  const getStatus = () => page.evaluate(async () => (await fetch('/__opencraft_updates', { cache: 'no-store' })).json());
  const before = await getStatus();
  await check.click();
  await expect.poll(async () => { const s = await getStatus(); return !s.checking && s.checkedAt !== before.checkedAt; }, { timeout: 140_000 }).toBe(true);
  await expect(check).toBeEnabled();
  const after = await getStatus();
  expect(after.checkError, 'A successful HTTP POST alone is not a successful registry check').toBeNull();
  expect(after.current).toEqual(before.current); expect(after.job).toEqual(before.job);
  expect(after.authenticated).toBe(false);
  if (expected === 'none') {
    expect(after.latest).toBeNull();
    await expect(page.getByText(/^(No published release|暂无发布版本)$/)).toBeVisible();
  } else {
    expect(after.latest.version).toBe(expected);
    await expect(page.getByText(expected, { exact: true }).last()).toBeVisible();
  }
  const servedBuild = await page.evaluate(async () => (await (await fetch('/version.json', { cache: 'no-store' })).json()).buildId);
  expect(servedBuild).toBe(after.current.buildId);
  expect(await page.locator('meta[name="opencraft-build-id"]').getAttribute('content')).toBe(servedBuild);
  expect(errors).toEqual([]);
  const screenshot = process.env.OPENCRAFT_WEB_SMOKE_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
});
