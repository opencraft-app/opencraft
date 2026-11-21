import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { ServerInformationStore, serverInformationHttp } from '../../../apps/headless-server/src/server-information.mjs';

// Real React Settings primitives, locale, server-scoped fetch, HTTP API and durable
// configuration. Authentication roles are synthetic; no production data or sends.
const directory = await mkdtemp(join(tmpdir(), 'server-information-browser-'));
const artifacts = process.env.OPENCRAFT_SERVER_INFORMATION_ARTIFACTS ?? join(directory, 'screenshots'); await mkdir(artifacts, { recursive: true });
let store, actorId = 'fixture-admin', administrator = true, expired = false, failRead = false, delayRead = 0;
let publicOrigin;
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', cacheDir: join(directory, 'vite-cache'), resolve: { dedupe: ['react', 'react-dom', 'react-intl'] }, esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'server-information-fixture', configureServer(vite) { vite.middlewares.use((req, res, next) => {
    if (req.url?.startsWith('/servers/fixture/__opencraft_server_information')) {
      req.url = req.url.slice('/servers/fixture'.length);
      if (failRead && req.method === 'GET') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return; }
      const handle = () => void serverInformationHttp(store, () => expired ? null : ({ actorId, administrator, origin: publicOrigin }))(req, res);
      if (delayRead && req.method === 'GET') setTimeout(handle, delayRead); else handle(); return;
    }
    if (req.url?.split('?')[0] !== '/') return next();
    res.setHeader('content-type', 'text/html'); res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script id="opencraft-server-context" type="application/json">{"id":"fixture","name":"Fixture server","basePath":"/servers/fixture","selectorPath":"/servers"}</script><script type="module" src="/tests/fixtures/server-information.tsx"></script></body></html>');
  }); } }] });
let browser;
try {
  await server.listen(); publicOrigin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
  for (const touch of [false, true]) for (const theme of ['light', 'dark']) {
    const locale = touch ? 'zh-CN' : 'en-US', name = `${touch ? 'touch' : 'pointer'}-${theme}`;
    store = new ServerInformationStore(join(directory, name + '.json')); administrator = true; expired = false; failRead = false;
    const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message)); await page.addInitScript('window.__name = value => value');
    await page.goto(publicOrigin + '/?locale=' + locale + '&theme=' + theme);
    const field = page.getByRole('textbox', { name: touch ? '公开访问地址' : 'Public access URL', exact: true });
    const save = page.getByRole('button', { name: touch ? '保存' : 'Save', exact: true });
    const reload = page.getByRole('button', { name: touch ? '重新载入' : 'Reload', exact: true });
    await field.waitFor(); await page.waitForFunction(() => !document.querySelector('input#server-public-url')?.readOnly);
    assert.equal(await field.inputValue(), ''); assert.equal(await save.isDisabled(), true);
    const entry = 'https://notify.example/servers/hub-fixture'; await field.fill(entry); await (touch ? save.tap() : save.click()); await page.getByRole('status').filter({ hasText: touch ? '已保存' : 'Saved.' }).waitFor();
    assert.equal((await store.read()).publicUrl, entry); assert.equal((await store.read()).revision, 1);
    await page.screenshot({ path: join(artifacts, name + '.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.reload(); await page.waitForFunction(() => document.querySelector('input#server-public-url')?.value === 'https://notify.example/servers/hub-fixture');
    await field.fill('https://draft.example'); failRead = true; await (touch ? reload.tap() : reload.click()); await page.getByRole('alert').waitFor(); assert.equal(await field.inputValue(), entry, 'explicit reload discarded draft but retained last successful configuration');
    failRead = false; await (touch ? reload.tap() : reload.click()); await page.waitForFunction(() => !document.querySelector('input#server-public-url')?.readOnly);
    await field.fill('https://draft.example'); await store.write(1, 'https://other-admin.example', 'other-admin', () => {}); await (touch ? save.tap() : save.click()); await page.getByRole('alert').waitFor(); assert.equal(await field.inputValue(), 'https://draft.example'); assert.equal(await save.isDisabled(), true);
    await (touch ? reload.tap() : reload.click()); await page.waitForFunction(() => document.querySelector('input#server-public-url')?.value === 'https://other-admin.example');
    administrator = false; await (touch ? reload.tap() : reload.click()); await page.waitForFunction(() => document.querySelector('input#server-public-url')?.readOnly); assert.equal(await save.isDisabled(), true);
    administrator = true; expired = true; await (touch ? reload.tap() : reload.click()); await field.waitFor({ state: 'detached' }); await page.getByRole('alert').waitFor();
    assert.deepEqual(errors, []); await context.close();
  }
  console.log('PASS four real Settings pointer/touch light/dark cases, scoped API, save/reload, durable entry, cached errors, conflict-preserved draft, member read-only, session expiry and no horizontal overflow. Artifacts: ' + artifacts);
} finally { await browser?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
