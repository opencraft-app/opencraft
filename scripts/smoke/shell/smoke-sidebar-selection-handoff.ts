import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/sidebar-selection-handoff');
const returnProbe = process.env.OPENCRAFT_SIDEBAR_RETURN_ONLY === '1';
const source = `
import React,{useState,useSyncExternalStore,useLayoutEffect,useEffect} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {SidebarToggleButton} from '/apps/workbench-web/src/chrome-actions/sidebar-toggle-button.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {SettingsNavigation} from '/apps/workbench-web/src/components/settings-page.tsx';
import {ApplicationsSidebarFrame} from '/apps/workbench-web/src/components/applications-sidebar.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {useShellPresentation} from '/apps/workbench-web/src/components/shell-presentation.ts';
import {createWorkbenchNavigationTransaction} from '/apps/workbench-web/src/runtime/workbench-navigation-transaction.ts';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {createWorkbenchThreadLocation,legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();window.setTheme=setThemePreference;
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async()=>{}});
const rows=['a','b','c'].map(id=>({id,title:'Conversation '+id,project:'workspace',status:'ready',updatedAt:Date.now()/1000,connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
const deferred=new Map();
const nav=createWorkbenchNavigationTransaction(createWorkbenchThreadLocation('local','a'),{
 setViewId(){},cancelPending(){},mountRestored(){},prepare:()=>new Promise(()=>{}),
},{getActiveDraft:()=>null},{mode:'memory',isRetainedView:()=>true,restoreViewId:location=>new Promise((resolve,reject)=>deferred.set(location.key.threadId,{resolve,reject}))});
window.nav=nav;window.release=id=>deferred.get(id).resolve('view-'+id);window.reject=id=>deferred.get(id).reject(Error('fixture failure'));
window.samples=[];
window.materialSamples=[];window.fadeFrames=[];
function sampleMaterials(){
 const body=document.querySelector('.main-content-body');
 if(body&&window.fadeFrames.length<600)window.fadeFrames.push({alpha:Number(getComputedStyle(body).opacity),phase:nav.getTransition()?.phase,body:document.querySelector('[data-body]')?.getAttribute('data-body')});
 const frames=[...document.querySelectorAll('.shell-sidebar-primary-action > .ui-liquid-glass,.shell-navigation__entrance[data-surface="settings"] > .ui-liquid-glass')].filter(e=>e.getBoundingClientRect().width>0&&getComputedStyle(e).display!=='none').map(e=>({background:getComputedStyle(e).backgroundColor,filter:getComputedStyle(e,'::before').backdropFilter,lenses:e.querySelectorAll('filter').length}));
 if(frames.length&&window.materialSamples.length<120)window.materialSamples.push(frames);
 requestAnimationFrame(sampleMaterials);
}requestAnimationFrame(sampleMaterials);
function Header(){const shell=useShellPresentation();return <SidebarToggleButton open={shell.sidebarOpen} onToggle={shell.toggleSidebar} hostRole='persistent'/>}
function Body({id}){const shell=useShellPresentation();useLayoutEffect(()=>{window.shell=shell;window.samples.push({id,open:shell.sidebarOpen,opacity:Number(getComputedStyle(document.querySelector('.main-content-body')).opacity)});});return <div data-body={id}><h1>Conversation {id}</h1><input aria-label='Draft' defaultValue='Preserved'/></div>}
const returnProbe=${returnProbe};
const contributions={subscribe:()=>()=>{},getSnapshot:()=>emptyContributions},emptyContributions={settingsPages:[],views:[],navigation:[]};
const renderers={subscribe:()=>()=>{},getSnapshot:()=>emptyContributions,resolve:()=>null};
const navigationPresentation=returnProbe?{...nav,attachDeparture(driver){return nav.attachDeparture((id,prepared)=>{const result=driver(id,prepared);if(!window.holdReturn)return result;return new Promise(resolve=>{window.releaseReturn=()=>result.then(resolve);});});}}:nav;
const navigation={layout:'unified',actions:[{id:'chat',title:'Chat',icon:'chat',onInvoke:()=>{}}],settingsActive:false,onOpenSettings:()=>nav.openSettings(),account:{snapshot:{phase:'anonymous',name:null,avatarUrl:null},onOpen:()=>{},onRefresh:async()=>{},onSignOut:async()=>{}}};
function App(){
 const route=useSyncExternalStore(nav.subscribe,nav.getSnapshot);
 const pending=useSyncExternalStore(nav.subscribePendingLocation,nav.getPendingLocation);
 const transition=useSyncExternalStore(nav.subscribeTransition,nav.getTransition);
 useLayoutEffect(()=>{
   if(transition?.phase!=='committed')return;
   window.present=()=>nav.acknowledgePresented(transition.id,route.routeScopeId);
   if(!window.holdPaint)window.present();
 },[transition,route.routeScopeId]);
 const [sidebar,setSidebar]=useState(false),[destination,setDestination]=useState('context');
 const returnToChat=()=>{setDestination('context');void nav.openChat({sidebar:'preserve'});};
 useEffect(()=>{if(route.applicationRoute.kind==='settings')setDestination('context');},[route.applicationRoute.kind]);
 window.returnFixture={destination,openApplications:()=>setDestination('applications'),openSettings:()=>setDestination('settings')};
 const settings=(<SettingsNavigation section={destination==='settings'?'':route.applicationRoute.slug??'appearance'} presentation='sidebar' extensionContributions={contributions} profiles={[]} machines={[]} activeHostId='local' onBack={returnToChat} onSectionChange={section=>nav.openSettings(section)}/>);

 const id=route.location.key.threadId;
 return <AppShell navigationPresentation={navigationPresentation} navigationFailure={transition?.phase==='failed'?<span>Switch failed</span>:null} sceneOwnerId={route.routeScopeId} foreground='primary' layoutScope='handoff' mainContentLayout='default'
 navigation={returnProbe?{...navigation,applicationsInSidebar:true,onOpenSettings:()=>setDestination('settings'),actions:[{id:'chat',title:'Chat',icon:'chat',onInvoke:returnToChat}]}:navigation} sidebarOpen={sidebar} sidebarWidth={275} onSidebarCollapse={()=>setSidebar(false)} onSidebarExpand={()=>setSidebar(true)} onSidebarResizeEnd={()=>{}}
 windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} header={<Header/>} floatingSidebarHeader={()=>null}
 leftPanel={returnProbe?<ApplicationsSidebarFrame selected={destination==='applications'} settingsContent={destination==='settings'?settings:null} onReturnToChat={returnToChat} contributions={contributions} renderers={renderers} host={{platform:'web'}} route={route.applicationRoute}>
 {route.applicationRoute.kind==='settings'?settings:<Sidebar threads={rows} activeHostId='local' activeThreadId={id} pendingHostId={pending?.key.hostId??null} pendingThreadId={pending?.key.threadId??null}
 sidebarLayout={layout} onSelectThread={(_,id)=>nav.selectConversation(createWorkbenchThreadLocation('local',id)).catch(()=>false)} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false} showNewChat/>}
 </ApplicationsSidebarFrame>:<Sidebar threads={rows} activeHostId='local' activeThreadId={id} pendingHostId={pending?.key.hostId??null} pendingThreadId={pending?.key.threadId??null}
 sidebarLayout={layout} onSelectThread={(_,id)=>nav.selectConversation(createWorkbenchThreadLocation('local',id)).catch(()=>false)} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false} showNewChat/>}
 rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}}><Body id={id}/></AppShell>
}
createIntlTestRoot(document.getElementById('root')).render(<App/>);
`;
const vite = await createServer({ configFile:false,root:process.cwd(),logLevel:'error',
  resolve:{dedupe:['react','react-dom','react-intl']},cacheDir:output+'/vite-cache',esbuild:{jsx:'automatic'},
  optimizeDeps:{entries:[],include:["@deepseek-ai/cordis","@dnd-kit/core","@dnd-kit/sortable","@dnd-kit/utilities","@mermaid-js/layout-elk","@radix-ui/react-alert-dialog","@radix-ui/react-context-menu","@radix-ui/react-dialog","@radix-ui/react-dropdown-menu","@radix-ui/react-popover","@radix-ui/react-slot","@radix-ui/react-tooltip","@tanstack/react-query","framer-motion","hoist-non-react-statics","marked","mermaid","motion/react","react-dom","react-dom/client","react-intl","react-is","react-router","react-use-event-hook","react","react/jsx-dev-runtime","react/jsx-runtime","scheduler","sonner","tslib"]},
  server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'handoff',resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?source:null,
    configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>');});}}]});
let browser;
try {
  await mkdir(output,{recursive:true});await vite.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  for(const {label,width,touch} of [{label:'phone',width:390,touch:true},{label:'phone-reduced',width:390,touch:true},{label:'tablet',width:1024,touch:true},{label:'desktop',width:1440,touch:false}].filter(item=>!process.env.OPENCRAFT_SMOKE_CASE||item.label===process.env.OPENCRAFT_SMOKE_CASE)){
    const compact=width===390;
    const context=await browser.newContext({viewport:{width,height:844},hasTouch:touch,isMobile:touch});
    const page=await context.newPage();await page.emulateMedia({reducedMotion:label==='phone-reduced'?'reduce':'no-preference'});const errors:string[]=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.stack);});
    page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
    page.on('requestfailed',r=>console.error('REQUEST',r.url(),r.failure()));
    await page.addInitScript('window.__name=v=>v');
    await page.goto(vite.resolvedUrls!.local[0]!,{waitUntil:'commit'});
    await page.waitForFunction(()=>!!(window as any).shell,null,{timeout:120000}).catch(async error=>{
      console.error('BOOT',await page.evaluate(()=>({nav:!!(window as any).nav,shell:(window as any).shell,html:document.body.innerHTML.slice(0,6000)})));
      await page.screenshot({path:output+'/boot-failure.png'});throw error;
    });
    if(touch)await page.evaluate(()=>document.documentElement.dataset.uiDensity='touch');
    await page.evaluate(()=>{const w=window as any;if(!w.shell.sidebarOpen)w.shell.toggleSidebar();});
    if(returnProbe){
      const drawer=()=>page.evaluate(()=>(window as any).shell.sidebarOpen);
      const click=async(locator:any)=>touch?locator.tap():locator.click();
      const returnButton=()=>page.locator('.settings-return-to-app:visible');
      const clickReturn=()=>click(compact?returnButton():page.locator('[data-action-id=chat]:visible'));
      const original=await page.evaluate(()=>{const w=window as any;w.originalDraft=document.querySelector('[aria-label=Draft]');return w.nav.getSnapshot().routeScopeId;});
      const assertReturned=async()=>{
        await page.waitForFunction(()=>(window as any).nav.getSnapshot().applicationRoute.kind==='conversation');
        await page.waitForFunction(()=>getComputedStyle(document.querySelector('.main-content-body')).opacity==='1');
        await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
        assert.equal(await drawer(),true,'Back to app preserves the list/drawer instead of entering fullscreen Chat');
        assert.equal(await page.evaluate(()=>(window as any).returnFixture.destination),'context');
        assert.equal(await page.evaluate(()=>(window as any).nav.getSnapshot().routeScopeId),original);
        assert.equal(await page.locator('.sidebar-activity-item.is-selected').textContent().then(t=>t?.includes('Conversation a')),true);
        assert.equal(await page.getByRole('textbox',{name:'Draft',exact:true}).inputValue(),'Preserved');
        assert.equal(await page.getByRole('textbox',{name:'Draft',exact:true}).evaluate(e=>e===(window as any).originalDraft),true);
        assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')==='Draft'),false,'return does not open an IME');
      };
      // Switching peer lists without selecting a page must retain the open allocation.
      await page.evaluate(()=>(window as any).returnFixture.openSettings());
      await clickReturn();await assertReturned();
      await page.evaluate(()=>(window as any).returnFixture.openApplications());
      await clickReturn();await assertReturned();
      // The selected Settings page has its own route; return still restores the same View/list.
      await page.evaluate(()=>(window as any).returnFixture.openSettings());
      await click(page.getByRole('button',{name:'Appearance',exact:true}));
      if(compact){await page.waitForFunction(()=>!(window as any).shell.sidebarOpen);await page.evaluate(()=>(window as any).shell.toggleSidebar());}
      if(compact)await page.getByRole('button',{name:'Back to app',exact:true}).waitFor({state:'visible'});
      // Hold the presentation handoff to exercise preparing across actual React commits.
      await page.evaluate(()=>(window as any).holdReturn=true);
      await clickReturn();
      await page.waitForFunction(()=>(window as any).nav.getTransition()?.phase==='preparing');
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      assert.equal(await drawer(),true,'preparation must not dismiss an in-place list return');
      await page.evaluate(()=>{const w=window as any;w.holdReturn=false;w.releaseReturn();});
      await assertReturned();
      await page.screenshot({path:output+'/'+label+'-return-open.png'});
      // Selecting the already-current conversation is still an explicit row action.
      await click(page.locator('.sidebar-activity-item').filter({hasText:'Conversation a'}));
      if(compact){await page.waitForFunction(()=>!(window as any).shell.sidebarOpen);await page.evaluate(()=>(window as any).shell.toggleSidebar());}
      else assert.equal(await drawer(),true);
      assert.equal(await page.evaluate(()=>(window as any).nav.getSnapshot().routeScopeId),original);
      // Explicit conversation selection restores the normal compact/docked policy.
      const target=page.locator('.sidebar-activity-item').filter({hasText:'Conversation b'});
      await click(target);await page.waitForFunction(()=>(window as any).nav.getPendingLocation()?.key.threadId==='b');
      if(compact)await page.waitForFunction(()=>!(window as any).shell.sidebarOpen);
      else assert.equal(await drawer(),true,'docked list stays visible on iPad and desktop');
      await page.evaluate(()=>(window as any).release('b'));
      await page.waitForFunction(()=>document.querySelector('[data-body]')?.getAttribute('data-body')==='b');
      assert.equal(await drawer(),!compact);
      assert.deepEqual(errors,[]);
      console.log('PASS',label,'peer-list/page return, same View/draft, explicit selection');
      await context.close();continue;
    }
    const row=(id:string)=>page.locator('.sidebar-activity-item').filter({hasText:'Conversation '+id});
    const invoke=(id:string)=>touch?row(id).tap():row(id).click();
    await invoke('b');
    await page.waitForFunction(()=>(window as any).nav.getPendingLocation()?.key.threadId==='b');
    if(label!=='phone-reduced')assert.ok(await page.locator('.sidebar-activity-item.is-selected').textContent().then(text=>text?.includes('Conversation b')));
    assert.equal(await page.locator('[data-body]').getAttribute('data-body'),'a');
    if(compact){
      await page.waitForFunction(()=>!(window as any).shell.sidebarOpen);
      assert.equal(await page.locator('.app-shell-navigation-preparation').count(),0,'navigation has no loading mask');
      await page.waitForFunction(()=>!document.querySelector('.app-shell-page-presentation[data-mobile-sidebar-present]'));
      if(label!=='phone-reduced')await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.main-content-body')).opacity)<=0.01);
      assert.equal(await page.locator('[aria-label=Draft]').evaluate(e=>!!e.closest('[inert]')),true);
      await page.screenshot({path:output+'/'+label+'-pending.png'});
      await page.locator('.app-shell-header-motion-host [data-app-shell-sidebar-trigger]').tap();
    }else assert.equal(await page.evaluate(()=>(window as any).shell.sidebarOpen),true);
    // A newer selection wins; an old restoration cannot close the drawer.
    await invoke('c');await page.evaluate(()=>(window as any).release('b'));
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert.equal(await page.locator('[data-body]').getAttribute('data-body'),'a');
    assert.equal(await page.evaluate(()=>(window as any).shell.sidebarOpen),!compact);
    assert.equal(await page.locator('.app-shell-navigation-preparation').count(),0);
    await page.evaluate(()=>{(window as any).samples=[];(window as any).holdPaint=true;(window as any).release('c');});
    await page.waitForFunction(()=>document.querySelector('[data-body]')?.getAttribute('data-body')==='c');
    assert.equal(await page.locator('.main-content-body').evaluate(e=>e.hasAttribute('inert')),true,'layout handoff retains interaction ownership until target readiness');
    const arrival=await page.evaluate(()=>new Promise<{elapsed:number;frames:number;maxFrameGap:number}>(resolve=>{
      const w=window as any;w.holdPaint=false;
      const started=performance.now();let frames=0,last=started,maxFrameGap=0;
      w.present();
      const sample=()=>{
        const now=performance.now();frames++;maxFrameGap=Math.max(maxFrameGap,now-last);last=now;
        if(getComputedStyle(document.querySelector('.main-content-body')).opacity==='1')
          resolve({elapsed:now-started,frames,maxFrameGap});
        else requestAnimationFrame(sample);
      };requestAnimationFrame(sample);
    }));
    await writeFile(output+'/'+label+'-arrival-budget.json',JSON.stringify(arrival,null,2));
    // Allow the measured longest frame for scheduler jitter on a shared runner.
    // The old 280ms fade must fail even with a normal one-frame allowance.
    assert.ok(arrival.elapsed<=100+arrival.maxFrameGap,'ready content exceeded its reveal budget: '+JSON.stringify(arrival));
    if(compact)await page.waitForFunction(()=>!(window as any).shell.sidebarOpen);
    else assert.equal(await page.evaluate(()=>(window as any).shell.sidebarOpen),true,'docked desktop sidebar remains open');
    const samples=await page.evaluate(()=>(window as any).samples);
    assert.ok(samples.every((s:any)=>s.id==='a'||s.id==='c'),'preparation may retain the outgoing view, never a superseded destination');
    assert.equal(await page.locator('[aria-label=Draft]').evaluate(e=>e===document.activeElement),false,'selection does not open an IME');
    if(compact)await page.evaluate(()=>(window as any).shell.toggleSidebar());
    await invoke('b');await page.evaluate(()=>(window as any).reject('b'));
    await page.waitForFunction(()=>(window as any).nav.getPendingLocation()===null);
    assert.equal(await page.evaluate(()=>(window as any).shell.sidebarOpen),!compact,'failure cannot reopen or close another presentation');
    await page.getByRole('alert').filter({hasText:'Switch failed'}).waitFor();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.main-content-body')).opacity==='1');
    assert.equal(await page.locator('[data-body]').getAttribute('data-body'),'c');
    await page.screenshot({path:output+'/'+label+'-failed.png'});
    if(compact){
      await page.evaluate(()=>(window as any).shell.toggleSidebar());
      await invoke('b');
      await page.waitForFunction(()=>!(window as any).shell.sidebarOpen);
      await page.waitForFunction(()=>!document.querySelector('.app-shell-page-presentation[data-mobile-sidebar-present]'));
      await page.locator('.app-shell-header-motion-host [data-app-shell-sidebar-trigger]').tap();
      await page.waitForFunction(()=>(window as any).shell.sidebarOpen);
      await page.evaluate(()=>(window as any).release('b'));
      await page.waitForFunction(()=>document.querySelector('[data-body]')?.getAttribute('data-body')==='b');
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      assert.equal(await page.evaluate(()=>(window as any).shell.sidebarOpen),true,'old receipt cannot dismiss a reopened drawer');
    }
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.main-content-body')).opacity==='1');
    // Retained Views must commit before a stopped animation clock can complete.
    // This deterministically rejects a minimum animation-duration gate.
    await page.evaluate(async()=>{
      const w=window as any;w.holdPaint=true;
      const raf=window.requestAnimationFrame;window.requestAnimationFrame=()=>0;
      try {
        const promise=w.nav.selectConversation(createTarget());
        for(let i=0;i<12;i++)await Promise.resolve();
        if(w.nav.getTransition()?.phase!=='committed')throw Error('cached View waited for animation clock');
        if(!(await promise))throw Error('cached View did not commit');
      } finally {window.requestAnimationFrame=raf;w.holdPaint=false;}
      function createTarget(){return {kind:'thread',key:{hostId:'local',threadId:'a'}};}
    });
    await page.waitForFunction(()=>document.querySelector('[data-body]')?.getAttribute('data-body')==='a');
    assert.ok(await page.locator('.main-content-body').evaluate(e=>Number(getComputedStyle(e).opacity))>=0.95,'warm handoff must not insert an opaque-to-transparent reset');
    const arrivalAlpha=await page.evaluate(()=>{
      const w=window as any,t=w.nav.getTransition();w.nav.acknowledgePresented(t.id,w.nav.getSnapshot().routeScopeId);
      return new Promise<number>(resolve=>requestAnimationFrame(()=>resolve(Number(getComputedStyle(document.querySelector('.main-content-body')).opacity))));
    });
    assert.ok(arrivalAlpha>=0.95,'ready cached content must preserve outgoing visibility at its first paint: '+arrivalAlpha);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.main-content-body')).opacity==='1');
    assert.equal(await page.locator('.main-content-body').evaluate(e=>e.hasAttribute('inert')),false,'arrival opacity does not block a ready View');
    assert.deepEqual(errors,[]);
    const fadeFrames=await page.evaluate(()=>(window as any).fadeFrames);
    if(label!=='phone-reduced')assert.ok(fadeFrames.some((v:any)=>v.alpha>0&&v.alpha<1),'content must actually fade, not snap behind a replacement cover');
    // Readiness gates interaction, not a mandatory fully transparent frame.
    await writeFile(output+'/'+label+'-fade.json',JSON.stringify(fadeFrames,null,2));
    if(compact){
      await page.evaluate(()=>{const w=window as any;if(!w.shell.sidebarOpen)w.shell.toggleSidebar();});
      const materials=await page.evaluate(()=>(window as any).materialSamples);
      assert.ok(materials.length>2,'sample actual visible footer paint across frames');
      for(const frame of materials)for(const surface of frame){
        assert.equal(surface.filter,'none');assert.equal(surface.lenses,0);
        assert.ok(surface.background.startsWith('rgb('),'opaque floor must exist on every sampled frame: '+surface.background);
      }
      await writeFile(output+'/'+label+'-materials.json',JSON.stringify(materials,null,2));
      await page.screenshot({path:output+'/'+label+'-footer.png'});
      const heldMaterial=async(theme:string)=>{
        const cdp=await context.newCDPSession(page);
        const touch=async(type:string,x?:number)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:x===undefined?[]:[{x,y:600,id:1,radiusX:2,radiusY:2,force:1}]});
        await touch('touchStart',350);await touch('touchMove',300);await touch('touchMove',260);
        await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
        const held=await page.locator('.shell-sidebar-primary-action').evaluate(e=>{
          const panel=e.closest('.app-shell-floating-left-panel')!;
          const alphas=[];for(let node:Element|null=e;node;node=node.parentElement)alphas.push(Number(getComputedStyle(node).opacity));
          return {scale:new DOMMatrixReadOnly(getComputedStyle(panel).transform).a,alphas};
        });
        assert.ok(held.scale<1,'test must hold a real partially closed drag');
        assert.ok(held.alphas.every((alpha:number)=>alpha===1),'footer ancestors must not fade during drag: '+JSON.stringify(held));
        await page.screenshot({path:output+'/'+label+'-footer-held-'+theme+'.png'});
        await touch('touchMove',300);
        await touch('touchCancel');
        await page.waitForFunction(()=>{const e=document.querySelector('.app-shell-floating-left-panel');return e&&new DOMMatrixReadOnly(getComputedStyle(e).transform).a===1;});
        await cdp.detach();
      };
      if(label==='phone')await heldMaterial('light');
      await page.evaluate(()=>(window as any).setTheme('dark'));
      await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
      const footer=page.locator('.shell-sidebar-primary-action > .ui-liquid-glass');
      await page.waitForFunction(expected=>{const e=document.querySelector('.shell-sidebar-primary-action > .ui-liquid-glass');return e&&getComputedStyle(e).backgroundColor!==expected;},materials[0][0].background);
      const dark=await footer.evaluate(e=>({background:getComputedStyle(e).backgroundColor,filter:getComputedStyle(e,'::before').backdropFilter}));
      assert.notEqual(dark.background,materials[0][0].background,'opaque material follows the theme');
      assert.equal(dark.filter,'none');
      await page.screenshot({path:output+'/'+label+'-footer-dark.png'});
      if(label==='phone')await heldMaterial('dark');
      await page.emulateMedia({forcedColors:'active'});
      assert.equal(await footer.evaluate(e=>getComputedStyle(e,'::before').backdropFilter),'none');
    }
    await page.screenshot({path:output+'/'+label+'.png'});
    await writeFile(output+'/'+label+'.json',JSON.stringify(samples,null,2));
    console.log('PASS',label,'intent, supersession, committed-body exit, failure, no IME');
    await context.close();
  }
}finally{await browser?.close();await vite.close();}
