import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const output = resolve(process.env.OPENCRAFT_SERVER_SETTINGS_SMOKE_DIRECTORY ?? '.local/server-selection-settings');
await mkdir(output, { recursive: true });
const source = `import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory'});
application.supervisor.navigation.openSettings('appearance');
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN').render(<WorkbenchRoot application={application}/>);
window.proof={theme:setThemePreference,route:()=>application.supervisor.navigation.getSnapshot().applicationRoute};`;
const vite = await createServer({ configFile: false, cacheDir: '.local/server-settings/vite-cache', root: process.cwd(), logLevel: 'error',
  define: { 'process.env.NEXT_PUBLIC_REGION': '"cn"', 'process.env.NEXT_PUBLIC_PREVIEW_LOCALES': '""', 'import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN': '"false"', 'import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN': '"false"', 'import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST': '"false"' },
  esbuild: { jsx: 'automatic' }, resolve: { dedupe: ['react', 'react-dom'] }, server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'server-selection-settings-proof', resolveId: id => id === '/proof.tsx' ? id : null, load: id => id === '/proof.tsx' ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      const url = new URL(req.url!, 'http://fixture.test');
      if (url.pathname === '/') {
        const selectorPath = url.searchParams.has('legacy') ? '/__opencraft_servers' : '/servers';
        const context = url.searchParams.has('direct') ? '' : `<script id="opencraft-server-context" type="application/json">${JSON.stringify({id:'team-a',name:'Team A',basePath:selectorPath+'/team-a',selectorPath})}</script>`;
        res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${context}<div id="app"></div><script type="module" src="/proof.tsx"></script></body></html>`);
      } else if (['/servers', '/__opencraft_servers'].includes(url.pathname)) {
        res.setHeader('content-type', 'text/html'); res.end('<!doctype html><h1>Server chooser fixture</h1>');
      } else next();
    }); } }] });
await vite.listen();
const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--no-proxy-server'] });
try {
  const cases = [];
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript('window.__name = target => target;');
    await page.goto(origin);
    if (width === 390) await page.getByRole('button', { name: '显示侧边栏', exact: true }).first().click();
    const navigation = page.getByRole('navigation', { name: 'Settings sections', exact: true });
    await navigation.getByRole('button', { name: '服务器', exact: true }).click();
    await page.getByText('当前服务器', { exact: true }).waitFor();
    await page.getByText('Team A', { exact: true }).waitFor();
    // Hostless Workbench uses its existing dismissible floating drawer.
    if (width === 390) {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Close sidebar', exact: true }).waitFor({ state: 'hidden' });
    }
    assert.equal(await page.locator('.shell-navigation__items').getByRole('button', { name: /切换服务器|Switch server/u }).count(), 0);
    await page.evaluate(theme => (window as any).proof.theme(theme), theme);
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(geometry.scrollWidth <= geometry.width + 1, JSON.stringify(geometry));
    await page.screenshot({ path: join(output, `${width}-${theme}.png`), fullPage: true });
    await page.getByRole('button', { name: '切换服务器', exact: true }).click();
    await page.getByRole('heading', { name: 'Server chooser fixture', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/servers');
    assert.deepEqual(errors, []); cases.push({ width, theme, geometry, errors }); await context.close();
  }
  const page = await browser.newPage(); await page.addInitScript('window.__name = target => target;');
  await page.goto(origin + '/?legacy');
  await page.getByRole('navigation', { name: 'Settings sections', exact: true }).getByRole('button', { name: '服务器', exact: true }).click();
  await page.getByRole('button', { name: '切换服务器', exact: true }).click();
  await page.getByRole('heading', { name: 'Server chooser fixture', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/__opencraft_servers');
  await page.goto(origin + '/?direct');
  await page.getByRole('navigation', { name: 'Settings sections', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '服务器', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '切换服务器', exact: true }).count(), 0);
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ cases, legacyContext: true, directDeploymentHasNoDeadEntry: true,
    headlessBuildFlagNotRequired: true, boundary: 'Real Workbench bootstrap, settings and mobile drawer. Synthetic deployment context; real relay, target admission and saved choices are covered by smoke-server-selection.' }, null, 2));
  console.log(JSON.stringify({ output, cases: cases.length, success: true }));
} finally { await browser.close(); await vite.close(); }
