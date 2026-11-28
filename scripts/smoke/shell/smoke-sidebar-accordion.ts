import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
const source = `
import React,{useState}from'react';
import{createClientRuntime}from'/apps/workbench-web/src/runtime/client-runtime';
import{bindInteractionDensity}from'/apps/workbench-web/src/runtime/interaction-density';
const inputRuntime=createClientRuntime(document);inputRuntime.start();
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{AppShellHeader,AppShellNavigationControls}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{Sidebar}from'/apps/workbench-web/src/components/sidebar.tsx';
import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import{legacyDirectServerProjectionFromHost}from'@opencraft/workbench-runtime';
import{UiPreferencesProvider,openWorkbenchUiPreferences}from'/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import{initializeAppearanceTheme}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';initializeAppearanceTheme();
const preferences=await openWorkbenchUiPreferences(),layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_,v)=>v});
bindInteractionDensity(document,preferences);
const rows=[...Array.from({length:32},(_,i)=>({id:'pin'+i,title:'置顶会话 '+i,pinned:true})),...Array.from({length:64},(_,i)=>({id:'recent'+i,title:'最近会话 '+i})),...Array.from({length:18},(_,i)=>({id:'mine'+i,title:'私有会话 '+i,accessMode:'private'})),...Array.from({length:14},(_,i)=>({id:'attention'+i,title:'待处理会话 '+i,status:'review'})),{id:'schedule',title:'计划会话',schedule:{status:'active'}}].map((row,i)=>({project:'workspace',status:'ready',updatedAt:Date.now()/1000-i,connectionHostId:'local',connectionHostLabel:'Local',...row,...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
const listeners=new Set(),folded=new Set();let snapshot={revision:0,mode:null,modes:[],hideRowBadge:false,notice:null};
const contribution={id:'accordion-fixture',getSnapshot:()=>snapshot,subscribe:l=>{listeners.add(l);return()=>listeners.delete(l)},watch:()=>()=>{},project:refs=>[{id:'mine',label:'创建者甲',avatarUrl:null,collapsed:folded.has('mine'),threads:refs.filter(r=>r.threadId.startsWith('pin'))},{id:'recent',label:'创建者乙',avatarUrl:null,collapsed:folded.has('recent'),threads:refs.filter(r=>!r.threadId.startsWith('pin'))},...Array.from({length:24},(_,i)=>({id:'extra'+i,label:'其他分组 '+i,avatarUrl:null,collapsed:false,threads:[]}))],toggleGroup:id=>{folded.has(id)?folded.delete(id):folded.add(id);snapshot={...snapshot,revision:snapshot.revision+1};listeners.forEach(l=>l())},setMode:mode=>{snapshot={...snapshot,mode,revision:snapshot.revision+1};listeners.forEach(l=>l())}};
function Fixture(){const[open,setOpen]=useState(true),[threads,setThreads]=useState(rows),[active,setActive]=useState('recent0');window.fixture={preferences,setOpen,setActive,group:()=>contribution.setMode('creator'),ungroup:()=>contribution.setMode(null),refresh:()=>setThreads(v=>v.map(r=>({...r,updatedAt:r.updatedAt+1}))) };
return <UiPreferencesProvider runtime={preferences}><AppShell navigation={{settingsActive:false,onOpenSettings:()=>{},account:{snapshot:{phase:'anonymous',name:null,avatarUrl:null},onOpen:()=>{},onRefresh:async()=>{},onSignOut:async()=>{}},actions:[{id:'shell.home',title:'首页',icon:'home',onInvoke:()=>{}}]}} layoutScope='accordion' sidebarOpen={open} sidebarWidth={335} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={()=>{}} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}}
header={<AppShellHeader title={null} project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
floatingSidebarHeader={dock=><AppShellNavigationControls hostRole='transient' sidebarOpen={false} canGoBack={false} canGoForward={false} onToggleSidebar={dock} onHome={()=>{}} onBack={()=>{}} onForward={()=>{}} actions={['sidebar-toggle']}/>}
leftPanel={<Sidebar threads={threads} activeHostId='local' activeThreadId={active} sidebarLayout={layout} threadListGrouping={contribution} onSelectThread={(_,id)=>setActive(id)} onNewTask={()=>{}} onOpenSettings={()=>{}} showStart={false} showFooter={false} showNewChat/>}>
<textarea aria-label='Main draft' defaultValue='保留草稿'/></AppShell></UiPreferencesProvider>}
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<Fixture/>);`;
const output=process.env.OPENCRAFT_ACCORDION_OUTPUT??'/tmp/opencraft-sidebar-accordion';
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',publicDir:'apps/workbench-web/public',resolve:{dedupe:['react','react-dom','react-intl']},cacheDir:'node_modules/.vite-sidebar-accordion',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'fixture',resolveId:id=>id==='/accordion.tsx'?id:null,load:id=>id==='/accordion.tsx'?source:null,configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/accordion.tsx"></script>')})}}]});
let browser:any;const evidence:any[]=[];
try{
 await mkdir(output,{recursive:true});await vite.listen();const{chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 for(const mode of (process.env.OPENCRAFT_ACCORDION_ONE?[{touch:false,width:1200,mobile:false}]:[{touch:false,width:1200,mobile:false},{touch:true,width:390,mobile:true},{touch:false,width:600,mobile:false},{touch:true,width:1200,mobile:false}]))for(const theme of (process.env.OPENCRAFT_ACCORDION_ONE?['light']:['light','dark'])){
 const context=await browser.newContext({viewport:{width:mode.width,height:800},hasTouch:mode.touch,isMobile:mode.touch,reducedMotion:theme==='dark'?'reduce':'no-preference'});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
 await page.addInitScript(theme=>{(window as any).__name=(x:any)=>x;localStorage.setItem('opencraft.appearance-theme',theme);localStorage.setItem('opencraft.ui.touch-friendly-density','auto')},theme);
 await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port,{waitUntil:'commit'});await page.getByLabel('Main draft').waitFor({timeout:120000});
 const collapsed=page.locator('[data-chrome-action-id="sidebar-toggle"][data-chrome-action-host-role="persistent"]');if(!await page.locator('.sidebar-panel').isVisible()){if(mode.touch)await collapsed.tap();else await collapsed.click();}await page.locator('.sidebar-panel').waitFor();await page.waitForTimeout(250);
 const section=(name:string)=>page.getByRole('region',{name,exact:true});const button=(name:string)=>section(name).locator('.sidebar-thread-group-toggle');
 const expanded=()=>page.locator('.sidebar-thread-group-toggle[aria-expanded="true"]').count();
 const activate=async(name:string)=>{const b=button(name);await b.scrollIntoViewIfNeeded();if(mode.touch)await b.tap();else await b.click();await page.waitForTimeout(220);assert.ok(await expanded()<=1);};
 const switcher=page.getByRole('radiogroup',{name:'对话',exact:true});const recentOption=switcher.getByRole('radio',{name:/最近/});const privateOption=switcher.getByRole('radio',{name:/私密/});
 assert.equal(await expanded(),1);assert.equal(await button('最近').getAttribute('aria-expanded'),'true');
 const editor=await page.getByLabel('Main draft').elementHandle();
 if(mode.touch)await privateOption.tap();else await privateOption.click();await section('私密').waitFor();
 if(mode.touch)await recentOption.tap();else await recentOption.click();await section('最近').waitFor();
 await activate('置顶');assert.equal(await button('最近').getAttribute('aria-expanded'),'false');await activate('置顶');assert.equal(await expanded(),0);
 await page.evaluate(()=>(window as any).fixture.refresh());assert.equal(await expanded(),0,'catalog updates must not reopen collapsed sections');
 await activate('定时任务');assert.equal(await button('定时任务').getAttribute('aria-expanded'),'true');await activate('等你处理');assert.equal(await button('定时任务').getAttribute('aria-expanded'),'false');
 // Collapse a long group from its sticky heading and retain a visible title at the boundary.
 const mobile = await page.locator('.sidebar-panel').evaluate(el => el.closest('.shell-sidebar__column')?.getAttribute('data-navigation-layout') === 'mobile');
 assert.equal(mobile, mode.mobile, 'fixture input adapter reaches the intended drawer/dock presentation');
 const viewport=page.locator(mobile?'.shell-sidebar__column[data-navigation-layout="mobile"] .shell-sidebar__scroll':'.sidebar-activity-list');
 await viewport.evaluate(el=>el.scrollTop+=250);await page.waitForTimeout(100);const header=button('等你处理');const before=await header.boundingBox();if(mode.touch)await header.tap();else await header.click();await page.waitForTimeout(250);assert.equal(await expanded(),0);const after=await header.boundingBox(),bounds=await viewport.boundingBox();assert.ok(after&&bounds&&after.y>=bounds.y-1&&after.y+after.height<=bounds.y+bounds.height+1,'collapsed heading stays visible');
 // An upper disclosure can stay in place exactly; selection auto-reveal must not fight it.
 const anchor=button('置顶');const y=(await anchor.boundingBox())!.y;if(mode.touch)await anchor.tap();else await anchor.click();await page.waitForTimeout(220);const anchorDelta=(await anchor.boundingBox())!.y-y;assert.ok(Math.abs(anchorDelta)<2,'available heading anchor is preserved');
 await page.screenshot({path:output+'/'+mode.width+'-'+mode.touch+'-'+theme+'-anchored.png'});await activate('置顶');assert.equal(await expanded(),0);await button('最近').focus();await page.keyboard.press('Enter');assert.equal(await expanded(),1);await page.keyboard.press('Space');assert.equal(await expanded(),0);
 // Rapid native activations before one React commit preserve toggle parity.
 await button('置顶').evaluate(el=>{(el as HTMLButtonElement).click();(el as HTMLButtonElement).click()});assert.equal(await expanded(),0);
 await page.evaluate(()=>(window as any).fixture.group());await section('创建者甲').waitFor();assert.ok(await expanded()<=1);
 await activate('创建者甲');if(await button('创建者甲').getAttribute('aria-expanded')==='false')await activate('创建者甲');await activate('定时任务');assert.equal(await button('创建者甲').getAttribute('aria-expanded'),'false','fixed and contribution IDs do not collide');await activate('创建者乙');assert.equal(await button('定时任务').getAttribute('aria-expanded'),'false');await activate('创建者乙');assert.equal(await expanded(),0);await page.evaluate(()=>(window as any).fixture.refresh());assert.equal(await expanded(),0);
 await activate('创建者甲');await viewport.evaluate(el=>{const h=el.querySelector<HTMLElement>('[aria-label="创建者乙"] .sidebar-thread-group-heading')!;el.scrollTop+=h.getBoundingClientRect().top-el.getBoundingClientRect().top-60});await page.waitForTimeout(150);
 const lowerBefore=(await button('创建者乙').boundingBox())!.y;if(mode.touch)await button('创建者乙').tap();else await button('创建者乙').click();await page.waitForTimeout(220);const lowerDelta=(await button('创建者乙').boundingBox())!.y-lowerBefore;if(Math.abs(lowerDelta)>=2){console.log(JSON.stringify({mode,theme,lowerBefore,lowerDelta,geometry:await viewport.evaluate(el=>({scrollTop:el.scrollTop,height:el.clientHeight,total:el.scrollHeight,headers:[...el.querySelectorAll('.sidebar-thread-group-heading')].slice(0,4).map(h=>({label:h.textContent,y:h.getBoundingClientRect().top}))}))}));await page.screenshot({path:output+'/anchor-failure.png'})};const anchorLimits=await viewport.evaluate(el=>{const section=el.querySelector<HTMLElement>('[aria-label="创建者乙"]')!;return {natural:section.getBoundingClientRect().top+el.scrollTop,max:Math.max(0,el.scrollHeight-el.clientHeight)}});
 const expectedAfter=anchorLimits.natural-Math.max(0,Math.min(anchorLimits.max,anchorLimits.natural-lowerBefore));
 assert.ok(Math.abs((await button('创建者乙').boundingBox())!.y-expectedAfter)<2,'heading anchor respects actual native scroll limits, without adding blank spacers');assert.equal(await expanded(),1);await page.screenshot({path:output+'/'+mode.width+'-'+mode.touch+'-'+theme+'-contribution.png'});
 assert.equal(await page.getByLabel('Main draft').evaluate((el,old)=>el===old,editor),true);assert.equal(await page.getByLabel('Main draft').inputValue(),'保留草稿');assert.equal(await page.getByText('定位分组',{exact:true}).count(),0);assert.deepEqual(errors,[]);
 await page.screenshot({path:output+'/'+mode.width+'-'+mode.touch+'-'+theme+'.png'});evidence.push({...mode,theme,anchorDelta,lowerDelta,boundaryMoved:after!.y-before!.y,exclusive:true,allCollapsed:true,contributed:true,keyboard:true,rapid:true,draft:true});await context.close();
 }
 await writeFile(output+'/report.json',JSON.stringify({passed:true,evidence},null,2));console.log(JSON.stringify({output,evidence}));
}finally{await browser?.close();await vite.close();}
