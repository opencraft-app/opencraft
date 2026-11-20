import assert from 'node:assert/strict';
import {mkdir,writeFile}from'node:fs/promises';
import {createServer}from'vite';
const output=process.env.OPENCRAFT_RECENCY_REPORT??'/tmp/opencraft-sidebar-live-recency';
const fixture=`
import React,{useState}from'react';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{AppShellHeader}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{Sidebar}from'/apps/workbench-web/src/components/sidebar.tsx';
import{frame}from'@opencraft/design-system/tokens';
import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import{projectAppServerThread,legacyDirectServerProjectionFromHost}from'@opencraft/workbench-runtime';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import{useHostThreadCatalogQueries}from'/apps/workbench-web/src/runtime/use-host-thread-catalog-queries.ts';
import{bindThreadCatalogNotifications}from'/apps/workbench-web/src/runtime/thread-catalog-notifications.ts';
import{sidebarThreadCatalogQueryKey}from'/apps/workbench-web/src/runtime/thread-catalog-query.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const query=new QueryClient({defaultOptions:{queries:{retry:false}}}),layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_s,d)=>d});
const now=Date.now()/1000,yesterday=new Date(new Date().getFullYear(),new Date().getMonth(),new Date().getDate()-1,12).getTime()/1000;
const make=(id,name,at)=>({id,name,cwd:'/workspace',preview:'',updatedAt:at,recencyAt:at,createdAt:yesterday-86400,status:{type:'idle'},pinned:false});
let metadata=[make('old','Yesterday task',yesterday),make('fresh','Fresh task',now-60),make('untouched','Untouched task',yesterday-1)],receive,reads=0,renders=0;
const profile={hostId:'fixture',hostKind:'local',revision:1,enabled:true,includeInSidebar:true,autoConnect:true};
const runtime={getSnapshot:()=>({phase:'ready'}),resources:{threads:{list:async()=>{reads++;return{data:structuredClone(metadata),nextCursor:null}}}}};
const registry={peekRuntime:()=>runtime,ensureConnected:async()=>runtime};
const key=sidebarThreadCatalogQueryKey('fixture',{revision:1,authorizationEpoch:null});
const inputs=[{profile,currentProfile:()=>profile,management:null,registry,queryKey:key,enabled:true}];
bindThreadCatalogNotifications({subscribeNotification(fn){receive=fn;return()=>{}}},'fixture',query);
function Demo(){if(++renders>150)throw Error('Catalog render loop');const[open,setOpen]=useState(true),[selected,setSelected]=useState('fresh');const[result]=useHostThreadCatalogQueries(inputs);
const threads=(result.data?.data??[]).map(row=>({...projectAppServerThread(row),connectionHostId:'fixture',connectionHostLabel:'Fixture',...legacyDirectServerProjectionFromHost({hostId:'fixture',hostKind:'local',label:'Fixture'})}));
window.fixture={setThemePreference,reads:()=>reads,renders:()=>renders,refresh:()=>query.invalidateQueries({queryKey:key}),start:(at=now)=>{metadata=metadata.map(r=>r.id==='old'?{...r,status:{type:'active',activeFlags:[]}}:r);receive({method:'turn/started',params:{threadId:'old',turn:{id:'synthetic-native-turn',startedAt:at}}});},complete:()=>{metadata=metadata.map(r=>r.id==='old'?{...r,status:{type:'idle'}}:r);receive({method:'turn/completed',params:{threadId:'old',turn:{id:'synthetic-native-turn',completedAt:now}}});},catchUp:()=>{metadata=metadata.map(r=>r.id==='old'?{...r,recencyAt:now+1}:r);return query.invalidateQueries({queryKey:key});},yesterday};
const navigation={layout:'unified',account:null,onOpenSettings:()=>{},actions:[{id:'shell.start',title:'Start',icon:'start',active:true,onInvoke:()=>{}}]};
return <AppShell navigation={navigation} layoutScope='Chat' mainContentLayout='default' header={<AppShellHeader title='Native catalog activity' project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} onToggleSidebar={()=>setOpen(v=>!v)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>} floatingSidebarHeader={()=>null}
leftPanel={<Sidebar threads={threads} activeHostId='fixture' activeThreadId={selected} sidebarLayout={layout} showStart={false} showFooter={false} onSelectThread={(_host,id)=>setSelected(id)} onNewTask={()=>{}} onOpenSettings={()=>{}}/>} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} sidebarOpen={open} sidebarWidth={frame.sidebarUnifiedDefaultWidth} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={()=>{}} onRightPanelOpenChange={()=>{}}><p>Actual catalog hook, notification binding, journal and Sidebar; synthetic native metadata only.</p></AppShell>}
createIntlTestRoot(document.getElementById('root')).render(<QueryClientProvider client={query}><Demo/></QueryClientProvider>);
`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},cacheDir:output+'/vite-cache',esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'sidebar-live-recency',resolveId:id=>id==='/probe.tsx'?id:null,load:id=>id==='/probe.tsx'?fixture:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/probe.tsx"></script>')})}}]});
const{chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');let browser;const results=[],errors=[];
try{await mkdir(output,{recursive:true});await vite.listen();browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
for(const{width,touch}of[{width:1280,touch:false},{width:1280,touch:true},{width:390,touch:false},{width:390,touch:true}])for(const theme of['light','dark']){
 const context=await browser.newContext({viewport:{width,height:800},deviceScaleFactor:2,isMobile:width<640,hasTouch:touch,timezoneId:width<640?'Asia/Shanghai':'UTC'}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+vite.httpServer.address().port);await page.waitForFunction(()=>Boolean(window.fixture));await page.evaluate(t=>window.fixture.setThemePreference(t),theme);
 if(!await page.locator('.sidebar-activity-item').first().isVisible())await page.locator('[data-chrome-action-id=sidebar-toggle]').first().click();await page.locator('.sidebar-activity-item').nth(2).waitFor();
 const days=()=>page.evaluate(()=>{const out=[];for(const group of document.querySelectorAll('.sidebar-activity-group__items')){let day;for(const wrapper of group.children){const heading=wrapper.querySelector('h4.sidebar-activity-group__heading');if(heading)day=heading.textContent;for(const title of wrapper.querySelectorAll('.sidebar-activity-item__title'))out.push({title:title.textContent,day});}}return out;});
 // Selecting a task normally dismisses the mobile drawer. Reopen through the
 // actual Shell control before observing its rows; do not disable that behavior.
 const reveal=async()=>{if(width<640){await page.waitForFunction(()=>!document.querySelector('.app-shell-row[data-mobile-sidebar-present=\"true\"]'));await page.locator('[data-chrome-action-id=sidebar-toggle]').first().click();await page.waitForFunction(()=>Boolean(document.querySelector('.app-shell-row[data-mobile-sidebar-present=\"true\"]')));await page.locator('.sidebar-activity-item').nth(2).waitFor();}};
 const old=page.locator('.sidebar-activity-item').filter({hasText:'Yesterday task'});await old.click();await reveal();assert.equal((await days()).find(r=>r.title==='Yesterday task')?.day,'Yesterday','Opening alone is not activity');
 await page.screenshot({path:output+'/'+width+'-'+touch+'-'+theme+'-before.png'});
 await page.evaluate(()=>window.fixture.start());await page.waitForFunction(()=>document.querySelector('.sidebar-activity-item__title')?.textContent==='Yesterday task');
 assert.deepEqual((await days()).map(r=>[r.title,r.day]),[['Yesterday task','In progress'],['Fresh task','Today'],['Untouched task','Yesterday']]);
 for(let attempt=0;attempt<3;attempt++){await page.evaluate(()=>window.fixture.refresh());assert.equal((await days()).find(r=>r.title==='Yesterday task')?.day,'In progress','Lagging native index cannot undo activity');}
 await page.evaluate(()=>window.fixture.start(window.fixture.yesterday));await page.evaluate(()=>window.fixture.complete());await page.evaluate(()=>window.fixture.refresh());assert.equal((await days()).find(r=>r.title==='Yesterday task')?.day,'Today');
 await page.locator('.sidebar-activity-item').filter({hasText:'Untouched task'}).click();await reveal();assert.equal((await days()).find(r=>r.title==='Untouched task')?.day,'Yesterday');
 await page.evaluate(()=>window.fixture.catchUp());await page.screenshot({path:output+'/'+width+'-'+touch+'-'+theme+'-after.png'});
 const counters=await page.evaluate(()=>({reads:window.fixture.reads(),renders:window.fixture.renders()}));assert.ok(counters.renders<100,'No reconciliation render loop');results.push({width,touch,theme,days:await days(),...counters});await context.close();
}
assert.deepEqual(errors,[]);console.log('Real catalog hook / native-event bridge / Sidebar recency passed');
}catch(error){for(const context of browser?.contexts()??[])for(const page of context.pages()){await page.screenshot({path:output+'/failure.png'});await writeFile(output+'/failure.json',JSON.stringify(await page.evaluate(()=>({html:document.body.innerText,root:document.querySelector('.app-shell-root')?.outerHTML.slice(0,1800),reads:window.fixture?.reads(),renders:window.fixture?.renders()})),null,2));}throw error;}finally{await browser?.close();await vite.close();await writeFile(output+'/result.json',JSON.stringify({results,errors},null,2));}
