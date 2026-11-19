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
const dates=location.search.includes('dates');
const dateRows=[
{id:'daily-parent',name:'每日处理',pinned:true},
{id:'date-11',name:'2026-11-11',parentThreadId:'daily-parent'},
{id:'date-10',name:'旧的非日期子任务',parentThreadId:'daily-parent'},
{id:'date-09',name:'2026-11-09',parentThreadId:'daily-parent'},
{id:'ordinary',name:'单独核查',parentThreadId:'daily-parent'},
{id:'date-08',name:'2026-11-08',parentThreadId:'daily-parent'},
{id:'date-07',name:'2026-11-07',parentThreadId:'daily-parent'},
{id:'older-detail',name:'历史核查记录',parentThreadId:'date-11'}]
.map((row,i)=>({...projectAppServerThread({preview:'',cwd:'/workspace',status:{type:'idle'},updatedAt:100+i,createdAt:90,parentThreadId:null,...row}),connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
function Fixture(){const[open,setOpen]=useState(true),[active,setActive]=useState('parent');
Object.assign(window,{selectChild:(id)=>setActive(id)});
return <UiPreferencesProvider runtime={preferences}><AppShell navigation={{layout:'unified',settingsActive:false,onOpenSettings:()=>{},account:{snapshot:{phase:'anonymous',name:null,avatarUrl:null},onOpen:()=>{},onRefresh:async()=>{},onSignOut:async()=>{}},actions:[{id:'shell.home',title:'首页',icon:'home',onInvoke:()=>{}}]}} layoutScope='child-threads' sidebarOpen={open} sidebarWidth={335} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={()=>{}} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}}
header={<AppShellHeader title={null} project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
floatingSidebarHeader={dock=><AppShellNavigationControls hostRole='transient' sidebarOpen={false} canGoBack={false} canGoForward={false} onToggleSidebar={dock} onHome={()=>{}} onBack={()=>{}} onForward={()=>{}} actions={['sidebar-toggle']}/>}
leftPanel={<Sidebar threads={dates?dateRows:initial} activeHostId='local' activeThreadId={active} sidebarLayout={layout} onSelectThread={(_,id)=>setActive(id)} onNewTask={()=>{}} onOpenSettings={()=>{}} showStart={false} showFooter={false} showNewChat/>}>
<textarea aria-label='Main draft' defaultValue='保留草稿'/></AppShell></UiPreferencesProvider>}
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<Fixture/>);`;
const vite = await createServer({ configFile:false,root:process.cwd(),logLevel:'error',publicDir:'apps/workbench-web/public',resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'fixture',resolveId:id=>id==='/child-threads.tsx'?id:null,load:id=>id==='/child-threads.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/child-threads.tsx"></script>')})}}] });
let browser:any;
const evidence:unknown[]=[];
try {
  await mkdir(output,{recursive:true});await vite.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  for(const touch of [false,true])for(const theme of ['light','dark']){
    const page=await browser.newPage({viewport:{width:touch?390:1100,height:900},hasTouch:touch,isMobile:touch});
    const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
    await page.addInitScript(theme=>{(window as any).__name=(v:any)=>v;localStorage.setItem('opencraft.appearance-theme',theme);localStorage.setItem('opencraft.ui.touch-friendly-density','auto')},theme);
    const settledSidebar=()=>page.waitForFunction(()=>{const panel=document.querySelector('.app-shell-floating-left-panel');const row=document.querySelector('.app-shell-row');return !!panel&&!!row&&Math.abs(row.getBoundingClientRect().x-panel.getBoundingClientRect().width)<1});
    const row=(id:string)=>page.locator('[data-thread-id="'+id+'"] > .sidebar-activity-row .sidebar-activity-item');
    // Exercise the same real Sidebar with mixed child titles; no native routing or customer data.
    await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port+'/?dates');
    const draft=page.getByLabel('Main draft');await draft.waitFor();await draft.fill('保留未发送的日期核查草稿');
    if(touch){await page.locator('[data-chrome-action-id="sidebar-toggle"][data-chrome-action-host-role="persistent"]').tap();await settledSidebar()}
    await row('date-07').waitFor();
    const dateParent=page.locator('[data-thread-id="daily-parent"]');
    assert.deepEqual(await dateParent.locator(':scope > .sidebar-thread-tree__children > [data-thread-id]').evaluateAll(els=>els.map(el=>el.getAttribute('data-thread-id'))),['date-07','date-08','ordinary']);
    const toggle=page.getByRole('button',{name:'更多子 Agent（3）',exact:true});
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    assert.equal(await row('date-11').count(),0);assert.equal(await row('ordinary').count(),1);
    const draftHandle=await draft.elementHandle();
    if(touch)await toggle.tap();else{await toggle.focus();await toggle.press('Enter')}
    await row('date-11').waitFor();
    if(touch)await toggle.tap();else await toggle.press('Space');
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    assert.equal(await row('date-11').count(),0);
    // Selecting a deep historical child reveals its folded child ancestor automatically.
    await page.evaluate(()=>(window as any).selectChild('older-detail'));
    await row('older-detail').waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');
    assert.equal(await row('older-detail').evaluate(el=>el.classList.contains('is-selected')),true);
    assert.equal(await draftHandle!.evaluate(el=>el===document.querySelector('textarea')),true);
    assert.equal(await draft.inputValue(),'保留未发送的日期核查草稿');
    await page.screenshot({path:output+'/'+(touch?'touch':'desktop')+'-'+theme+'-dates-expanded.png'});
    // Search must find an older non-date child without first opening the disclosure.
    await page.getByRole('searchbox').fill('旧的非日期子任务');
    await row('date-10').waitFor();assert.equal(await page.locator('.sidebar-activity-item').count(),1);
    await page.getByRole('searchbox').fill('');await row('older-detail').waitFor();
    if(touch)await toggle.tap();else await toggle.click();
    await page.screenshot({path:output+'/'+(touch?'touch':'desktop')+'-'+theme+'-dates-folded.png'});
    assert.deepEqual(errors,[]);evidence.push({touch,theme,dateChildren:'passed',status:'passed'});await page.close();
  }
  await writeFile(output+'/result.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({output,evidence}));
}finally{await browser?.close();await vite.close()}
