import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.OPENCRAFT_SAFE_BOTTOM_OUTPUT ?? '/tmp/opencraft-composer-safe-bottom';
const source = `import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {SafeLayout} from '@opencraft/design-system-web/safe-layout';
import {createComposerController} from '@opencraft/composer-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {useTimelineViewportHost} from '/apps/workbench-web/src/timeline-viewport.ts';
import '/apps/workbench-web/src/styles/app.scss';
const controller=createComposerController({type:'existing-thread',key:{hostId:'fixture',threadId:'one'}},{now:Date.now,createId:()=>crypto.randomUUID()});
function App(){useTimelineViewportHost({kind:'browser',platform:'linux',safeArea:{left:0,right:0}});return <div className='app-shell-root has-browser-safe-layout'><SafeLayout edges={['top','bottom']} className='app-shell-row' style={{display:'block'}}><div style={{height:56}}>Header</div><div className='thread-scroll-layout' style={{height:'calc(100% - 56px)'}}><div className='thread-scroll'><div className='thread-scroll-footer'><div className='thread-scroll-footer__content thread-layout-width'><OpenCraftComposer controller={controller} placeholder='Reconnecting…' onSubmit={()=>false} onCancel={()=>{}}/></div></div><div style={{height:1600,flexShrink:0}}>Conversation</div></div></div></SafeLayout></div>};createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const server = await createServer({ root: process.cwd(), configFile: false, logLevel: 'error', resolve: { dedupe: ['react', 'react-dom'] }, esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'safe-bottom-fixture', enforce: 'pre', transform(code, id) { if (id.endsWith('.scss'))
                return code.replace(/env\(safe-area-inset-bottom(?:,[^)]*)?\)/g, 'var(--test-safe-bottom, 0px)'); }, resolveId: id => id === '/safe-bottom.tsx' ? id : null, load: id => id === '/safe-bottom.tsx' ? source : null, configureServer(v) { v.middlewares.use((req, res, next) => { if (req.url !== '/')
                return next(); res.setHeader('content-type', 'text/html'); res.end('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><div id="root"></div><script type="module" src="/safe-bottom.tsx"></script>'); }); } }] });
let browser: any;
const results = [];
try {
    await mkdir(output, { recursive: true });
    await server.listen();
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    for (const width of [390, 402])
        for (const theme of ['light', 'dark'])
            for (const inset of [34, 0]) {
                const page = await browser.newPage({ viewport: { width, height: 874 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
                await page.addInitScript(() => { const v = new EventTarget(); Object.assign(v, { height: 812, width: innerWidth, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 }); Object.defineProperty(window, 'visualViewport', { value: v }); });
                await page.goto(server.resolvedUrls!.local[0]);
                await page.locator('.opencraft-composer-shell').waitFor();
                await page.evaluate(({ theme, inset }) => { const root = document.documentElement; Object.defineProperty(root, 'clientHeight', { configurable: true, value: 812 }); window.visualViewport!.dispatchEvent(new Event('resize')); Object.assign(root.dataset, { theme, uiDensity: 'touch', windowHost: 'browser', windowDisplayMode: 'standalone', windowEdgeStrategy: 'legacy-overlay-requested' }); root.style.setProperty('--test-safe-bottom', inset + 'px'); root.style.setProperty('--safe-layout-inset-top', '47px'); document.activeElement instanceof HTMLElement && document.activeElement.blur(); }, { theme, inset });
                await page.waitForTimeout(100);
                const geometry = await page.evaluate(() => { const shell = document.querySelector('.app-shell-root')!, row = document.querySelector('.app-shell-row')!, composer = document.querySelector('.opencraft-composer-shell')!; return { paintBottom: shell.getBoundingClientRect().bottom, contentBottom: row.getBoundingClientRect().bottom - parseFloat(getComputedStyle(row).paddingBottom), composerBottom: composer.getBoundingClientRect().bottom, footerPadding: getComputedStyle(document.querySelector('.thread-scroll-footer')!).paddingBottom, keyboard: document.documentElement.dataset.timelineKeyboardOpen, attributes: { ...document.documentElement.dataset }, available: document.documentElement.style.getPropertyValue('--timeline-available-viewport-height') }; });
                await page.screenshot({ path: `${output}/${width}-${theme}-${inset}.png` });
                results.push({ width, theme, inset, ...geometry });
                await writeFile(`${output}/result.json`, JSON.stringify(results, null, 2));
                assert.equal(geometry.contentBottom, 812 - inset, 'content capacity is independent of canvas height');
                assert.equal(geometry.paintBottom, 874, 'paint still fills the document canvas');
                assert.equal(geometry.keyboard, 'false');
                assert.equal(geometry.footerPadding, "16px", "route does not claim the Shell-owned inset again");
                assert.ok(geometry.composerBottom <= 812 - inset, `Composer enters native safe region: ${JSON.stringify(results.at(-1))}`);
                assert.equal(geometry.composerBottom, 812 - inset - 16, 'preserve original gutter for 0px and 34px');
                const oldFrame = await page.addStyleTag({ content: '.app-shell-root > .app-shell-row { padding-bottom: 0 !important; }' });
                assert.ok(await page.locator('.opencraft-composer-shell').evaluate(e => e.getBoundingClientRect().bottom) > 812 - inset, 'negative control: the removed content constraint reproduces clipping');
                await oldFrame.evaluate(e => e.remove());
                await page.evaluate(() => { Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 874 }); Object.assign(window.visualViewport!, { height: 874 }); window.visualViewport!.dispatchEvent(new Event('resize')); });
                await page.waitForTimeout(100);
                assert.equal(await page.locator('.opencraft-composer-shell').evaluate(e => e.getBoundingClientRect().bottom), 874 - inset - 16, 'matching paint/visible capacity retains the original layout');
                await page.evaluate(()=>{Object.assign(window.visualViewport!,{height:500});window.visualViewport!.dispatchEvent(new Event('resize'));});
                await page.locator('.opencraft-composer-editor').focus();
                await page.waitForFunction(()=>document.documentElement.dataset.timelineKeyboardOpen==='true'&&getComputedStyle(document.querySelector('.app-shell-row')!).paddingBottom==='0px');
                assert.equal(await page.locator('.opencraft-composer-shell').evaluate(e=>e.getBoundingClientRect().bottom),484,'ordinary gap remains above keyboard with nonzero device inset');
                await page.locator('.opencraft-composer-editor').evaluate(e=>(e as HTMLElement).blur());
                await page.evaluate(()=>{Object.assign(window.visualViewport!,{height:874});window.visualViewport!.dispatchEvent(new Event('resize'));});
                await page.waitForFunction(inset=>document.documentElement.dataset.timelineKeyboardOpen==='false'&&getComputedStyle(document.querySelector('.app-shell-row')!).paddingBottom===`${inset}px`,inset);
                assert.equal(await page.locator('.opencraft-composer-shell').evaluate(e=>e.getBoundingClientRect().bottom),874-inset-16,'keyboard close restores one inset and ordinary gap');
                await page.close();
            }
    console.log('PASS: full-screen native frame, 390/402, light/dark, 0/34px, original gutter');
}
finally {
    await browser?.close();
    await server.close();
}
