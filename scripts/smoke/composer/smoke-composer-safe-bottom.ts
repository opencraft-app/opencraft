import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.OPENCRAFT_SAFE_BOTTOM_OUTPUT ?? '/tmp/opencraft-composer-safe-bottom';
const source = `import React from 'react';
import {projectWindowAppearance,resolveWindowAppearanceIntent} from '/apps/workbench-web/src/runtime/window-appearance.ts';
import {readWindowPresentation} from '/apps/workbench-web/src/runtime/window-presentation.ts';
window.fixtureProjectAppearance=()=>projectWindowAppearance(document,resolveWindowAppearanceIntent('light','light',{surface:'#fff',opaqueWindows:true}),readWindowPresentation(window),'resolved');
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
                return next(); res.setHeader('content-type', 'text/html'); res.end('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><div id="root"></div><script type="module" src="/safe-bottom.tsx"></script>'); }); } }] });

let browser: any;
const results = [];
try {
    await mkdir(output, { recursive: true });
    await server.listen();
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    for (const width of [390, 402]) for (const theme of ['light', 'dark'])
    for (const inset of [34, 0]) for (const visibleHeight of [812, 874])
    for (const status of ['black-translucent', 'default']) {
        const page = await browser.newPage({ viewport: { width, height: 874 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
        await page.addInitScript(({ visibleHeight }) => {
            Object.defineProperty(navigator, 'standalone', { value: true });
            Object.defineProperty(window, 'innerHeight', { configurable: true, value: visibleHeight });
            const v = new EventTarget(); Object.assign(v, { height: visibleHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
            Object.defineProperty(window, 'visualViewport', { value: v });
        }, { visibleHeight });
        await page.goto(server.resolvedUrls!.local[0]);
        const editor = page.locator('.opencraft-composer-editor'); await editor.waitFor();
        await page.evaluate(({ theme, inset, status }) => {
            const root = document.documentElement;
            Object.defineProperty(root, 'clientHeight', { configurable: true, value: 812 });
            document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')!.setAttribute('content', status);
            (window as any).fixtureProjectAppearance();
            Object.assign(root.dataset, { theme, uiDensity: 'touch' });
            root.style.setProperty('--test-safe-bottom', inset + 'px'); root.style.setProperty('--safe-layout-inset-top', '62px');
            document.activeElement instanceof HTMLElement && document.activeElement.blur();
            window.visualViewport!.dispatchEvent(new Event('resize'));
        }, { theme, inset, status });
        const canvasHeight = status === 'black-translucent' ? 874 : visibleHeight;
        await page.waitForFunction(height => document.querySelector('.app-shell-root')!.getBoundingClientRect().height === height, canvasHeight);
        const geometry = await page.evaluate(() => {
            const shell = document.querySelector('.app-shell-root')!, row = document.querySelector('.app-shell-row')!, composer = document.querySelector('.opencraft-composer-shell')!;
            return { rootHeight: document.documentElement.getBoundingClientRect().height, paintBottom: shell.getBoundingClientRect().bottom, contentBottom: row.getBoundingClientRect().bottom - parseFloat(getComputedStyle(row).paddingBottom), composerBottom: composer.getBoundingClientRect().bottom, footerPadding: getComputedStyle(document.querySelector('.thread-scroll-footer')!).paddingBottom, keyboard: document.documentElement.dataset.timelineKeyboardOpen, attributes: { ...document.documentElement.dataset } };
        });
        assert.equal(geometry.contentBottom, canvasHeight - inset);
        assert.equal(geometry.paintBottom, canvasHeight);
        if (status === 'black-translucent') assert.equal(geometry.rootHeight, 874, 'installed document retains its full CSS canvas');
        assert.equal(geometry.keyboard, 'false');
        assert.equal(geometry.footerPadding, '16px');
        assert.equal(geometry.composerBottom, canvasHeight - inset - 16, 'one device inset, ordinary gutter');
        const name = `${width}-${theme}-${inset}-${visibleHeight}-${status}`;
        await page.screenshot({ path: `${output}/${name}.png` });
        // A status-excluded native report must not truncate an installed CSS canvas.
        const wrongHeight = canvasHeight === 874 ? 812 : 874;
        const oldFrame = await page.addStyleTag({ content: `.app-shell-root { height: ${wrongHeight}px !important; }` });
        await page.waitForFunction(height => document.querySelector('.app-shell-root')!.getBoundingClientRect().height === height, wrongHeight);
        assert.equal(await page.locator('.opencraft-composer-shell').evaluate(e => e.getBoundingClientRect().bottom), wrongHeight - inset - 16);
        await oldFrame.evaluate(e => e.remove());
        await page.waitForFunction(height => document.querySelector('.app-shell-root')!.getBoundingClientRect().height === height, canvasHeight);
        await page.evaluate(height => { Object.assign(window.visualViewport!, { scale: 2, height: height / 2 }); window.visualViewport!.dispatchEvent(new Event('resize')); }, visibleHeight);
        await page.waitForFunction(height => document.querySelector('.app-shell-root')!.getBoundingClientRect().height === height, status === 'black-translucent' ? 874 : 812);
        await page.evaluate(height => { Object.assign(window.visualViewport!, { scale: 1, height }); window.visualViewport!.dispatchEvent(new Event('resize')); }, visibleHeight);
        await page.waitForFunction(height => document.querySelector('.app-shell-root')!.getBoundingClientRect().height === height, canvasHeight);
        await editor.fill('preserve mobile draft');
        const handle = await editor.elementHandle();
        await page.evaluate(() => { Object.assign(window.visualViewport!, { height: 440 }); window.visualViewport!.dispatchEvent(new Event('resize')); });
        await page.waitForFunction(() => document.querySelector('.app-shell-root')!.getBoundingClientRect().height === 440);
        assert.equal(await page.evaluate(() => document.documentElement.dataset.timelineKeyboardOpen), 'true');
        const keyboard = await page.evaluate(() => ({bottom:document.querySelector('.opencraft-composer-shell')!.getBoundingClientRect().bottom, row:document.querySelector('.app-shell-row')!.getBoundingClientRect().toJSON(), attrs:{...document.documentElement.dataset},scrollY,visualTop:visualViewport!.pageTop}));
        assert.equal(keyboard.bottom, 440 - 16, 'keyboard consumes no Home inset: ' + JSON.stringify({name,keyboard}));
        await editor.blur();
        await page.waitForFunction(() => document.documentElement.dataset.timelineKeyboardOpen === 'false');
        assert.equal(await page.locator('.app-shell-root').evaluate(e => e.getBoundingClientRect().height), 440, 'blur preserves remaining contraction');
        await page.evaluate(height => { Object.assign(window.visualViewport!, { height }); window.visualViewport!.dispatchEvent(new Event('resize')); }, visibleHeight);
        await page.waitForFunction(height => document.querySelector('.app-shell-root')!.getBoundingClientRect().height === height, canvasHeight);
        assert.equal(await editor.innerText(), 'preserve mobile draft'); assert.ok(await handle!.evaluate(e => e.isConnected));
        results.push({ width, theme, inset, visibleHeight, canvasHeight, status, ...geometry, keyboardHeight: 440, draftRetained: true });
        await writeFile(`${output}/result.json`, JSON.stringify(results, null, 2));
        await page.close();
    }
    console.log('PASS: CSS-owned installed canvas, status-excluded reports, overlay/default, 390/402, light/dark, 0/34px, keyboard/blur/restore and draft');
} finally { await browser?.close(); await server.close(); }
