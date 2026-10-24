import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { humanAuthFixture } from '../../../tests/support/human-auth-fixture';

const output = process.env.OPENCRAFT_HUMAN_AUTH_REPORT ?? '/tmp/opencraft-human-auth-smoke';
await mkdir(output, { recursive: true });
const cleanups: Array<() => Promise<void>> = [];
const fixture = await humanAuthFixture({ after(close: () => Promise<void>) { cleanups.push(close); } });
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
try {
  const password = 'fixture-browser-passphrase';
  const p = await fixture.localAccounts.create('alice', 'Alice', password);
  const human = fixture.actors.resolveHuman(p)!;
  fixture.members.setActor(human.actorId, 'admin', true, 'fixture-operator');
  const results: unknown[] = [];
  for (const width of [390, 1280]) for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, hasTouch: width === 390 });
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.origin + '/');
    await page.getByRole('link', { name: '登录与账号' }).click();
    await page.getByLabel('用户名').fill('alice'); await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL(fixture.origin + '/');
    await page.goto(fixture.origin + '/__opencraft_auth/');
    await page.getByRole('heading', { name: '已绑定的登录方式' }).waitFor();
    assert.equal(await page.locator('html').evaluate(el => el.scrollWidth > window.innerWidth), false);
    await page.screenshot({ path: `${output}/account-${width}-${colorScheme}.png`, fullPage: true });
    const cookies = await context.cookies();
    assert.ok(cookies.some(cookie => cookie.name === 'oc_human' && cookie.httpOnly && cookie.sameSite === 'Lax'));
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByRole('heading', { name: '登录 OpenCraft', exact: true }).waitFor();
    await page.screenshot({ path: `${output}/login-${width}-${colorScheme}.png`, fullPage: true });
    results.push({ width, colorScheme, errors }); assert.deepEqual(errors, []);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage();
  await page.goto(fixture.origin + '/__opencraft_auth/');
  await page.getByLabel('用户名').fill('alice'); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL(fixture.origin + '/');
  await page.goto(fixture.origin + '/__opencraft_auth/');
  await page.getByRole('button', { name: '绑定 企业单点登录' }).click();
  await page.waitForURL(fixture.origin + '/__opencraft_auth/');
  await page.getByText('企业单点登录 · Example Person', { exact: true }).waitFor();
  assert.equal(fixture.actors.bindings(human.actorId).length, 2);
  assert.equal(fixture.actors.list().filter(actor => actor.kind === 'human').length, 1);
  await page.screenshot({ path: `${output}/linked-390.png`, fullPage: true });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: '使用 企业单点登录 登录' }).click();
  await page.waitForURL(fixture.origin + '/');
  const me = await context.request.get(fixture.origin + '/__opencraft_actors/me');
  assert.equal((await me.json()).actor.id, human.actorId);
  await page.goto(fixture.origin + '/__opencraft_auth/');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('heading', { name: '登录 OpenCraft', exact: true }).waitFor();
  const hold = fixture.issuer.holdToken();
  await page.getByRole('button', { name: '使用 企业单点登录 登录' }).click({ noWaitAfter: true });
  await hold.reached;
  const cancelled = await context.request.post(fixture.origin + '/__opencraft_auth/cancel', { headers: { origin: fixture.origin }, data: {} });
  assert.equal(cancelled.status(), 200); hold.resume();
  await page.waitForURL(fixture.origin + '/__opencraft_auth/?error=login_failed');
  assert.equal((await context.cookies()).some(cookie => cookie.name === 'oc_human'), false);
  await context.close();
  await writeFile(`${output}/result.json`, JSON.stringify({ results, linkedActor: human.actorId,
    oidc: 'real browser code/PKCE/nonce/state/signature through isolated identity-server fixture', cancelledLateCallback: true,
    externalEnterpriseIdp: 'not exercised', workbench: 'minimal static fixture; no inference or user data' }, null, 2));
  console.log('Human authentication browser smoke passed: four layouts/themes, local/OIDC/link/logout/cancelled late callback.');
} finally { await browser.close(); for (const close of cleanups.reverse()) await close(); }
