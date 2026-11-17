import assert from "node:assert/strict";
import { createServer } from "vite";

// Real Sidebar + shared theme/Intl, no duplicate test-only rendering.
const source = `
import React,{useState}from'react';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{useHostThreadCatalogQueries}from'/apps/workbench-web/src/runtime/use-host-thread-catalog-queries';
import{bindThreadCatalogNotifications}from'/apps/workbench-web/src/runtime/thread-catalog-notifications';
import{projectAppServerThread}from'@opencraft/workbench-runtime';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{canDisplayHostThreadCatalog,canReadHostThreadCatalog}from'/apps/workbench-web/src/runtime/host-thread-catalog.ts';
import{Sidebar}from'/apps/workbench-web/src/components/sidebar.tsx';
import{UiPreferencesProvider,openWorkbenchUiPreferences}from'/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import{legacyDirectServerProjectionFromHost}from'@opencraft/workbench-runtime';
import{initializeAppearanceTheme,setThemePreference,setAppearanceThemeId}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_scope,doc)=>doc});
const preferences=await openWorkbenchUiPreferences();
const actions=[];
let failNameSave=false;
const updatePreference=preferences.update.bind(preferences);
preferences.update=(key,edit)=>{if(key==='sidebar.instanceNames'&&failNameSave){failNameSave=false;return Promise.reject(new Error('Synthetic write failure'));}return updatePreference(key,edit)};
let snapshot={revision:0,mode:null,modes:[],hideRowBadge:false,notice:null,filter:{label:'My conversations',enabled:false}};
const listeners=new Set();
const grouping={id:'filter-fixture',getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},watch:()=>()=>{},project:()=>[],setMode:()=>{},toggleGroup:()=>{},filterThreads:refs=>snapshot.filter.enabled?refs.filter(ref=>ref.hostId==='local'):refs,setFilterEnabled:enabled=>{snapshot={...snapshot,revision:snapshot.revision+1,filter:{...snapshot.filter,enabled}};listeners.forEach(fn=>fn())}};
function row(i,remote=false){const hostId=remote?'ssh:remote':'local';return{id:'thread-'+i,title:'Task '+i,project:'workspace',status:'ready',updatedAt:Date.now()-i*1000,connectionHostId:hostId,connectionHostLabel:remote?'Remote':'Local',...legacyDirectServerProjectionFromHost({hostId,hostKind:remote?'remote-ssh':'local',label:remote?'Remote':'Local'})};}
function agentRows(){
 const agents=[['codex','Codex','codex_'],['cursor','Cursor','cursor_'],['pi-cli','Pi','picli_'],['claude-code','Claude Code','claude_'],['codebuddy','CodeBuddy CLI','codebuddy_'],['codebuddy-ide','CodeBuddy IDE','codebuddy_ide_'],['dsh','DSH','dsh_']];
 const declaration={defaultEngine:'codex',providers:agents.map(([id,label,threadPrefix])=>({id,label,threadPrefix}))};
 return agents.map(([id,label,prefix],i)=>({...row(i,i===1),...projectAppServerThread({id:i===0?'thread-0':prefix+i,name:i===0?'Project review':i===1?'OpenCraft confirmation response with a very long title':'New chat',cwd:'/workspace',createdAt:1,updatedAt:100-i,modelProvider:'openai',status:i===1?{type:'active',activeFlags:[]}:i===3?{type:'active',activeFlags:['waitingOnUserInput']}:i===4?{type:'systemError'}:{type:'idle'}},100000,declaration),pinned:true,unread:i===0,goalActive:i===2}));
}
function App(){const[filterUi,setFilterUi]=useState(false);const[epoch,setEpoch]=useState(0);const[threads,setThreads]=useState([]);const[catalogs,setCatalogs]=useState([{hostId:'ssh:remote',label:'Remote',phase:'loading'}]);const[discovery,setDiscovery]=useState(null);const[remoteAvailable,setRemoteAvailable]=useState(true);
const profile={hostId:'ssh:remote',hostKind:'remote-ssh',enabled:true,includeInSidebar:true,autoConnect:false,revision:1};
const cachedRows=[{...row(0),pinned:true},{...row(1,true),pinned:true},{...row(2,true),pinned:true},{...row(3),pinned:true}];
function connection(state,authenticated=true,phase=state==='open'?'ready':'reconnecting'){const management={available:true,authenticated,items:[{serverId:'ssh:remote',enabled:true,revision:1,state}],legacyServers:[],refreshing:false,error:null};
const admitted=canReadHostThreadCatalog(profile,phase,management);
setRemoteAvailable(phase==='ready'&&admitted);
setThreads(cachedRows.filter(r=>r.connectionHostId==='local'||canDisplayHostThreadCatalog(profile,management))
 .map(r=>({...r,interactionAvailable:r.connectionHostId==='local'||(phase==='ready'&&admitted)})));
return admitted;}
window.fixture={preferences,failNextNameSave:()=>{failNameSave=true},setFilterUi,resetList:()=>setEpoch(v=>v+1),grouping,setThreads,setCatalogs,setDiscovery,row,actions,setThemePreference,setAppearanceThemeId,agentRows,connection};
const threadActions={onRename:async()=>{},onFork:async()=>{},onArchive:async()=>{},onDelete:async()=>{},onSetPinned:async(target,pinned)=>{actions.push({pin:target.threadId,pinned});setThreads(rows=>rows.map(row=>row.id===target.threadId&&row.connectionHostId===target.hostId?{...row,pinned}:row));}};
return <div className={location.search.includes('mobile-layout')?'shell-sidebar__column':undefined} data-navigation-layout={location.search.includes('mobile-layout')?'mobile':undefined} style={{height:'100vh',width:300,display:'flex',flexDirection:'column'}}><Sidebar key={epoch} threadListGrouping={filterUi?grouping:null} threads={threads} activeHostId='local' activeThreadId='thread-0' sidebarLayout={layout} threadActions={threadActions} threadCapabilities={hostId=>({pin:hostId==='ssh:remote'&&remoteAvailable,rename:false,archive:false,fork:false,delete:false})} threadCatalogs={catalogs} threadCatalogDiscovery={discovery} onRetryThreadCatalogDiscovery={()=>{actions.push('discovery-read');setDiscovery('loading');}} onRetryThreadCatalog={id=>{actions.push(id);setCatalogs([{hostId:id,label:'Remote',phase:'loading'}]);}} onSelectThread={(hostId,id)=>actions.push({hostId,id})} onNewTask={()=>{}} onNewTaskInFolder={target=>actions.push({folder:target})} onOpenSettings={()=>{}} /></div>;}
const liveQuery=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
const liveProfile={hostId:'live',hostKind:'local',enabled:true,includeInSidebar:true,autoConnect:true,revision:1};
let liveRows=Array.from({length:150},(_,i)=>({id:'old-'+i,name:'Old '+i,cwd:'/workspace',createdAt:1,updatedAt:300-i,preview:'',ephemeral:false,source:'cli',status:{type:'idle'},turns:[]}));
let liveReceive,liveRelease,liveHold=false,liveWaiting=false,liveReads=0,liveSequence=0;
const liveKey=['appserver','live','threads','sidebar-pages','updated_at','desc',false,1,null,0];
bindThreadCatalogNotifications({subscribeNotification(fn){liveReceive=fn;return()=>{}}},'live',liveQuery);
const liveRuntime={getSnapshot:()=>({phase:'ready'}),resources:{threads:{async list({cursor,limit}){
 liveReads++;const offset=Number(cursor??0),data=liveRows.slice(offset,offset+limit),nextCursor=offset+limit<liveRows.length?String(offset+limit):null;
 if(liveHold&&offset===50){liveWaiting=true;await new Promise(resolve=>{liveRelease=resolve});liveWaiting=false;}
 return{data,nextCursor};
}}}};
const liveRegistry={peekRuntime:()=>liveRuntime,ensureConnected:async()=>liveRuntime};
function LiveApp(){const[q]=useHostThreadCatalogQueries([{profile:liveProfile,currentProfile:()=>liveProfile,management:null,registry:liveRegistry,enabled:true,queryKey:liveKey}]);
window.fixture={get waiting(){return liveWaiting},get reads(){return liveReads},get ready(){return !q.isFetching&&!q.hasNextPage},setThemePreference,
 refetch(){liveHold=true;void liveQuery.invalidateQueries({queryKey:liveKey})},release(){liveHold=false;liveRelease?.()},
 create(){const thread={...liveRows[0],id:'live-new',name:'New live conversation',updatedAt:1000,turns:[]};liveRows=[thread,...liveRows];liveReceive({method:'opencraft/thread-catalog/changed',params:{version:1,source:'synthetic-server',revision:++liveSequence,change:{type:'upsert',thread}}})},
 remove(){liveRows=liveRows.filter(row=>row.id!=='live-new');liveReceive({method:'opencraft/thread-catalog/changed',params:{version:1,source:'synthetic-server',revision:++liveSequence,change:{type:'remove',threadId:'live-new'}}})}};
const threads=(q.data?.data??[]).map(thread=>({...projectAppServerThread(thread),connectionHostId:'live',connectionHostLabel:'Live',...legacyDirectServerProjectionFromHost({hostId:'live',hostKind:'local',label:'Live'})}));
return <><textarea id='live-draft' aria-label='Draft' style={{position:'fixed',left:330,top:10}} defaultValue='keep draft'/><div style={{height:'100vh',width:300,display:'flex',flexDirection:'column'}}><Sidebar threads={threads} activeHostId='live' activeThreadId='old-0' sidebarLayout={layout} threadCatalogs={[{hostId:'live',label:'Live',phase:q.isFetching?'loading':'ready'}]} onSelectThread={()=>{}} onNewTask={()=>{}} onOpenSettings={()=>{}} /></div></>;}
createIntlTestRoot(document.getElementById('root')).render(<UiPreferencesProvider runtime={preferences}>{location.search.includes('live-catalog')?<QueryClientProvider client={liveQuery}><LiveApp/></QueryClientProvider>:<App/>}</UiPreferencesProvider>);`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-sidebar-catalog", esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "sidebar-catalog-fixture",
    resolveId: id => id === "/catalog-probe.tsx" ? id : null,
    load: id => id === "/catalog-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/catalog-probe.tsx"></script>');
    }); },
  }],
});
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
let browser: any;
const evidence: unknown[] = [];
// Focus this interaction contract independently of the catalog/error/pagination suite.
async function verifyGroupDisclosures(page: any, touch: boolean, mobileLayout = touch) {
  assert.equal(await page.locator('.sidebar-thread-group-count').count(), 0, 'group headings omit thread counts');
  for (const name of ['Pinned', 'Recent']) {
    const section = page.getByRole('region', { name, exact: true });
    const toggle = section.getByRole('button', { name, exact: true });
    const arrow = toggle.locator('> svg');
    await toggle.waitFor();
    const geometry = () => toggle.evaluate((button: HTMLElement) => {
      const label = button.querySelector('.sidebar-thread-group-label')!.getBoundingClientRect();
      const glyph = button.querySelector(':scope > svg')!.getBoundingClientRect();
      return { labelEnd: label.right, arrowStart: glyph.left, buttonHeight: button.getBoundingClientRect().height };
    });
    const resting = await geometry();
    assert.ok(resting.arrowStart - resting.labelEnd >= 4 && resting.arrowStart - resting.labelEnd <= 10, 'disclosure stays beside label');
    const waitArrow = async (opacity: string) => page.waitForFunction(
      ({ arrow, opacity }: any) => getComputedStyle(arrow).opacity === opacity,
      { arrow: await arrow.elementHandle(), opacity }, { timeout: 3000 });
    if (mobileLayout) {
      await waitArrow('1');
      assert.ok(resting.buttonHeight >= 44, 'touch disclosure has a full row hit target');
      if (touch) await toggle.tap(); else await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await waitArrow('1');
      if (touch) await toggle.tap(); else await toggle.click();
    } else {
      await page.mouse.move(700, 800);
      await page.locator('.sidebar-list-mode-trigger').focus();
      await waitArrow('0');
      await toggle.hover();
      await waitArrow('1');
      assert.deepEqual(await geometry(), resting, 'revealing arrow does not shift label or row');
      await page.mouse.move(700, 800);
      await waitArrow('0');
      await page.keyboard.press('Tab');
      await toggle.focus();
      await waitArrow('1');
      await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await page.keyboard.press('Space');
    }
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'same disclosure restores expanded content');
    assert.equal(await section.locator('.sidebar-activity-group__items').isVisible(), true);
  }
}
try {
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0]!;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  if (process.env.OPENCRAFT_SIDEBAR_RECENT_ONLY === '1') {
    const output=process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR ?? '/tmp/opencraft-sidebar-recent';
    await (await import('node:fs/promises')).mkdir(output,{recursive:true});
    for(const touch of [false,true])for(const theme of ['light','dark','lavender']){
      const context=await browser.newContext({viewport:{width:touch?390:900,height:1000},hasTouch:touch,isMobile:touch,reducedMotion:theme==='lavender'?'reduce':'no-preference'});
      const page=await context.newPage(),errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
      await page.addInitScript('globalThis.__name = fn => fn');
      await page.goto(origin);await page.waitForFunction(()=>Boolean((window as any).fixture));
      await page.evaluate(async theme=>{
        const f=(window as any).fixture,now=Math.floor(Date.now()/1000);
        f.setThemePreference(theme==='dark'?'dark':'light');if(theme==='lavender')f.setAppearanceThemeId('opencraft.core.lavender');
        await f.preferences.set('sidebar.instanceNames',{'["local","local"]':'My Mac'});
        const make=(i,remote=false)=>({...f.row(i,remote),updatedAt:now-i,cwd:remote?'/remote/app':'/local/app',directoryGroup:{id:remote?'/remote/app':'/local/app',name:'app'},instanceGroup:{id:remote?'remote':'local',name:remote?'Remote server':'Original Mac'},agent:remote?{id:'cursor',label:'Cursor'}:{id:'codex',label:'Codex'}});
        (window as any).recentRows=[
          {...make(0),title:'Local newest'}, {...make(0,true),title:'Remote newest',updatedAt:now-1},
          {...make(2),title:'Private',accessMode:'private'}, {...make(3),title:'Pinned',pinned:true},
          {...make(4),title:'Review',status:'review'}, {...make(5),title:'Child',parentThreadId:'thread-0'},
          ...Array.from({length:9},(_,i)=>({...make(i+7),title:'Older '+(i+7)})),
          {...make(6),title:'Old running',status:'running',updatedAt:now-30},
          {...make(16),title:'Hidden',visibility:'hidden',updatedAt:now+1},
        ];
        f.setCatalogs([]);f.setThreads((window as any).recentRows);
      },theme);
      const recent=page.getByRole('region',{name:'Recent',exact:true});
      await recent.waitFor();
      const titles=recent.locator('.sidebar-activity-item__title');
      await page.waitForFunction(()=>document.querySelectorAll('[data-row-scope="recent"] .sidebar-activity-item').length===10);
      assert.deepEqual((await titles.allTextContents()).slice(0,6),['Local newest','Remote newest','Private','Pinned','Review','Child']);
      assert.equal(await recent.locator('.sidebar-thread-tree__children').count(),0,'child conversations are represented exactly once in the flat timeline');
      assert.equal(await recent.getByText('Hidden',{exact:true}).count(),0);
      await recent.getByRole('button',{name:'Show more',exact:true}).click();
      await page.waitForFunction(()=>document.querySelectorAll('[data-row-scope="recent"] .sidebar-activity-item').length===16);
      const source=recent.locator('.sidebar-activity-item__context').first();
      assert.equal(await source.locator('[data-source="device"]').textContent(),'My Mac');
      assert.equal(await source.locator('[data-source="folder"]').textContent(),'app');
      assert.equal(await source.locator('[data-source="agent"]').textContent(),'Codex');
      assert.equal(await page.evaluate(()=>{const mine=document.querySelector('[aria-label="Mine"]'),r=document.querySelector('[aria-label="Recent"]'),devices=document.querySelector('.sidebar-native-projects');return Boolean(mine&&r&&devices&&(mine.compareDocumentPosition(r)&Node.DOCUMENT_POSITION_FOLLOWING)&&(r.compareDocumentPosition(devices)&Node.DOCUMENT_POSITION_FOLLOWING));}),true);
      const remote=recent.locator('[data-host-id="ssh:remote"][data-thread-id="thread-0"]');
      if(touch)await remote.locator('.sidebar-activity-item').tap();else await remote.locator('.sidebar-activity-item').click();
      assert.deepEqual(await page.evaluate(()=>(window as any).fixture.actions.at(-1)),{hostId:'ssh:remote',id:'thread-0'});
      const menu=remote.locator('.sidebar-activity-item__menu-trigger');
      if(touch)await menu.tap();else{await menu.focus();await page.keyboard.press('Enter');}
      await page.getByRole('menu').waitFor();assert.equal(await page.getByRole('menu').count(),1,'duplicated conversation opens one menu');
      await page.keyboard.press('Escape');
      const dir=page.locator('.sidebar-native-projects [data-host-id="ssh:remote"][data-thread-id="thread-0"]');
      const dirMenu=dir.locator('.sidebar-activity-item__menu-trigger');
      if(touch)await dirMenu.tap();else{await dirMenu.focus();await page.keyboard.press('Enter');}
      await page.getByRole('menu').waitFor();assert.equal(await page.getByRole('menu').count(),1);await page.keyboard.press('Escape');
      const toggle=recent.getByRole('button',{name:'Recent',exact:true});
      if(touch)await toggle.tap();else await toggle.click();
      assert.equal(await recent.locator('.sidebar-activity-group__items').isVisible(),false);
      assert.equal(await dir.isVisible(),true,'Recent disclosure does not collapse the device tree');
      if(touch)await toggle.tap();else await toggle.click();
      assert.equal((await titles.allTextContents()).at(-1),'Old running','running status never overrides update time');
      const original=await remote.elementHandle();
      await page.evaluate(()=>{const f=(window as any).fixture,rows=(window as any).recentRows;rows[1]={...rows[1],updatedAt:rows[0].updatedAt+10};f.setThreads([...rows]);});
      await page.waitForFunction(()=>document.querySelector('[data-row-scope="recent"] .sidebar-activity-item__title')?.textContent==='Remote newest');
      assert.equal(await remote.evaluate((el,original)=>el===original,original),true,'activity updates reorder without replacing the row');
      await page.evaluate(()=>{const f=(window as any).fixture;f.setThreads((window as any).recentRows.map(r=>r.connectionHostId==='ssh:remote'?{...r,interactionAvailable:false}:r));f.setCatalogs([{hostId:'ssh:remote',label:'Remote server',phase:'error',cachedAt:Date.now()}]);});
      await page.waitForFunction(()=>document.querySelector('[data-row-scope="recent"][data-host-id="ssh:remote"] .sidebar-activity-item')?.hasAttribute('disabled'));
      assert.equal(await remote.locator('.sidebar-activity-item__context').isVisible(),true,'offline saved sources retain their annotations');
      await page.evaluate(()=>{const f=(window as any).fixture;f.setCatalogs([]);f.setThreads((window as any).recentRows);f.setFilterUi(true);f.grouping.setFilterEnabled(true);});
      await page.waitForFunction(()=>!document.querySelector('[data-row-scope="recent"][data-host-id="ssh:remote"]'));
      const search=page.getByRole('searchbox',{name:'Search conversations'});await search.fill('Child');
      await page.waitForFunction(()=>document.querySelectorAll('[data-row-scope="recent"]').length===1);
      assert.equal(await titles.first().textContent(),'Child');
      await search.fill('');await page.evaluate(()=>{const f=(window as any).fixture;f.grouping.setFilterEnabled(false);});
      assert.equal(await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(el=>el.id);return ids.length===new Set(ids).size;}),true,'all repeated conversation occurrences have unique DOM ids');
      await page.evaluate(()=>{const f=(window as any).fixture;f.setThreads((window as any).recentRows.map(r=>r.connectionHostId==='ssh:remote'?{...r,instanceGroup:{...r.instanceGroup,name:'remote-build-machine-01'},directoryGroup:{...r.directoryGroup,name:'sample_workspace_operations'}}:r));});
      await page.waitForFunction(()=>document.querySelector('[data-row-scope="recent"][data-host-id="ssh:remote"] [data-source="device"]')?.textContent==='remote-build-machine-01');
      const longSources=remote.locator('.sidebar-activity-item__context');
      assert.equal(await longSources.locator('[data-source="device"]').getAttribute('title'),'Device: remote-build-machine-01');
      const sizes=await longSources.evaluate(el=>{const device=el.querySelector('[data-source="device"]')!.getBoundingClientRect(),folder=el.querySelector('[data-source="folder"]')!.getBoundingClientRect(),agent=el.querySelector('[data-source="agent"]')!.getBoundingClientRect();return{device:device.width,folder:folder.width,agent:agent.width,bounds:el.getBoundingClientRect().width,contained:agent.right<=el.getBoundingClientRect().right+1};});
      assert(sizes.device>sizes.folder&&sizes.agent>0&&sizes.contained,'device and Agent retain priority over a long folder label');
      await recent.getByRole('button',{name:'Show less',exact:true}).click();
      await toggle.scrollIntoViewIfNeeded();
      await page.screenshot({path:output+'/'+(touch?'touch':'desktop')+'-'+theme+'.png',animations:'disabled'});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
      evidence.push({touch,theme,chronology:true,allSources:true,sourceLabels:true,duplicateMenuIsolation:true,pagination:true,offline:true,filter:true,rowIdentity:true});await context.close();
    }
  } else if (process.env.OPENCRAFT_SIDEBAR_FOLDERS_ONLY === '1') {
    const output=process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR ?? '/tmp/opencraft-sidebar-folder-actions';
    await (await import('node:fs/promises')).mkdir(output,{recursive:true});
    for(const touch of [false,true])for(const theme of ['light','dark','lavender']){
      const context=await browser.newContext({viewport:{width:touch?390:900,height:900},hasTouch:touch,isMobile:touch});
      const page=await context.newPage(),errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
      await page.goto(origin);await page.waitForFunction(()=>Boolean((window as any).fixture));
      await page.evaluate(theme=>{const f=(window as any).fixture;f.setThemePreference(theme==='dark'?'dark':'light');if(theme==='lavender')f.setAppearanceThemeId('opencraft.core.lavender');f.setCatalogs([]);f.setThreads([
        {...f.row(0),cwd:'/local/app',directoryGroup:{id:'/local/app',name:'app'},instanceGroup:{id:'local',name:'Local Mac'}},
        {...f.row(1,true),cwd:'/remote/app',directoryGroup:{id:'/remote/app',name:'app'},instanceGroup:{id:'remote',name:'Remote server'}},
        {...f.row(2,true),cwd:'/remote/unavailable',interactionAvailable:false,directoryGroup:{id:'/remote/unavailable',name:'offline'},instanceGroup:{id:'remote',name:'Remote server'}},
        {...f.row(3),nativeProject:{source:'codex',id:'opaque-native-project',name:'Native project',position:0},cwd:'/local/native',instanceGroup:{id:'local',name:'Local Mac'}},
      ]);},theme);
      const local=page.locator('[data-instance-id="local"]'),remote=page.locator('[data-instance-id="remote"]');
      const folder=remote.locator('[data-native-project]').filter({has:page.getByRole('button',{name:'app',exact:true})});
      const toggle=folder.locator('.sidebar-folder-toggle'),plus=folder.getByRole('button',{name:'New chat in app',exact:true});
      await plus.waitFor();await plus.scrollIntoViewIfNeeded();
      const labelBounds=await toggle.locator('.sidebar-thread-group-label').evaluate(el=>{const r=el.getBoundingClientRect(),p=el.closest('.sidebar-folder-heading')!.getBoundingClientRect();return{x:r.x-p.x,y:r.y-p.y,width:r.width,height:r.height};});
      if(!touch){
        await page.mouse.move(800,800);assert.equal(await plus.evaluate(el=>getComputedStyle(el).opacity),'0');
        await toggle.hover();await page.waitForFunction(()=>[...document.querySelectorAll('.sidebar-folder-heading:hover .sidebar-folder-new-chat')].some(el=>getComputedStyle(el).opacity==='1'));assert.equal(await plus.evaluate(el=>getComputedStyle(el).opacity),'1');
        assert.deepEqual(await toggle.locator('.sidebar-thread-group-label').evaluate(el=>{const r=el.getBoundingClientRect(),p=el.closest('.sidebar-folder-heading')!.getBoundingClientRect();return{x:r.x-p.x,y:r.y-p.y,width:r.width,height:r.height};}),labelBounds,'revealing does not move the folder name');
      }else assert.equal(await plus.evaluate(el=>getComputedStyle(el).opacity),'1','touch does not depend on hover');
      if(touch)await plus.tap();else await plus.click();
      assert.deepEqual(await page.evaluate(()=>(window as any).fixture.actions.at(-1)),{folder:{hostId:'ssh:remote',cwd:'/remote/app'}});
      assert.equal(await toggle.getAttribute('aria-expanded'),'true','plus must not collapse folder');
      if(touch)await toggle.tap();else await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'),'false');
      if(touch)await plus.tap();else{await plus.focus();await page.keyboard.press('Enter');}
      assert.equal(await toggle.getAttribute('aria-expanded'),'false','new chat also leaves a collapsed folder unchanged');
      const native=local.getByRole('button',{name:'New chat in Native project',exact:true});
      if(touch)await native.tap();else{await native.focus();await page.keyboard.press('Enter');}
      assert.deepEqual(await page.evaluate(()=>(window as any).fixture.actions.at(-1)),{folder:{hostId:'local',cwd:'/local/native'}},'native display project id must not become execution project/cwd');
      const offline=remote.getByRole('button',{name:'New chat in offline',exact:true});assert(await offline.isDisabled());
      if(!touch){await page.mouse.move(800,800);await toggle.focus();await page.keyboard.press('Tab');assert(await plus.evaluate(el=>el===document.activeElement),'Tab reaches the folder action');await page.waitForFunction(()=>document.activeElement && getComputedStyle(document.activeElement).opacity==='1');assert.equal(await plus.evaluate(el=>getComputedStyle(el).opacity),'1');}
      const headerBounds=await folder.locator('.sidebar-folder-heading').boundingBox(),buttonBounds=await plus.boundingBox();
      assert(buttonBounds!.x + buttonBounds!.width <= headerBounds!.x + headerBounds!.width+1);
      if(touch)assert(buttonBounds!.height>=44&&buttonBounds!.width>=44);
      else {
        const ring=await plus.evaluate(el=>{const style=getComputedStyle(el);return Math.max(0,parseFloat(style.outlineWidth)||0)+Math.max(0,parseFloat(style.outlineOffset)||0);});
        assert(buttonBounds!.x+buttonBounds!.width+ring<=headerBounds!.x+headerBounds!.width,'keyboard focus stays inside the folder row');
      }
      await page.screenshot({path:output+'/'+(touch?'touch':'desktop')+'-'+theme+'.png',animations:'disabled'});
      assert.deepEqual(errors,[]);evidence.push({touch,theme,folderAction:true,hostAndCwdScoped:true,disclosureUnchanged:true,offlineDisabled:true});console.log('PASS folder action',touch?'touch':'desktop',theme);await context.close();
    }
  } else if (process.env.OPENCRAFT_SIDEBAR_AGENTS_ONLY === '1') {
    const output=process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR ?? '/tmp/opencraft-sidebar-agent-icons';
    await (await import('node:fs/promises')).mkdir(output,{recursive:true});
    for(const touch of [false,true])for(const theme of ['light','dark','lavender']){
      const context=await browser.newContext({viewport:{width:touch?390:900,height:900},hasTouch:touch,isMobile:touch,reducedMotion:'reduce'});
      const page=await context.newPage(),errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
      await page.goto(origin);await page.waitForFunction(()=>Boolean((window as any).fixture));
      await page.evaluate(theme=>{const f=(window as any).fixture;f.setThemePreference(theme==='dark'?'dark':'light');if(theme==='lavender')f.setAppearanceThemeId('opencraft.core.lavender');f.setThreads(f.agentRows());f.setCatalogs([]);},theme);
      for(let i=0;i<10&&await page.locator('.sidebar-activity-item__agent').count()<7;i++){const more=page.locator('.sidebar-activity-more:visible').first();if(!await more.count())break;await more.click();}
      for(const id of ['codex','cursor','pi-cli','claude-code','codebuddy','codebuddy-ide','dsh']){
        const icon=page.locator('.sidebar-activity-item__agent[data-agent="'+id+'"]').first();await icon.waitFor();
        const measurements=await icon.evaluate(el=>{const button=el.closest('button')!,title=button.querySelector('.sidebar-activity-item__title')!,status=button.querySelector('.sidebar-activity-item__trailing')!;
          const r=el.getBoundingClientRect(),t=title.getBoundingClientRect(),s=status.getBoundingClientRect();return{width:r.width,height:r.height,beforeStatus:r.right<=s.left,afterTitle:r.left>=t.right,navHit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===button};});
        assert.equal(measurements.width,14);assert.equal(measurements.height,14);assert.ok(measurements.beforeStatus);assert.ok(measurements.afterTitle);assert.ok(measurements.navHit);
      }
      const cursor=page.locator('.sidebar-activity-row').filter({has:page.locator('.sidebar-activity-item__agent[data-agent="cursor"]')}).first();
      const icon=cursor.locator('.sidebar-activity-item__agent'),before=await icon.boundingBox();
      if(touch)await icon.tap();else await icon.click();
      assert.ok(await page.evaluate(()=>(window as any).fixture.actions.some(action=>action?.hostId==='ssh:remote'&&action?.id==='cursor_1')));
      const menu=cursor.locator('.sidebar-activity-item__menu-trigger');
      if(touch)await menu.tap();else{await menu.focus();await page.keyboard.press('Enter');}
      await page.getByRole('menu').waitFor();assert.deepEqual(await icon.boundingBox(),before,'Agent glyph is stable while actions open');
      await page.keyboard.press('Escape');
      if(!touch){await menu.hover();assert.deepEqual(await icon.boundingBox(),before,'hover does not move or replace the Agent glyph');}
      await page.screenshot({path:output+'/'+(touch?'touch':'desktop')+'-'+theme+'.png',animations:'disabled'});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
      evidence.push({touch,theme,declaredAgents:7,sharedGlyphSize:14,independentActivityAndMenu:true,navigationAndMenuInput:true});await context.close();
    }
  } else {
  const scenarios = [{ touch: false, mobileLayout: false }, { touch: true, mobileLayout: true }];
  if (process.env.OPENCRAFT_SIDEBAR_GROUPS_ONLY === '1') scenarios.push({ touch: false, mobileLayout: true });
  if (process.env.OPENCRAFT_SMOKE_CATALOG_LIVE_ONLY) {
    for (const touch of [false, true]) for (const theme of ['light', 'dark']) {
      const context=await browser.newContext({viewport:{width:1000,height:800},hasTouch:touch,isMobile:touch,reducedMotion:'reduce'});
      const page=await context.newPage();const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));
      await page.goto(`${origin}?live-catalog`);
      await page.waitForFunction(()=> (window as any).fixture?.ready);
      await page.evaluate(theme=>(window as any).fixture.setThemePreference(theme),theme);
      const draft=page.locator('#live-draft');await draft.fill('unsent local text');await draft.focus();
      await page.evaluate(()=>{(window as any).originalDraft=document.querySelector('#live-draft');(window as any).fixture.refetch()});
      await page.waitForFunction(()=>(window as any).fixture.waiting);
      await page.evaluate(()=>(window as any).fixture.create());
      const created=page.locator('.sidebar-activity-item__title').filter({hasText:'New live conversation'});
      await created.waitFor({state:'visible'});
      assert.equal(await page.evaluate(()=>(window as any).fixture.waiting),true,'new row paints while an old second page remains blocked');
      assert.equal(await draft.inputValue(),'unsent local text');
      assert.equal(await page.evaluate(()=>document.activeElement===(window as any).originalDraft),true);
      if(process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR)await page.screenshot({path:`${process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR}/live-catalog-${touch ? "touch" : "desktop"}-${theme}.png`});
      await page.evaluate(()=>(window as any).fixture.release());
      await page.waitForFunction(()=>(window as any).fixture.ready);
      await created.waitFor({state:'visible'});
      await page.evaluate(()=>(window as any).fixture.remove());
      await created.waitFor({state:'detached'});
      assert.equal(await page.evaluate(()=>document.querySelector('#live-draft')===(window as any).originalDraft),true);
      assert.deepEqual(errors,[]);evidence.push({theme,touch,liveQueryAndSidebar:true,threePages:true,immediateWhileBlocked:true,lateReadPreservesCreation:true,removal:true,draftAndFocus:true});
      await context.close();
    }
  }
  for (const { touch, mobileLayout } of process.env.OPENCRAFT_SMOKE_CATALOG_LIVE_ONLY ? [] : scenarios) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : mobileLayout ? 600 : 900, height: 844 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(origin + (mobileLayout && process.env.OPENCRAFT_SIDEBAR_GROUPS_ONLY === '1' ? '?mobile-layout' : ''), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean((window as any).fixture && document.querySelector('.sidebar-tasks')), null, { timeout: 60000 });
    await page.locator('.sidebar-tasks[aria-busy="true"]').waitFor({ state: "attached" });
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    if (process.env.OPENCRAFT_SIDEBAR_GROUPS_ONLY === '1') {
      await page.evaluate(() => {
        const f = (window as any).fixture;
        f.setThreads([{ ...f.row(0), pinned: true }, f.row(1)]);
        f.setCatalogs([]);
      });
      await verifyGroupDisclosures(page, touch, mobileLayout);
      assert.deepEqual(errors, []);
      if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR}/groups-${touch ? 'touch' : mobileLayout ? 'mobile-mouse' : 'desktop'}-${theme}.png` });
      evidence.push({ touch, mobileLayout, theme, groupDisclosures: true, hiddenDesktop: !mobileLayout, alwaysVisibleMobile: mobileLayout, stableGeometry: true, reversibleCollapse: true });
      await context.close();
      continue;
    }
    // Radix restores focus after closing: open, restored and keyboard focus
    // must retain the filled treatment rather than the old standalone ring.
    const filterTrigger = page.locator(".sidebar-list-mode-trigger");
    const assertFilledFocus = async () => {
      const state = await filterTrigger.evaluate(el => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--color-background-button-primary)";
        document.body.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, expected, outline: style.outlineStyle, foreground: style.color };
      });
      assert.equal(state.background, state.expected, "open/focused filter uses shared primary fill, including hover");
      assert.equal(state.outline, "none", "filter has no standalone outline");
      assert.notEqual(state.foreground, state.background, "filter glyph contrasts with fill");
    };
    if (touch) await filterTrigger.tap(); else await filterTrigger.click();
    await page.getByRole("menu").waitFor();
    await assertFilledFocus();
    await page.getByRole("menuitemradio").first().click();
    await page.getByRole("menu").waitFor({ state: "hidden" });
    assert.equal(await filterTrigger.evaluate(el => getComputedStyle(el).outlineStyle), "none", "pointer selection restores focus without a ring");
    await page.keyboard.press("Tab");
    await filterTrigger.focus();
    await assertFilledFocus();
    await page.keyboard.press("Enter");
    await page.getByRole("menu").waitFor();
    await page.keyboard.press("Escape");
    await assertFilledFocus();
    await page.mouse.click(350, 10);
    assert.equal(await page.locator(".sidebar-activity-empty").count(), 0, "pending is not empty");
    assert.equal(await page.locator(".sidebar-catalog-feedback").count(), 0, "loading has no feedback row or spacer");
    assert.equal(await page.locator(".sidebar-tasks .workbench-loading-spinner").count(), 0, "catalog loading has no visible spinner");
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.setThreads([f.row(0)]);
      f.setCatalogs([{ hostId: "ssh:remote", label: "Remote Server with a deliberately long directory label", phase: "error" }]);
    });
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await retry.waitFor();
    const retryBounds = await retry.boundingBox();
    const sidebarBounds = await page.locator('.sidebar-panel').boundingBox();
    assert.ok(retryBounds && sidebarBounds && retryBounds.x >= sidebarBounds.x
      && retryBounds.x + retryBounds.width <= sidebarBounds.x + sidebarBounds.width + 1,
      'Retry is fully inside the Sidebar before interaction or automatic scrolling');
    assert.equal(await page.locator(".sidebar-activity-item").count(), 1, "one failed server retains healthy rows");
    // Scheme C: directory is auxiliary text below the title, never a chip or title column.
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.setThreads([
        { ...f.row(0), title: 'A deliberately long conversation title that needs its full body width', project: 'a-very-long-working-directory-that-must-not-push-the-title', status: 'running' },
        { ...f.row(1), project: 'workspace', status: 'review' },
        { ...f.row(2), project: 'runtime', status: 'error' },
      ]);
    });
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-activity-item__project').length === 3);
    const geometry = await page.locator('.sidebar-activity-item').evaluateAll(items => items.map(item => {
      const title = item.querySelector<HTMLElement>('.sidebar-activity-item__title')!;
      const project = item.querySelector<HTMLElement>('.sidebar-activity-item__project')!;
      const body = item.querySelector<HTMLElement>('.sidebar-activity-item__body')!;
      const style = getComputedStyle(project);
      return { title: title.textContent, titleBottom: title.getBoundingClientRect().bottom, projectTop: project.getBoundingClientRect().top,
        projectRight: project.getBoundingClientRect().right, bodyRight: body.getBoundingClientRect().right,
        background: style.backgroundColor, directoryColor: style.color,
        titleColor: getComputedStyle(title).color, truncated: project.scrollWidth > project.clientWidth,
        height: item.getBoundingClientRect().height };
    }));
    assert.ok(geometry.every(row => row.projectTop >= row.titleBottom), 'directory occupies the second line');
    assert.ok(geometry.every(row => row.background === 'rgba(0, 0, 0, 0)'), 'directory has no chip surface, including selected row');
    assert.ok(geometry.every(row => row.directoryColor !== row.titleColor), 'directory uses auxiliary text color');
    assert.ok(geometry.every(row => row.projectRight <= row.bodyRight + 1), 'directory stays within title body');
    assert.ok(geometry.find(row => row.title === 'A deliberately long conversation title that needs its full body width')!.truncated, 'long directory truncates without consuming title width');
    assert.ok(geometry.every(row => row.height >= 48), 'two-line rows preserve readable height');
    assert.equal(await page.locator('.sidebar-activity-item__state-label').filter({ hasText: 'Running' }).count(), 0, 'no redundant running text');
    if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR}/project-secondary-${touch ? 'touch' : 'desktop'}-${theme}.png` });
    await page.evaluate(() => { const f = (window as any).fixture; f.setThreads([f.row(0)]); });
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-activity-item').length === 1);
    await page.evaluate(() => { (window as any).healthyRow = document.querySelector(".sidebar-activity-item"); });
    if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR}/catalog-error-${touch ? "touch" : "desktop"}-${theme}.png` });
    if (touch) await retry.tap(); else await retry.click();
    await page.locator('.sidebar-tasks[aria-busy="true"]').waitFor({ state: "attached" });
    assert.equal(await page.locator(".sidebar-catalog-feedback").count(), 0, "retry removes the error without adding loading chrome");
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions), ["ssh:remote"], "retry is host-scoped and does not select a Thread");
    assert.equal(await page.locator(".sidebar-activity-item").count(), 1);
    assert.equal(await page.evaluate(() => (window as any).healthyRow === document.querySelector(".sidebar-activity-item")), true, "retry must not remount a healthy row");
    await page.evaluate(() => { const f = (window as any).fixture; f.setCatalogs([]); f.setDiscovery('error'); });
    await page.getByText("Couldn't load remote connections", { exact: true }).waitFor();
    assert.equal(await page.locator('.sidebar-activity-item').count(), 1, "discovery failure retains healthy local history");
    if (touch) await retry.tap(); else await retry.click();
    await page.locator('.sidebar-tasks[aria-busy="true"]').waitFor({ state: "attached" });
    assert.equal(await page.locator('.sidebar-catalog-feedback').count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions), ["ssh:remote", "discovery-read"]);
    assert.equal(await page.evaluate(() => (window as any).healthyRow === document.querySelector('.sidebar-activity-item')), true);
    const loadingTop = (await page.locator('.sidebar-activity-item').boundingBox())!.y;
    await page.evaluate(() => (window as any).fixture.setDiscovery(null));
    await page.locator('.sidebar-tasks[aria-busy="false"]').waitFor({ state: "attached" });
    assert.equal((await page.locator('.sidebar-activity-item').boundingBox())!.y, loadingTop, "loading completion must not move healthy history");
    assert.equal(await page.evaluate(() => (window as any).healthyRow === document.querySelector('.sidebar-activity-item')), true);
    await page.evaluate(()=>{const f=(window as any).fixture;f.setCatalogs([]);f.setFilterUi(true);f.grouping.setFilterEnabled(true);f.setThreads([...Array.from({length:8},(_,i)=>f.row(i)),...Array.from({length:39},(_,i)=>f.row(100+i,true))]);});
    await page.waitForFunction(()=>document.querySelectorAll('.sidebar-activity-item').length===8);
    assert.equal(await page.locator('.sidebar-activity-more').count(),0,'filtered-out conversations do not create bottom prompts');
    await page.evaluate(()=>{const f=(window as any).fixture;f.setThreads([...Array.from({length:12},(_,i)=>f.row(i)),...Array.from({length:39},(_,i)=>f.row(100+i,true))]);});
    const filteredMore=page.getByRole('button',{name:'Load more',exact:true});await filteredMore.waitFor();
    assert.equal(await page.locator('.sidebar-activity-more').count(),1,'only the matching recent display budget creates Load more');
    await filteredMore.click();
    await page.waitForFunction(()=>document.querySelectorAll('.sidebar-activity-item').length===12);
    assert.equal(await page.locator('.sidebar-activity-more').count(),0,'no redundant collapse/show-all footer after loading');
    assert.equal(await page.locator('.sidebar-list-chips').count(),0,'participation and server chips are consolidated');
    await page.getByRole('button',{name:'Filters',exact:true}).click();
    assert.equal(await page.getByRole('menuitemradio',{name:'All servers',exact:true}).getAttribute('aria-checked'),'true');
    if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) await page.getByRole('menu').screenshot({path:process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR+'/filters-'+(touch?'touch':'desktop')+'-'+theme+'.png'});
    assert.equal(await page.getByRole('menuitemcheckbox',{name:'Only my conversations',exact:true}).getAttribute('aria-checked'),'true','loading never disables the personal filter');
    await page.getByRole('menuitemcheckbox',{name:'Only my conversations',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.sidebar-activity-item').length===51);
    assert.equal(await page.locator('.sidebar-activity-more').count(),0);
    await page.evaluate(()=>{(window as any).fixture.setFilterUi(false);(window as any).fixture.resetList();});
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.setDiscovery(null);
      f.setThreads(Array.from({ length: 13 }, (_, i) => f.row(i, i >= 10)));
      f.setCatalogs([{ hostId: "ssh:remote", label: "Remote", phase: "ready" }]);
    });
    const more = page.getByRole("button", { name: "Load more", exact: true });
    await more.waitFor();
    assert.equal(await page.locator(".sidebar-activity-item").count(), 10);
    if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR}/catalog-more-${touch ? "touch" : "desktop"}-${theme}.png` });
    if (touch) await more.tap(); else await more.click();
    await more.waitFor({state:"detached"});
    assert.equal(await page.locator(".sidebar-activity-item").count(), 13);
    assert.equal(await page.locator(".sidebar-catalog-feedback").count(), 0);
    await page.evaluate(()=>{(window as any).fixture.setFilterUi(false);(window as any).fixture.resetList();});
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.setThreads([...Array.from({ length: 13 }, (_, i) => f.row(i, i >= 10)), { ...f.row(100, true), pinned: true }]);
    });
    const pinnedSection = page.getByRole("region", { name: "Pinned", exact: true });
    await pinnedSection.waitFor();
    assert.equal(await pinnedSection.locator(".sidebar-activity-item").count(), 1);
    await verifyGroupDisclosures(page, touch);

    assert.equal(await page.locator(".sidebar-activity-item").count(), 11, "pins do not consume ten recent slots");
    assert.equal(await page.getByRole("button", { name: "Actions for Task 0", exact: true }).count(), 0, "unsupported host hides the operation trigger");
    const trigger = page.getByRole("button", { name: "Actions for Task 100", exact: true });
    if (!touch) await pinnedSection.locator(".sidebar-activity-row").hover();
    if (touch) await trigger.tap(); else await trigger.click();
    const unpin = page.getByRole("menuitem", { name: "Unpin", exact: true });
    await unpin.waitFor();
    if (touch) await unpin.tap(); else await unpin.click();
    await pinnedSection.waitFor({ state: "detached" });
    assert.equal(await page.locator(".sidebar-activity-item").count(), 10);
    assert.equal(await page.evaluate(() => (window as any).fixture.actions.at(-1).pinned), false);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    if (!touch) await page.locator(".sidebar-activity-row").filter({ has: page.getByRole("button", { name: "Actions for Task 100", exact: true }) }).hover();
    await page.getByRole("button", { name: "Actions for Task 100", exact: true }).click();
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await pinnedSection.waitFor();
    assert.equal(await pinnedSection.locator(".sidebar-activity-item").count(), 1, "pin appears once after acknowledgement");
    assert.equal(await page.locator(".sidebar-activity-item").count(), 14);
    await page.evaluate(() => (window as any).fixture.connection('open'));
    await page.getByText('Task 3', { exact: true }).waitFor();
    const before = await page.locator('.sidebar-activity-item').evaluateAll(rows => rows.map(row => ({text: row.textContent, y: row.getBoundingClientRect().y})));
    await page.evaluate(() => { (window as any).retainedRows = [...document.querySelectorAll('.sidebar-activity-item')]; });
    for (const state of ['connecting', 'open', 'idle', 'open', 'error', 'open', 'connecting', 'open']) {
      const admitted = await page.evaluate(state => (window as any).fixture.connection(state), state);
      assert.equal(admitted, state === 'open', 'displaying cached rows cannot authorize offline reads');
      await page.waitForTimeout(30);
      assert.deepEqual(await page.locator('.sidebar-activity-item').evaluateAll(rows => rows.map(row => ({text: row.textContent, y: row.getBoundingClientRect().y}))), before, 'transport transitions cannot remove/reorder cached rows');
      assert.equal(await page.evaluate(() => (window as any).retainedRows.every((row, index) => row === document.querySelectorAll('.sidebar-activity-item')[index])), true, 'reconnect preserves actual row nodes');
    }
    await page.evaluate(() => (window as any).fixture.connection('open', false));
    await page.waitForTimeout(30);
    assert.equal(await page.locator('.sidebar-activity-item').count(), 2, 'authorization revocation clears remote cache while local rows remain');
    await page.evaluate("window.fixture.setThreads([{...window.fixture.row(201),status:'review'},{...window.fixture.row(202),status:'error'},{...window.fixture.row(203),unread:true},{...window.fixture.row(204),unread:true,pinned:true}])");
    const attention = page.getByRole("region", { name: "Needs your attention", exact: true });
    await attention.getByText("Task 201", { exact: true }).waitFor();
    assert.equal(await attention.locator('.sidebar-activity-item').count(), 2);
    assert.equal(await attention.getByText("Task 202", { exact: true }).count(), 1);
    assert.equal(await attention.getByText("Task 203", { exact: true }).count(), 0, "unread replies never become todos");
    assert.equal(await pinnedSection.getByText("Task 204", { exact: true }).count(), 1, "unread keeps pinned placement");
    assert.equal(await page.getByText("Task 203", { exact: true }).count(), 1, "unread reply remains reachable");
    await page.evaluate(() => (window as any).fixture.setThreads([]));
    await page.locator(".sidebar-activity-empty").waitFor();
    await page.evaluate(() => (window as any).fixture.connection('open'));
    const serverFilter = page.getByRole('button', { name: 'Filters', exact: true });
    await serverFilter.click();
    await page.getByRole('menuitemradio', { name: 'Remote', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-activity-item').length === 2);
    await page.evaluate(() => { (window as any).filteredRows = [...document.querySelectorAll('.sidebar-activity-item')]; });
    for (const state of ['idle', 'open', 'error', 'open']) {
      await page.evaluate(state => (window as any).fixture.connection(state), state);
      await page.waitForFunction(online => [...document.querySelectorAll<HTMLButtonElement>('.sidebar-activity-item')].every(row => row.disabled === !online), state === 'open');
      assert.equal(await page.evaluate(() => (window as any).filteredRows.every((row, i) => row === document.querySelectorAll('.sidebar-activity-item')[i])), true, 'offline keeps filtered row identity');
      assert.ok((await serverFilter.getAttribute('title'))?.includes('Remote'));
    }
    assert.equal(await page.evaluate(() => (window as any).fixture.connection('open', true, 'reconnecting')), false, 'stale backend open cannot bypass logical reconnect');
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('.sidebar-activity-item')].every(row => row.disabled));
    const actionsBeforeOfflineClick = await page.evaluate(() => (window as any).fixture.actions.length);
    await page.locator('.sidebar-activity-item').first().evaluate((row: HTMLButtonElement) => row.click());
    assert.equal(await page.evaluate(() => (window as any).fixture.actions.length), actionsBeforeOfflineClick, 'offline row cannot invoke conversation navigation');
    if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR}/filtered-offline-${touch ? 'touch' : 'desktop'}-${theme}.png` });
    await page.reload();
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Remote', exact: true }).waitFor();
    assert.equal(await page.getByRole('menuitemradio', { name: 'Remote', exact: true }).getAttribute('aria-checked'),'true');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { const f = (window as any).fixture; f.setThreads([f.row(0)]); });
    await page.waitForTimeout(30);
    assert.equal(await page.locator('.sidebar-activity-item').count(), 0, 'restored filter never falls back to unrelated local rows during remote loading');
    await page.evaluate(() => (window as any).fixture.connection('open'));
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-activity-item').length === 2);
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'All servers', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-activity-item').length === 4);
    // A successful Hub response may contain a saved directory after refresh failed.
    // Transport success must not hide the failure or its Host-scoped retry.
    const cachedMessage = page.getByText("Showing saved Remote conversations; refresh failed", { exact: true });
    const rowsBeforeCachedRetry = await page.locator('.sidebar-activity-item').elementHandles();
    const actionsBeforeCachedRetry = await page.evaluate(() => (window as any).fixture.actions.slice());
    for (const catalog of [{ phase: 'ready', cachedAt: 0 }, { phase: 'error', cachedAt: 123 }]) {
      await page.evaluate(catalog => (window as any).fixture.setCatalogs([{ hostId: 'ssh:remote', label: 'Remote', ...catalog }]), catalog);
      await cachedMessage.waitFor();
      assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).count(), 1);
      assert.equal(await page.locator('.sidebar-activity-item').count(), 4, 'saved directory failure keeps existing rows');
      if (touch) await retry.tap(); else await retry.click();
      await page.locator('.sidebar-tasks[aria-busy="true"]').waitFor({ state: 'attached' });
      assert.equal(await page.locator('.sidebar-catalog-feedback').count(), 0, 'cached retry remains visually quiet');
      for (const [index, row] of rowsBeforeCachedRetry.entries()) assert.equal(await row.evaluate((row, index) => row === document.querySelectorAll('.sidebar-activity-item')[index], index), true, 'cached retry preserves row identity');
    }
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions), [...actionsBeforeCachedRetry, 'ssh:remote', 'ssh:remote'], 'saved-directory retries only read their exact Host');
    await page.evaluate(() => (window as any).fixture.setCatalogs([{ hostId: 'ssh:remote', label: 'Remote', phase: 'loading', cachedAt: 123 }]));
    await page.locator('.sidebar-tasks[aria-busy="true"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.sidebar-catalog-feedback').count(), 0, 'in-flight cached refresh adds no feedback row');
    await page.evaluate(() => (window as any).fixture.setCatalogs([{ hostId: 'ssh:remote', label: 'Remote', phase: 'ready' }]));
    await page.locator('.sidebar-tasks[aria-busy="false"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.sidebar-catalog-feedback').count(), 0, 'successful refresh removes cached failure');
    assert.deepEqual(errors, []);
    evidence.push({ touch, theme, reducedMotion: true, quietLoading: true, savedDirectoryFailureRetry: true, loadingNotEmpty: true, stableHistoryGeometry: true, failedHostIsolation: true, scopedRetry: true, discoveryRetryWithoutProfiles: true, matchingResultsOnly: true, filteredRowsHaveNoFooter: true, loadMorePreservesFilters: true, serverFilterSurvivesReload: true, missingFilteredServerNeverBroadens: true, offlineControlsDisabled: true, capabilityLossPreservesRows: true, successfulEmpty: true, cachedRowsStableThroughReconnect: true, revokedCacheHidden: true, nativePinPresentation: true, unsupportedPinHidden: true, pinDoesNotConsumeRecentBudget: true });
    await context.close();
  }
  for(const touch of [false,true])for(const theme of ["light","dark"]) {
    const context=await browser.newContext({viewport:{width:touch?390:1000,height:900},hasTouch:touch,isMobile:touch,reducedMotion:"reduce"});
    const page=await context.newPage();const errors:string[]=[];page.on("pageerror",(error:Error)=>errors.push(error.message));
    await page.goto(origin);await page.waitForFunction(()=>(window as any).fixture?.setThreads);
    await page.evaluate(theme=>{const f=(window as any).fixture;f.setThemePreference(theme);f.setCatalogs([]);f.setThreads([
      {...f.row(0),instanceGroup:{id:"laptop",name:"My laptop"},directoryGroup:{id:"/work/app",name:"app"}},
      {...f.row(1,true),instanceGroup:{id:"remote",name:"Remote server"},directoryGroup:{id:"/work/app",name:"app"}},
      {...f.row(2,true),instanceGroup:{id:"remote",name:"Remote server"},directoryGroup:{id:"/work/api",name:"api"}},
    ]);},theme);
    const remote=page.locator('[data-instance-id="remote"]');await remote.waitFor();
    assert.equal(await page.locator('.sidebar-instance-group').count(),2);
    assert.equal(await remote.locator('[data-native-project]').count(),2);
    const toggle=remote.getByRole('button',{name:'Remote server',exact:true});
    const row=remote.locator('[data-thread-id="thread-1"] .sidebar-activity-item');await row.waitFor();
    if(touch)await toggle.tap();else{await toggle.focus();await page.keyboard.press('Enter');}
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await row.isVisible(),false);
    if(touch)await toggle.tap();else await page.keyboard.press('Enter');
    await row.waitFor();
    const project=remote.getByRole('button',{name:'app',exact:true});if(touch)await project.tap();else await project.click();
    assert.equal(await row.isVisible(),false);await project.click();await row.waitFor();
    const rename=remote.getByRole('button',{name:'Rename device',exact:true});
    if(touch)await rename.tap();else{await rename.focus();await page.keyboard.press('Enter');}
    let dialog=page.getByRole('dialog',{name:'Rename device',exact:true});
    const nameInput=dialog.getByRole('textbox',{name:'Device name',exact:true});
    await nameInput.fill('');assert.equal(await dialog.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
    await nameInput.fill('Cancelled name');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    await remote.getByRole('button',{name:'Remote server',exact:true}).waitFor();
    await rename.click();dialog=page.getByRole('dialog',{name:'Rename device',exact:true});
    await dialog.getByRole('textbox',{name:'Device name',exact:true}).fill('Production node');
    await page.evaluate(()=>(window as any).fixture.failNextNameSave());
    await dialog.getByRole('button',{name:'Save',exact:true}).click();await dialog.getByRole('alert').waitFor();
    assert.equal(await dialog.getByRole('textbox').inputValue(),'Production node','failed persistence keeps the edit');
    await page.screenshot({animations:'disabled',path:`/tmp/opencraft-instance-rename-${touch?'touch':'desktop'}-${theme}.png`});
    await dialog.getByRole('button',{name:'Save',exact:true}).click();await dialog.waitFor({state:'detached'});
    await remote.getByRole('button',{name:'Production node',exact:true}).waitFor();
    assert.equal(await remote.getByRole('button',{name:'Production node',exact:true}).getAttribute('aria-expanded'),'true','rename preserves disclosure state');
    if(!touch)assert.equal(await rename.evaluate(el=>el===document.activeElement),true,'save restores the opener focus');
    await page.reload();await page.waitForFunction(()=>(window as any).fixture?.setThreads);
    await page.evaluate(()=>{const f=(window as any).fixture;f.setCatalogs([]);f.setThreads([
      {...f.row(0),instanceGroup:{id:'laptop',name:'My laptop'},directoryGroup:{id:'/work/app',name:'app'}},
      {...f.row(1,true),instanceGroup:{id:'remote',name:'Remote server'},directoryGroup:{id:'/work/app',name:'app'}}
    ]);});
    await remote.getByRole('button',{name:'Production node',exact:true}).waitFor();
    await page.screenshot({animations:"disabled",path:`/tmp/opencraft-sidebar-instances-${touch?'touch':'desktop'}-${theme}.png`});
    await page.evaluate(()=>{const f=(window as any).fixture;f.setThreads([{...f.row(0),instanceGroup:{id:'laptop',name:'My laptop'},directoryGroup:{id:'/work/app',name:'app'}}]);});
    await page.waitForFunction(()=>document.querySelectorAll('.sidebar-instance-group').length===0);
    assert.equal(await page.locator('[data-native-project]').count(),1,'single instance displays project/session directly');
    await page.locator('[data-thread-id="thread-0"] .sidebar-activity-item').waitFor();
    assert.deepEqual(errors,[]);evidence.push({touch,theme,instanceProjectSession:true,singleInstanceTwoLevels:true,keyboardOrTouchDisclosures:true});
    await context.close();
  }
  }
  console.log(JSON.stringify({ ok: true, realSidebar: true, evidence }));
} finally { await browser?.close(); await vite.close(); }
