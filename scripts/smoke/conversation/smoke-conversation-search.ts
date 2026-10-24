import assert from "node:assert/strict";
import { pluginBranding } from "../../../apps/workbench-web/plugin-branding.vite";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_SEARCH_REPORT ?? "/tmp/opencraft-conversation-search";
import { readFileSync } from "node:fs";
import { DEFAULT_APPLICATION_BRANDING, isApplicationBranding } from "@opencraft/extension-contract";
// Trusted local test data; public probes run without any downstream checkout.
const fixtureBranding = process.env.OPENCRAFT_SMOKE_BRANDING_FILE
  ? JSON.parse(readFileSync(process.env.OPENCRAFT_SMOKE_BRANDING_FILE, "utf8"))
  : DEFAULT_APPLICATION_BRANDING;
assert.ok(isApplicationBranding(fixtureBranding));
const source = `
import React,{useState}from'react';import{createIntlTestRoot as createRoot}from'/tests/fixtures/intl-root.tsx';
import{ConversationSearch}from'/apps/workbench-web/src/components/conversation-search.tsx';
import{Sidebar}from'/apps/workbench-web/src/components/sidebar.tsx';
import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import{ApplicationBrand}from'/apps/workbench-web/src/components/application-brand.tsx';
import{AppShellNavigationControls}from'/apps/workbench-web/src/components/app-shell-header.tsx';
const branding = ${JSON.stringify(fixtureBranding)};
import{createWebTimelineViewportPort}from'@opencraft/timeline-host-web';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{ModalSurface}from'/apps/workbench-web/src/components/modal/modal-surface.tsx';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
const queryClient=new QueryClient();
import{readHostThreadCatalog}from'/apps/workbench-web/src/runtime/host-thread-catalog.ts';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();const selected=[];
const catalogReads=[];const fixtureProfile={hostId:'a',hostKind:'local',enabled:true,autoConnect:true,includeInSidebar:true,revision:1};
const catalogRuntime={getSnapshot:()=>({phase:'ready'}),resources:{threads:{list:async params=>{
catalogReads.push(params.cursor);return params.cursor===null?{data:Array.from({length:50},(_,n)=>({id:'recent-'+n,title:'Recent '+n,updatedAt:0})),nextCursor:'older'}:{data:[{id:'older-repair',title:'用户云桌面异常',updatedAt:0}],nextCursor:null};}}}};
const completeCatalog=await readHostThreadCatalog({profile:fixtureProfile,currentProfile:()=>fixtureProfile,management:null,registry:{peekRuntime:()=>catalogRuntime,ensureConnected:async()=>catalogRuntime}});
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_scope,doc)=>doc});
const threads=[{id:'same',title:'中文 Search alpha',updatedAt:3,connectionHostId:'a',serverOrigin:{serverId:'a',label:'Alpha server'}},{id:'offline',title:'Search unavailable',updatedAt:2,connectionHostId:'a',interactionAvailable:false,serverOrigin:{serverId:'a',label:'Alpha server'}},{id:'same',title:'Search beta',updatedAt:1,connectionHostId:'b',serverOrigin:{serverId:'b',label:'Beta server'}},...completeCatalog.data.map(t=>({...t,connectionHostId:'a',serverOrigin:{serverId:'a',label:'Alpha server'}}))].map(t=>({...t,project:'opencraft',status:'ready',connectionHostLabel:t.connectionHostId,serverRouteLocality:'local'}));
function App(){const[open,setOpen]=useState(false);const[sidebar,setSidebar]=useState(true);const[other,setOther]=useState(false);window.fixture={setThemePreference};
return <><AppShell navigation={{layout:'unified',actions:[{id:'shell.start',title:'Start',icon:'home',onInvoke:()=>{}},{id:'shell.search',title:'Search conversations (Ctrl+K)',icon:'search',onInvoke:()=>setOpen(true)}],onOpenSettings:()=>{},account:null}}
layoutScope='test' sidebarOpen={sidebar} sidebarWidth={335} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setSidebar(false)} onSidebarExpand={()=>setSidebar(true)} onSidebarResizeEnd={()=>{}} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}}
header={<div className='app-shell-header'><AppShellNavigationControls brand={<ApplicationBrand branding={branding}/>} hostRole='persistent' sidebarOpen={sidebar} onToggleSidebar={()=>setSidebar(!sidebar)} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} onHome={()=>{}} actions={['sidebar-toggle']}/><button onClick={()=>setSidebar(!sidebar)}>Toggle sidebar</button></div>} floatingSidebarHeader={()=><AppShellNavigationControls brand={<ApplicationBrand branding={branding}/>} hostRole='transient' sidebarOpen onToggleSidebar={()=>setSidebar(false)} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} onHome={()=>{}} actions={[]}/>}
leftPanel={<Sidebar searchInDialog threads={threads} activeHostId='a' activeThreadId='' sidebarLayout={layout} onSelectThread={()=>{}} showFooter={false} showStart={false} onNewTask={()=>{}} onOpenSettings={()=>{}}/>}>
<textarea aria-label='Composer draft' defaultValue='Keep this draft'/><button onClick={()=>setOther(true)}>Other modal</button>
<ConversationSearch enabled open={open} onOpenChange={setOpen} threads={threads} loading={false} onSelectThread={(host,id)=>selected.push([host,id])}/></AppShell>
{other?<ModalSurface label='Another dialog' onDismiss={()=>setOther(false)}><input aria-label='Other input'/></ModalSurface>:null}</>}
window.viewportPort=createWebTimelineViewportPort(window,document,{kind:'browser',platform:'linux'});window.selected=selected;window.catalogReads=catalogReads;createRoot(document.getElementById('root')).render(<QueryClientProvider client={queryClient}><App/></QueryClientProvider>);`;
const vite = await createServer({configFile:false,root:process.cwd(),publicDir:"apps/workbench-web/public",logLevel:"error",resolve:{dedupe:["react","react-dom"]},cacheDir:"node_modules/.vite-conversation-search",esbuild:{jsx:"automatic",target:"esnext"},server:{host:"127.0.0.1",port:0},optimizeDeps:{include:["react","react-dom/client","@radix-ui/react-dialog","@radix-ui/react-dropdown-menu","@radix-ui/react-tooltip"]},plugins:[pluginBranding(process.env.OPENCRAFT_SMOKE_BRANDING_WORKSPACE ?? process.cwd(), []),{name:"search-fixture",resolveId:id=>id==="/search-probe.tsx"?id:null,load:id=>id==="/search-probe.tsx"?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=="/")return next();res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/search-probe.tsx"></script>');});}}]});
// Send native Chromium composition and keyboard input through the real modal boundary.
async function assertComposingEscape(page:any, input:any, dialog:any, reopen:()=>Promise<void>) {
  await input.fill('保留搜索');
  await input.evaluate(el=>{
    window.imeInput=el;window.imeEvents=[];
    el.addEventListener('compositionstart',()=>window.imeEvents.push({type:'start'}),{once:true});
    el.addEventListener('compositionend',()=>window.imeEvents.push({type:'end'}),{once:true});
    el.addEventListener('keydown',event=>{if(event.key==='Escape')window.imeEvents.push({type:'escape',composing:event.isComposing});});
  });
  const cdp=await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.imeSetComposition',{text:'候选',selectionStart:2,selectionEnd:2});
    const query=await input.inputValue();assert.equal(query,'保留搜索候选');
    await page.keyboard.press('Escape');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await dialog.isVisible(),true,'composing Escape retains the dialog');
    assert.equal(await input.inputValue(),query);
    assert.equal(await input.evaluate(el=>el===window.imeInput&&document.activeElement===el),true);
    assert.equal(await page.evaluate(()=>window.imeEvents.some(e=>e.type==='start')&&window.imeEvents.some(e=>e.type==='escape'&&e.composing)),true);
    await cdp.send('Input.insertText',{text:'已确认'});
    assert.equal(await page.evaluate(()=>window.imeEvents.some(e=>e.type==='end')),true);
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>window.imeEvents.some(e=>e.type==='escape'&&!e.composing)),true);
    assert.equal(await page.getByLabel('Composer draft').inputValue(),'Keep this draft');
    await reopen();await input.waitFor();assert.equal(await input.inputValue(),'');
  } finally {await cdp.detach();}
}
let browser:any;
try {
  await mkdir(output,{recursive:true});await vite.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  const errors:string[]=[];
  for(const platform of process.env.OPENCRAFT_SEARCH_MOBILE_ONLY ? [] : ["Win32","MacIntel"]){
    const page=await browser.newPage({viewport:{width:1280,height:800},reducedMotion:"reduce"});
    page.setDefaultTimeout(15000);page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.addInitScript(platform=>{Object.defineProperty(navigator,'platform',{value:platform});window.__name=value=>value;},platform);
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
    const trigger=page.locator('[data-action-id="shell.search"]');await trigger.waitFor();
    assert.equal(await page.locator('.sidebar-list-search').count(),0);
    await trigger.click();const dialog=page.getByRole('dialog',{name:'Search conversations',exact:true});await dialog.waitFor();
    const input=dialog.getByRole('combobox');assert.equal(await input.evaluate(el=>document.activeElement===el),true);
    await assertComposingEscape(page,input,dialog,async()=>{await trigger.click();});
    await input.fill('search');assert.equal(await dialog.getByRole('option').count(),3);
    assert.equal(await dialog.getByRole('option',{name:'Search unavailable Alpha server'}).isDisabled(),true);
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await dialog.waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>window.selected),[['b','same']]);
    await page.getByLabel('Composer draft').focus();await page.keyboard.press(platform==='MacIntel'?'Meta+k':'Control+k');await dialog.waitFor();
    await input.fill('云桌面异常');const older=dialog.getByRole('option',{name:'用户云桌面异常 Alpha server',exact:true});await older.waitFor();
    assert.equal(await dialog.getByRole('option').count(),1);assert.deepEqual(await page.evaluate(()=>window.catalogReads),[null,'older']);
    await older.click();await dialog.waitFor({state:'hidden'});assert.deepEqual(await page.evaluate(()=>window.selected),[['b','same'],['a','older-repair']]);
    await page.getByLabel('Composer draft').focus();await page.keyboard.press(platform==='MacIntel'?'Meta+k':'Control+k');await dialog.waitFor();
    await input.fill('no such conversation');await page.getByRole('status').filter({hasText:'No matching conversations'}).waitFor();
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    assert.equal(await page.getByLabel('Composer draft').inputValue(),'Keep this draft');assert.equal(await page.getByLabel('Composer draft').evaluate(el=>document.activeElement===el),true);
    await page.getByRole('button',{name:'Other modal',exact:true}).click();await page.getByLabel('Other input').focus();await page.keyboard.press(platform==='MacIntel'?'Meta+k':'Control+k');assert.equal(await dialog.count(),0);await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Toggle sidebar',exact:true}).click();
    await page.keyboard.press(platform==='MacIntel'?'Meta+k':'Control+k');await dialog.waitFor();assert.equal(await input.inputValue(),'');
    for(const theme of ['light','dark']){await page.evaluate(theme=>window.fixture.setThemePreference(theme),theme);await page.screenshot({path:output+'/'+platform+'-'+theme+'.png'});}
    // Responsive adaptation must retain the focused input, query and owner.
    await input.fill('search');await input.evaluate(el=>window.searchInput=el);
    await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>{const r=document.querySelector('.conversation-search')?.getBoundingClientRect();return r&&r.x===0&&r.y===0&&r.width===390&&r.height===844});
    assert.equal(await input.inputValue(),'search');assert.equal(await input.evaluate(el=>el===window.searchInput),true);
    let box=await dialog.boundingBox();let inputBox=await input.boundingBox();assert.ok(box&&inputBox&&inputBox.y>box.height-100);
    await page.screenshot({path:output+'/'+platform+'-mobile.png'});
    await page.setViewportSize({width:844,height:390});await page.evaluate(()=>document.documentElement.dataset.uiDensity='touch');
    await page.waitForFunction(()=>document.querySelector('.conversation-search')?.getBoundingClientRect().height===390);
    assert.equal(await input.inputValue(),'search');assert.equal(await input.evaluate(el=>el===window.searchInput),true);
    await dialog.getByRole('button',{name:'Close search conversations'}).click();await dialog.waitFor({state:'hidden'});
    // Restore desktop and verify outside dismissal remains available there.
    await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>delete document.documentElement.dataset.uiDensity);
    await page.keyboard.press(platform==='MacIntel'?'Meta+k':'Control+k');await dialog.waitFor();
    await page.waitForFunction(()=>document.querySelector('.conversation-search').getBoundingClientRect().x>0);
    await input.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.mouse.click(2,2);await dialog.waitFor({state:'hidden'});await page.close();
  }
  for(const theme of ['light','dark']) {
    const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce',userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'});
    page.setDefaultTimeout(15000);page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.addInitScript(theme=>{localStorage.setItem('opencraft.appearance-theme',theme);document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.uiDensity='touch');
      window.fixtureViewport=new EventTarget();Object.assign(window.fixtureViewport,{width:390,height:844,offsetLeft:0,offsetTop:0,scale:1});
      Object.defineProperty(window,'visualViewport',{value:window.fixtureViewport,configurable:true});
    },theme);
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
    const persistentToggle=page.locator('[data-app-shell-sidebar-trigger][data-chrome-action-host-role="persistent"]');await persistentToggle.waitFor();await persistentToggle.click();
    const header=page.locator('[data-mobile-sidebar] .shell-sidebar__header');await header.waitFor();
    const mobileSearch=header.locator('[data-action-id="shell.search.header"]');await mobileSearch.waitFor();
    assert.equal(await header.locator('.application-brand__mark').evaluateAll(els=>els.some(el=>el.getBoundingClientRect().width>0)),false);
    assert.equal(await header.locator('.application-brand__wordmark:visible').innerText(),fixtureBranding.name);
    await page.screenshot({path:output+'/drawer-initial-'+theme+'.png'});
    assert.equal(await page.locator('[data-mobile-sidebar] [data-action-id="shell.search"]').isVisible(),false);
    const scroll=page.locator('[data-mobile-sidebar] .shell-sidebar__scroll');await scroll.evaluate(el=>el.scrollTop=200);
    const scrollBefore=await scroll.evaluate(el=>el.scrollTop);assert.ok(scrollBefore>0);
    await page.screenshot({path:output+'/drawer-'+theme+'.png'});
    await mobileSearch.click();const dialog=page.getByRole('dialog',{name:'Search conversations',exact:true});const input=dialog.getByRole('combobox');await input.waitFor();
    assert.equal(await input.evaluate(el=>document.activeElement===el),true);
    await assertComposingEscape(page,input,dialog,async()=>{await mobileSearch.click();});
    await input.fill('search');await page.waitForFunction(()=>document.querySelectorAll('.conversation-search [role="option"]').length===3);
    for(const geometry of [{height:480,offsetTop:0},{height:380,offsetTop:100},{height:844,offsetTop:0}]) {
      await page.evaluate(geometry=>{Object.assign(window.fixtureViewport,geometry);window.fixtureViewport.dispatchEvent(new Event('resize'));},geometry);
      await page.waitForFunction(geometry=>{const r=document.querySelector('.conversation-search').getBoundingClientRect();return Math.abs(r.y-geometry.offsetTop)<1&&Math.abs(r.height-geometry.height)<1},geometry);
      const field=await input.boundingBox();const close=await dialog.locator('.modal-surface__close').boundingBox();assert.ok(field&&close&&field.y>=geometry.offsetTop&&field.y+field.height<geometry.offsetTop+geometry.height&&close.y+close.height<=geometry.offsetTop+geometry.height);
      assert.equal(await input.inputValue(),'search');await page.screenshot({path:output+'/search-'+theme+'-'+geometry.height+'.png'});
    }
    await page.emulateMedia({forcedColors:'active'});await page.waitForFunction(()=>matchMedia('(forced-colors: active)').matches&&getComputedStyle(document.querySelector('.conversation-search__input')).backdropFilter==='none');assert.equal(await dialog.locator('.conversation-search__input').evaluate(el=>getComputedStyle(el).backdropFilter),'none');await page.emulateMedia({forcedColors:'none'});
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.conversation-search__input')).backdropFilter==='none');
    await cdp.send('Emulation.setEmulatedMedia',{features:[]});await cdp.detach();
    await input.fill('');const body=dialog.locator('.conversation-search__body');await body.evaluate(el=>el.scrollTop=el.scrollHeight);
    const last=await dialog.getByRole('option').last().boundingBox();const field=await input.boundingBox();assert.ok(last&&field&&last.y+last.height<field.y,'last result clears the floating input');
    await dialog.locator('.modal-surface__close').click();await dialog.waitFor({state:'hidden'});
    assert.equal(await scroll.evaluate(el=>el.scrollTop),scrollBefore);assert.equal(await mobileSearch.evaluate(el=>document.activeElement===el),true);
    await persistentToggle.click();await header.waitFor({state:'hidden'});await persistentToggle.click();await header.waitFor();
    await mobileSearch.click();await dialog.getByRole('combobox').fill('Search beta');await dialog.getByRole('option',{name:'Search beta Beta server'}).click();await dialog.waitFor({state:'hidden'});
    await page.locator('[data-mobile-sidebar] .shell-sidebar__header').waitFor({state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>window.selected),[['b','same']]);assert.equal(await page.getByLabel('Composer draft').inputValue(),'Keep this draft');await page.close();
  }
  assert.deepEqual(errors,[]);await writeFile(output+'/report.json',JSON.stringify({ok:true,platforms:['macOS Cmd+K','Windows Ctrl+K'],checks:['native composing Escape retains query/input/focus, ordinary Escape closes','real AppShell rail and Sidebar input removal','focus and draft restoration','duplicate IDs across Hosts','disabled rows skipped by keyboard','Enter selection','empty results','other-modal ownership','collapsed sidebar','desktop outside dismissal','responsive query/input identity','mobile full-page search and floating header','keyboard resize/pan/close through real viewport port','mobile scroll/focus restoration and collapse/reopen','forced-colors and reduced-transparency opaque fallback','last result clears floating input','light/dark/mobile']},null,2));console.log('Conversation search browser checks passed');
}finally{await browser?.close();await vite.close();}
