import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const output=process.env.OPENCRAFT_SMOKE_OUTPUT??'.local/conversation-header-ownership';
const source=`
import React,{useState,useEffect} from 'react';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{AppShellHeader}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{ConversationTaskMenu}from'/apps/workbench-web/src/components/conversation-task-menu.tsx';
import{ConversationSummaryButton,ConversationSummarySurface,ConversationSummaryLayout,useConversationSummary}from'/apps/workbench-web/src/components/conversation-summary.tsx';
import{createWorkbenchPanelReactRuntime}from'@opencraft/workbench-panels-react';
import{ThreadSummaryPlugin}from'@opencraft/plugin-thread-summary';
import{WorkbenchPanelRuntimeProvider}from'/apps/workbench-web/src/runtime/panel-runtime-context';
import{useUiPreferencesRuntime}from'/apps/workbench-web/src/runtime/ui-preferences-runtime';
import{bindInteractionDensity}from'/apps/workbench-web/src/runtime/interaction-density';
import{initializeAppearanceTheme,setThemePreference,setAppearanceThemeId,coreThemeId}from'/apps/workbench-web/src/appearance-theme';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const runtime=await createWorkbenchPanelReactRuntime();await runtime.install(ThreadSummaryPlugin);
const client=new QueryClient();const noop=()=>{};
function App(){const[right,setRight]=useState(false),[full,setFull]=useState(false),[foreground,setForeground]=useState('primary'),[sidebar,setSidebar]=useState(false),[scope,setScope]=useState('a');
 const preferences=useUiPreferencesRuntime();useEffect(()=>bindInteractionDensity(document,preferences),[preferences]);
 const summary=useConversationSummary(scope,true);
 window.fixture={configureDock:()=>preferences.set("shell.toolbarDocks",{[JSON.stringify(["a","conversation-header"])]:["share-link","rename","pin","fork"]}),setRight,setFull,setForeground,setSidebar,setScope,setThemePreference,setAppearanceThemeId,coreThemeId,setDensity:value=>preferences.set('interface.touchFriendly',value)};
 return <AppShell navigation={{layout:'unified',actions:[],onOpenSettings:noop,account:{snapshot:{phase:'anonymous'},onOpen:noop}}}
 layoutScope='ownership' sceneOwnerId='ownership' mainContentLayout='thread-edge-scroll' sidebarOpen={sidebar} sidebarWidth={275} onSidebarCollapse={()=>setSidebar(false)} onSidebarExpand={()=>setSidebar(true)} onSidebarResizeEnd={noop}
 foreground={foreground} onForegroundChange={setForeground} rightPanel={<div data-tool style={{height:'100%'}}>Browser / terminal / file viewport<input aria-label='Tool state' defaultValue='Alive'/></div>} rightPanelKeepMounted rightPanelOpen={right} rightPanelFullWidth={full} onRightPanelOpenChange={setRight}
 windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} floatingSidebarHeader={()=>null} leftPanel={<div>Conversations</div>}
 header={<AppShellHeader conversationHeader primaryActionFixedSlots={2} title={'Conversation '+scope} project='Workspace' primaryAction={<span className='conversation-header-actions'><ConversationSummaryButton controller={summary}/><ConversationTaskMenu scope={scope} serverId='local' threadId={scope} title={'Conversation '+scope} shareUrl='https://example.test' onRename={async()=>{}} onSetPinned={async()=>{}} onFork={async()=>{}} verifyConversation={async()=>{}} onOpenTasks={noop}/></span>}
 sidebarOpen={sidebar} rightPanelOpen={right} rightPanelFullWidth={full} onToggleSidebar={()=>setSidebar(v=>!v)} onToggleRightPanel={()=>setRight(v=>!v)} onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={['sidebar-toggle']}/>}
 ><ConversationSummaryLayout controller={summary}><div className='conversation-summary-reading'><div style={{height:'100%',padding:32}}><h1>Conversation {scope}</h1><textarea aria-label='Draft' defaultValue='Keep this draft'/></div></div><ConversationSummarySurface controller={summary} context={{scopeKey:scope,title:'Conversation '+scope,timeline:null,goal:null,current:true,onOpenResource:noop,onOpenThread:noop}}/></ConversationSummaryLayout></AppShell>;
}
createIntlTestRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><WorkbenchPanelRuntimeProvider runtime={runtime}><App/></WorkbenchPanelRuntimeProvider></QueryClientProvider>);
`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},cacheDir:'node_modules/.vite-header-ownership-v2',esbuild:{jsx:'automatic'},optimizeDeps:{entries:[],include:["@deepseek-ai/cordis","@dnd-kit/core","@dnd-kit/sortable","@dnd-kit/utilities","@mermaid-js/layout-elk","@radix-ui/react-alert-dialog","@radix-ui/react-context-menu","@radix-ui/react-dialog","@radix-ui/react-dropdown-menu","@radix-ui/react-popover","@radix-ui/react-slot","@radix-ui/react-tooltip","@tanstack/react-query","marked","mermaid","motion/react","react-dom","react-dom/client","react-intl","react-use-event-hook","react","react/jsx-dev-runtime","react/jsx-runtime","sonner","tslib","framer-motion","hoist-non-react-statics","react-is","scheduler"]},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'header-ownership',resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>')})}}]});
let browser;
const evidence=[];
try{
 await mkdir(output,{recursive:true});await vite.listen();browser=await chromium.launch({headless:true});
 for(const item of [{width:390,touch:true,theme:'light'},{width:1024,touch:true,theme:'dark'},{width:1440,touch:false,theme:'light'},{width:1440,touch:false,theme:'lavender'}]){
  const {width,touch,theme}=item;const context=await browser.newContext({viewport:{width,height:900},hasTouch:touch,isMobile:width<600});const page=await context.newPage();page.setDefaultTimeout(10000);console.log('CASE',item);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript('window.__name=v=>v');await page.goto(vite.resolvedUrls!.local[0]!,{waitUntil:'commit'});await page.getByRole('textbox',{name:'Draft',exact:true}).waitFor({timeout:90000});
  await page.evaluate(({touch,theme})=>{const w=window as any;w.fixture.setDensity(touch?'on':'off');w.fixture.setThemePreference(theme==='dark'?'dark':'light');if(theme==='lavender')w.fixture.setAppearanceThemeId('opencraft.core.lavender');w.draft=document.querySelector('[aria-label=Draft]');w.tool=document.querySelector('[aria-label="Tool state"]');},item);
  const click=async(locator:any)=>touch?locator.tap():locator.click();const info=()=>page.getByRole('button',{name:'Task info',exact:true});
  await page.evaluate(()=>(window as any).fixture.configureDock());
  await info().waitFor();const initialDockCount=await page.locator('.toolbar-dock__action').count();assert.equal(await page.locator('.app-shell-header__end-slot .conversation-header-actions').count(),0,'workspace end slot contains no conversation actions');
  await click(info());await page.locator('.conversation-summary[data-summary-present=true]').waitFor();
  if(width>600){
   await page.evaluate(()=>{const w=window as any;w.fixture.setRight(true)});
   await page.waitForFunction(()=>{const card=document.querySelector('.conversation-summary');const tools=document.querySelector('.app-shell-right-panel');return !card||!tools||card.getBoundingClientRect().right<=tools.getBoundingClientRect().left+1});
   await page.waitForFunction(()=>{const h=document.querySelector('[data-app-shell-primary-header]')!.getBoundingClientRect(),p=document.querySelector('.app-shell-right-panel')!.getBoundingClientRect();return Math.abs(h.right-p.left)<30&&p.width>300});
   const splitDockCount=await page.locator('.toolbar-dock__action').count();
   assert.ok(splitDockCount<=initialDockCount,'tool space cannot increase primary capacity');
   if(width===1024)assert.ok(splitDockCount<initialDockCount,'touch split folds actions using the primary pane width, not total window width');
   const geometry=await page.evaluate(()=>{const r=(s:string)=>{const b=document.querySelector(s)!.getBoundingClientRect();return{left:b.left,right:b.right,width:b.width}};return{header:r('[data-app-shell-primary-header]'),action:r('.app-shell-header__primary-actions'),tools:r('.app-shell-right-panel'),card:r('.conversation-summary[data-summary-present=true]')}});
   assert.ok(geometry.action.right<=geometry.tools.left+1,JSON.stringify(geometry));assert.ok(geometry.card.right<=geometry.tools.left+1,JSON.stringify(geometry));
   await click(page.locator('.conversation-summary[data-summary-present=true] .conversation-summary__close'));await page.waitForFunction(()=>!document.querySelector('.conversation-summary'));
   // Hold a real resize gesture: every sampled frame keeps primary controls before tools.
   const handle=page.locator('.app-shell-right-panel .right-panel-resize-handle');
   assert.equal(await handle.count(),1,'split exposes its real resize owner');
   const box=await handle.boundingBox();assert.ok(box);
   const x=box.x+box.width/2,y=box.y+box.height/2;
   const cdp=touch?await context.newCDPSession(page):null;
   const move=async(type:'start'|'move'|'end',at=x)=>{
    if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:type==='start'?'touchStart':type==='move'?'touchMove':'touchEnd',touchPoints:type==='end'?[]:[{x:at,y,id:1,radiusX:2,radiusY:2,force:1}]});
    else if(type==='start'){await page.mouse.move(at,y);await page.mouse.down();}
    else if(type==='move')await page.mouse.move(at,y);else await page.mouse.up();
   };
   await move('start');
   for(const delta of [60,120,60,0]){
    await move('move',x+delta);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const ok=await page.evaluate(()=>document.querySelector('.app-shell-header__primary-actions')!.getBoundingClientRect().right<=document.querySelector('.app-shell-right-panel')!.getBoundingClientRect().left+1);
    assert.ok(ok,'held resize moves the primary actions with their pane');
   }
   await move('end');await cdp?.detach();
   await click(info());await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.conversation-summary[data-summary-present=true]')!).opacity)>.99);
   await page.screenshot({path:output+'/'+width+'-'+theme+'-split.png'});
   await page.evaluate(()=>{const w=window as any;w.fixture.setFull(true);w.fixture.setForeground('tools')});
   await page.waitForFunction(()=>document.querySelector('[data-app-shell-primary-header]')!.hasAttribute('inert'));
   assert.equal(await info().isVisible(),false,'tool foreground has no main-conversation info control');assert.equal(await page.locator('.conversation-summary').count(),0,'a portalled summary cannot remain over another scene');
   await page.evaluate(()=>{const w=window as any;w.fixture.setFull(false);w.fixture.setForeground('primary')});await page.locator('.conversation-summary-trigger').waitFor();await page.locator('.conversation-summary[data-summary-present=true]').waitFor();
  }
  await click(page.locator('.conversation-summary[data-summary-present=true] .conversation-summary__close'));await page.waitForFunction(()=>!document.querySelector('.conversation-summary'));
  await page.evaluate(()=>(window as any).fixture.setScope('b'));await click(info());await page.locator('.conversation-summary__heading h2').filter({hasText:'Conversation b'}).waitFor();
  await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.conversation-summary[data-summary-present=true]')!).opacity)>.99);
  await page.screenshot({path:output+'/'+width+'-'+theme+'-current.png'});
  // A transient conversation menu cannot outlive its presented primary scene.
  await click(page.locator('.conversation-summary[data-summary-present=true] .conversation-summary__close'));await page.waitForFunction(()=>!document.querySelector('.conversation-summary'));
  await click(page.getByRole('button',{name:'Conversation actions',exact:true}));await page.getByRole('menu').waitFor();
  await page.evaluate(()=>{const w=window as any;w.fixture.setRight(true);w.fixture.setFull(true);w.fixture.setForeground('tools')});
  await page.waitForFunction(()=>!document.querySelector('[role=menu]'));
  await page.evaluate(()=>{const w=window as any;w.fixture.setFull(false);w.fixture.setRight(false);w.fixture.setForeground('primary')});
  await page.locator('.conversation-summary-trigger').waitFor();assert.equal(await page.getByRole('menu').count(),0,'closed menu does not reopen on primary return');
  assert.equal(await page.locator('[aria-label=Draft]').evaluate(e=>e===(window as any).draft),true);
  assert.equal(await page.locator('[aria-label=\"Tool state\"]').evaluate(e=>e===(window as any).tool),true);
  assert.deepEqual(errors,[]);evidence.push({...item,split:width>600,draftAndToolIdentity:true,errors});await context.close();
 }
 await writeFile(output+'/result.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({ok:true,evidence}));
}finally{await browser?.close();await vite.close()}
