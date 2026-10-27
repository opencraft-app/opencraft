import { test, expect } from '@playwright/test';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createManagedWebServer } from '../../scripts/web-deployment/server.mjs';
import { releaseFixture } from '../support/web-deployment-fixture.mjs';

// The production SPA, bundled worker/updater and real npm CLI are exercised.
// Only the registry and execution endpoint are local fixtures: no publishing,
// user credentials, existing deployment state or model inference is required.
let directory; let fixture; let app; let base; let backend; let probeConnections;
let pageErrors; let releaseLookup; let releaseDownload;
const api = '/__opencraft_updates';
const labels = {
  check: /^(Check updates|检查更新)$/,
  install: /^(Update website|更新网站)$/,
  rollback: /^(Roll back previous version|回退上一版)$/,
  authorize: /^(Authorize management|授权管理)$/,
  key: /^(Deployment administrator key|部署管理员密钥)$/,
  logout: /^(End administrator session|结束管理会话)$/,
};
const button = (page, name) => page.getByRole('button', { name: labels[name] });
// Settings are organized by machine: two configured Hosts surface as two
// machines and the reachable accessible name carries the machine count badge.
const machinesNav = /^(Machines|机器) ?2$/;
const machineRowAction = /^(Open|打开)$/;
const status = async page => page.evaluate(async path => (await fetch(path, { cache: 'no-store' })).json(), api);
async function check(page) {
  await button(page, 'check').click();
  await expect.poll(async () => { const s = await status(page); return !!s.checkedAt && !s.checking; }).toBe(true);
  await expect(button(page, 'check')).toBeEnabled();
}
async function authorize(page) {
  await page.getByLabel(labels.key).fill((await readFile(app.adminKeyPath, 'utf8')).trim());
  await button(page, 'authorize').click();
  await expect(button(page, 'install')).toBeVisible();
  await expect(page.getByLabel(labels.key)).toHaveCount(0);
}
async function assertCurrent(page, version) {
  await expect.poll(async () => (await status(page)).current.version).toBe(version);
  await expect(page.getByText(version, { exact: true }).first()).toBeVisible();
}
async function probe(page, text) {
  return page.evaluate(text => new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error('Execution socket did not respond')), 3000);
    window.continuitySocket.onmessage = e => { clearTimeout(timeout); accept(e.data); };
    window.continuitySocket.send(text);
  }), `continuity:${text}`);
}

test.beforeAll(async () => {
  // Copy and pack four complete releases per worker before timing UI actions.
  // The hook has its own budget; individual tests keep their configured timeout.
  test.setTimeout(180_000);
  directory = await mkdtemp(join(tmpdir(), 'opencraft-playwright-updates-'));
  const realWebRoots = {};
  for (const version of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) {
    const root = join(directory, `web-${version}`); realWebRoots[version] = root;
    await cp(resolve('apps/workbench-web/dist'), root, { recursive: true });
    const versionPath = join(root, 'version.json');
    const metadata = JSON.parse(await readFile(versionPath, 'utf8'));
    const htmlPath = join(root, 'index.html');
    await writeFile(htmlPath, (await readFile(htmlPath, 'utf8')).replace(`content="${metadata.buildId}"`, `content="e2e-${version}"`));
    await writeFile(versionPath, JSON.stringify({ ...metadata, buildId: `e2e-${version}` }));
  }
  fixture = await releaseFixture(directory, { realWebRoots });
});
test.beforeEach(async ({ page }) => {
  fixture.select('1.1.0'); fixture.lookupError(null); fixture.holdLookup(null); fixture.holdDownload(null); fixture.failDownload(false);
  probeConnections = new Set(); pageErrors = []; releaseLookup = null; releaseDownload = null;
  page.on('pageerror', error => pageErrors.push(error.message));
  backend = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(backend, 'listening');
  backend.on('connection', socket => socket.on('message', data => {
    const text = data.toString();
    if (text.startsWith('continuity:')) { probeConnections.add(socket); socket.send(text); }
    else {
      const request = JSON.parse(text);
      if (request.id != null) socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: 'No execution in this fixture' } }));
    }
  }));
  const stateDirectory = await mkdtemp(join(directory, 'state-'));
  app = await createManagedWebServer({ initialRelease: fixture.releases.get('1.0.0').packageRoot,
    stateDirectory, registry: fixture.registry, userconfig: fixture.userconfig,
    appServerTarget: `ws://127.0.0.1:${backend.address().port}/rpc`,
    codexServerTarget: `ws://127.0.0.1:${backend.address().port}/rpc/codex` });
  base = `http://127.0.0.1:${(await app.listen({ port: 0 })).port}`;
  await page.goto(`${base}/settings/updates`);
  await expect(button(page, 'check')).toBeVisible();
  // The settings shell starts a one-shot automatic check when the persisted
  // status has no checkedAt. Let that real background check settle before a
  // test holds the next npm lookup; otherwise the hold can time out the
  // automatic check and insert its error notice while a test is measuring the
  // administrator form.
  await expect.poll(async () => { const s = await status(page); return !!s.checkedAt && !s.checking; }, { timeout: 15_000 }).toBe(true);
});
test.afterEach(async () => {
  releaseLookup?.(); releaseDownload?.(); fixture.holdLookup(null); fixture.holdDownload(null);
  await app?.close(); app = null;
  for (const socket of backend?.clients ?? []) socket.terminate();
  if (backend) await new Promise(done => backend.close(done));
  expect(pageErrors).toEqual([]);
});
test.afterAll(async () => { await fixture?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

test('generic release discovers runtime Codex Host and built-in settings before and after update', async ({ page }) => {
  const assertDeployment = async () => {
    const config = await page.locator('#opencraft-deployment-config').textContent();
    expect(JSON.parse(config)).toEqual({ hosts: [
      { hostId: 'local', label: 'Server', kind: 'remote-control', url: '/appserver' },
      { hostId: 'local-codex', label: 'Server', kind: 'remote-control', url: '/codex-appserver' },
    ], builtinAgents: true, hypernode: false });
    const profiles = await page.evaluate(async () => {
      const db = await new Promise((accept, reject) => {
        const request = indexedDB.open('opencraft-host-connections');
        request.onsuccess = () => accept(request.result); request.onerror = () => reject(request.error);
      });
      try { return await new Promise((accept, reject) => {
        const request = db.transaction('profiles').objectStore('profiles').getAll();
        request.onsuccess = () => accept(request.result.map(profile => profile.hostId).sort());
        request.onerror = () => reject(request.error);
      }); } finally { db.close(); }
    });
    expect(profiles).toEqual(['local', 'local-codex']);
    const nav = page.locator(".settings-page__navigation .ui-navigation-list:visible");
    await expect(nav.getByText(/^(Run|运行)$/)).toBeVisible();
    const machines = nav.getByRole('button', { name: machinesNav });
    await expect(machines).toBeVisible();
    await machines.click();
    const rowAction = page.getByRole('button', { name: machineRowAction });
    await expect(rowAction).toHaveCount(2);
    // Each machine page exposes its Agent's built-in settings in the Agent row;
    // opening both configured machines must reach both entries.
    const opened = [];
    for (let index = 0; index < 2; index++) {
      await rowAction.nth(index).click();
      await expect(page.getByRole('heading', { name: /^(Agent|Agent)$/ })).toBeVisible();
      // The Run group also exposes first-level sidebar entries with the same
      // names, so scope to the machine page's Agent section (semantic region)
      // instead of the whole page.
      const agentRegion = page.getByRole('region', { name: /^Agent$/ });
      await expect(agentRegion).toBeVisible();
      const services = agentRegion.getByRole('button', { name: /^(Model services|模型服务)$/ });
      const accounts = agentRegion.getByRole('button', { name: /^(Codex accounts|Codex 账户)$/ });
      await expect(services.or(accounts)).toHaveCount(1);
      const servicesOpen = (await services.count()) === 1;
      await (servicesOpen ? services : accounts).click();
      await expect(page.getByRole('heading', { name: servicesOpen ? '全部提供商' : 'Codex 账户' })).toBeVisible();
      opened.push(servicesOpen ? 'model services' : 'codex accounts');
      await machines.click();
      await expect(rowAction).toHaveCount(2);
    }
    expect(opened.sort()).toEqual(['codex accounts', 'model services']);
    await nav.getByRole('button', { name: /^(Website updates|网站更新)$/ }).click();
    await expect(button(page, 'check')).toBeVisible();
  };
  await assertDeployment();
  await check(page); await authorize(page); await button(page, 'install').click();
  await expect.poll(async () => (await status(page)).job?.phase).toBe('completed');
  await page.reload(); await expect(button(page, 'check')).toBeVisible();
  await assertDeployment();
});

test('anonymous check finds the real npm release and preserves the administrator draft during lookup', async ({ page }) => {
  expect((await status(page)).authenticated).toBe(false);
  await expect(button(page, 'install')).toHaveCount(0);
  const input = page.getByLabel(labels.key);
  await input.fill('unsaved-draft');
  const before = await input.boundingBox();
  fixture.holdLookup(new Promise(done => { releaseLookup = done; }));
  await button(page, 'check').click();
  await expect.poll(async () => (await status(page)).checking).toBe(true);
  await expect(button(page, 'check')).toBeDisabled(); await expect(input).toBeEnabled();
  await input.fill('edited-while-checking');
  expect(await input.boundingBox()).toEqual(before);
  releaseLookup(); fixture.holdLookup(null);
  await expect(page.getByText('1.1.0', { exact: true })).toBeVisible();
  const result = await status(page);
  expect(result.latest).toEqual({ version: '1.1.0', buildId: 'e2e-1.1.0' });
  expect(result.checkError).toBeNull(); expect(result.updateAvailable).toBe(true);
  expect(result.current.version).toBe('1.0.0'); expect(result.job).toBeNull();
  await expect(input).toHaveValue('edited-while-checking');
});

for (const code of [404]) test(`missing release (${code}) is not reported as a credentials failure`, async ({ page }) => {
  fixture.lookupError({ status: code, message: 'npm包[@opencraft-app/opencraft]不存在' });
  await check(page);
  await expect(page.getByText(/^(No published release|暂无发布版本)$/)).toBeVisible();
  await expect(page.getByText(/npm request failed|npm 认证失败/)).toHaveCount(0);
  const result = await status(page);
  expect(result.checkError).toBeNull(); expect(result.latest).toBeNull(); expect(result.updateAvailable).toBe(false);
  await assertCurrent(page, '1.0.0');
  await authorize(page); await expect(button(page, 'install')).toBeDisabled();
});

for (const [code, kind, text] of [
  [401, 'authentication', /npm authentication failed|npm 认证失败/],
  [503, 'network', /Cannot reach the npm registry|无法连接npm 源/],
  [400, 'registry', /The npm registry rejected|npm 源拒绝/],
]) test(`lookup failure ${code} is actionable and a retry recovers`, async ({ page }) => {
  fixture.lookupError({ status: code, message: 'private-registry-detail-do-not-expose' });
  await check(page); await expect(page.getByText(text)).toBeVisible();
  expect((await status(page)).checkErrorCode).toBe(kind);
  await expect(page.getByText('private-registry-detail-do-not-expose')).toHaveCount(0);
  await expect(page.getByText(/^(Check failed|检查失败)$/)).toBeVisible();
  fixture.lookupError(null); await check(page);
  await expect(page.getByText('1.1.0', { exact: true })).toBeVisible();
  await expect(page.getByText(text)).toHaveCount(0);
  expect((await status(page)).checkError).toBeNull();
});

test('390px update actions keep every label inside its own button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await check(page); await authorize(page);
  const failures = await page.locator('.settings-control-actions.web-updates-actions button').evaluateAll(buttons => buttons.flatMap(button => {
    const range = document.createRange(); range.selectNodeContents(button);
    const text = range.getBoundingClientRect(); const box = button.getBoundingClientRect();
    const label = (button.textContent ?? '').trim();
    return text.left < box.left - 0.5 || text.right > box.right + 0.5
      ? [{ label, textLeft: text.left, textRight: text.right, buttonLeft: box.left, buttonRight: box.right }]
      : [];
  }));
  expect(failures).toEqual([]);
});

test('install and rollback preserve the execution WebSocket and serve the selected build to new pages', async ({ page, context }) => {
  await check(page); await authorize(page);
  await page.evaluate(() => new Promise((accept, reject) => {
    window.continuitySocket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/appserver`);
    window.continuitySocket.onopen = () => accept(); window.continuitySocket.onerror = () => reject(new Error('Cannot open execution socket'));
  }));
  expect(await probe(page, 'before')).toBe('continuity:before');
  fixture.holdDownload(new Promise(done => { releaseDownload = done; }));
  await button(page, 'install').click();
  await expect.poll(async () => (await status(page)).job?.phase).toBe('downloading');
  expect(await probe(page, 'during')).toBe('continuity:during');
  await expect(button(page, 'install')).toBeDisabled();
  releaseDownload(); fixture.holdDownload(null);
  await assertCurrent(page, '1.1.0');
  await expect.poll(async () => (await status(page)).job?.phase).toBe('completed');
  await expect(button(page, 'rollback')).toBeEnabled();
  expect(await probe(page, 'upgraded')).toBe('continuity:upgraded');
  await expect(page.getByText(/This page is still displaying the previous build|当前页面仍显示旧版/)).toBeVisible();
  const fresh = await context.newPage();
  await fresh.goto(`${base}/settings/updates`); await expect(button(fresh, 'check')).toBeVisible();
  expect(await fresh.locator('meta[name="opencraft-build-id"]').getAttribute('content')).toBe('e2e-1.1.0');
  await fresh.close();
  await button(page, 'rollback').click(); await assertCurrent(page, '1.0.0');
  await expect.poll(async () => (await status(page)).job?.phase).toBe('completed');
  expect(await probe(page, 'rolled-back')).toBe('continuity:rolled-back'); expect(probeConnections.size).toBe(1);
  const persisted = JSON.parse(await readFile(join(app.adminKeyPath, '..', 'deployment.json'), 'utf8'));
  expect(persisted.current.version).toBe('1.0.0');
  await button(page, 'logout').click(); await expect(page.getByLabel(labels.key)).toBeVisible();
  await expect(button(page, 'install')).toHaveCount(0);
});

test('failed worker startup retains the installed site and can be retried with a healthy release', async ({ page }) => {
  fixture.select('1.2.0'); await check(page); await authorize(page);
  await button(page, 'install').click();
  await expect.poll(async () => (await status(page)).job?.phase).toBe('failed');
  await expect(page.getByText(/New Web worker exited before readiness/)).toBeVisible();
  await assertCurrent(page, '1.0.0');
  fixture.select('1.1.0'); await check(page); await button(page, 'install').click();
  await assertCurrent(page, '1.1.0');
  await expect.poll(async () => (await status(page)).job?.phase).toBe('completed');
});

test('management requires authorization and cross-origin requests cannot start an operation', async ({ page }) => {
  const codes = await page.evaluate(async api => {
    const post = (name, input = {}) => fetch(`${api}/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).then(r => r.status);
    return [await post('install', { version: '1.1.0' }), await post('rollback'), await post('login', { key: 'wrong' })];
  }, api);
  expect(codes).toEqual([401, 401, 401]);
  const foreign = await page.request.post(`${base}${api}/check`, { headers: { origin: 'https://foreign.test' }, data: {} });
  expect(foreign.status()).toBe(403);
  expect((await status(page)).job).toBeNull();
  await check(page); expect((await status(page)).latest.version).toBe('1.1.0');
});
