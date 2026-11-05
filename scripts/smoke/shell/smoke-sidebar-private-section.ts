import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.OPENCRAFT_PRIVATE_SECTION_OUTPUT ?? '/tmp/opencraft-sidebar-private-section';
const source = `
import React,{useState} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader,AppShellNavigationControls} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import {UiPreferencesProvider,openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const preferences=await openWorkbenchUiPreferences();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_,v)=>v});
const initial=[{id:'pin',title:'共享置顶',pinned:true},{id:'recent',title:'共享最近'},
{id:'private',title:'我的私有',accessMode:'private',pinned:true,parentThreadId:'pin'},
{id:'shared-child',title:'共享派生',parentThreadId:'private'},
...Array.from({length:11},(_,i)=>({id:'mine-'+i,title:'私有历史 '+i,accessMode:'private'}))]
.map((row,i)=>({...row,project:'workspace',status:'ready',updatedAt:Date.now()/1000-i,connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
let projected=[];
const listeners=new Set();let snapshot={revision:0,mode:null,modes:[],hideRowBadge:false,notice:null};
const grouping={subscribe:l=>{listeners.add(l);return()=>listeners.delete(l)},getSnapshot:()=>snapshot,watch:()=>()=>{},
filterThreads:refs=>refs,project:refs=>{projected=refs;return [{id:'custom',label:'共享分组',collapsed:false,threads:refs}]},
toggleGroup:()=>{},setMode:()=>{}};
function Fixture(){const[open,setOpen]=useState(true),[rows,setRows]=useState(initial),[active,setActive]=useState('recent');
window.fixture={setRows,setOpen,initial,preferences,projected:()=>projected,
setPrivate:(id,mode)=>setRows(rows=>rows.map(row=>row.id===id?{...row,accessMode:mode}:row)),
custom:()=>{snapshot={...snapshot,revision:snapshot.revision+1,mode:'custom'};listeners.forEach(l=>l())}};
return <UiPreferencesProvider runtime={preferences}><AppShell navigation={{layout:'unified',settingsActive:false,onOpenSettings:()=>{},account:{snapshot:{phase:'anonymous',name:null,avatarUrl:null},onOpen:()=>{},onRefresh:async()=>{},onSignOut:async()=>{}},actions:[{id:'shell.home',title:'首页',icon:'home',onInvoke:()=>{}}]}} layoutScope='private-section' sidebarOpen={open} sidebarWidth={335} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={()=>{}} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}}
header={<AppShellHeader title={null} project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
floatingSidebarHeader={dock=><AppShellNavigationControls hostRole='transient' sidebarOpen={false} canGoBack={false} canGoForward={false} onToggleSidebar={dock} onHome={()=>{}} onBack={()=>{}} onForward={()=>{}} actions={['sidebar-toggle']}/>}
leftPanel={<Sidebar threads={rows} activeHostId='local' activeThreadId={active} sidebarLayout={layout} threadListGrouping={grouping} onSelectThread={(_,id)=>setActive(id)} onNewTask={()=>{}} onOpenSettings={()=>{}} showStart={false} showFooter={false} showNewChat/>}>
<textarea aria-label='Main draft' defaultValue='保留草稿'/></AppShell></UiPreferencesProvider>}
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<Fixture/>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', publicDir: 'apps/workbench-web/public', resolve: { dedupe: ['react','react-dom'] }, esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{name:'fixture',resolveId:id=>id==='/private-section.tsx'?id:null,load:id=>id==='/private-section.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/private-section.tsx"></script>')})}}] });
let browser: any;
const evidence: unknown[]=[];
try {
  await mkdir(output,{recursive:true}); await vite.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  for(const touch of [false,true]) {
    const page=await browser.newPage({viewport:{width:touch?390:1100,height:900},hasTouch:touch,isMobile:touch});
    const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
    await page.addInitScript(theme=>{(window as any).__name=(v:any)=>v;localStorage.setItem('opencraft.appearance-theme',theme);localStorage.setItem('opencraft.ui.touch-friendly-density','auto')},touch?'dark':'light');
    await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port);
    await page.getByLabel('Main draft').waitFor({timeout:60000});
    if(touch)await page.locator('[data-chrome-action-id="sidebar-toggle"][data-chrome-action-host-role="persistent"]').tap();
    const mine=page.getByRole('region',{name:'我的',exact:true});
    const pin=page.getByRole('region',{name:'置顶',exact:true});
    const recent=page.getByRole('region',{name:'最近',exact:true});
    await mine.waitFor();
    assert.deepEqual(await page.locator('.sidebar-thread-group-label').allTextContents(),['置顶','我的','最近']);
    assert.equal(await page.getByRole('tab').count(),0);
    assert.equal(await mine.locator('[data-thread-id="private"]').count(),1);
    assert.equal(await pin.locator('[data-thread-id="private"]').count(),0);
    assert.equal(await recent.locator('[data-thread-id="shared-child"]').count(),1);
    assert.equal(await mine.locator('.sidebar-activity-item').count(),10);
    const activate=async(button:any)=>{await button.scrollIntoViewIfNeeded();if(touch)await button.tap();else{await button.focus();await button.press('Enter');}};
    await activate(mine.getByRole('button',{name:'查看更多',exact:true}));
    assert.equal(await mine.locator('.sidebar-activity-item').count(),12);
    await activate(mine.getByRole('button',{name:'我的',exact:true}));
    assert.equal(await mine.locator('.sidebar-activity-group__items').isVisible(),false);
    assert.equal(await recent.locator('.sidebar-activity-group__items').isVisible(),true);
    await activate(mine.getByRole('button',{name:'我的',exact:true}));
    const search=page.getByRole('searchbox');await search.fill('我的私有');
    assert.equal(await mine.locator('.sidebar-activity-item').count(),1);
    await search.fill('');
    await page.evaluate(()=>{(window as any).fixture.setPrivate('recent','private')});
    await mine.locator('[data-thread-id="recent"]').waitFor();
    assert.equal(await page.locator('[data-thread-id="recent"]').count(),1);
    await page.evaluate(()=>{(window as any).fixture.setPrivate('recent','shared')});
    await recent.locator('[data-thread-id="recent"]').waitFor();
    await mine.getByRole('button',{name:'我的',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:output+'/'+(touch?'touch-dark':'desktop-light')+'.png'});
    await page.evaluate(()=>{(window as any).fixture.custom()});
    await page.getByRole('region',{name:'共享分组',exact:true}).waitFor();
    assert.equal(await mine.locator('[data-thread-id="private"]').count(),1);
    assert.ok((await page.evaluate(()=>(window as any).fixture.projected())).every((ref:any)=>!ref.threadId.startsWith('mine-')&&ref.threadId!=='private'));
    await page.evaluate(()=>{const f=(window as any).fixture;f.setRows(f.initial.filter((row:any)=>row.accessMode!=='private'))});
    await mine.getByText('还没有私有会话').waitFor();
    assert.equal(await page.getByLabel('Main draft').inputValue(),'保留草稿');
    assert.deepEqual(errors,[]);evidence.push({touch,status:'passed',errors});await page.close();
  }
  await writeFile(output+'/result.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({output,evidence}));
} finally {await browser?.close();await vite.close();}
