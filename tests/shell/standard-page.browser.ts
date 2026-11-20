import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page, type BrowserContext } from 'playwright';
import { navigationLifecycleFixture } from '../fixtures/navigation-lifecycle';

// Actual Shell, Router, IM renderer and shared route-family retention. Only the
// account/channel transport is synthetic; no production data or inference.
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/standard-page');
const source = navigationLifecycleFixture
  .replace("if(method==='opencraft/personal-assistant/get')", "if(method==='opencraft/personal-assistant/bots/list')return{bots:[]};if(method==='opencraft/personal-assistant/get')")
  .replace('window.navigationProbe=navigation;', 'const routeFamilies=new Map([...views.values()].filter(v=>v.routeFamily).map(v=>[v.id,v.routeFamily]));window.navigationProbe=navigation;')
  .replace("routeStackPresentation(state,'synthetic-account')", "routeStackPresentation(state,'synthetic-account',routeFamilies)")
  .replace('<RouteViewStack navigation={state}>', '<RouteViewStack navigation={state} routeFamilies={routeFamilies}>');
assert.notEqual(source, navigationLifecycleFixture);
assert.ok(source.includes('routeFamilies={routeFamilies}'));
const server = await createServer({
  root: process.cwd(), publicDir: resolve("apps/workbench-web/public"), configFile: false, cacheDir: '.local/standard-page-vite', logLevel: 'error',
  resolve: { dedupe: ['react', 'react-dom', 'react-intl'] }, esbuild: { jsx: 'automatic', target: 'esnext' },
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'motion/react', '@tanstack/react-query', 'react-intl', 'tslib', 'prosemirror-state', 'prosemirror-view', 'prosemirror-model', 'prosemirror-transform', 'prosemirror-commands', 'prosemirror-history', 'prosemirror-keymap', 'prosemirror-inputrules', 'prosemirror-schema-list', '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities', '@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-popover', '@radix-ui/react-alert-dialog'] },
  plugins: [{ name: 'inbox-swipe-fixture', resolveId: id => id === '/inbox-swipe.tsx' ? id : null,
    load: id => {
      if (id === '/inbox-swipe.tsx') return source;
      if (process.env.OPENCRAFT_STANDARD_PAGE_BASELINE && id.endsWith('/app-shell-master-detail.tsx'))
        return execFileSync('git', ['show', process.env.OPENCRAFT_STANDARD_PAGE_BASELINE + ':apps/workbench-web/src/components/app-shell-master-detail.tsx'], { encoding: 'utf8' });
      return null;
    },
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (!req.headers.accept?.includes('text/html')) return next();
      res.setHeader('content-type', 'text/html');
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/inbox-swipe.tsx"></script>');
    }); },
  }],
});

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: unknown[] = [];
try {
  await mkdir(output, { recursive: true }); await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width === 390, isMobile: width === 390 });
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
    await page.goto(server.resolvedUrls!.local[0]! + '?theme=' + theme);
    const inbox = page.getByRole('button', { name: 'Open Inbox', exact: true });
    if (width === 390) await inbox.tap(); else await inbox.click();
    const chrome = page.locator('.app-shell-header');
    await chrome.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
    assert.equal(await page.locator('.people-page').getByRole('heading', { name: 'Inbox', exact: true }).count(), 0, 'one title owner, no body duplicate');
    await page.locator('.people-stream').evaluate(el => { el.scrollTop = 70; (window as any).originalList = el; });
    const group = page.getByRole('button', { name: 'Navigation group 2', exact: true });
    if (width === 390) await group.tap(); else await group.click();
    await chrome.getByRole('heading', { name: 'Navigation group 2', exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.im-channel-chat__conversation > header').count(), 0, 'selected detail uses the global standard header at every width');
    const editor = page.locator('.im-channel-chat__conversation [contenteditable="true"]:visible');
    await editor.waitFor(); await page.waitForTimeout(450); await editor.fill('Keep standard page draft'); await editor.blur();
    await page.waitForTimeout(150); assert.equal(await editor.innerText(), 'Keep standard page draft', 'draft settles before resize');
    await editor.evaluate(el => { (window as any).originalEditor = el; });
    // Header ownership changes must not move the editor, recreate the directory,
    // or reset its scroll checkpoint when the actual aperture changes.
    for (const nextWidth of [width === 390 ? 1280 : 390, width]) {
      await page.setViewportSize({ width: nextWidth, height: 844 });
      await page.waitForTimeout(450);
      await chrome.getByRole('heading', { name: 'Navigation group 2', exact: true }).waitFor({ timeout: 10000 });
      assert.equal(await editor.evaluate(el => el === (window as any).originalEditor), true);
      assert.equal(await editor.innerText(), 'Keep standard page draft');
      assert.equal(await page.locator('.people-stream').evaluate(el => el === (window as any).originalList && el.scrollTop === 70), true);
      assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth), true);
    }
    await page.screenshot({ path: resolve(output, width + '-' + theme + '-inbox.png') });
    await page.evaluate(() => (window as any).navigationProbe.openExtensionView('opencraft.im.agents'));
    await chrome.getByRole('heading', { name: 'Assistants', exact: true }).waitFor();
    assert.equal(await page.locator('.people-page').getByRole('heading', { name: 'Assistants', exact: true }).count(), 0);
    assert.equal(await page.locator('.people-page__description').isVisible(), true);
    await page.screenshot({ path: resolve(output, width + '-' + theme + '-assistants.png') });
    assert.deepEqual(errors, []);
    results.push({ width, theme, sharedHeader: true, stableEditor: true, retainedScroll: true, input: width === 390 ? 'touch' : 'mouse' });
    await context.close();
  }
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ passed: true, results }, null, 2));
  console.log(JSON.stringify({ passed: true, results }));
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  if (page) await page.screenshot({ path: resolve(output, 'failure.png') });
  throw error;
} finally { await browser?.close(); await server.close(); }
