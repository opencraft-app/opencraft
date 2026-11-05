import assert from "node:assert/strict";
import { sidebarToggleGlyphs } from "@opencraft/design-system/sidebar-toggle-glyphs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const browserName = process.env.OPENCRAFT_SMOKE_BROWSER ?? 'chromium';
assert(['chromium', 'webkit'].includes(browserName), 'Select chromium or webkit');
const mobile = process.argv.includes('--mobile-browser');
const pagePresentation = process.argv.includes('--page-presentation');
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
const params=new URLSearchParams(location.search);const mobile=params.has('mobile');const topology=params.has('page-presentation');
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
panels.register({kind:'fixture-document',createTab:({id})=>({id,resource:id,kind:'fixture-document',region:'right',title:'Notes',icon:'file',closable:true,preview:false}),disposeTab:t=>closed.push(t.resource)});
panels.registerToolbarAction({id:'fixture.new-document',region:'right',order:200,label:'New document tab',creationLabel:'Document',icon:'file',run:()=>{panels.open('scope','fixture-document',{id:'document:one'});}});
function Tool(){return <div style={{height:'100%',padding:20}}><input aria-label='Terminal input' defaultValue='process alive'/></div>}
function Document(){return <div>Document content</div>}
const renderers=[{kind:'fixture-document',Component:Document},{kind:'terminal',Component:Tool,residency:'while-tab-open'},...ctx.workbenchPanelRenderers.getSnapshot()];
const subscribe=f=>panels.subscribeOwner('scope',f),get=()=>panels.getOwnerSnapshot('scope');

function FixtureHeader(){const shell=useShellPresentation();return <>{topology&&<button data-fixture-sidebar onClick={()=>shell?.toggleSidebar()}>Toggle sidebar</button>}<button type='button' onClick={()=>shell?.toggleRightPanel()}>Open preview</button></>}
function App(){const state=useSyncExternalStore(subscribe,get);const [sidebar,setSidebar]=useState(false);const [width,setWidth]=useState(275);const [enabled,setEnabled]=useState(true);const[unified,setUnified]=useState(true);
window.fixture={state,closed,submitted,setSidebar,setUnified,controller,panels,keyboardRequests,setThemePreference,setEnabled,pages,openBrowser:()=>workbench.open('scope',{initialUrl:location.origin+'/browser-fixture',panelOwnerId:'scope'})};
const panel=()=> <RightPanel state={state} presentationId='view' renderers={renderers} toolbarActions={panels.getToolbarActionSnapshot()} toolbarActionContext={{ownerId:'scope',resourceOwnerId:'scope',hostId:'fixture-host',cwd:null}} onAction={a=>panels.dispatch('scope',a)} onCloseTab={t=>panels.close('scope',t.region,t.id)}/>;
const navigation=topology&&unified?{layout:'unified',actions:[],account:{snapshot:{phase:'anonymous'},onOpen:()=>{}},onOpenSettings:()=>{}}:undefined;
return <AppShell navigation={navigation} layoutScope='scope' mainContentLayout='default' header={<FixtureHeader/>} floatingSidebarHeader={()=>null} leftPanel={<div><p>Navigation</p><button data-fixture-drawer-action onClick={()=>closed.push("drawer-action")}>Drawer action</button></div>} sidebarOpen={sidebar} sidebarWidth={width} onSidebarCollapse={()=>setSidebar(false)} onSidebarExpand={()=>setSidebar(true)} onSidebarResizeEnd={setWidth} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanelKeepMounted={true} rightPanel={panel('right')} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onRightPanelOpenChange={open=>panels.dispatch('scope',{type:'set-region-open',region:'right',open})}>
<div style={{height:'100%',display:'flex',flexDirection:'column'}}><p style={{flex:1}}>Parent conversation</p>
<ThreadComposerPresentation scopeId='scope' controller={controller} activeTabId={state.right.activeTabId} enabled={enabled} timeline={{key,revision:1,phase:'live',authoritative:true,anchorFrameIds:new Map(),frames:[{id:'user-frame',type:'user',turnId:'turn',status:'complete',durationMs:null,hookStats:null,anchors:[],blocks:[{id:'user-block',type:'text',text:'User intro must not be duplicated',sourceItemIds:[],streaming:false}]},{id:'assistant-frame',type:'assistant',turnId:'turn',status:'complete',durationMs:1000,hookStats:null,anchors:[],blocks:[{id:'answer',type:'text',text:'Latest answer preview\\n\\n'+('A bounded response paragraph.\\n\\n'.repeat(40)),sourceItemIds:['answer'],streaming:false,completed:true,phase:'final_answer'}]}]}} documentContext={{conversationId:'parent',hostId:'fixture-host',cwd:null,theme:'light'}}>
<div className='thread-composer-region'><OpenCraftComposer controller={controller} onSubmit={async intent=>{submitted.push(intent.target)}} onCancel={()=>{}} /></div>
</ThreadComposerPresentation></div></AppShell>}
createRoot(document.getElementById('root'),undefined,params.get('locale')??'en-US').render(<AsyncNoticesProvider><TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}><BrowserEnvironmentProvider pages={pages} surfaces={surfaces} presentations={presentations} workbench={workbench}><App/><BrowserPresentationRoot/></BrowserEnvironmentProvider></TimelineBlockRendererProvider></AsyncNoticesProvider>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", cacheDir: "node_modules/.vite-workspace-presentation", resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0 }, optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@tanstack/react-query"] }, plugins: [{ name: "workspace-presentation-fixture", resolveId: id => id === "/workspace-probe.tsx" ? id : null, load: id => id === "/workspace-probe.tsx" ? source : null, configureServer(server) { server.middlewares.use((req,res,next) => { if (req.url === "/browser-fixture") { res.setHeader("content-type","text/html"); res.end('<title>Fixture web page</title><button onclick="this.textContent=String.fromCharCode(80,97,103,101,32,99,111,117,110,116,32)+(++window.count)">Page count 0</button><script>window.count=0</script>'); return; } if(req.url?.split("?")[0] !== "/") return next();res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/workspace-probe.tsx"></script>'); }); } }] });
let browser: any;
const errors: string[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await playwright[browserName].launch({ headless: true, ...(browserName === 'chromium' ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] } : {}) });
  if (pagePresentation) {
    const receipts: unknown[] = [];
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript('window.__name=value=>value');
      page.setDefaultNavigationTimeout(120_000); await page.goto(vite.resolvedUrls!.local[0]! + '?mobile=1&page-presentation=1');
      await page.waitForFunction(() => Boolean((window as any).fixture));
      await page.evaluate(() => { const f=(window as any).fixture; f.openBrowser(); if(!f.panels.getOwnerSnapshot('scope').rightPanelFullWidth)f.panels.dispatch('scope',{type:'toggle-right-full-width'}); });
      await page.getByRole('button', { name: 'Open preview', exact: true }).click();
      await page.getByRole('button', { name: 'Agent', exact: true }).click();
      const editor=page.locator('.opencraft-composer-editor');
      await editor.click();
      await page.keyboard.insertText('Preserve this draft');
      await page.waitForFunction(()=>(window as any).fixture.controller.getSnapshot().draft.document && JSON.stringify((window as any).fixture.controller.getSnapshot().draft.document).includes('Preserve this draft'));
      await editor.evaluate(e => { (window as any).originalEditor=e; });
      await page.locator('.web-browser-frame').evaluate(e => { (window as any).originalGuest=e; });
      const summary=page.locator('.thread-composer-overlay__summary');
      await summary.waitFor();
      await page.waitForTimeout(500);
      let box=(await summary.boundingBox())!;
      const cdp=await context.newCDPSession(page);
      const touch=(type:string,x=0)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y:box.y+box.height/2,id:1}]});
      const geometry=()=>page.evaluate(()=>{
        const rect=(s:string)=>document.querySelector(s)!.getBoundingClientRect();
        const anchor=rect('.main-content-body'),overlay=rect('.thread-composer-overlay-host'),row=rect('.app-shell-row');
        const content=document.querySelector('.app-shell-page-overlays') as HTMLElement;
        return {rowX:row.x,anchorX:anchor.x,overlayX:overlay.x,anchorBottom:anchor.bottom,overlayBottom:overlay.bottom,
          blocked:content?.inert??false,inputBlocked:!!document.querySelector('[contenteditable="true"]')!.closest('[inert]'),
          guestBlocked:!!document.querySelector('.web-browser-frame')!.closest('[inert]'),
          sameEditor:document.querySelector('[contenteditable="true"]')===(window as any).originalEditor,
          sameGuest:document.querySelector('.web-browser-frame')===(window as any).originalGuest};
      });
      const check=async(label:string,moving:boolean)=>{
        await page.waitForTimeout(35);
        const g=await geometry();
        assert.ok(Math.abs(g.anchorX-g.overlayX)<1, label+': page and input move together '+JSON.stringify(g));
        assert.ok(Math.abs(g.anchorBottom-g.overlayBottom)<1, label+': common safe frame');
        assert.ok(g.sameEditor&&g.sameGuest, label+': original editor and guest survive');
        if(moving){assert.ok(g.rowX>15,label+': real held movement');assert.ok(g.blocked&&g.inputBlocked&&g.guestBlocked,label+': page-wide input boundary');}
        receipts.push({reducedMotion,label,...g});
      };
      await check('rest',false);
      await touch('touchStart',80);
      for(const x of [112,152,192]){await touch('touchMove',x);await check('held-'+x,true);}
      await touch('touchMove',125);await check('reversed',true);
      await touch('touchCancel');await page.waitForTimeout(650);await check('cancelled',false);
      box=(await summary.boundingBox())!;
      await touch('touchStart',80);
      for(const x of [115,155,195,245,300]){await touch('touchMove',x);await page.waitForTimeout(20);}
      await touch('touchEnd');await page.waitForTimeout(650);await check('opened',true);
      await page.screenshot({path:output+'/page-open-'+reducedMotion+'.png'});
      await page.locator('[data-fixture-drawer-action]').click();
      assert.deepEqual(await page.evaluate(()=>(window as any).fixture.closed),['drawer-action']);
      await page.locator('.app-shell-mobile-page-dismiss').evaluate((e:HTMLElement)=>e.click());
      await page.waitForTimeout(650);await check('closed',false);
      assert.equal(await editor.textContent(),'Preserve this draft');
      await page.setViewportSize({width:1400,height:900});
      await page.evaluate(()=>{document.documentElement.dataset.uiDensity='pointer';(window as any).fixture.setSidebar(true)});
      await page.waitForTimeout(700);await check('desktop-docked',false);
      await page.evaluate(()=>{(window as any).fixture.setSidebar(false);(window as any).fixture.setUnified(false)});
      await page.waitForTimeout(650);
      await page.mouse.move(2,150);await page.waitForTimeout(650);
      await check('desktop-floating',false);
      const desktopLayers=await page.evaluate(()=>({page:Number(getComputedStyle(document.querySelector('.app-shell-page-presentation')!).zIndex),drawer:Number(getComputedStyle(document.querySelector('.app-shell-floating-overlay-root')!).zIndex)}));
      assert.ok(desktopLayers.page<desktopLayers.drawer,'desktop drawer covers page overlays');
      await page.screenshot({path:output+'/desktop-floating-'+reducedMotion+'.png'});
      await context.close();
    }
    assert.deepEqual(errors,[]);
    await writeFile(output+'/page-presentation.json',JSON.stringify(receipts,null,2));
    console.log('Page presentation passed:',receipts.length,'geometry/continuity samples');
    process.exitCode=0;
  } else if (mobile) {
    for (const theme of ['light', 'dark']) {
      console.log('Mobile browser:',theme);
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
      page.on('pageerror', error => { errors.push(error.message); console.error('Browser:', error.message); });
      page.on('console', message => { if (message.type() === 'error') console.error('Console:', message.text()); });
      page.on('requestfailed', request => console.error('Request:', request.url(), request.failure()));
      await page.addInitScript('window.__name=value=>value');
      page.setDefaultNavigationTimeout(120_000); await page.goto(vite.resolvedUrls!.local[0]! + '?mobile=1&theme=' + theme);
      await page.waitForFunction(() => Boolean((window as any).fixture));
      await page.evaluate(() => { const f=(window as any).fixture; f.openBrowser(); f.openBrowser(); if(!f.panels.getOwnerSnapshot('scope').rightPanelFullWidth)f.panels.dispatch('scope',{type:'toggle-right-full-width'}); });
      await page.getByRole('button',{name:'Open preview',exact:true}).click();
      const dock = page.locator('.panel-mobile-dock');
      try { await dock.waitFor({ timeout: 15000 }); }
      catch (error) { await page.screenshot({ path: output + '/mobile-failure.png' }); await writeFile(output + '/mobile-failure.html', await page.content()); console.error('Fixture state:',await page.evaluate(()=>(window as any).fixture?.state)); throw error; }
      assert.equal(await dock.locator('.panel-mobile-dock__address.ui-control-surface[data-control-surface="floating"]').count(), 1, 'dock uses the shared Shell surface');
      assert.equal(await dock.locator('.ui-liquid-glass:visible').count(), 1, 'one shared lens for the group');
      assert.equal(await dock.locator('button:not(.ui-button)').count(), 0, 'all dock actions consume shared buttons');
      const workspaceGlyph = dock.getByRole('button', { name: 'Back to workspace', exact: true }).locator('svg');
      assert.equal(await workspaceGlyph.getAttribute('data-sidebar-toggle-icon-state'), 'hidden', 'workspace uses the same sidebar entrance as Shell');
      assert.equal(await workspaceGlyph.getAttribute('viewBox'), sidebarToggleGlyphs.viewBox);
      assert.equal(await workspaceGlyph.locator('path').getAttribute('d'), sidebarToggleGlyphs.hidden, 'no lookalike sidebar artwork');
      const iconSizes = await dock.locator('button svg').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, expected: parseFloat(getComputedStyle(element).getPropertyValue('--size-chrome-icon')) };
      }));
      assert.ok(iconSizes.length >= 5);
      for (const size of iconSizes) {
        assert.equal(size.width, size.expected, 'chrome token owns dock glyph width');
        assert.equal(size.height, size.expected, 'chrome token owns dock glyph height');
      }

      const assertFixedTabSlot = async () => {
        const position = await dock.evaluate(element => {
          const surface = element.querySelector('.panel-mobile-dock__address')!;
          const tabs = element.querySelector('.panel-mobile-dock__tabs')!;
          const style = getComputedStyle(surface), frame = surface.getBoundingClientRect(), bounds = tabs.getBoundingClientRect();
          return { x: bounds.x, width: bounds.width, height: bounds.height,
            trailingEdge: frame.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth), right: bounds.right };
        });
        assert.ok(position.width >= 44 && position.height >= 44, 'tab entrance stays visible with its touch target');
        assert.ok(Math.abs(position.right - position.trailingEdge) < 1, 'tab entrance always owns the final toolbar slot');
        return position;
      };
      await assertFixedTabSlot();
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
        await assertFixedTabSlot();
        const geometry = await dock.evaluate(e => {
          const r = e.getBoundingClientRect();
          return { dock: r.toJSON(), width: innerWidth, height: innerHeight, viewport: { width: visualViewport?.width, height: visualViewport?.height }, panel: e.closest('.browser-panel')?.getBoundingClientRect().toJSON() };
        });
        await writeFile(`${output}/geometry-${theme}-${width}.json`, JSON.stringify(geometry, null, 2));
        if (!(geometry.dock.left >= 0 && geometry.dock.right <= geometry.width && geometry.dock.bottom <= geometry.height)) {
          await page.screenshot({ path: `${output}/overflow-${theme}-${width}.png` });
        }
        assert.equal(geometry.dock.left >= 0 && geometry.dock.right <= geometry.width && geometry.dock.bottom <= geometry.height, true);
        const row = await dock.locator('.panel-mobile-dock__address').boundingBox();
        assert.ok(row && row.height < 60, 'all browser controls occupy one row');
        for (const button of await dock.locator('button:visible').all()) {
          const r = await button.boundingBox(); assert(r && r.width >= 44 && r.height >= 44);
          assert.ok(row && r.y >= row.y && r.y + r.height <= row.y + row.height, 'control stays on the address row');
          assert.ok(r.x >= geometry.dock.left && r.x + r.width <= geometry.dock.right, 'touch target stays inside the viewport');
        }
        const address = await dock.getByRole('textbox', { name: 'Web address', exact: true }).boundingBox();
        assert.ok(address && address.width >= 60, 'address retains usable space at narrow widths');
      }
      await page.setViewportSize({ width: 390, height: 480 });
      await settleMobileViewport(page);
      const ordinarySlotMargin = await page.locator('.browser-panel[data-mobile-browser="true"] .browser-viewport-slot').evaluate(e=>getComputedStyle(e).marginBottom);
      await page.evaluate(() => { document.documentElement.style.setProperty('--safe-layout-inset-bottom','34px'); });
      await page.waitForFunction(() => {
        const dock = document.querySelector('.panel-mobile-dock');
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
      assert.equal(await dock.getByRole('button', { name: 'Keyboard', exact: true }).isVisible(),true, 'remote keyboard remains independently accessible while open');
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
      await dock.getByRole('button', { name: 'Agent', exact: true }).tap();
      await page.locator('.thread-composer-overlay__latest[data-visible="true"]').waitFor();
      assert.equal(await page.locator('.browser-agent-sheet__header').count(), 0, 'no separate Agent sheet header');
      assert.equal(await dock.getByRole('button', { name: 'Agent', exact: true }).innerText(), '', 'Agent uses its icon and accessible name');
      await editor.fill('Keep this mobile draft');
      // Exercise the viewport-tracking CSS that a physical mobile keyboard activates.
      // Resizes simulate keyboard geometry; they do not prove OS keyboard behavior.
      await page.evaluate(() => { document.documentElement.dataset.timelineTracksVisualViewport = 'true'; });
      for (const width of [320, 390, 430]) {
        await editor.focus();
        await page.setViewportSize({ width, height: 480 });
        await settleMobileViewport(page);
        await page.setViewportSize({ width, height: 844 });
        await settleMobileViewport(page);
        await editor.evaluate(e => (e as HTMLElement).blur());
        await page.waitForFunction(() => document.querySelector('.thread-composer-overlay__content')?.getAttribute('data-density') === 'expanded');
        const geometry = await editor.evaluate(e => {
          const shell = e.closest('.opencraft-composer-shell')!;
          const footer = shell.querySelector('.opencraft-composer-footer')!;
          const attachment = shell.querySelector('.opencraft-composer-footer__attachment')!;
          const end = shell.querySelector('.opencraft-composer-footer__end')!;
          return { editor: e.getBoundingClientRect().toJSON(), shell: shell.getBoundingClientRect().toJSON(),
            footer: footer.getBoundingClientRect().toJSON(), attachment: attachment.getBoundingClientRect().toJSON(),
            end: end.getBoundingClientRect().toJSON(), endDisplay: getComputedStyle(end).display,
            sameNode: e === (window as any).originalEditor };
        });
        assert.equal(geometry.sameNode, true);
        assert.match(await editor.innerText(), /Keep this mobile draft/);
        assert.ok(geometry.editor.width > geometry.shell.width / 2, 'blurred text retains usable editor width');
        assert.notEqual(geometry.endDisplay, 'none', 'send controls remain available after blur');
        assert.ok(geometry.end.width > 0 && geometry.end.height > 0);
        assert.ok(geometry.attachment.y < geometry.end.y + geometry.end.height && geometry.end.y < geometry.attachment.y + geometry.attachment.height, 'add and send share the footer row');
        assert.ok(geometry.shell.x >= 0 && geometry.shell.x + geometry.shell.width <= width);
        await writeFile(output + '/blurred-' + theme + '-' + width + '.json', JSON.stringify(geometry, null, 2));
      }
      await page.screenshot({ path: output + '/keyboard-dismissed-' + theme + '.png' });
      await dock.getByRole('button', { name: 'Agent', exact: true }).tap();
      assert.equal(await editor.isVisible(), false, 'Agent explicitly hides the touch editor');
      await dock.getByRole('button', { name: 'Agent', exact: true }).tap();
      assert.match(await editor.innerText(), /Keep this mobile draft/);
      assert.equal(await editor.evaluate(e => e === (window as any).originalEditor), true);
      await page.evaluate(() => { delete document.documentElement.dataset.timelineTracksVisualViewport; });
      await page.setViewportSize({ width: 390, height: 844 });
      await settleMobileViewport(page);
      await editor.focus();
      await page.evaluate(() => document.documentElement.style.setProperty('--safe-layout-inset-bottom','34px'));
      const browserComposerPadding=page.locator('.thread-composer-overlay-host[data-mobile-panel="true"] .thread-composer-overlay__padding');
      const dockAllocation = await browserComposerPadding.evaluate(e=>getComputedStyle(e).paddingBottom);
      assert.ok(parseFloat(dockAllocation) < 80, 'single-row dock reservation');
      const assertPortalGeometry = async (inset: number, timeout = 5000) => {
        try { await page.waitForFunction(inset => {
          const anchor = document.querySelector('.main-content-body');
          const host = document.querySelector('.thread-composer-overlay-host[data-mobile-panel="true"]');
          const surface = host?.querySelector('.thread-composer-overlay__interactive');
          const composer = host?.querySelector('.opencraft-composer-shell');
          if (!anchor || !host || !surface || !composer) return false;
          const a = anchor.getBoundingClientRect(), h = host.getBoundingClientRect(), b = surface.getBoundingClientRect(), c = composer.getBoundingClientRect();
          const dock = document.querySelector('.panel-mobile-dock')!.getBoundingClientRect();
          return a.bottom === innerHeight - inset && h.bottom === a.bottom && Math.abs(c.bottom - (dock.top - 8)) < 1 && c.bottom === b.bottom;
        }, inset, { timeout }); } catch (error) {
          await writeFile(output + '/portal-failure-' + theme + '.json', JSON.stringify(await page.evaluate(() => ({ anchor:document.querySelector('.main-content-body')?.getBoundingClientRect().toJSON(), host:document.querySelector('.thread-composer-overlay-host[data-mobile-panel="true"]')?.getBoundingClientRect().toJSON(), composer:document.querySelector('.thread-composer-overlay-host[data-mobile-panel="true"] .opencraft-composer-shell')?.getBoundingClientRect().toJSON(), height:innerHeight, html:document.querySelector('.thread-composer-overlay-host[data-mobile-panel="true"]')?.outerHTML.slice(0,700) })), null, 2));
          throw error;
        }
        const geometry = await page.evaluate(() => ({
          anchorBottom: document.querySelector('.main-content-body')!.getBoundingClientRect().bottom,
          hostBottom: document.querySelector('.thread-composer-overlay-host[data-mobile-panel="true"]')!.getBoundingClientRect().bottom,
          surfaceBottom: document.querySelector('.thread-composer-overlay-host[data-mobile-panel="true"] .thread-composer-overlay__interactive')!.getBoundingClientRect().bottom,
          composerBottom: document.querySelector('.thread-composer-overlay-host[data-mobile-panel="true"] .opencraft-composer-shell')!.getBoundingClientRect().bottom,
          dockTop: document.querySelector('.panel-mobile-dock')!.getBoundingClientRect().top,
          height: innerHeight,
        }));
        assert.equal(geometry.anchorBottom, geometry.height - inset);
        assert.equal(geometry.hostBottom, geometry.anchorBottom, 'body portal measures the protected content anchor');
        assert.ok(Math.abs(geometry.surfaceBottom - (geometry.dockTop - 8)) < 1, 'Composer sits above the one browser rail');
        assert.equal(geometry.composerBottom, geometry.surfaceBottom, 'original Composer has no enclosing sheet padding');
        assert.ok(geometry.composerBottom <= geometry.hostBottom - 8);
        return geometry;
      };
      // Native keyboard pan can move the fixed plane while client-space Shell
      // remains visible. Simulate that basis shift without resizing the layout
      // viewport, using the same origin/capacity contract as the viewport owner.
      await editor.focus();
      await page.evaluate(() => {
        const root = document.documentElement;
        root.dataset.timelineTracksVisualViewport = 'true';
        root.dataset.timelineKeyboardOpen = 'true';
        root.style.setProperty('--timeline-available-viewport-height', '480px');
        root.style.setProperty('--timeline-available-viewport-width', '390px');
        root.style.setProperty('--timeline-available-viewport-top', '-260px');
        root.style.setProperty('--timeline-available-viewport-left', '-12px');
        root.style.transform = 'translate(12px, 260px)';
      });
      await page.waitForFunction(() => document.querySelector('.main-content-body')!.getBoundingClientRect().bottom === 480);
      // Wait for anchor capacity measurement, then compare actual client bounds.
      await page.waitForFunction(() => document.querySelector('.thread-composer-overlay-host[data-mobile-panel="true"]')!.getBoundingClientRect().height === document.querySelector('.main-content-body')!.getBoundingClientRect().height);
      const keyboardPan = await page.evaluate(() => {
        const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON();
        return { anchor: bounds('.main-content-body'), host: bounds('.thread-composer-overlay-host[data-mobile-panel="true"]'),
          editor: bounds('.opencraft-composer-editor'), send: bounds('.opencraft-composer-submit'), dock: bounds('.panel-mobile-dock'),
          focused: document.activeElement === (window as any).originalEditor, layoutHeight: innerHeight };
      });
      await page.screenshot({ path: output + '/keyboard-open-pan-' + theme + '.png' });
      await writeFile(output + '/keyboard-open-pan-' + theme + '.json', JSON.stringify(keyboardPan, null, 2));
      assert.equal(keyboardPan.layoutHeight, 844, 'keyboard simulation retains the layout viewport');
      assert.equal(keyboardPan.focused, true);
      assert.ok(Math.abs(keyboardPan.host.top - keyboardPan.anchor.top) < 1, 'portal shares Shell client origin after native pan');
      assert.ok(Math.abs(keyboardPan.host.left - keyboardPan.anchor.left) < 1, 'portal shares Shell horizontal origin');
      assert.ok(keyboardPan.editor.top >= keyboardPan.anchor.top && keyboardPan.editor.bottom <= keyboardPan.dock.top, 'focused editor remains above the dock in visible capacity');
      assert.ok(keyboardPan.send.top >= keyboardPan.anchor.top && keyboardPan.send.bottom <= keyboardPan.dock.top, 'send remains visible with keyboard open');
      await page.evaluate(() => {
        const root = document.documentElement;
        root.style.removeProperty('transform');
        for (const suffix of ['height', 'width', 'top', 'left']) root.style.removeProperty('--timeline-available-viewport-' + suffix);
        delete root.dataset.timelineTracksVisualViewport;
        delete root.dataset.timelineKeyboardOpen;
      });
      const portalSafe = await assertPortalGeometry(34);
      await page.evaluate(() => { document.documentElement.dataset.timelineKeyboardOpen = 'true'; });
      const portalKeyboard = await assertPortalGeometry(0);
      await page.evaluate(() => { delete document.documentElement.dataset.timelineKeyboardOpen; });
      const portalRestored = await assertPortalGeometry(34);
      await page.screenshot({ path: output + '/portal-safe-34-' + theme + '.png' });
      const wrongAnchor = await page.addStyleTag({ content: '.thread-composer-overlay-host[data-mobile-panel="true"] { top: 0 !important; height: 100vh !important; }' });
      await page.waitForFunction(() => document.querySelector('.thread-composer-overlay-host[data-mobile-panel="true"]')!.getBoundingClientRect().bottom === innerHeight);
      assert.equal(await browserComposerPadding.evaluate(e=>getComputedStyle(e).paddingBottom),dockAllocation);
      await assert.rejects(assertPortalGeometry(34, 300), 'viewport-sized portal must fail even with the same dock allocation');
      await wrongAnchor.evaluate(e => e.remove());
      await assertPortalGeometry(34);
      await writeFile(output + '/portal-geometry-' + theme + '.json', JSON.stringify({ portalSafe, portalKeyboard, portalRestored, wrongAnchorRejected: true }, null, 2));
      await page.evaluate(() => document.documentElement.style.removeProperty('--safe-layout-inset-bottom'));
      await assertPortalGeometry(0);
      assert.equal(await editor.evaluate(e => e === (window as any).originalEditor), true);
      const latest = page.locator('.thread-composer-overlay__latest[data-visible="true"]');
      for (const width of [320, 390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await settleMobileViewport(page);
        await assertPortalGeometry(0);
        const card = await latest.boundingBox(), composer = await page.locator('.thread-composer-overlay-host[data-mobile-panel="true"] .opencraft-composer-shell').boundingBox();
        assert.ok(card && composer && card.x > composer.x && card.x + card.width < composer.x + composer.width, 'recent turn is inset behind the original Composer');
        assert.ok(composer && composer.x >= 0 && composer.x + composer.width <= width, 'Composer cannot protrude outside the phone');
        assert.ok(card && card.y >= 0, 'recent reply stays inside visible height');
      }
      await page.evaluate(() => { document.documentElement.dataset.timelineKeyboardOpen = 'true'; });
      for (const height of [480, 320]) {
        await page.setViewportSize({ width: 390, height });
        await settleMobileViewport(page);
        await assertPortalGeometry(0);
        await page.waitForFunction(() => document.querySelector('.thread-composer-overlay__latest[data-visible="true"]')!.getBoundingClientRect().top >= 0, undefined, { timeout: 3000 });
        assert.equal(await dock.getByRole('button', { name: 'Keyboard', exact: true }).isVisible(), true);
      }
      await page.evaluate(() => { delete document.documentElement.dataset.timelineKeyboardOpen; });
      await page.setViewportSize({ width: 390, height: 844 });
      await settleMobileViewport(page);
      await page.screenshot({ path: output + '/mobile-' + theme + '-agent.png' });
      await dock.getByRole('button', { name: 'Agent', exact: true }).tap();
      await dock.getByRole('button', { name: 'Tabs', exact: true }).tap();
      const overview = page.getByRole('dialog', { name: 'Tabs', exact: true });
      await overview.waitFor();
      assert.equal(await overview.locator('.panel-mobile-tab__activate').count(), 3);
      assert.equal(await overview.locator('button:not(.ui-button)').count(), 0, 'overview actions use shared navigation/buttons');
      assert.equal(await overview.locator('.ui-navigation-item[aria-current="page"]').count(), 1, 'shared navigation owns current-tab feedback');
      await page.screenshot({ path: output + '/mobile-' + theme + '-tabs.png' });
      console.log('Switching tabs:',theme);
      const otherTab = await page.evaluate(original => (window as any).fixture.state.right.tabs.find((t:any)=>t.kind==='browser'&&t.id!==original).id,originalTab);
      await overview.locator('[data-tab-id="'+otherTab+'"] .panel-mobile-tab__activate').tap();
      await dock.getByRole('button',{name:'Tabs',exact:true}).tap();
      await overview.locator('[data-tab-id="'+originalTab+'"] .panel-mobile-tab__activate').tap();
      console.log('Restored active page:',theme);
      await page.waitForFunction(() => { const f=(window as any).originalFrame as HTMLIFrameElement; const r=f.getBoundingClientRect(); return f.dataset.browserSurfaceVisible==='true' && document.elementFromPoint(r.left+10,r.top+10)===f && getComputedStyle(f.parentElement!).pointerEvents==='auto'; });
      await counter.click(); assert.equal(await counter.innerText(), 'Page count 2');
      assert.equal(await page.locator('iframe[data-browser-surface-visible="true"]').first().evaluate(e => e === (window as any).originalFrame), true);
      const beforeEditingTab = await assertFixedTabSlot();
      await dock.getByRole('textbox', { name: 'Web address', exact: true }).tap();
      const editingTab = await assertFixedTabSlot();
      assert.equal(editingTab.x, beforeEditingTab.x, 'address editing cannot move or hide the tab entrance');
      await page.screenshot({ path: output + '/address-editing-' + theme + '.png' });
      await dock.getByRole('button', { name: 'Tabs', exact: true }).tap();
      await overview.waitFor();
      await overview.getByRole('button', { name: 'Done', exact: true }).tap();
      assert.equal((await assertFixedTabSlot()).x, beforeEditingTab.x, 'blur and opening the overview preserve the target');

      await dock.getByRole('button', { name: 'Tabs', exact: true }).tap();
      console.log('Closing inactive tab:',theme);
      await overview.locator('[data-tab-id="'+otherTab+'"] .panel-mobile-tab__close').tap();
      await page.waitForFunction(()=>(window as any).fixture.pages.listForOwner('scope').length===1);
      await overview.getByRole('button', { name: 'New browser tab', exact: true }).tap();
      await page.waitForFunction(() => (window as any).fixture.pages.listForOwner('scope').length === 2);
      await dock.getByRole('button', { name: 'Agent', exact: true }).tap();
      assert.match(await editor.innerText(), /Keep this mobile draft/);
      assert.equal(await editor.evaluate(e => e === (window as any).originalEditor), true);
      await dock.getByRole('button', { name: 'Agent', exact: true }).tap();
      await dock.getByRole('button', { name: 'More browser actions', exact: true }).tap();
      const more = page.getByRole('dialog', { name: 'More browser actions', exact: true });
      await more.waitFor();
      assert.equal(await more.getByRole('button', { name: 'Reload', exact: true }).isVisible(), true);
      await more.getByRole('button', { name: 'Done', exact: true }).tap();
      await dock.getByRole('button', { name: 'Back to workspace', exact: true }).tap();
      await page.getByRole('button', { name: 'Open preview', exact: true }).tap();
      await dock.waitFor();
      // A non-browser tab keeps the same return, Agent and tab navigation.
      await dock.getByRole('button', { name: 'Tabs', exact: true }).tap();
      const allTabs = page.getByRole('dialog', { name: 'Tabs', exact: true });
      assert.equal(await allTabs.locator('[data-tab-kind="terminal"]').count(), 1);
      assert.ok(await allTabs.locator('[data-tab-kind="browser"]').count() > 0);
      await allTabs.getByRole('button', { name: 'New document tab', exact: true }).tap();
      await page.getByText('Document content', { exact: true }).waitFor();
      await assertFixedTabSlot();
      assert.equal(await dock.getByRole('button', { name: 'More browser actions', exact: true }).count(), 0);
      await dock.getByRole('button', { name: 'Tabs', exact: true }).tap();
      assert.equal(await allTabs.locator('[data-tab-kind="fixture-document"]').count(), 1);
      await allTabs.locator('[data-tab-kind="terminal"] .panel-mobile-tab__activate').tap();
      await dock.getByRole('button', { name: 'Tabs', exact: true }).tap();
      await allTabs.getByRole('button', { name: 'Close Notes', exact: true }).tap();
      assert.equal(await allTabs.locator('[data-tab-kind="fixture-document"]').count(), 0);
      assert.equal(await page.evaluate(() => (window as any).fixture.closed.filter((id: string) => id === 'document:one').length), 1);
      await allTabs.locator('[data-tab-kind="terminal"] .panel-mobile-tab__activate').tap();
      await page.getByRole('textbox', { name: 'Terminal input', exact: true }).fill('Keep terminal state');
      await assertFixedTabSlot();
      await page.screenshot({ path: output + '/terminal-tab-slot-' + theme + '.png' });
      await dock.getByRole('button', { name: 'Back to workspace', exact: true }).tap();
      await page.getByRole('button', { name: 'Open preview', exact: true }).tap();
      assert.equal(await page.getByRole('textbox', { name: 'Terminal input', exact: true }).inputValue(), 'Keep terminal state');
      assert.equal(await page.locator('.right-panel-toolbar:visible').count(), 0);
      await page.screenshot({ path: output + '/mobile-' + theme + '-terminal.png' });
      await dock.getByRole('button', { name: 'Tabs', exact: true }).tap();
      await allTabs.getByRole('searchbox', { name: 'Search tabs', exact: true }).fill('Terminal');
      assert.equal(await allTabs.locator('[data-tab-kind="browser"]').count(), 0);
      await allTabs.getByRole('searchbox', { name: 'Search tabs', exact: true }).fill('');
      await allTabs.locator('[data-tab-kind="browser"] .panel-mobile-tab__activate').first().tap();
      await dock.waitFor();
      assert.equal(await editor.evaluate(e => e === (window as any).originalEditor), true);
      await page.evaluate(() => { document.documentElement.dataset.uiDensity='compact'; });
      await page.locator('.browser-panel__toolbar').waitFor();
      assert.equal(await dock.count(), 0);
      await page.evaluate(() => { document.documentElement.dataset.uiDensity='touch'; });
      await dock.waitFor();
      await page.setViewportSize({ width: 1280, height: 844 });
      await page.locator('.browser-panel__toolbar').waitFor();
      assert.equal(await dock.count(), 0);
      // A manually hidden desktop overlay is detached; reveal it through its
      // existing desktop control before checking the preserved editor node.
      const desktopToggle = page.getByRole('button', { name: 'Show floating composer', exact: true });
      if (await desktopToggle.count()) await desktopToggle.click();
      assert.equal(await editor.evaluate(e => e === (window as any).originalEditor), true);
      // Exercise the same consumer with the product's Chinese catalog.
      await page.setViewportSize({ width: 390, height: 844 });
      page.setDefaultNavigationTimeout(120_000); await page.goto(vite.resolvedUrls!.local[0]! + '?mobile=1&theme=' + theme + '&locale=zh-CN');
      await page.waitForFunction(() => Boolean((window as any).fixture));
      await page.evaluate(() => { const f=(window as any).fixture; f.openBrowser(); if(!f.panels.getOwnerSnapshot('scope').rightPanelFullWidth)f.panels.dispatch('scope',{type:'toggle-right-full-width'}); });
      await page.getByRole('button', { name: 'Open preview', exact: true }).click();
      await dock.waitFor();
      await dock.getByRole('button', { name: 'Agent', exact: true }).tap();
      await page.locator('.thread-composer-overlay__summary').getByText('最近一轮', { exact: true }).waitFor();
      await page.screenshot({ path: output + '/zh-' + theme + '-agent.png' });
      await dock.getByRole('button', { name: '标签页', exact: true }).tap();
      await page.getByRole('dialog', { name: '标签页', exact: true }).waitFor();
      await page.screenshot({ path: output + '/zh-' + theme + '-tabs.png' });
      await page.close();
    }
    assert.deepEqual(errors, []);
    await writeFile(output + '/mobile-result.json', JSON.stringify({ result: 'passed', browser: browserName, version: browser.version(), themes: ['light','dark'], widths: [320,390,430], originalEditorRetained: true, originalPageRetained: true, keyboardBoundary: 'simulated capability; synchronous gesture verified, no physical OS keyboard proof', errors }, null, 2));
    console.log('Newera mobile browser actual-consumer smoke passed: ' + output);
  } else {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, reducedMotion: process.env.OPENCRAFT_REDUCED_MOTION === "0" ? "no-preference" : "reduce" });
  page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript("window.__name=value=>value");
  page.setDefaultNavigationTimeout(120_000); await page.goto(vite.resolvedUrls!.local[0]!, { timeout: 60000 }); await page.waitForLoadState("networkidle", { timeout: 60000 });
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
