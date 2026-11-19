import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');
const output=process.env.OPENCRAFT_SIDEBAR_CREATION_OUTPUT??'/tmp/opencraft-sidebar-creation';
const source=`
import React,{useState,useSyncExternalStore} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader,AppShellNavigationControls} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost,projectAppServerThread} from '@opencraft/workbench-runtime';
import {UiPreferencesProvider,openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import {ThreadCatalogUpdates} from '/apps/workbench-web/src/runtime/thread-catalog-updates.ts';
import {parseThreadCatalogChange} from '@opencraft/appserver-protocol';
import {TencentOaController} from '/products/join/plugins/tencentoa/src/controller.ts';
import {TencentOaParticipantsController} from '/products/join/plugins/tencentoa/src/participants-controller.ts';
import {TencentOaCreatorGrouping} from '/products/join/plugins/tencentoa/src/creator-grouping.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const preferences=await openWorkbenchUiPreferences();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_,v)=>v});
const identity=new TencentOaController(async()=>new Response(JSON.stringify({available:true,identity:{loginName:'alice',staffId:'11',expiresAt:new Date(Date.now()+60000).toISOString()}})));
await identity.refresh();
let calls=0,release;
const client={connectionGeneration:1,initializeResult:{capabilities:{extensions:{'opencraft/ioa/thread-participants/list':{version:1}}}},
 requestRaw:async(method,{threadIds})=>{calls++;if(calls===1)await new Promise(resolve=>release=resolve);return {data:threadIds.map(threadId=>({threadId,revision:1,creator:'other',participants:['other']}))}},
 subscribeNotification:()=>()=>{},subscribeStatus:()=>()=>{},subscribeRequestLifecycle:()=>()=>{}};
const participants=new TencentOaParticipantsController(()=>client);
const grouping=new TencentOaCreatorGrouping(identity,participants,null);grouping.setFilterEnabled(true);
const updates=new ThreadCatalogUpdates('local');updates.enabled=true;
const row=(id,createdByViewer)=>({id,cwd:'/synthetic',name:null,preview:'',updatedAt:2,createdAt:1,status:{type:'active',activeFlags:[]},ephemeral:false,turns:[],createdByViewer});
const base={data:Array.from({length:100},(_,i)=>row('old-'+i,undefined)),nextCursor:null};
let revision=0;
window.fixture={calls:()=>calls,release:()=>release(),
 add:(id,createdByViewer)=>updates.receive(parseThreadCatalogChange({version:1,source:'synthetic',revision:++revision,change:{type:'upsert',thread:row(id,createdByViewer)}})),
 remove:id=>updates.receive({version:1,source:'synthetic',revision:++revision,change:{type:'remove',threadId:id}}),
 stale:()=>updates.acknowledge(updates.markRead(base,updates.getSnapshot()))};
function Fixture(){const[open,setOpen]=useState(true);useSyncExternalStore(updates.subscribe,updates.getSnapshot,updates.getSnapshot);
const rows=updates.project(base).data.map(thread=>({...projectAppServerThread(thread),connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
return <UiPreferencesProvider runtime={preferences}><AppShell navigation={{layout:'unified',settingsActive:false,onOpenSettings:()=>{},account:{snapshot:{phase:'anonymous',name:null,avatarUrl:null},onOpen:()=>{},onRefresh:async()=>{},onSignOut:async()=>{}},actions:[{id:'shell.home',title:'Home',icon:'home',onInvoke:()=>{}}]}} layoutScope='creation-facts' sidebarOpen={open} sidebarWidth={335} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)}
 onSidebarResizeEnd={()=>{}} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}}
 header={<AppShellHeader title={null} project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
 floatingSidebarHeader={dock=><AppShellNavigationControls hostRole='transient' sidebarOpen={false} canGoBack={false} canGoForward={false} onToggleSidebar={dock} onHome={()=>{}} onBack={()=>{}} onForward={()=>{}} actions={['sidebar-toggle']}/>}
 leftPanel={<Sidebar threads={rows} activeHostId='local' activeThreadId='new' sidebarLayout={layout} threadListGrouping={grouping} onSelectThread={()=>{}} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/>}
><button onClick={()=>setOpen(true)}>Open sidebar</button><textarea aria-label='Main draft' defaultValue='keep draft'/></AppShell></UiPreferencesProvider>}
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<Fixture/>);
`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',publicDir:'apps/workbench-web/public',resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'fixture',resolveId:id=>id==='/creation.tsx'?id:null,load:id=>id==='/creation.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/creation.tsx"></script>')})}}]});
let browser:any;const evidence:any[]=[];
try{
 await mkdir(output,{recursive:true});await vite.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 for(const touch of [false,true]){
  const page=await browser.newPage({viewport:{width:touch?390:1100,height:900},hasTouch:touch,isMobile:touch});const errors:string[]=[];
  page.on('pageerror',(e:Error)=>errors.push(e.message));await page.addInitScript(()=>{(window as any).__name=(v:any)=>v});
  await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port);await page.getByLabel('Main draft').waitFor({timeout:60000});
  if(touch)await page.locator('[data-chrome-action-id="sidebar-toggle"][data-chrome-action-host-role="persistent"]').tap();
  await page.waitForFunction(()=>(window as any).fixture.calls()===1);
  await page.evaluate(()=>{const f=(window as any).fixture;f.add('new',true);f.add('unknown',undefined);f.add('other',false)});
  const fresh=page.locator('[data-thread-id="new"]');await fresh.waitFor({state:'visible'});
  assert.equal(await fresh.count(),1);assert.equal(await page.locator('[data-thread-id="unknown"]').count(),0);assert.equal(await page.locator('[data-thread-id="other"]').count(),0);
  assert.equal(await page.evaluate(()=>(window as any).fixture.calls()),1,'row appeared while old metadata batch is still blocked');
  await page.evaluate(()=>{const f=(window as any).fixture;f.add('new',true);f.stale()});assert.equal(await fresh.count(),1);
  await page.screenshot({animations:'disabled',path:output+'/'+(touch?'touch':'desktop')+'.png'});
  await page.evaluate(()=>(window as any).fixture.remove('new'));await fresh.waitFor({state:'detached'});
  assert.equal(await page.getByLabel('Main draft').inputValue(),'keep draft');assert.deepEqual(errors,[]);
  evidence.push({touch,passed:true,metadataBatchStillBlocked:true});await page.close();
 }
 await writeFile(output+'/result.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({output,evidence}));
}finally{await browser?.close();await vite.close()}
