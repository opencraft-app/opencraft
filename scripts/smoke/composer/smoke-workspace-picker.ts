import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', cacheDir: 'node_modules/.vite-workspace-picker',
  esbuild: { jsx: 'automatic' }, resolve: { dedupe: ['react', 'react-dom'] }, server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'workspace-picker', configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url?.split('?')[0] !== '/') return next();
    res.setHeader('content-type', 'text/html'); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/workspace-picker.tsx"></script>');
  }); } }] });
await vite.listen();
const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
try {
  for (const touch of [false, true]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 844 }, hasTouch: touch, isMobile: touch });
    await context.addInitScript('window.__name=value=>value');
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(60_000);
    page.on('pageerror', error => errors.push(error.message));
    let releaseMenus!: () => void;
    const menusReady = new Promise<void>(resolve => { releaseMenus = resolve; });
    await page.route('**/draft-execution-utility-bar.tsx*', async route => { await menusReady; await route.continue(); });
    await page.goto(`${vite.resolvedUrls!.local[0]}?toolbar&theme=${theme}${touch ? '' : '&desktop'}`, { waitUntil: 'domcontentloaded' });
    const editor = page.locator('.opencraft-composer-editor'); await editor.waitFor();
    await editor.fill('Keep this workspace draft');
    await editor.evaluate(element => { (window as any).keptEditor = element; });
    assert.equal(await page.getByRole('button', { name: 'Choose workspace', exact: true }).count(), 0);
    releaseMenus();
    const trigger = page.getByRole('button', { name: 'Choose workspace', exact: true });
    const open = async () => {
      await trigger.scrollIntoViewIfNeeded();
      if (touch) await trigger.tap(); else { await trigger.focus(); await page.keyboard.press('Enter'); }
      await page.getByRole('searchbox', { name: 'Search workspaces' }).waitFor();
    };
    const select = async (label: string) => {
      const item = page.getByRole('menuitem').filter({ hasText: label });
      if (touch) await item.tap(); else await item.click();
    };
    const execution = () => page.evaluate(() => (window as any).picker.execution().execution);
    await open();
    assert.equal(await page.locator('.composer-utility-scroll-area__content > button').count(), 2);
    assert.equal(await page.getByRole('button', { name: 'Run environment', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Workspace source', exact: true }).count(), 0);
    const search = page.getByRole('searchbox');
    await search.fill('opencraft');
    if (touch) await select('opencraft'); else { await search.press('ArrowDown'); await page.keyboard.press('Enter'); }
    assert.equal((await execution()).workspace.projectId, 'project');
    await open();
    await page.screenshot({ path: `/tmp/workspace-picker-${touch ? 'touch' : 'desktop'}-${theme}.png` });
    await select('Shared library');
    let target = await execution();
    assert.equal(target.environment.configurationId, 'e2b');
    assert.equal(target.workspace.source.libraryId, 'shared');
    assert.equal(target.workspace.cwd, null);
    assert.equal(target.workspace.projectId, undefined);
    assert.deepEqual(target.workspace.runtimeWorkspaceRoots, []);
    await open();
    await page.evaluate(() => (window as any).picker.setAvailable(false));
    assert.equal(await page.getByRole('menuitem').filter({ hasText: 'Shared library' }).getAttribute('data-disabled'), '');
    assert.equal(await page.locator('.opencraft-composer-submit').isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal((await execution()).workspace.source.libraryId, 'shared');
    await page.evaluate(() => (window as any).picker.setAvailable(true));
    await open(); await select('New temporary workspace'); await select('other');
    target = await execution();
    assert.equal(target.environment.configurationId, 'other');
    assert.deepEqual(target.workspace, { cwd: null, runtimeWorkspaceRoots: [] });
    await open(); await select('opencraft');
    assert.equal((await execution()).environment, undefined);
    await open(); await select('New temporary workspace'); await select('Host');
    target = await execution();
    assert.equal(target.environment, undefined);
    assert.deepEqual(target.workspace, { cwd: null, runtimeWorkspaceRoots: [] });
    await open(); await select('Open folder');
    assert.equal((await execution()).workspace.cwd, '/opened-folder');
    assert.equal(await editor.innerText(), 'Keep this workspace draft');
    assert.equal(await editor.evaluate(element => element === (window as any).keptEditor), true);
    assert.deepEqual(errors, []);
    console.log(`Unified workspace picker ${touch ? 'touch' : 'desktop'} ${theme} passed`);
    await context.close();
  }
} finally { await browser.close(); await vite.close(); }
