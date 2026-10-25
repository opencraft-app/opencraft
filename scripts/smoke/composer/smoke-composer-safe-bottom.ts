import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import sharp from 'sharp';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.OPENCRAFT_SAFE_BOTTOM_OUTPUT ?? '/tmp/opencraft-composer-safe-bottom';
const source = `import React from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
initializeAppearanceTheme();window.fixtureSetTheme=setThemePreference;
import {projectWindowAppearance,resolveWindowAppearanceIntent} from '/apps/workbench-web/src/runtime/window-appearance.ts';
import {readWindowPresentation} from '/apps/workbench-web/src/runtime/window-presentation.ts';
window.fixtureProjectAppearance=()=>projectWindowAppearance(document,resolveWindowAppearanceIntent('light','light',{surface:'#fff',opaqueWindows:true}),readWindowPresentation(window),'resolved');
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createComposerController} from '@opencraft/composer-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {useTimelineViewportHost} from '/apps/workbench-web/src/timeline-viewport.ts';
import '/apps/workbench-web/src/styles/app.scss';
const controller=createComposerController({type:'existing-thread',key:{hostId:'fixture',threadId:'one'}},{now:Date.now,createId:()=>crypto.randomUUID()});
const noop=()=>{};const client=new QueryClient();
function App(){useTimelineViewportHost({kind:'browser',platform:'linux',safeArea:{left:0,right:0}});return <QueryClientProvider client={client}><AppShell layoutScope='safe-bottom' sidebarTransientEnabled={false} mainContentLayout='thread-edge-scroll' sidebarOpen={false} sidebarWidth={320} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={noop} onSidebarExpand={noop} onSidebarResizeEnd={noop} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={noop} leftPanel={null}
header={<AppShellHeader conversationHeader title='Safe bottom' project={null} sidebarOpen={false} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false} onToggleSidebar={noop} onToggleRightPanel={noop} onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={[]}/>}
><div className='thread-scroll-layout'><div className='thread-scroll' data-thread-find-target='conversation'><div className='thread-scroll-footer'><div className='thread-scroll-footer__content thread-layout-width'><OpenCraftComposer controller={controller} placeholder='Reconnecting…' onSubmit={()=>false} onCancel={()=>{}}/></div></div><div style={{height:1600,flexShrink:0,background:'repeating-linear-gradient(#d0edfa 0 24px,#305b75 24px 48px)'}}>Conversation</div></div></div></AppShell></QueryClientProvider>};createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
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
            (window as any).fixtureSetTheme(theme);
            Object.assign(root.dataset, { theme, uiDensity: 'touch', touchNewera: 'on' });
            root.style.setProperty('--test-safe-bottom', inset + 'px'); root.style.setProperty('--safe-layout-inset-top', '62px');
            document.activeElement instanceof HTMLElement && document.activeElement.blur();
            window.visualViewport!.dispatchEvent(new Event('resize'));
        }, { theme, inset, status });
        // Ordinary non-overlay surfaces retain the existing layout/visual capacity.
        const canvasHeight = status === 'black-translucent' ? 874 : Math.min(812, visibleHeight);
        await page.waitForFunction(height => document.querySelector('.app-shell-root')!.getBoundingClientRect().height === height, canvasHeight);
        const geometry = await page.evaluate(() => {
            const shell = document.querySelector('.app-shell-root')!, row = document.querySelector('.app-shell-row')!, composer = document.querySelector('.opencraft-composer-shell')!;
            return { rootHeight: document.documentElement.getBoundingClientRect().height, paintBottom: shell.getBoundingClientRect().bottom, contentBottom: row.getBoundingClientRect().bottom - parseFloat(getComputedStyle(row).paddingBottom), composerBottom: composer.getBoundingClientRect().bottom, footerPadding: getComputedStyle(document.querySelector('.thread-scroll-footer')!).paddingBottom, scrollBottom: document.querySelector('.thread-scroll')!.getBoundingClientRect().bottom, anchorBottom: document.querySelector('.main-content-body')!.getBoundingClientRect().bottom, keyboard: document.documentElement.dataset.timelineKeyboardOpen, attributes: { ...document.documentElement.dataset } };
        });
        assert.equal(geometry.contentBottom, canvasHeight - inset);
        assert.equal(geometry.paintBottom, canvasHeight);
        if (status === 'black-translucent') assert.equal(geometry.rootHeight, 874, 'installed document retains its full CSS canvas');
        assert.equal(geometry.keyboard, 'false');
        assert.equal(geometry.scrollBottom, canvasHeight, 'reading scrollport reaches the full bottom edge');
        assert.equal(geometry.anchorBottom, canvasHeight - inset, 'overlay anchor keeps exactly one protected inset');
        assert.equal(geometry.footerPadding, (16 + inset) + 'px', 'inline footer reuses the allocated inset inside the full-bleed scrollport');
        assert.equal(geometry.composerBottom, canvasHeight - inset - 16, 'one device inset, ordinary gutter');
        const name = `${width}-${theme}-${inset}-${visibleHeight}-${status}`;
        await page.screenshot({ path: `${output}/${name}.png` });
        await page.locator('.thread-scroll').evaluate(e=>e.scrollTop=-400);
        const bottomPaint=await page.locator('.thread-scroll').evaluate(e=>{const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.bottom-2);return !!hit&&(e===hit||e.contains(hit));});
        assert.ok(bottomPaint,'conversation paint and hit testing continue through the bottom safe strip');
        const readingImage=await page.screenshot({ path: output+'/'+name+'-reading-bottom.png' });
        const {data:pixel}=await sharp(readingImage).extract({left:Math.floor(width/2),top:canvasHeight-2,width:1,height:1}).removeAlpha().raw().toBuffer({resolveWithObject:true});
        assert.ok(pixel[2]>pixel[0]+10,'reading background remains visible in the bottom safe strip: '+JSON.stringify([...pixel]));
        await page.locator('.thread-scroll').evaluate(e=>e.scrollTop=0);
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
        assert.equal(await page.locator('.thread-scroll').evaluate(e=>e.getBoundingClientRect().bottom),440,'keyboard scrollport ends at the actual available bottom');
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
