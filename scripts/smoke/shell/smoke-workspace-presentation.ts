import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const browserName = process.env.OPENCRAFT_SMOKE_BROWSER ?? 'chromium';
assert(['chromium', 'webkit'].includes(browserName), 'Select chromium or webkit');
const mobile = process.argv.includes('--mobile-browser');
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-workspace-presentation";
async function settleMobileViewport(page: any) {
  await page.waitForFunction(() => {
    const panel = document.querySelector('.browser-panel[data-mobile-browser="true"]');
    if (!panel) return false;
    const bounds = panel.getBoundingClientRect();
    return Math.abs(bounds.width - innerWidth) < 1 && Math.abs(bounds.height - innerHeight) < 1;
  }, undefined, { timeout: 5000 });
}
const source = `
import React,{useSyncExternalStore,useState} from 'react';import{createIntlTestRoot as createRoot}from'/tests/fixtures/intl-root.tsx';
import{Context}from'@deepseek-ai/cordis';import{WorkbenchPanelService}from'@opencraft/workbench-panels';
import{WorkbenchPanelRendererRegistryService}from'@opencraft/workbench-panels-react';
import{createConversationBindingStore}from'@opencraft/workbench-runtime';
import{BrowserEnvironmentProvider,BrowserPresentationRoot}from'/apps/workbench-web/src/browser/browser-runtime-context.tsx';
import{WebIframeSurfaceHost}from'/apps/workbench-web/src/browser/web-browser-surface-host.ts';
import{WebBrowserPageRuntime}from'/apps/workbench-web/src/browser/web-browser-runtime.ts';
import{BrowserPresentationCoordinator}from'/apps/workbench-web/src/browser/browser-presentation-coordinator.ts';
import{BrowserWorkbenchCoordinator}from'/apps/workbench-web/src/browser/browser-workbench-coordinator.ts';
import{createBrowserWorkbenchPanelPlugin}from'/apps/workbench-web/src/browser/browser-panel-plugin.tsx';
import{createComposerController}from'@opencraft/composer-core';import{createConversationKey}from'@opencraft/chat-core';
import{OpenCraftComposer}from'@opencraft/composer-editor';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{RightPanel}from'/apps/workbench-web/src/components/right-panel.tsx';
import{useShellPresentation}from'/apps/workbench-web/src/components/shell-presentation.ts';
import{ThreadComposerPresentation}from'/apps/workbench-web/src/components/thread-composer-presentation.tsx';
import{TimelineBlockRendererProvider,TimelineBlockRendererRegistryService}from'@opencraft/timeline-render-react';
import{BuiltinTimelineRendererPlugin}from'/apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import{AsyncNoticesProvider}from'/apps/workbench-web/src/components/async-notices.tsx';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();const ctx=new Context();await ctx.plugin(WorkbenchPanelService);const panels=ctx.workbenchPanels;const key=createConversationKey('fixture-host','parent');
const params=new URLSearchParams(location.search);const mobile=params.has('mobile');
if(mobile){document.documentElement.dataset.uiDensity='touch';;setThemePreference(params.get('theme')==='dark'?'dark':'light');}
const controller=createComposerController({type:'existing-thread',key},{now:Date.now,createId:()=>crypto.randomUUID()});const closed=[];const submitted=[];
await ctx.plugin(WorkbenchPanelRendererRegistryService);
await ctx.plugin(TimelineBlockRendererRegistryService);await ctx.plugin(BuiltinTimelineRendererPlugin);
const surfaces=new WebIframeSurfaceHost();const pages=new WebBrowserPageRuntime(surfaces);const presentations=new BrowserPresentationCoordinator(pages,surfaces);
const keyboardRequests=[];if(mobile){surfaces.keyboardState=()=>window.fixtureKeyboardState??'ready';surfaces.onKeyboardState=()=>()=>{};surfaces.showKeyboard=id=>keyboardRequests.push({id,gesture:navigator.userActivation.isActive});}
const workbench=new BrowserWorkbenchCoordinator(pages,panels,createConversationBindingStore());
await ctx.plugin(createBrowserWorkbenchPanelPlugin(workbench,()=>{workbench.open('scope',{initialUrl:location.origin+'/browser-fixture'});}));
panels.register({kind:'terminal',createTab:({id})=>({id,resource:id,kind:'terminal',region:'right',title:'Terminal',icon:'terminal',closable:true,preview:false}),disposeTab:t=>closed.push(t.resource)});
panels.open('scope','terminal',{id:'terminal:one'});
function Tool(){return <div style={{height:'100%',padding:20}}><input aria-label='Terminal input' defaultValue='process alive'/></div>}
const renderers=[{kind:'terminal',Component:Tool},...ctx.workbenchPanelRenderers.getSnapshot()];
const subscribe=f=>panels.subscribeOwner('scope',f),get=()=>panels.getOwnerSnapshot('scope');

function FixtureHeader(){const shell=useShellPresentation();return <button type='button' onClick={()=>shell?.toggleRightPanel()}>Open preview</button>}
function App(){const state=useSyncExternalStore(subscribe,get);const [sidebar,setSidebar]=useState(false);const [width,setWidth]=useState(275);const [enabled,setEnabled]=useState(true);
window.fixture={state,closed,submitted,controller,panels,keyboardRequests,setThemePreference,setEnabled,pages,openBrowser:()=>workbench.open('scope',{initialUrl:location.origin+'/browser-fixture',panelOwnerId:'scope'})};
const panel=()=> <RightPanel state={state} presentationId='view' renderers={renderers} toolbarActions={panels.getToolbarActionSnapshot()} toolbarActionContext={{ownerId:'scope',resourceOwnerId:'scope',hostId:'fixture-host',cwd:null}} onAction={a=>panels.dispatch('scope',a)} onCloseTab={t=>panels.close('scope',t.region,t.id)}/>;
return <AppShell layoutScope='scope' mainContentLayout='default' header={<FixtureHeader/>} floatingSidebarHeader={()=>null} leftPanel={<p>Navigation</p>} sidebarOpen={sidebar} sidebarWidth={width} onSidebarCollapse={()=>setSidebar(false)} onSidebarExpand={()=>setSidebar(true)} onSidebarResizeEnd={setWidth} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanel={panel('right')} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onRightPanelOpenChange={open=>panels.dispatch('scope',{type:'set-region-open',region:'right',open})}>
<div style={{height:'100%',display:'flex',flexDirection:'column'}}><p style={{flex:1}}>Parent conversation</p>
<ThreadComposerPresentation scopeId='scope' controller={controller} activeTabId={state.right.activeTabId} enabled={enabled} timeline={{key,revision:1,phase:'live',authoritative:true,anchorFrameIds:new Map(),frames:[{id:'user-frame',type:'user',turnId:'turn',status:'complete',durationMs:null,hookStats:null,anchors:[],blocks:[{id:'user-block',type:'text',text:'User intro must not be duplicated',sourceItemIds:[],streaming:false}]},{id:'assistant-frame',type:'assistant',turnId:'turn',status:'complete',durationMs:1000,hookStats:null,anchors:[],blocks:[{id:'answer',type:'text',text:'Latest answer preview\\n\\n'+('A bounded response paragraph.\\n\\n'.repeat(40)),sourceItemIds:['answer'],streaming:false,completed:true,phase:'final_answer'}]}]}} documentContext={{conversationId:'parent',hostId:'fixture-host',cwd:null,theme:'light'}}>
<div className='thread-composer-region'><OpenCraftComposer controller={controller} onSubmit={async intent=>{submitted.push(intent.target)}} onCancel={()=>{}} /></div>
</ThreadComposerPresentation></div></AppShell>}
createRoot(document.getElementById('root')).render(<AsyncNoticesProvider><TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}><BrowserEnvironmentProvider pages={pages} surfaces={surfaces} presentations={presentations} workbench={workbench}><App/><BrowserPresentationRoot/></BrowserEnvironmentProvider></TimelineBlockRendererProvider></AsyncNoticesProvider>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", cacheDir: "node_modules/.vite-workspace-presentation", resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0 }, optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@tanstack/react-query"] }, plugins: [{ name: "workspace-presentation-fixture", resolveId: id => id === "/workspace-probe.tsx" ? id : null, load: id => id === "/workspace-probe.tsx" ? source : null, configureServer(server) { server.middlewares.use((req,res,next) => { if (req.url === "/browser-fixture") { res.setHeader("content-type","text/html"); res.end('<title>Fixture web page</title><button onclick="this.textContent=String.fromCharCode(80,97,103,101,32,99,111,117,110,116,32)+(++window.count)">Page count 0</button><script>window.count=0</script>'); return; } if(req.url?.split("?")[0] !== "/") return next();res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/workspace-probe.tsx"></script>'); }); } }] });
let browser: any;
const errors: string[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await playwright[browserName].launch({ headless: true, ...(browserName === 'chromium' ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] } : {}) });
  if (mobile) {
    for (const theme of ['light', 'dark']) {
      console.log('Mobile browser:',theme);
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
      page.on('pageerror', error => { errors.push(error.message); console.error('Browser:', error.message); });
      page.on('console', message => { if (message.type() === 'error') console.error('Console:', message.text()); });
      page.on('requestfailed', request => console.error('Request:', request.url(), request.failure()));
      await page.addInitScript('window.__name=value=>value');
      await page.goto(vite.resolvedUrls!.local[0]! + '?mobile=1&theme=' + theme);
      await page.waitForFunction(() => Boolean((window as any).fixture));
      await page.evaluate(() => { const f=(window as any).fixture; f.openBrowser(); f.openBrowser(); if(!f.panels.getOwnerSnapshot('scope').rightPanelFullWidth)f.panels.dispatch('scope',{type:'toggle-right-full-width'}); });
      await page.getByRole('button',{name:'Open preview',exact:true}).click();
      const dock = page.locator('.browser-mobile-dock');
      try { await dock.waitFor({ timeout: 15000 }); }
      catch (error) { await page.screenshot({ path: output + '/mobile-failure.png' }); await writeFile(output + '/mobile-failure.html', await page.content()); console.error('Fixture state:',await page.evaluate(()=>(window as any).fixture?.state)); throw error; }
      const editor = page.locator('.opencraft-composer-editor');
      await editor.waitFor({ state: 'attached' });
      const identity = await editor.evaluate(e => { (window as any).originalEditor = e; return true; });
      assert(identity);
      assert.equal(await page.locator('.right-panel-toolbar:visible').count(), 0);
      assert.equal(await page.locator('.thread-composer-overlay__interactive:visible').evaluate(e => Boolean(e.closest('[inert]'))), true);
      const counter = page.frameLocator('iframe[data-browser-surface-visible="true"]').first().getByRole('button', { name: /Page count/ });
      await counter.click();
      const originalTab = await page.evaluate(() => (window as any).fixture.state.right.activeTabId);
      const frameNode = await page.locator('iframe[data-browser-surface-visible="true"]').first().evaluate(e => { (window as any).originalFrame = e; return true; });
      assert(frameNode);
      for (const width of [320, 390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        const started = Date.now();
        await settleMobileViewport(page);
        console.log('Viewport settled:', browserName, width, Date.now() - started);
        const geometry = await dock.evaluate(e => {
          const r = e.getBoundingClientRect();
          return { dock: r.toJSON(), width: innerWidth, height: innerHeight, viewport: { width: visualViewport?.width, height: visualViewport?.height }, panel: e.closest('.browser-panel')?.getBoundingClientRect().toJSON() };
        });
        await writeFile(`${output}/geometry-${theme}-${width}.json`, JSON.stringify(geometry, null, 2));
        if (!(geometry.dock.left >= 0 && geometry.dock.right <= geometry.width && geometry.dock.bottom <= geometry.height)) {
          await page.screenshot({ path: `${output}/overflow-${theme}-${width}.png` });
        }
        assert.equal(geometry.dock.left >= 0 && geometry.dock.right <= geometry.width && geometry.dock.bottom <= geometry.height, true);
        for (const button of await dock.locator('button:visible').all()) {
          const r = await button.boundingBox(); assert(r && r.width >= 44 && r.height >= 44);
        }
      }
      await page.setViewportSize({ width: 390, height: 480 });
      await settleMobileViewport(page);
      const ordinarySlotMargin = await page.locator('.browser-panel[data-mobile-browser="true"] .browser-viewport-slot').evaluate(e=>getComputedStyle(e).marginBottom);
      await page.evaluate(() => { document.documentElement.style.setProperty('--safe-layout-inset-bottom','34px'); });
      await page.waitForFunction(() => {
        const dock = document.querySelector('.browser-mobile-dock');
        return dock && dock.getBoundingClientRect().bottom <= innerHeight - 34;
      }, undefined, { timeout: 5000 });
      const safeGeometry = await dock.evaluate(e => ({ rect: e.getBoundingClientRect().toJSON(), height: innerHeight, panel: e.closest('.browser-panel')?.getBoundingClientRect().toJSON(), bottom: getComputedStyle(e).bottom, safe: getComputedStyle(e).getPropertyValue('--shell-mobile-safe-bottom') }));
      await writeFile(output + '/safe-geometry-' + theme + '.json', JSON.stringify(safeGeometry, null, 2));
      await page.screenshot({ path: output + '/safe-' + theme + '.png' });
      assert.equal(await dock.evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight-34),true);
      assert.equal(safeGeometry.panel!.bottom, safeGeometry.height - 34, 'Shell owns the device inset once');
      assert.equal(safeGeometry.rect.bottom, safeGeometry.panel!.bottom - 8, 'dock keeps its ordinary 8px gap inside protected content');
      assert.equal(await page.locator('.browser-panel[data-mobile-browser="true"] .browser-viewport-slot').evaluate(e=>getComputedStyle(e).marginBottom), ordinarySlotMargin, 'guest viewport does not subtract the device inset again');
      // The real viewport port's nonzero-inset lifecycle is covered by
      // smoke-composer-safe-bottom; this fixture checks the browser consumer.
      await page.evaluate(()=>{document.documentElement.dataset.timelineKeyboardOpen='true';});
      await page.waitForFunction(()=>getComputedStyle(document.querySelector('.app-shell-row')!).paddingBottom==='0px');
      assert.equal(await dock.locator('.browser-mobile-dock__actions').isVisible(),false);
      assert.equal(await page.locator('.app-shell-row').evaluate(e=>getComputedStyle(e).paddingBottom),'0px','keyboard projection drops the real 34px inset');
      await page.evaluate(()=>{delete document.documentElement.dataset.timelineKeyboardOpen;});
      await page.waitForFunction(()=>getComputedStyle(document.querySelector('.app-shell-row')!).paddingBottom==='34px');
      assert.equal(await page.locator('.app-shell-row').evaluate(e=>getComputedStyle(e).paddingBottom),'34px','keyboard projection restores the one device inset');
      await page.evaluate(() => { delete document.documentElement.dataset.timelineKeyboardOpen; document.documentElement.style.removeProperty('--safe-layout-inset-bottom'); });
      await page.setViewportSize({ width: 390, height: 844 });
      await settleMobileViewport(page);
      await dock.getByRole('button', { name: 'Keyboard', exact: true }).tap();
      assert.equal(await page.evaluate(() => (window as any).fixture.keyboardRequests.length), 1);
      assert.equal(await page.evaluate(() => (window as any).fixture.keyboardRequests[0].gesture), true);
      await page.screenshot({ path: output + '/mobile-' + theme + '-browse.png' });
      await dock.locator('button:has-text("Agent")').tap();
      await page.locator('.browser-agent-sheet__header').waitFor();
      await editor.fill('Keep this mobile draft');
      await page.evaluate(() => document.documentElement.style.setProperty('--safe-layout-inset-bottom','34px'));
      const browserComposerPadding=page.locator('.thread-composer-overlay-host[data-mobile-browser="true"] .thread-composer-overlay__padding');
      assert.equal(await browserComposerPadding.evaluate(e=>getComputedStyle(e).paddingBottom),'8px','body portal retains only its ordinary gap');
      const assertPortalGeometry = async (inset: number, timeout = 5000) => {
        try { await page.waitForFunction(inset => {
          const anchor = document.querySelector('.main-content-body');
          const host = document.querySelector('.thread-composer-overlay-host[data-mobile-browser="true"]');
          const surface = host?.querySelector('.thread-composer-overlay__interactive');
          const composer = host?.querySelector('.opencraft-composer-shell');
          if (!anchor || !host || !surface || !composer) return false;
          const a = anchor.getBoundingClientRect(), h = host.getBoundingClientRect(), b = surface.getBoundingClientRect(), c = composer.getBoundingClientRect();
          // The sheet surface has the outer 8px gap; its unchanged 12px padding
          // and 1px border put the nested Composer another 13px inside it.
          return a.bottom === innerHeight - inset && h.bottom === a.bottom && b.bottom === h.bottom - 8 && c.bottom === b.bottom - 13;
        }, inset, { timeout }); } catch (error) {
          await writeFile(output + '/portal-failure-' + theme + '.json', JSON.stringify(await page.evaluate(() => ({ anchor:document.querySelector('.main-content-body')?.getBoundingClientRect().toJSON(), host:document.querySelector('.thread-composer-overlay-host[data-mobile-browser="true"]')?.getBoundingClientRect().toJSON(), composer:document.querySelector('.thread-composer-overlay-host[data-mobile-browser="true"] .opencraft-composer-shell')?.getBoundingClientRect().toJSON(), height:innerHeight, html:document.querySelector('.thread-composer-overlay-host[data-mobile-browser="true"]')?.outerHTML.slice(0,700) })), null, 2));
          throw error;
        }
        const geometry = await page.evaluate(() => ({
          anchorBottom: document.querySelector('.main-content-body')!.getBoundingClientRect().bottom,
          hostBottom: document.querySelector('.thread-composer-overlay-host[data-mobile-browser="true"]')!.getBoundingClientRect().bottom,
          surfaceBottom: document.querySelector('.thread-composer-overlay-host[data-mobile-browser="true"] .thread-composer-overlay__interactive')!.getBoundingClientRect().bottom,
          composerBottom: document.querySelector('.thread-composer-overlay-host[data-mobile-browser="true"] .opencraft-composer-shell')!.getBoundingClientRect().bottom,
          height: innerHeight,
        }));
        assert.equal(geometry.anchorBottom, geometry.height - inset);
        assert.equal(geometry.hostBottom, geometry.anchorBottom, 'body portal measures the protected content anchor');
        assert.equal(geometry.surfaceBottom, geometry.hostBottom - 8, 'effective painted sheet gap is exactly 8px');
        assert.equal(geometry.composerBottom, geometry.surfaceBottom - 13, 'nested Composer preserves existing 12px padding and 1px border');
        assert.ok(geometry.composerBottom <= geometry.hostBottom - 8);
        return geometry;
      };
      const portalSafe = await assertPortalGeometry(34);
      await page.evaluate(() => { document.documentElement.dataset.timelineKeyboardOpen = 'true'; });
      const portalKeyboard = await assertPortalGeometry(0);
      await page.evaluate(() => { delete document.documentElement.dataset.timelineKeyboardOpen; });
      const portalRestored = await assertPortalGeometry(34);
      await page.screenshot({ path: output + '/portal-safe-34-' + theme + '.png' });
      const wrongAnchor = await page.addStyleTag({ content: '.thread-composer-overlay-host[data-mobile-browser="true"] { top: 0 !important; height: 100vh !important; }' });
      await page.waitForFunction(() => document.querySelector('.thread-composer-overlay-host[data-mobile-browser="true"]')!.getBoundingClientRect().bottom === innerHeight);
      assert.equal(await browserComposerPadding.evaluate(e=>getComputedStyle(e).paddingBottom),'8px');
      await assert.rejects(assertPortalGeometry(34, 300), 'viewport-sized portal must fail even when CSS padding remains 8px');
      await wrongAnchor.evaluate(e => e.remove());
      await assertPortalGeometry(34);
      await writeFile(output + '/portal-geometry-' + theme + '.json', JSON.stringify({ portalSafe, portalKeyboard, portalRestored, wrongAnchorRejected: true }, null, 2));
      await page.evaluate(() => document.documentElement.style.removeProperty('--safe-layout-inset-bottom'));
      await assertPortalGeometry(0);
      assert.equal(await editor.evaluate(e => e === (window as any).originalEditor), true);
      await page.screenshot({ path: output + '/mobile-' + theme + '-agent.png' });
      await page.getByRole('button', { name: 'Close Agent', exact: true }).tap();
      await dock.getByRole('button', { name: 'Tabs', exact: true }).tap();
      const overview = page.getByRole('dialog', { name: 'Tabs', exact: true });
      await overview.waitFor();
      assert.equal(await overview.locator('.browser-mobile-tab__activate').count(), 3);
      await page.screenshot({ path: output + '/mobile-' + theme + '-tabs.png' });
      console.log('Switching tabs:',theme);
      const otherTab = await page.evaluate(original => (window as any).fixture.state.right.tabs.find((t:any)=>t.kind==='browser'&&t.id!==original).id,originalTab);
      await overview.locator('[data-tab-id="'+otherTab+'"] .browser-mobile-tab__activate').tap();
      await dock.getByRole('button',{name:'Tabs',exact:true}).tap();
      await overview.locator('[data-tab-id="'+originalTab+'"] .browser-mobile-tab__activate').tap();
      console.log('Restored active page:',theme);
      await page.waitForFunction(() => { const f=(window as any).originalFrame as HTMLIFrameElement; const r=f.getBoundingClientRect(); return f.dataset.browserSurfaceVisible==='true' && document.elementFromPoint(r.left+10,r.top+10)===f && getComputedStyle(f.parentElement!).pointerEvents==='auto'; });
      await counter.click(); assert.equal(await counter.innerText(), 'Page count 2');
      assert.equal(await page.locator('iframe[data-browser-surface-visible="true"]').first().evaluate(e => e === (window as any).originalFrame), true);
      await dock.getByRole('textbox', { name: 'Web address', exact: true }).tap();
      await page.keyboard.press('Escape');
      await dock.getByRole('button', { name: 'Tabs', exact: true }).tap();
      console.log('Closing inactive tab:',theme);
      await overview.locator('[data-tab-id="'+otherTab+'"] .browser-mobile-tab__close').tap();
      await page.waitForFunction(()=>(window as any).fixture.pages.listForOwner('scope').length===1);
      await overview.getByRole('button', { name: 'New browser tab', exact: true }).tap();
      await page.waitForFunction(() => (window as any).fixture.pages.listForOwner('scope').length === 2);
      await dock.locator('button:has-text("Agent")').tap();
      assert.match(await editor.innerText(), /Keep this mobile draft/);
      assert.equal(await editor.evaluate(e => e === (window as any).originalEditor), true);
      await page.getByRole('button', { name: 'Close Agent', exact: true }).tap();
      await page.evaluate(() => { document.documentElement.dataset.uiDensity='compact'; });
      await page.locator('.browser-panel__toolbar').waitFor();
      assert.equal(await dock.count(), 0);
      await page.evaluate(() => { document.documentElement.dataset.uiDensity='touch'; });
      await dock.waitFor();
      await page.setViewportSize({ width: 1280, height: 844 });
      await page.locator('.browser-panel__toolbar').waitFor();
      assert.equal(await dock.count(), 0);
      assert.equal(await editor.evaluate(e => e === (window as any).originalEditor), true);
      await page.close();
    }
    assert.deepEqual(errors, []);
    await writeFile(output + '/mobile-result.json', JSON.stringify({ result: 'passed', browser: browserName, version: browser.version(), themes: ['light','dark'], widths: [320,390,430], originalEditorRetained: true, originalPageRetained: true, keyboardBoundary: 'simulated capability; synchronous gesture verified, no physical OS keyboard proof', errors }, null, 2));
    console.log('Newera mobile browser actual-consumer smoke passed: ' + output);
  } else {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, reducedMotion: process.env.OPENCRAFT_REDUCED_MOTION === "0" ? "no-preference" : "reduce" });
  page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript("window.__name=value=>value");
  await page.goto(vite.resolvedUrls!.local[0]!, { timeout: 60000 }); await page.waitForLoadState("networkidle", { timeout: 60000 });
  const editor = page.locator('[contenteditable="true"]:visible');
  await editor.fill("Keep this parent draft");
  await page.getByRole("button", { name: "Maximize panel", exact: true }).click();
  const overlay = page.getByTestId("right-panel-composer-overlay-host"); await overlay.waitFor();
  await page.waitForFunction(() => document.querySelector('.main-content-viewport')!.getBoundingClientRect().width < 1);
  assert.equal(await editor.count(), 1); assert.match(await editor.innerText(), /Keep this parent draft/);
  assert.equal(await editor.evaluate(element => element.closest("[inert]") !== null), false);
  await page.getByRole("textbox", { name: "Terminal input" }).fill("Still interactive behind overlay");
  // Non-browser tools use the default overlay, without browser peek handles.
  assert.equal(await page.getByRole("button", { name: "Hide chat input" }).count(), 0);
  assert.match(await editor.innerText(), /Keep this parent draft/);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    await page.setViewportSize({ width: theme === "light" ? 1280 : 800, height: 850 });
    await page.waitForTimeout(120);
    const bounds = await overlay.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= (theme === "light" ? 1280 : 800) + 1);
    await page.screenshot({ path: output + "/" + theme + ".png" });
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.getByRole("button", { name: "Restore panel", exact: true }).click();
  assert.equal(await page.locator('.app-shell-bottom-panel, [data-panel-region="bottom"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: /Move .* to bottom panel|Show bottom panel/ }).count(), 0);
  assert.equal(await page.evaluate(() => (window as any).fixture.closed.length), 0);
  assert.match(await editor.innerText(), /Keep this parent draft/);
  await page.screenshot({ path: output + "/restored.png" });
  await page.evaluate(() => (window as any).fixture.openBrowser());
  const frame = page.frameLocator('iframe').first();
  const counter = frame.getByRole('button', { name: /Page count/ });
  await counter.click(); assert.equal(await counter.innerText(), 'Page count 1');
  await page.getByRole('button', { name: 'Maximize panel', exact: true }).click();
  await counter.click(); assert.equal(await counter.innerText(), 'Page count 2');
  await editor.focus();
  await page.waitForFunction(() => document.querySelector('.thread-composer-overlay__content')?.getAttribute('data-density') === 'expanded');
  await page.getByRole('button', { name: 'Latest turn', exact: true }).click();
  const response = page.locator('.thread-composer-overlay__response'); await response.waitFor();
  await page.waitForFunction(() => document.querySelector('.thread-composer-overlay__response')?.textContent?.includes('Latest answer preview'));
  assert.match(await response.innerText(), /Latest answer preview/);
  assert.doesNotMatch(await response.innerText(), /User intro must not be duplicated/);
  const responseBox = await response.boundingBox(); assert.ok(responseBox && responseBox.height <= 361);
  await page.screenshot({ path: output + '/latest-turn.png' });
  // Scrolling the preview consumes its own scroll; it must not hide/expand input.
  await response.hover(); await page.mouse.wheel(0, 100); await page.waitForTimeout(100);
  assert.equal(await page.getByRole('button', { name: 'Latest turn', exact: true }).getAttribute('aria-expanded'), 'true');
  await page.getByRole('button', { name: 'Hide chat input', exact: true }).click();
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.opencraft-composer-editor').evaluate(e => Boolean(e.closest('[inert]'))), true);
  const reveal = page.getByRole('button', { name: 'Show chat input', exact: true });
  await reveal.focus(); await reveal.press('Enter'); await page.waitForTimeout(180);
  assert.match(await editor.innerText(), /Keep this parent draft/);
  assert.equal(await page.evaluate(() => (window as any).fixture.pages.listForOwner('scope').length), 1);
  await page.getByRole('button', { name: 'Restore panel', exact: true }).click();
  await page.evaluate(() => (window as any).fixture.panels.dispatch('scope', { type: 'set-region-open', region: 'right', open: false }));
  // Parked iframe resources keep their viewport dimensions; visibility and
  // interaction, not a zero width, define the hidden presentation.
  await page.waitForFunction(() => { const f = document.querySelector('iframe'); return !f || f.getAttribute('aria-hidden') === 'true'; });
  await page.evaluate(() => (window as any).fixture.panels.dispatch('scope', { type: 'set-region-open', region: 'right', open: true }));
  await counter.click(); assert.equal(await counter.innerText(), 'Page count 3');
  await page.screenshot({ path: output + "/browser-right.png" });
  await page.locator('[data-panel-region="right"] .right-panel-tab[data-active="true"] .right-panel-tab__close').click();
  assert.equal(await page.evaluate(() => (window as any).fixture.pages.listForOwner('scope').length), 0);
  await page.getByRole('button', { name: 'Maximize panel', exact: true }).click();
  await overlay.waitFor();
  await editor.press('Enter');
  await page.waitForFunction(() => (window as any).fixture.submitted.length === 1);
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.submitted[0]), { type: 'existing-thread', key: { hostId: 'fixture-host', threadId: 'parent' } });
  assert.deepEqual(errors, []);
  await writeFile(output + "/result.json", JSON.stringify({ result: "passed", invariants: ["WSP-01", "WSP-02", "WSP-05", "WSP-06", "WSP-10", "WSP-14"], bottomPanelAbsent: true, browserCounterSurvivedMaximizeAndHide: true, errors }, null, 2));
  console.log("Workspace presentation smoke passed: " + output);
  }
} finally { await browser?.close(); await vite.close(); }
