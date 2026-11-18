import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from '@playwright/test';
import { createWorkbenchWebConfig } from '../../../apps/workbench-web/vite.config';

const withHost = process.argv.includes('--with-host');
const output = resolve(process.env.OPENCRAFT_SERVER_SETTINGS_SMOKE_DIRECTORY ?? `.local/server-selection-settings/${withHost ? 'active' : 'hostless'}`);
await mkdir(output, { recursive: true });
const workbenchConfig = createWorkbenchWebConfig({ command: 'serve', mode: 'development' });
const source = `import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId,lavenderThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
if (${withHost}) {const config=document.createElement('script'); config.id='opencraft-deployment-config';config.type='application/json';config.textContent=JSON.stringify({hosts:[{hostId:'fixture-host',label:'Fixture Host',kind:'remote-ssh',url:location.origin.replace('http','ws')+'/fixture-rpc'}],builtinAgents:false,hypernode:false});document.head.append(config);}
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',...(${withHost}?{clientProduct:createSmokeClientProduct()}: {})});
application.supervisor.navigation.openSettings('appearance');
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN').render(<WorkbenchRoot application={application}/>);
window.proof={mode:application.supervisor.mode,theme:setThemePreference,extensionTheme:()=>setAppearanceThemeId(lavenderThemeId)};`;
const icon = await readFile('apps/workbench-web/public/opencraft-icon.svg');
const vite = await createServer({ configFile: false, cacheDir: '.local/server-brand/vite-cache', root: process.cwd(), logLevel: 'error',
  define: { 'process.env.NEXT_PUBLIC_REGION': '"cn"', 'process.env.NEXT_PUBLIC_PREVIEW_LOCALES': '""', 'import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN': '"false"', 'import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN': '"false"', 'import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST': '"false"' },
  optimizeDeps: { ...workbenchConfig.optimizeDeps, include: [...workbenchConfig.optimizeDeps!.include!, '@opencraft/browser-core', '@opencraft/browser-core/presentation', '@opencraft/browser-core/metadata-sync'] },
  esbuild: { jsx: 'automatic' }, resolve: { dedupe: ['react', 'react-dom'] }, server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'server-brand-proof', resolveId: id => id === '/proof.tsx' ? id : null, load: id => id === '/proof.tsx' ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      const url = new URL(req.url!, 'http://fixture.test');
      if (url.pathname === '/') {
        const selectorPath = url.searchParams.has('legacy') ? '/__opencraft_servers' : '/servers';
        const context = url.searchParams.has('direct') ? '' : `<script id="opencraft-server-context" type="application/json">${JSON.stringify({ id: 'team-a', name: 'Team A', basePath: selectorPath + '/team-a', selectorPath })}</script>`;
        res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${context}<div id="app"></div><script type="module" src="/proof.tsx"></script></body></html>`);
      } else if (['/servers', '/__opencraft_servers'].includes(url.pathname)) {
        res.setHeader('content-type', 'text/html'); res.end('<!doctype html><h1>Server chooser fixture</h1>');
      } else if (url.pathname.endsWith('/opencraft-icon.svg')) {
        res.setHeader('content-type', 'image/svg+xml'); res.end(icon);
      } else next();
    }); } }] });
await vite.listen();
const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--no-proxy-server'] });
const brandSelector = 'button[data-brand-action="switch-server"]';
async function interactiveBrand(page: Page, touch = false) {
  const selector = touch ? `.app-shell-floating-left-panel ${brandSelector}` : brandSelector;
  await page.waitForFunction(selector => [...document.querySelectorAll<HTMLElement>(selector)].some(node => {
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !node.closest('[inert]') && node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }), selector);
  const candidates = page.locator(selector);
  for (let i = 0; i < await candidates.count(); i++) {
    const candidate = candidates.nth(i);
    if (await candidate.evaluate(node => { const r = node.getBoundingClientRect(); return !node.closest('[inert]') && node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })) return candidate;
  }
  throw new Error('No interactive server brand');
}
try {
  const cases = [];
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    console.log('case', width, theme);
    const touch = width === 390;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.addInitScript('window.__name = target => target;');
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => !!(window as any).proof, undefined, { timeout: 60000 });
    assert.equal(await page.evaluate(() => (window as any).proof.mode), withHost ? 'active' : 'hostless');
    if (touch) await page.getByRole('button', { name: '显示侧边栏', exact: true }).first().tap();
    await page.locator('.settings-page__navigation .ui-navigation-list:visible').waitFor();
    assert.equal(await page.locator('.settings-page__navigation').getByRole('button', { name: '服务器', exact: true }).count(), 0);
    await page.evaluate(theme => (window as any).proof.theme(theme), theme);
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    const switcher = await interactiveBrand(page, touch);
    if (touch) {
      await page.waitForFunction(() => { const panel = document.querySelector('.app-shell-floating-left-panel'); if (!panel) return false; const matrix = new DOMMatrixReadOnly(getComputedStyle(panel).transform); return Math.abs(matrix.a - 1) < 0.0001 && Math.abs(matrix.d - 1) < 0.0001; });
      await switcher.tap({ trial: true });
    } else await switcher.click({ trial: true });
    await page.screenshot({ path: join(output, `${width}-${theme}.png`), fullPage: true });
    assert.equal(await switcher.getAttribute('aria-label'), '切换服务器 · Team A');
    assert.equal(await switcher.locator('svg').count(), 1);
    const brandGeometry = await switcher.evaluate(node => {
      const r = node.getBoundingClientRect();
      return { x: r.x, width: r.width, height: r.height, children: [...node.children].map(child => { const c = child.getBoundingClientRect(); return { x: c.x, right: c.right, width: c.width }; }).filter(c => c.width > 0) };
    });
    assert(brandGeometry.x >= 0 && brandGeometry.children.every(c => c.x >= brandGeometry.x && c.right <= brandGeometry.x + brandGeometry.width + 1), JSON.stringify(brandGeometry));
    const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert(geometry.scrollWidth <= geometry.width + 1, JSON.stringify(geometry));
    if (touch) await switcher.tap(); else { await switcher.focus(); await page.keyboard.press('Enter'); }
    await page.getByRole('heading', { name: 'Server chooser fixture', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/servers');
    assert.deepEqual(errors, []); cases.push({ width, theme, geometry, brandGeometry, input: touch ? 'touch' : 'keyboard', errors });
    await context.close();
  }
  const page = await browser.newPage(); await page.addInitScript('window.__name = target => target;');
  await page.goto(origin + '/?legacy', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await (await interactiveBrand(page)).click();
  await page.getByRole('heading', { name: 'Server chooser fixture', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/__opencraft_servers');
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!(window as any).proof);
  await page.evaluate(() => (window as any).proof.extensionTheme());
  const themedBrand = await interactiveBrand(page);
  await themedBrand.click({ trial: true });
  await page.screenshot({ path: join(output, '1280-lavender.png'), fullPage: true });
  await themedBrand.click();
  await page.getByRole('heading', { name: 'Server chooser fixture', exact: true }).waitFor();
  await page.goto(origin + '/?direct', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.locator('.settings-page__navigation .ui-navigation-list:visible').waitFor();
  assert.equal(await page.locator(brandSelector).count(), 0);
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ mode: withHost ? 'active' : 'hostless', cases, legacyContext: true, extensionTheme: 'lavender', directDeploymentHasNoDeadEntry: true,
    boundary: 'Real Workbench Shell, settings and mobile drawer; synthetic deployment context, optional unavailable fixture Host and chooser destination. No production server, membership or authentication writes.' }, null, 2));
  console.log(JSON.stringify({ output, cases: cases.length, success: true }));
} finally { await browser.close(); await vite.close(); }
