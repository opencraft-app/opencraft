import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.OPENCRAFT_BROWSER_MENU_REPORT ?? '/tmp/opencraft-browser-menu';
await mkdir(output, { recursive: true });
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {BrowserLocalMenuController} from '/apps/workbench-web/src/browser/browser-local-menu.ts';
import {BrowserLocalMenu} from '/apps/workbench-web/src/browser/browser-local-menu-view.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const controller=new BrowserLocalMenuController();
let active=true,held=false,resolveCopy;const errors=[];let copied=0;
function open(x,y){active=true;controller.open({x,y,copy:true,link:true,current:()=>active,
 run:async action=>{copied++;if(action==='copy-link')return{text:'https://example.test/link'};if(held)return new Promise(resolve=>resolveCopy=resolve);return{text:'网页最终中文',html:'<b>网页最终中文</b>'}},
 focus:()=>document.querySelector('canvas').focus(),error:message=>errors.push(message)});}
window.proof={open,theme:setThemePreference,hold:()=>held=true,release:()=>resolveCopy({text:'迟到复制',html:'<b>迟到复制</b>'}),retire:()=>{active=false;controller.retire()},errors,get copied(){return copied}};
createIntlTestRoot(document.getElementById('root')).render(<><canvas width={280} height={180} tabIndex={0}
 aria-label="Remote page" onContextMenu={event=>{event.preventDefault();open(event.clientX,event.clientY)}}/>
 <BrowserLocalMenu controller={controller}/></>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
  cacheDir: 'node_modules/.vite-browser-menu', resolve: { dedupe: ['react', 'react-dom', 'react-intl'] }, esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0, hmr: false }, optimizeDeps: { entries: [], include: ['react', 'react-dom/client', 'react-intl', '@radix-ui/react-dropdown-menu'] },
  plugins: [{ name: 'browser-local-menu-proof', resolveId: id => id === '/menu-proof.tsx' ? id : null,
    load: id => id === '/menu-proof.tsx' ? source : null, configureServer(server) {
      server.middlewares.use((req, res, next) => { if (req.url !== '/') return next();
        res.setHeader('content-type', 'text/html'); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/menu-proof.tsx"></script>'); });
    } }],
});
let browser;
const results: unknown[] = [];
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
  for (const width of [960, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 700 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
    await page.goto(vite.resolvedUrls!.local[0]!, { timeout: 60000 });
    await page.waitForFunction(() => (window as any).proof);
    await page.evaluate(value => (window as any).proof.theme(value), theme);
    const surface = page.locator('canvas');
    await surface.click({ button: 'right', position: { x: 100, y: 80 } });
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).waitFor();
    const menuBounds = await page.getByRole('menu').boundingBox();
    assert(menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width);
    await page.screenshot({ path: `${output}/${width}-${theme}-menu.png` });
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'detached' });
    assert.equal(await surface.evaluate(element => element === document.activeElement), true);
    await surface.click({ button: 'right', position: { x: 100, y: 80 } });
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await page.waitForFunction(async () => await navigator.clipboard.readText() === '网页最终中文');
    const formats = await page.evaluate(async () => {
      const item = (await navigator.clipboard.read())[0]!;
      return { text: await (await item.getType('text/plain')).text(), html: await (await item.getType('text/html')).text() };
    });
    assert.equal(formats.text, '网页最终中文'); assert.match(formats.html, /<b>网页最终中文<\/b>/);
    await page.evaluate(() => (window as any).proof.hold());
    await surface.click({ button: 'right', position: { x: 100, y: 80 } });
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await page.waitForFunction(() => (window as any).proof.copied === 2);
    await page.evaluate(() => { (window as any).proof.retire(); (window as any).proof.release(); });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '网页最终中文');
    assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => (window as any).proof.errors), []);
    results.push({ width, theme, menuBounds, copiedFinalTextAndHtml: true, escapeRestoresFocus: true, lateCopyRejected: true });
    await context.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify({ boundary: 'Real Radix/client Clipboard API; remote native callback is a controlled fixture', results }, null, 2));
  console.log(JSON.stringify({ output, scenarios: results.length, passed: true }));
} finally { await browser?.close(); await vite.close(); }
