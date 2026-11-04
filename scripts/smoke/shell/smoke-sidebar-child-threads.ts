import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.OPENCRAFT_CHILD_THREADS_OUTPUT ?? '/tmp/opencraft-sidebar-child-threads';
const source = `
import React,{useState} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader,AppShellNavigationControls} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost,projectAppServerThread} from '@opencraft/workbench-runtime';
import {UiPreferencesProvider,openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const preferences=await openWorkbenchUiPreferences();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_,v)=>v});
const initial=[
{id:'parent',name:'项目改动讨论',pinned:true},
{id:'child-review-00000001',parentThreadId:'parent',agentNickname:'Atlas'},
{id:'child-design-00000002',parentThreadId:'parent',preview:'检查子会话标题与侧栏层级'},
{id:'child-empty-00000003',parentThreadId:'parent',agentRole:'reviewer'},
{id:'grandchild-00000004',parentThreadId:'child-design-00000002',name:'超长子任务标题：检查触控窄侧栏下标题截断与操作按钮是否完整可达'},
{id:'hidden',parentThreadId:'parent',visibility:'hidden',name:'隐藏子会话'}]
.map((row,i)=>({...projectAppServerThread({name:null,preview:'',cwd:'/workspace',status:{type:'idle'},updatedAt:100-i,createdAt:90,parentThreadId:null,...row}),visibility:row.visibility,connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
function Fixture(){const[open,setOpen]=useState(true),[active,setActive]=useState('parent');
return <UiPreferencesProvider runtime={preferences}><AppShell navigation={{layout:'unified',settingsActive:false,onOpenSettings:()=>{},account:{snapshot:{phase:'anonymous',name:null,avatarUrl:null},onOpen:()=>{},onRefresh:async()=>{},onSignOut:async()=>{}},actions:[{id:'shell.home',title:'首页',icon:'home',onInvoke:()=>{}}]}} layoutScope='child-threads' sidebarOpen={open} sidebarWidth={335} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={()=>{}} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}}
header={<AppShellHeader title={null} project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
floatingSidebarHeader={dock=><AppShellNavigationControls hostRole='transient' sidebarOpen={false} canGoBack={false} canGoForward={false} onToggleSidebar={dock} onHome={()=>{}} onBack={()=>{}} onForward={()=>{}} actions={['sidebar-toggle']}/>}
leftPanel={<Sidebar threads={initial} activeHostId='local' activeThreadId={active} sidebarLayout={layout} onSelectThread={(_,id)=>setActive(id)} onNewTask={()=>{}} onOpenSettings={()=>{}} showStart={false} showFooter={false} showNewChat/>}>
<textarea aria-label='Main draft' defaultValue='保留草稿'/></AppShell></UiPreferencesProvider>}
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<Fixture/>);`;
const vite = await createServer({ configFile:false,root:process.cwd(),logLevel:'error',publicDir:'apps/workbench-web/public',resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'fixture',resolveId:id=>id==='/child-threads.tsx'?id:null,load:id=>id==='/child-threads.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/child-threads.tsx"></script>')})}}] });
let browser:any;
const evidence:unknown[]=[];
try {
  await mkdir(output,{recursive:true});await vite.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  for(const touch of [false,true])for(const theme of ['light','dark']){
    const page=await browser.newPage({viewport:{width:touch?390:1100,height:900},hasTouch:touch,isMobile:touch});
    const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
    await page.addInitScript(theme=>{(window as any).__name=(v:any)=>v;localStorage.setItem('opencraft.appearance-theme',theme);localStorage.setItem('opencraft.ui.touch-friendly-density','auto')},theme);
    await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port);
    await page.getByLabel('Main draft').waitFor({timeout:60000});
    if(touch)await page.locator('[data-chrome-action-id="sidebar-toggle"][data-chrome-action-host-role="persistent"]').tap();
    const settledSidebar=()=>page.waitForFunction(()=>{const panel=document.querySelector('.app-shell-floating-left-panel');const row=document.querySelector('.app-shell-row');return !!panel&&!!row&&Math.abs(row.getBoundingClientRect().x-panel.getBoundingClientRect().width)<1});
    if(touch)await settledSidebar();
    const row=(id:string)=>page.locator('[data-thread-id="'+id+'"] > .sidebar-activity-row .sidebar-activity-item');
    await row('child-review-00000001').waitFor();
    assert.match(await row('child-review-00000001').innerText(),/Atlas/);
    assert.match(await row('child-empty-00000003').innerText(),/reviewer · 00000003/);
    assert.equal(await page.locator('[data-thread-id="hidden"]').count(),0);
    assert.equal(await page.locator('.sidebar-thread-tree__children').count(),2);
    const groups=await page.locator('.sidebar-thread-tree__children').evaluateAll(elements=>elements.map(element=>{
      const css=getComputedStyle(element),rect=element.getBoundingClientRect();
      const parent=element.parentElement!.querySelector('.sidebar-activity-row')!.getBoundingClientRect();
      return {border:css.borderInlineStartWidth,style:css.borderInlineStartStyle,color:css.borderInlineStartColor,inset:rect.x-parent.x,width:rect.width,height:rect.height};
    }));
    for(const group of groups){assert.equal(group.border,'1px');assert.equal(group.style,'solid');assert.ok(group.inset>0&&group.width>0&&group.height>0);assert.notEqual(group.color,'rgba(0, 0, 0, 0)')}
    const titleBox=await row('grandchild-00000004').boundingBox();
    const parentBox=await row('child-design-00000002').boundingBox();assert.ok(titleBox!.x>parentBox!.x);
    if(touch)await row('child-review-00000001').tap();else{await row('child-review-00000001').focus();await row('child-review-00000001').press('Enter')}
    if(touch)await page.locator('[data-chrome-action-id="sidebar-toggle"][data-chrome-action-host-role="persistent"]').tap();
    await page.waitForFunction(()=>document.querySelector('[data-thread-id="child-review-00000001"] > .sidebar-activity-row .sidebar-activity-item')?.classList.contains('is-selected'));
    if(touch)await settledSidebar();
    await page.screenshot({path:output+'/'+(touch?'touch':'desktop')+'-'+theme+'.png'});
    const search=page.getByRole('searchbox');await search.fill('Atlas');
    assert.equal(await page.locator('.sidebar-activity-item').count(),1);
    assert.equal(await page.locator('.sidebar-thread-tree__children').count(),0);
    await search.fill('');
    assert.equal(await page.locator('.sidebar-thread-tree__children').count(),2);
    assert.equal(await page.getByLabel('Main draft').inputValue(),'保留草稿');
    assert.deepEqual(errors,[]);evidence.push({touch,theme,groups,status:'passed'});await page.close();
  }
  await writeFile(output+'/result.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({output,evidence}));
}finally{await browser?.close();await vite.close()}
