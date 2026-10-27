import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createManagedWebServer } from '../../scripts/web-deployment/server.mjs';
import { startAgent } from '../../scripts/full-upgrade/agent.mjs';
import { signedInspectionFixture } from '../support/full-upgrade-fixture.mjs';
import { releaseFixture } from '../support/web-deployment-fixture.mjs';
test.skip(process.platform !== 'linux' || process.getuid?.() !== 0, 'Requires an isolated root-owned upgrade configuration');
let root, fixture, app, agent, config, base;
const api = '/__opencraft_updates';
const region = page => page.getByRole('region', { name: /^(All updates|全部更新)$/ });
async function post(page, action, body = {}) {
  return page.evaluate(async ({ api, action, body }) => {
    const response = await fetch(api + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  }, { api, action, body });
}
async function authorize(page) {
  await page.getByLabel(/^(Deployment administrator key|部署管理员密钥)$/).fill((await readFile(app.adminKeyPath, 'utf8')).trim());
  await page.getByRole('button', { name: /^(Authorize management|授权管理)$/ }).click();
  await expect(region(page)).toBeVisible();
}
test.beforeAll(async () => {
  test.setTimeout(180000);
  root = await mkdtemp(join(homedir(), '.opencraft-p2d-e2e-'));
  fixture = await releaseFixture(root, { realWebRoot: resolve('apps/workbench-web/dist') });
});
test.beforeEach(async ({ page }) => {
  const run = await mkdtemp(join(root, 'run-'));
  config = { protocol: 1, mode: 'local', stateRoot: join(run, 'agent-state'), controlStateRoot: join(run, 'control'),
    runtimeRoot: join(run, 'ipc'), artifactRoot: join(run, 'artifacts'), deployLock: join(run, 'activation.lock'),
    profilePath: join(run, 'profile.json'), targetRoot: join(run, 'fixed-target'), webState: join(run, 'web'), trustFile: join(run, 'missing-trust') };
  await mkdir(config.runtimeRoot + '-agent');
  const path = join(run, 'config.json'); await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  agent = await startAgent(config, resolve('scripts/full-upgrade/agent.mjs'));
  app = await createManagedWebServer({ initialRelease: fixture.releases.get('1.0.0').packageRoot,
    stateDirectory: config.webState, registry: fixture.registry, userconfig: fixture.userconfig, upgradeConfigPath: path });
  base = `http://127.0.0.1:${(await app.listen({ port: 0 })).port}`;
  await page.goto(base + '/settings/updates');
  await expect.poll(async () => (await page.request.get(base + api)).json().then(s => s.checking)).toBe(false);
});
test.afterEach(async () => {
  fixture.holdDownload(null);
  await app?.close();
  if (agent) { await new Promise(done => agent.server.close(done)); await agent.journal.close(); }
});
test.afterAll(async () => { await fixture?.close(); await rm(root, { recursive: true, force: true }); });

test('only the deployment administrator can inspect and stop; missing signature stays blocked across reload', async ({ page }) => {
  expect((await page.request.get(base + api + '/full')).status()).toBe(401);
  expect((await post(page, 'full/check')).status).toBe(401);
  await expect(region(page)).toHaveCount(0);
  await authorize(page);
  await region(page).getByRole('button', { name: /^(Check updates|检查更新)$/ }).click();
  await expect(region(page).getByText(/^(Upgrade requirements not met|升级条件未满足)$/).first()).toBeVisible();
  await expect(region(page).getByRole('button', { name: /^(Upgrade all components|升级全部组件)$/ })).toBeDisabled();
  await page.reload();
  await expect(region(page).getByText(/^(Upgrade requirements not met|升级条件未满足)$/).first()).toBeVisible();
  expect((await post(page, 'full/start', { planDigest: 'a'.repeat(64) })).status).toBe(400);
  expect((await post(page, 'full/check', { command: 'untrusted' })).status).toBe(400);
});

test('official Web child id survives duplicate clicks, cancellation and fresh-page recovery', async ({ page }) => {
  await authorize(page);
  await post(page, 'check');
  await expect.poll(async () => (await page.request.get(base + api)).json().then(s => s.latest?.version)).toBe('1.1.0');
  let releaseDownload; fixture.holdDownload(new Promise(done => { releaseDownload = done; }));
  try {
    const [accepted, duplicate] = await Promise.all([post(page, 'install', { version: '1.1.0' }), post(page, 'install', { version: '1.1.0' })]);
    expect(duplicate.value.jobId).toBe(accepted.value.jobId);
    await expect(region(page).getByRole('button', { name: /^(Cancel upgrade|取消升级)$/ })).toBeVisible();
    await region(page).getByRole('button', { name: /^(Cancel upgrade|取消升级)$/ }).click();
    releaseDownload(); fixture.holdDownload(null);
    await expect(region(page).getByText(/^(Stopped at a safe point|已安全停止)$/).first()).toBeVisible();
    const status = await (await page.request.get(base + api)).json(); expect(status.current.version).toBe('1.0.0');
    await page.reload();
    await expect(region(page).getByText('web-' + accepted.value.jobId, { exact: true })).toBeVisible();
    await expect(region(page).getByText(/^(Stopped at a safe point|已安全停止)$/).first()).toBeVisible();
  } finally { releaseDownload?.(); }
});

test('generation draining and local recovery render from durable journals in wide and touch layouts', async ({ page }) => {
  await signedInspectionFixture(config);
  const h = 'b'.repeat(64);
  for (const [id, state] of [['generation-one', 'active-draining'], ['generation-two', 'recovery-required']]) {
    const job = await agent.journal.create({ operationId: id, planDigest: h, manifestSha256: h, inventoryFingerprint: h, bootId: 'fixture-boot',
      steps: [{ stepId: 'activate', ownerId: 'codex-generation', action: 'activate', epoch: 1, fence: 'fixture-owner' }] });
    job.state = state; job.startedAt = '2026-10-28T00:00:00Z'; await agent.journal.save(job);
  }
  await authorize(page);
  await region(page).getByRole('button', { name: /^(Check updates|检查更新)$/ }).click();
  await expect(region(page).getByText('fixture-release', { exact: true }).first()).toBeVisible();
  await expect(region(page).getByText(/^(Local recovery required|需在服务器上恢复)$/).first()).toBeVisible();
  await expect(region(page).getByText(/reconcile generation-two/)).toBeVisible();
  expect(await region(page).locator('code.full-upgrade-recovery').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(region(page).getByRole('button', { name: /force|强制|reconcile|对账/i })).toHaveCount(0);
  const output = process.env.OPENCRAFT_UPGRADE_SCREENSHOTS;
  if (output) await page.screenshot({ path: join(output, 'updates-desktop.png'), fullPage: true });
  const touch = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  const narrow = await touch.newPage(); await narrow.goto(base + '/settings/updates'); await authorize(narrow);
  await expect(region(narrow).getByText('需在服务器上恢复').first()).toBeVisible();
  expect(await narrow.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (output) {
    await narrow.screenshot({ path: join(output, 'updates-touch.png'), fullPage: true });
    await region(narrow).locator('code.full-upgrade-recovery').scrollIntoViewIfNeeded();
    await narrow.screenshot({ path: join(output, 'updates-recovery-touch.png'), fullPage: true });
  }
  await touch.close();
});

test('signed fixed target replans after inventory drift and requires another explicit click', async ({ page }) => {
  await signedInspectionFixture(config);
  await authorize(page);
  const checked = await post(page, 'full/check');
  expect(checked.status).toBe(200); expect(checked.value.plan.releaseId).toBe('fixture-release');
  const profile = JSON.parse(await readFile(config.profilePath, 'utf8'));
  profile.storeRoots = [join(config.stateRoot, 'new-isolated-empty-root')];
  await writeFile(config.profilePath, JSON.stringify(profile));
  const started = await post(page, 'full/start', { planDigest: checked.value.plan.planDigest });
  expect(started.status).toBe(200); expect(started.value.replanRequired).toBe(true);
  expect(started.value.plan.executable).toBe(false); expect(started.value.job.state).toBe('blocked');
  expect(started.value.plan.planDigest).not.toBe(checked.value.plan.planDigest);
  expect((await post(page, 'full/start', { planDigest: checked.value.plan.planDigest })).status).toBe(400);
  expect((await agent.journal.list()).every(j => j.state === 'blocked' && j.steps.length === 0)).toBe(true);
});

test('an unknown Web child blocks a fresh install and keeps recovery local', async ({ page }) => {
  const childId = 'uncertain-web-child';
  await mkdir(join(config.webState, 'upgrade-children'), { recursive: true });
  await writeFile(join(config.webState, 'upgrade-children', childId + '.json'), JSON.stringify({ schemaVersion: 1, id: childId, version: '2', buildId: 'b2', phase: 'recovery-required', startedAt: null, finishedAt: null }));
  const { webChildControl } = await import('../../scripts/full-upgrade/web-child.mjs');
  await webChildControl(config, { operationId: childId }, agent.journal, 'fixture-boot');
  await authorize(page); await post(page, 'check');
  await expect.poll(async () => (await page.request.get(base + api)).json().then(s => s.checking)).toBe(false);
  expect((await post(page, 'install', { version: '1.1.0' })).status).toBe(409);
  expect((await post(page, 'rollback')).status).toBe(409);
  const status = await (await page.request.get(base + api)).json(); expect(status.recoveryRequired).toBe(true); expect(status.current.version).toBe('1.0.0');
});
