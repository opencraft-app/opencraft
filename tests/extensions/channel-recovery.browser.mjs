import fs from'node:fs';import assert from'node:assert/strict';import{pathToFileURL}from'node:url';
const task=process.env.OPENCRAFT_CHANNEL_RECOVERY_OUTPUT??process.cwd()+'/.local/channel-recovery-evidence/',root=process.cwd();fs.mkdirSync(task,{recursive:true});
const{createServer}=await import(pathToFileURL(root+'/node_modules/vite/dist/node/index.js'));const{chromium}=await import(pathToFileURL(root+'/node_modules/playwright/index.mjs'));
const source=`
import React,{useState,useEffect,useSyncExternalStore}from'react';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{createDeferredView}from'@opencraft/extension-react';import{createImExtension}from'/plugins/im/src/index.tsx';import{createApplicationNavigation}from'/apps/workbench-web/src/runtime/workbench-navigation.ts';import{bindMobileContainer}from'/apps/workbench-web/src/runtime/mobile-container.ts';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';import{AppShellHeader}from'/apps/workbench-web/src/components/app-shell-header.tsx';import{RouteViewStack}from'/apps/workbench-web/src/components/route-view-stack.tsx';
import{AppShellRouteRegionsProvider,useAppShellRouteHeader,appShellPlatformViewRegions}from'/apps/workbench-web/src/components/app-shell-route-regions.tsx';import{routeStackPresentation}from'/apps/workbench-web/src/components/route-stack-motion.tsx';import{WorkbenchPresentationRootProvider}from'/apps/workbench-web/src/components/workbench-presentation-root.tsx';import{useUiPreferencesRuntime}from'/apps/workbench-web/src/runtime/ui-preferences-runtime';import{bindInteractionDensity}from'/apps/workbench-web/src/runtime/interaction-density';import{createClientRuntime}from'/apps/workbench-web/src/runtime/client-runtime';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';import'/apps/workbench-web/src/styles/app.scss';
const params=new URLSearchParams(location.search);initializeAppearanceTheme();setThemePreference(params.get('theme')||'light');const inputRuntime=createClientRuntime(document);inputRuntime.start();
const renderers=new Map(),views=new Map(),lifetime=new AbortController(),noop=()=>{},subs=()=>()=>{};
const groups=Array.from({length:24},(_,i)=>({id:'g'+i,title:'Navigation group '+i,kind:'group',canSend:true,canManageMembers:false,latestMessage:{text:'A recent message',at:1700000000000-i*1000}}));

const changes=new Set(),disconnects=new Set(),recoveries=new Set();const subscriptions=new Map();let gates=[],blockedSync=true,blockedDirectory=false,syncFailure=false,denied=false,historyGate,historyFailure=false;
const control={enableEarlier:false,historyWaits:0,holdHistory(){return new Promise(resolve=>{historyGate=resolve})},releaseHistory(failed=false){historyFailure=failed;historyGate?.()},subscriptions,reads:0,sends:0,draftScope:'account-one',waits:0,
recovered:false,recoveryHint(){recoveries.forEach(fn=>fn())},rename(){groups[0]={...groups[0],title:'Updated group title'};control.changed()},blockSync(){blockedSync=true},blockDirectory(){blockedDirectory=true},fail(){syncFailure=true},recover(){syncFailure=false;denied=false;control.release();control.changed()},deny(){denied=true},releaseOne(){const first=gates.shift();first?.()},release(){blockedSync=false;blockedDirectory=false;const pending=gates;gates=[];pending.forEach(resolve=>resolve())},disconnect(){disconnects.forEach(fn=>fn())},changed(){for(const id of subscriptions.keys())changes.forEach(fn=>fn(id))},switchAccount(){control.draftScope='account-two';control.disconnect()}};window.control=control;
const wait=async kind=>{if(kind==='sync'?blockedSync:blockedDirectory){control.waits++;await new Promise(resolve=>gates.push(resolve))}};
const rpc={get draftScope(){return control.draftScope},supportsRead:true,connect:async()=>{},close:async()=>{},onChanged:fn=>{changes.add(fn);return()=>changes.delete(fn)},onDisconnect:fn=>{disconnects.add(fn);return()=>disconnects.delete(fn)},onRecoveryHint:fn=>{recoveries.add(fn);return()=>recoveries.delete(fn)},request:async(method,p,signal)=>{
if(method==='opencraft/channels/subscribe'){subscriptions.set(p.subscriptionId,p.channelId);return{}};
if(method==='opencraft/channels/unsubscribe'){subscriptions.delete(p.subscriptionId);return{}};
if(method==='opencraft/channels/list'){await wait('directory');return{groups}};
if(method==='opencraft/channels/people/list')return{people:[{actorId:'old-member',kind:'human',displayName:'Old account person'}],next:null};if(method==='opencraft/channels/group/members/list')return{members:[]};if(method==='opencraft/personal-assistant/get')return{assistant:null,runtime:{phase:'stopped'}};
if(method==='opencraft/channels/sync'){await wait('sync');if(denied)throw Error('channel_denied');if(syncFailure)throw Error('temporary');return{kind:'snapshot',messages:[...Array.from({length:20},(_,i)=>({sequence:i+1,messageId:'m'+i,author:'Alex',sender:{id:'alex',displayName:'Alex',actorKind:'human'},text:'Retained '+p.channelId+' message '+i,at:1700000000000+i,status:'received'})),...(control.recovered?[{sequence:21,messageId:'foreground-new',author:'Alex',text:'Foreground recovered message',at:1700000000021,status:'received'}]:[])],cursor:'one',hasEarlier:control.enableEarlier}};
if(method==='opencraft/channels/messages/list'){control.historyWaits++;await control.holdHistory();if(historyFailure)throw Error('channel_denied');return{messages:[{sequence:0,messageId:'old',author:'Alex',text:'Retired earlier page',at:1699999999999,status:'received'}],hasEarlier:false}};
if(method==='opencraft/channels/read'){control.reads++;return{}};if(method==='opencraft/channels/messages/send'){control.sends++;return{}};return null}};
await createImExtension(async()=>new Response(JSON.stringify({nativeChannels:true}),{headers:{'content-type':'application/json'}}),()=>rpc,true).activate({signal:lifetime.signal,views:{register:v=>views.set(v.id,v)},sidebar:{registerCatalog(){}},internal:{register:(type,v)=>{if(type==='platformViewRenderer'){const Actual=v.Component;renderers.set(v.viewType,v.viewType==='opencraft.im.channel-chat'?createDeferredView(async()=>{await new Promise(r=>setTimeout(r,650));return Actual}):Actual)}}},subscriptions:{add(){}},storage:{}});
const navigation=createApplicationNavigation(null,{mode:'browser',resolveParentRoute:route=>{const p=route.kind==='extension-view'?views.get(route.viewId)?.navigationParent:null;return p?{kind:'extension-view',viewId:p.viewId,resourceUri:p.resourceUri??null}:null}});
window.navigationProbe=navigation;const query=new QueryClient();let bridge;window.installNativeBridge=()=>{window.opencraftMobile={version:1,runtimeId:'navigation-probe'};window.mobileMessages=[];window.ReactNativeWebView={postMessage:raw=>window.mobileMessages.push(JSON.parse(raw))};bridge=bindMobileContainer(navigation)};
function App(){const preferences=useUiPreferencesRuntime();useEffect(()=>bindInteractionDensity(document,preferences),[preferences]);const state=useSyncExternalStore(navigation.subscribe,navigation.getSnapshot),route=state.applicationRoute;const[open,setOpen]=useState(false);window.sidebarProbe=()=>open;
const active=route.kind==='extension-view'?views.get(route.viewId):undefined,Component=active?renderers.get(active.viewType):undefined;const host={platform:'web',activeHostId:'fixture',profiles:[],activeView:route.kind==='extension-view'?route:undefined,openView:navigation.openExtensionView,provisionHost:async()=>{},removeHost:async()=>false,pushViewResource:navigation.pushExtensionViewResource,replaceViewResource:navigation.replaceExtensionViewResource};
const routeHeader=useAppShellRouteHeader(state.routeScopeId);const returning=state.canReturn===true,back=returning?navigation.returnToParent:navigation.back;
return <QueryClientProvider client={query}><AppShellRouteRegionsProvider controller={routeHeader.controller} target={routeHeader.target}><AppShell routeStack={routeStackPresentation(state,'synthetic-account')} navigation={{layout:'unified',account:{snapshot:{phase:'authenticated',name:'Synthetic employee',avatarUrl:null},onOpen:noop,onRefresh:async()=>{}},actions:[{id:'inbox',title:'Inbox',icon:'messages',onInvoke:()=>navigation.openExtensionView('opencraft.im.people')}],onOpenSettings:()=>navigation.openSettings()}} navigationReturn={returning?{key:state.navigationPath.at(-1).historyKey??state.url,invoke:navigation.returnToParent}:undefined} layoutScope='nav-probe' mainContentLayout='default' windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} sidebarOpen={open} sidebarWidth={335} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={noop} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={noop}
header={<AppShellHeader routeHeaderActive={routeHeader.active} routeHeaderHostRef={routeHeader.hostRef} title={active?.title??'Navigation'} project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false} onToggleSidebar={()=>setOpen(v=>!v)} onToggleRightPanel={noop} onHome={()=>navigation.openChat()} canReturn={returning} canGoBack={returning||state.canGoBack} canGoForward={state.canGoForward} onBack={back} onForward={navigation.forward} navigationActions={['sidebar-toggle']}/>}
floatingSidebarHeader={()=>null} leftPanel={<button onClick={()=>{setOpen(false);navigation.openExtensionView('opencraft.im.people')}}>Inbox destination</button>}>
{Component?<RouteViewStack navigation={state}><Component activation={{viewId:active.id,resourceUri:route.resourceUri}} contribution={active} host={host} regions={appShellPlatformViewRegions}/></RouteViewStack>:<div style={{padding:24}}><button onClick={()=>navigation.openExtensionView('opencraft.im.people')}>Open Inbox</button></div>}
<dialog id='gesture-dialog'><p>Modal owns this gesture</p><button onClick={()=>document.getElementById('gesture-dialog').close()}>Close modal</button></dialog>
</AppShell></AppShellRouteRegionsProvider></QueryClientProvider>}
const target=document.getElementById('root');createIntlTestRoot(target,undefined,'en-US').render(<WorkbenchPresentationRootProvider target={target}><App/></WorkbenchPresentationRootProvider>);
`;
const server=await createServer({root,configFile:false,cacheDir:task+'vite',publicDir:root+'/apps/workbench-web/public',logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['prosemirror-state','prosemirror-view','prosemirror-model','prosemirror-transform','prosemirror-commands','prosemirror-history','prosemirror-keymap','prosemirror-inputrules','prosemirror-schema-list','@dnd-kit/core','@dnd-kit/sortable','@dnd-kit/utilities','react','react-dom','react-dom/client','react/jsx-runtime','motion/react','@tanstack/react-query','react-intl','@radix-ui/react-dialog','@radix-ui/react-dropdown-menu','@radix-ui/react-popover','@radix-ui/react-alert-dialog','tslib']},plugins:[{name:'navigation-probe',resolveId:id=>id==='/navigation-probe.tsx'?id:null,load:id=>id==='/navigation-probe.tsx'?source:null,configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/@')||req.url?.startsWith('/node_modules')||req.url?.startsWith('/apps/')||req.url?.startsWith('/packages/')||req.url?.startsWith('/plugins/')||req.url?.startsWith('/navigation-probe.tsx')||req.url?.startsWith('/products/'))return next();if(req.headers.accept?.includes('text/html')){res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/navigation-probe.tsx"></script>')}else next()})}}]});
let browser;const evidence=[];
try{await server.listen();browser=await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:'/data/build/cache/playwright/chromium-1248/chrome-linux64/chrome'});
for(const touch of[false,true])for(const theme of['light','dark']){
const context=await browser.newContext({viewport:{width:touch?390:1200,height:844},hasTouch:touch,isMobile:touch}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/?theme='+theme);await page.getByRole('button',{name:'Open Inbox',exact:true}).click();await page.getByRole('button',{name:'Navigation group 0',exact:true}).click();
const live=page.locator('.page-stack > .page-stack__live');const timeline=live.locator('[data-message-timeline]'),editor=live.locator('[contenteditable=true]').first();await editor.waitFor();await page.waitForTimeout(750);assert.equal(await live.getByText('Loading messages…',{exact:true}).count(),0);assert.equal(await live.locator('.conversation-history-status svg').count(),0);assert.equal(await live.locator('.opencraft-composer-shell').getAttribute('data-loading'),'true');assert.equal(await live.getByText('New messages will appear here.',{exact:true}).count(),0);await editor.fill('Unsent across recovery');await page.evaluate(()=>{window.timelineNode=document.querySelector('.page-stack > .page-stack__live [data-message-timeline]');window.editorNode=document.querySelector('.page-stack > .page-stack__live [contenteditable=true]')});await page.screenshot({path:task+'cold-'+(touch?'touch':'desktop')+'-'+theme+'.png'});
await page.evaluate(()=>window.control.release());await live.locator('[data-history-presentation="none"]').waitFor();await live.getByText('Retained g0 message 19',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.timelineNode===document.querySelector('.page-stack > .page-stack__live [data-message-timeline]')),true);assert.equal(await page.evaluate(()=>window.editorNode===document.querySelector('.page-stack > .page-stack__live [contenteditable=true]')),true);
// A route can recover without a socket close or a CHANNELS_CHANGED notification.
await page.evaluate(()=>{window.control.recovered=true;window.control.recoveryHint()});await live.getByText('Foreground recovered message',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.control.sends),0);assert.ok((await editor.innerText()).includes('Unsent across recovery'));assert.equal(await page.evaluate(()=>window.editorNode===document.querySelector('.page-stack > .page-stack__live [contenteditable=true]')),true);
await page.evaluate(()=>{window.control.blockSync();window.control.blockDirectory();window.control.disconnect()});const warm=live.locator('[data-history-presentation="warm-loading"]');await warm.waitFor();assert.equal(await warm.evaluate(x=>x.inert),true);assert.equal(Number(await warm.evaluate(x=>getComputedStyle(x).opacity)),1,'recovery must retain full reading contrast');assert.equal(await page.evaluate(()=>window.timelineNode===document.querySelector('.page-stack > .page-stack__live [data-message-timeline]')),true);assert.ok((await editor.innerText()).includes('Unsent across recovery'));await page.screenshot({path:task+'cached-'+(touch?'touch':'desktop')+'-'+theme+'.png'});
await page.getByRole('button',{name:'Back',exact:true}).first().click();const row=live.getByRole('button',{name:'Navigation group 0',exact:true});await row.waitFor();assert.equal(await row.isDisabled(),true);await page.waitForTimeout(700);await page.screenshot({path:task+'inbox-cached-'+(touch?'touch':'desktop')+'-'+theme+'.png'});await page.evaluate(()=>window.control.release());await page.waitForFunction(()=>!document.querySelector('.page-stack > .page-stack__live button[aria-label="Navigation group 0"]').disabled);await row.click();await editor.waitFor();await page.waitForTimeout(750);assert.ok((await editor.innerText()).includes('Unsent across recovery'));await live.getByText('Retained g0 message 19',{exact:true}).waitFor();
// A failed refresh retains display rows without authorizing message actions.
await page.evaluate(()=>{window.control.fail();window.control.changed()});await live.locator('[data-history-presentation="warm-error"]').waitFor();assert.ok((await editor.innerText()).includes('Unsent across recovery'));await page.evaluate(()=>{window.control.blockSync();window.control.disconnect()});await live.locator('[data-history-presentation="warm-loading"]').waitFor();await page.getByRole('button',{name:'Back',exact:true}).first().click();await live.getByRole('button',{name:'Navigation group 1',exact:true}).waitFor();await page.evaluate(()=>window.control.release());await page.waitForTimeout(1100);await live.getByRole('button',{name:'Navigation group 1',exact:true}).click();await editor.waitFor();assert.equal(await live.getByText('Retained g0 message 19',{exact:true}).count(),0);assert.deepEqual(errors,[]);console.log(JSON.stringify({touch,theme,coldNoTextFlash:true,stableTimelineAndComposer:true,retainedDraft:true,cachedRowsReadableAndInert:true,cachedInboxDisabled:true,recoveryRestoresAuthority:true,foregroundHintCatchesMissedMessage:true,failedRefreshRetains:true,noOldGroupLeak:true}));await context.close();}
// A successful old connection response cannot grant authority after disconnect.
for(const scenario of ['late-response','revocation','account-scope']) {
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),page=await context.newPage();
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/');
  await page.getByRole('button',{name:'Open Inbox',exact:true}).click();
  await page.getByRole('button',{name:'Navigation group 0',exact:true}).click();
  const live=page.locator('.page-stack > .page-stack__live');
  await live.locator('[contenteditable=true]').first().waitFor();
  await page.waitForFunction(()=>window.control.waits>0);
  if(scenario==='late-response') {
    await page.evaluate(()=>{window.control.disconnect();window.control.releaseOne()});
    await page.waitForTimeout(100);
    assert.equal(await live.getByText('Retained g0 message 19',{exact:true}).count(),0);
    await live.locator('[data-history-presentation="cold-loading"]').waitFor();await page.evaluate(()=>window.control.release());
  } else await page.evaluate(()=>window.control.release());
  await live.getByText('Retained g0 message 19',{exact:true}).waitFor();
  if(scenario==='revocation') {
    await page.evaluate(()=>{window.control.deny();window.control.changed()});
    await live.getByText('This chat is no longer available.',{exact:true}).waitFor();
    assert.equal(await live.getByText('Retained g0 message 19',{exact:true}).count(),0);
  }
  if(scenario==='account-scope') {
    await page.evaluate(()=>{window.control.blockSync();window.control.blockDirectory();window.control.disconnect();window.control.switchAccount();window.control.release()});
    await page.waitForTimeout(1200);
    assert.equal(await live.getByText('Retained g0 message 19',{exact:true}).count(),0);
    await page.getByRole('button',{name:'Back',exact:true}).first().click();await page.waitForTimeout(700);
    assert.equal(await live.getByRole('button',{name:'Navigation group 0',exact:true}).count(),0);
  }
  console.log(JSON.stringify({scenario,passed:true}));await context.close();
}


// Pagination success and failure must belong to the same connection as admission.
for(const failed of [false,true]) {
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),page=await context.newPage();
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/');
 await page.evaluate(()=>{window.control.enableEarlier=true;window.control.release()});
 await page.getByRole('button',{name:'Open Inbox',exact:true}).click();await page.getByRole('button',{name:'Navigation group 0',exact:true}).click();
 const live=page.locator('.page-stack > .page-stack__live');await live.getByText('Retained g0 message 19',{exact:true}).waitFor();
 await live.locator('[data-message-timeline]').hover();await page.mouse.wheel(0,-10000);await page.waitForFunction(()=>window.control.historyWaits===1);
 await page.evaluate(()=>window.control.disconnect());await live.locator('[data-history-presentation="warm-loading"]').waitFor();
 await live.locator('[data-history-presentation="none"]').waitFor();
 await page.evaluate(failed=>window.control.releaseHistory(failed),failed);await page.waitForTimeout(250);
 assert.equal(await live.getByText('Retired earlier page',{exact:true}).count(),0);assert.equal(await live.getByText('This chat is no longer available.',{exact:true}).count(),0);
 assert.equal(await live.locator('[data-history-presentation="none"]').count(),1);
 assert.equal(await live.getByRole('button',{name:'Load earlier messages',exact:true}).isEnabled(),true);
 console.log(JSON.stringify({scenario:failed?'late-history-denied':'late-history-success',passed:true}));await context.close();
}

// Scope retirement must clear a currently visible Members tab, not only group rows.
{
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),page=await context.newPage();
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/');await page.getByRole('button',{name:'Open Inbox',exact:true}).click();await page.getByText('Members',{exact:true}).click();await page.getByText('Old account person',{exact:true}).waitFor();await page.evaluate(()=>window.control.switchAccount());await page.waitForTimeout(300);assert.equal(await page.getByText('Old account person',{exact:true}).count(),0);console.log(JSON.stringify({scenario:'retire-members-tab',passed:true}));await context.close();
}
// Inbox and channel header consume the same directory update.
{
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),page=await context.newPage();
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/');await page.getByRole('button',{name:'Open Inbox',exact:true}).click();await page.getByRole('button',{name:'Navigation group 0',exact:true}).click();await page.locator('.page-stack__live [contenteditable=true]').waitFor();await page.evaluate(()=>window.control.rename());await page.locator('.page-stack__live .app-shell-header__route').getByText('Updated group title',{exact:true}).waitFor();await page.getByRole('button',{name:'Back',exact:true}).first().click();await page.locator('.page-stack__live').getByRole('button',{name:'Updated group title',exact:true}).waitFor();console.log(JSON.stringify({scenario:'shared-directory-revision',passed:true}));await context.close();
}

// Visit more than the shared inactive-scope budget; edited input must remain retained.
{
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/');await page.evaluate(()=>window.control.release());await page.getByRole('button',{name:'Open Inbox',exact:true}).click();
 const live=page.locator('.page-stack__live');await live.getByRole('button',{name:'Navigation group 0',exact:true}).click();await live.locator('[contenteditable=true]').first().click();await live.locator('[contenteditable=true]').first().pressSequentially('Retained through scope eviction');
 for(let i=1;i<24;i++){await page.getByRole('button',{name:'Back',exact:true}).first().click();await live.getByRole('button',{name:'Navigation group '+i,exact:true}).click();await live.locator('[contenteditable=true]').first().waitFor();}
 await page.getByRole('button',{name:'Back',exact:true}).first().click();await live.getByRole('button',{name:'Navigation group 0',exact:true}).click();await live.locator('[contenteditable=true]').first().waitFor();assert.ok((await live.locator('[contenteditable=true]').first().innerText()).includes('Retained through scope eviction'));assert.deepEqual(errors,[]);console.log(JSON.stringify({scenario:'draft-survives-inactive-scope-budget',passed:true}));await context.close();
}

}finally{await browser?.close();await server.close();}
