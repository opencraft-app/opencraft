import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
const output=await mkdtemp(join(tmpdir(),'opencraft-toolbar-ownership-'));
const source=`
import React,{useState,useSyncExternalStore} from 'react';
import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {Context} from '@deepseek-ai/cordis';
import {WorkbenchPanelService} from '@opencraft/workbench-panels';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {RightPanel} from '/apps/workbench-web/src/components/right-panel.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();const ctx=new Context();await ctx.plugin(WorkbenchPanelService);const panels=ctx.workbenchPanels;
panels.register({kind:'terminal',createTab:({id})=>({id,resource:id,kind:'terminal',region:'right',title:'Terminal '+id,icon:'terminal',closable:true,preview:false})});
for(let i=0;i<12;i++)panels.open('scope','terminal',{id:String(i)});
const subscribe=f=>panels.subscribeOwner('scope',f),get=()=>panels.getOwnerSnapshot('scope');
const navigation={layout:'unified',actions:[{id:'chat',title:'Chat',icon:'chat',onInvoke:()=>{}}],settingsActive:false,onOpenSettings:()=>{},account:{snapshot:{phase:'anonymous',name:null,avatarUrl:null},onOpen:()=>{},onRefresh:async()=>{},onSignOut:async()=>{}}};
function App(){const state=useSyncExternalStore(subscribe,get);const [sidebar,setSidebar]=useState(false);window.fixture={panels,setThemePreference};
const action={id:'terminal',region:'right',icon:'terminal',label:'New terminal',creationLabel:'Terminal',run:()=>panels.open('scope','terminal',{id:crypto.randomUUID()})};
return <AppShell layoutScope='toolbar-ownership' mainContentLayout='default' navigation={navigation} sidebarOpen={sidebar} sidebarWidth={275} onSidebarCollapse={()=>setSidebar(false)} onSidebarExpand={()=>setSidebar(true)} onSidebarResizeEnd={()=>{}} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}}
header={<AppShellHeader title='Conversation' project={null} sidebarOpen={sidebar} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onToggleSidebar={()=>setSidebar(!sidebar)} onToggleRightPanel={()=>panels.dispatch('scope',{type:'set-region-open',region:'right',open:!state.right.open})} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
floatingSidebarHeader={()=>null} leftPanel={<p>Navigation</p>}
rightPanel={<RightPanel state={state} presentationId='view' renderers={[]} toolbarActions={[action]} toolbarActionContext={{ownerId:'scope',resourceOwnerId:'scope',hostId:'fixture',cwd:null}} onAction={a=>panels.dispatch('scope',a)} onCloseTab={t=>panels.close('scope',t.region,t.id)}/>}
rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onRightPanelOpenChange={open=>panels.dispatch('scope',{type:'set-region-open',region:'right',open})}><input aria-label='Draft' defaultValue='Keep draft'/></AppShell>}
createRoot(document.getElementById('root')).render(<App/>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},cacheDir:'node_modules/.vite-toolbar-ownership',optimizeDeps:{entries:[],include:['react','react-dom/client','react-intl']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'toolbar-ownership-fixture',resolveId:id=>id==='/toolbar-fixture.tsx'?id:null,load:id=>id==='/toolbar-fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/toolbar-fixture.tsx"></script>');});}}]});
let browser:any;
try{
await vite.listen();const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1600,height:850}});await page.addInitScript('window.__name=value=>value');const errors:string[]=[];page.on('pageerror',(e:Error)=>{errors.push(e.message);console.error(e.stack)});await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port);await page.getByLabel('Draft').waitFor();await page.getByLabel('Draft').fill('Preserved');
// Pixels detect opaque chrome even when pointer-events:none makes hit tests pass.
await page.addStyleTag({content:'.right-panel-toolbar__tab-actions{background:rgb(255,0,180)!important}'});
const evidence=[];
for(const mode of ['light','dark'])for(const [width,full] of [[1600,false],[1600,true],[800,false],[390,false]] as const){
await page.evaluate(full=>{const p=(window as any).fixture.panels;if(p.getOwnerSnapshot('scope').rightPanelFullWidth!==full)p.dispatch('scope',{type:'toggle-right-full-width'})},full);await page.setViewportSize({width,height:850});await page.evaluate(mode=>(window as any).fixture.setThemePreference(mode),mode);await page.evaluate(()=>(window as any).fixture.panels.dispatch('scope',{type:'set-region-open',region:'right',open:true}));await page.waitForTimeout(650);
const controls=page.locator('.right-panel-toolbar__tab-actions');if(!(await controls.isVisible())){assert.equal(width,390,'only immersive small-screen mode hides panel');await page.locator('.app-shell-header__end-slot .app-shell-header__right-panel-toggle').click();await controls.waitFor();await page.waitForTimeout(650);}
assert.equal(await page.locator('.right-panel-toolbar__actions').getByRole('button',{name:'New terminal',exact:true}).count(),0,'creation types are offered by menus, not repeated on the bar');
const before=await controls.screenshot({animations:'disabled'});
if(width===1600&&!full){const old=await page.addStyleTag({content:'.has-unified-sidebar[data-opencraft-window-type="browser"] .app-shell-header{background:var(--color-surface)!important}'});const covered=await controls.screenshot({animations:'disabled'});await old.evaluate(e=>e.remove());assert.notDeepEqual(before,covered,'negative control reproduces original opaque-header defect');}
const transparent=await page.addStyleTag({content:'.has-unified-sidebar[data-opencraft-window-type="browser"] .app-shell-header{background:none!important}'});const uncovered=await controls.screenshot({animations:'disabled'});await transparent.evaluate(e=>e.remove());assert.deepEqual(before,uncovered,mode+'/'+width+': header must not paint over panel controls');
for(const end of [0,100000]){await page.locator('.right-panel-tab-strip').evaluate((e:HTMLElement,end:number)=>{e.scrollLeft=end},end);for(const name of ['New tab','Tabs']){const button=page.getByRole('button',{name,exact:true});const box=await button.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width+1,name+' stays in viewport');assert.equal(await button.evaluate((e:HTMLElement)=>e.closest('.right-panel-tab-strip')===null),true);}}
await page.getByRole('button',{name:'Tabs',exact:true}).click();assert.equal(await page.locator('[role^="menuitem"]').count(),13,'creation action and all twelve tabs');await page.keyboard.press('Escape');await page.screenshot({path:join(output,mode+'-'+width+'-'+full+'.png')});evidence.push({mode,width,full});}
// Check intermediate frames, including rapid reversal, not only endpoints.
for (const reducedMotion of ['no-preference', 'reduce'] as const) {
await page.emulateMedia({reducedMotion});
for (const width of [390, 1280]) {
await page.setViewportSize({width,height:850});
await page.evaluate(()=>{document.documentElement.dataset.uiDensity='touch';const p=(window as any).fixture.panels;if(p.getOwnerSnapshot('scope').rightPanelFullWidth)p.dispatch('scope',{type:'toggle-right-full-width'});p.dispatch('scope',{type:'set-region-open',region:'right',open:false});});
await page.waitForTimeout(650);
const frames=await page.locator('button.app-shell-header__right-panel-toggle').evaluate(async(button:HTMLButtonElement)=>{
const read=()=>{const b=button.getBoundingClientRect();return {x:b.x,w:b.width,connected:button.isConnected,glyphs:Array.from(button.querySelectorAll<HTMLElement>('.right-panel-toggle-icon__glyph')).map(g=>{const r=g.getBoundingClientRect();return {x:r.x-b.x,y:r.y-b.y,w:r.width,h:r.height};})};};
const frames=[read()];button.click();
for(let i=0;i<50;i++){await new Promise(requestAnimationFrame);frames.push(read());if(i===3||i===6||i===35)button.click();}
return frames;
});
for(const frame of frames){assert.equal(frame.connected,true);assert.ok(Math.abs(frame.x-frames[0].x)<0.5,`toggle moved at ${width}/${reducedMotion}: ${JSON.stringify(frame)}`);assert.ok(frame.x+frame.w<=width+0.5);assert.equal(frame.w,44);assert.deepEqual(frame.glyphs,frames[0].glyphs,'cross-fade must not translate or scale glyphs');}
}
}
await page.evaluate(()=>document.documentElement.dataset.uiDensity='compact');
await page.emulateMedia({reducedMotion:'no-preference'});
await page.setViewportSize({width:1600,height:850});
await page.evaluate(()=>(window as any).fixture.panels.dispatch('scope',{type:'set-region-open',region:'right',open:true}));await page.waitForTimeout(650);
await page.getByRole('button',{name:'New tab',exact:true}).click();await page.getByRole('menuitem',{name:'Terminal',exact:true}).click();
await page.waitForFunction(()=>(window as any).fixture.panels.getOwnerSnapshot('scope').right.tabs.length===13);
await page.getByRole('button',{name:'Tabs',exact:true}).click();await page.getByRole('menuitemradio',{name:'Terminal 0',exact:true}).click();
await page.waitForFunction(()=>(window as any).fixture.panels.getOwnerSnapshot('scope').right.activeTabId==='0');
assert.equal(await page.getByLabel('Draft').inputValue(),'Preserved');assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,evidence,output}));
}finally{await browser?.close();await vite.close();}
