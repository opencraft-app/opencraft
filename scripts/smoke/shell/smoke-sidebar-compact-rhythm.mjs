import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'vite';
const output=process.env.OPENCRAFT_SIDEBAR_RHYTHM_REPORT??'/tmp/opencraft-sidebar-compact-rhythm';
const source=`
import React,{useState,useEffect} from 'react';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density';
import {useUiPreferencesRuntime} from '/apps/workbench-web/src/runtime/ui-preferences-runtime';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {NavigationList,NavigationItem} from '@opencraft/design-system-web/navigation';
import {IconButton} from '@opencraft/design-system-web/button';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const queryClient=new QueryClient();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_scope,doc)=>doc});
const glyph=<svg className='sidebar-section-icon' viewBox='0 0 24 24' aria-hidden='true'><path d='M4 9h16v11H4zM4 9l3-5h10l3 5M8 9v4h8V9'/></svg>;
const actions=[];
const catalogs=['Inbox','Assistant','Assets'].map(title=>({id:title,title,presentation:'entry',content:<NavigationList label={title} inset='contained'><NavigationItem onClick={()=>actions.push(title)}>{glyph}<span data-navigation-label=''>{title}</span></NavigationItem></NavigationList>}));
const titles=['Octop migration','A long synthetic title that must remain on one line and truncate','Review deployment','Daily brief','Restore first-response latency','Publish collaboration copy','Resolve mailbox whitelist','Follow up feedback','Investigate callback','Check release'];
const rows=titles.map((title,i)=>({id:'thread-'+i,title,project:'workspace',status:'ready',updatedAt:Date.now()/1000-i,connectionHostId:'fixture',connectionHostLabel:'Synthetic server',...legacyDirectServerProjectionFromHost({hostId:'fixture',hostKind:'remote-ssh',label:'Synthetic server'})}));
function Demo(){const preferences=useUiPreferencesRuntime();useEffect(()=>bindInteractionDensity(document,preferences),[preferences]);const [open,setOpen]=useState(false),[selected,setSelected]=useState('thread-3');window.fixture={setThemePreference,setOpen,actions,sidebarOpen:()=>open};
const navigation={account:{snapshot:{phase:'authenticated',name:'Synthetic employee',avatarUrl:null},onOpen:()=>{},onRefresh:async()=>{}},onOpenSettings:()=>{},actions:[{id:'shell.start',title:'Home',icon:'start',active:true,onInvoke:()=>{}},{id:'shell.applications',title:'Apps',icon:'grid',onInvoke:()=>{}}]};
return <QueryClientProvider client={queryClient}><AppShell navigation={navigation} layoutScope='Chat' mainContentLayout='default' header={<AppShellHeader title='Synthetic workspace' project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} onToggleSidebar={()=>setOpen(v=>!v)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>} floatingSidebarHeader={()=>null}
leftPanel={<Sidebar threads={rows} activeHostId='fixture' activeThreadId={selected} sidebarLayout={layout} showStart={false} showNewChat={true} showFooter={false} catalogs={catalogs} threadActions={{onRename:async()=>{},onArchive:async()=>{},onDelete:async()=>{},onFork:async()=>{},onSetPinned:async()=>{}}} threadBadge={{placement:'title',Component:()=> <IconButton size='accessory' aria-label='Synthetic participant'>{glyph}</IconButton>}} threadCapabilities={()=>({rename:true,archive:true,fork:true,delete:true,pin:true})} onSelectThread={(_host,id)=>setSelected(id)} onNewTask={()=>{}} onOpenSettings={()=>{}}/>} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} sidebarOpen={open} sidebarWidth={335} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={()=>{}} onRightPanelOpenChange={()=>{}}><p>Synthetic content only</p></AppShell></QueryClientProvider>}
createIntlTestRoot(document.getElementById('root')).render(<Demo/>);`;
const vite=await createServer({configFile:false,root:process.cwd(),cacheDir:output+'/vite-cache',logLevel:'error',resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'sidebar-rhythm',resolveId:id=>id==='/probe.tsx'?id:null,load:id=>id==='/probe.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/probe.tsx"></script>')})}}]});
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');
let browser;const results=[],errors=[];
const previousRhythm=':root{--height-sidebar-navigation-row:28px;--gap-sidebar-navigation-rows:1px;--gap-sidebar-navigation-groups:8px;--gap-sidebar-navigation-sections:2px;--gap-sidebar-navigation-heading-after:4px;--padding-sidebar-activity-single-row-block:calc(var(--spacing) / 2);--gap-sidebar-activity-groups:4px;--gap-sidebar-activity-expanded-groups:12px}';
try{
 await mkdir(output,{recursive:true});await vite.listen();browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const width of [390,1280])for(const touch of [false,true])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width,height:760},isMobile:width<640,hasTouch:touch,reducedMotion:'reduce',deviceScaleFactor:2});
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>{errors.push(error.message);console.error(error.message)});page.on('console',m=>{if(m.type()==='error')console.error(m.text())});
  await page.goto('http://127.0.0.1:'+vite.httpServer.address().port+'/');await page.waitForFunction(()=>Boolean(window.fixture)&&Boolean(document.documentElement.dataset.uiDensity));
  await page.evaluate(t=>window.fixture.setThemePreference(t),theme);
  await page.waitForTimeout(400);await page.locator('[data-chrome-action-id="sidebar-toggle"]').first().click();
  await page.locator('.sidebar-activity-item').first().waitFor();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(150);
  if(process.env.OPENCRAFT_SIDEBAR_CSS){await page.evaluate(()=>{for(const s of document.querySelectorAll('style,link[rel="stylesheet"]'))s.remove()});await page.addStyleTag({content:await readFile(process.env.OPENCRAFT_SIDEBAR_CSS,'utf8')})}
  const measure=()=>page.evaluate(()=>{
   const box=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}};
   const type=n=>{const s=getComputedStyle(n);return{fontSize:s.fontSize,lineHeight:s.lineHeight,fontWeight:s.fontWeight}};
   const entries=[...document.querySelectorAll('.sidebar-extension-catalog[data-catalog-presentation="entry"] .ui-navigation-item')];
   const column=document.querySelector('.shell-sidebar__column'),rows=[...document.querySelectorAll('.sidebar-activity-item-container')];
   return{mobile:column.dataset.navigationLayout==='mobile',touch:document.documentElement.dataset.uiDensity==='touch',
    entries:entries.map(n=>({box:box(n),type:type(n.querySelector('[data-navigation-label]')),icon:box(n.querySelector('svg'))})),
    rows:rows.map(n=>({box:box(n),type:type(n.querySelector('.sidebar-activity-item__title'))})),
    menu:[...document.querySelectorAll('.sidebar-activity-item__menu-trigger')].map(box),
    badge:[...document.querySelectorAll('.sidebar-activity-item__badge-slot button')].map(box),
    groups:[...document.querySelectorAll('.sidebar-thread-group-toggle')].map(box),
    footer:[...document.querySelectorAll('.shell-sidebar__footer,.shell-sidebar__rail-footer [data-surface],.shell-sidebar-primary-action')].map(box),
    headingAfter:getComputedStyle(column).getPropertyValue('--gap-sidebar-navigation-heading-after').trim(),
    overflow:document.documentElement.scrollWidth>innerWidth};
  });
  const old=await page.addStyleTag({content:previousRhythm});await page.evaluate(()=>new Promise(requestAnimationFrame));
  const before=await measure();await page.screenshot({path:output+'/'+width+'-'+(touch?'touch':'pointer')+'-'+theme+'-before.png'});
  await page.evaluate(()=>{window.retainedSidebarRow=document.querySelector('.sidebar-activity-item')});
  await old.evaluate(n=>n.remove());await page.evaluate(()=>new Promise(requestAnimationFrame));
  const after=await measure();
  assert.equal(after.mobile,width<640&&touch,'Capacity must not turn a pointer window into touch presentation');
  assert.equal(after.entries.length,3);
  assert.deepEqual(after.entries.map(n=>n.type),before.entries.map(n=>n.type),'Navigation typography unchanged');
  assert.deepEqual(after.entries.map(n=>[n.icon.width,n.icon.height]),before.entries.map(n=>[n.icon.width,n.icon.height]),'Icon size unchanged');
  assert.deepEqual(after.rows.map(n=>n.type),before.rows.map(n=>n.type),'Conversation typography unchanged');
  assert.deepEqual(after.footer,before.footer,'Bottom action geometry unchanged');
  assert.ok(after.rows.every((r,i)=>r.box.height>=before.rows[i].box.height));
  if(touch)for(const r of [...after.entries.map(r=>r.box),...after.rows.map(r=>r.box),...after.menu,...after.badge,...after.groups])assert.ok(r.height>=44,'Touch hit target retained');
  else {assert.ok(after.entries[0].box.height>before.entries[0].box.height);assert.ok(after.rows[0].box.height>before.rows[0].box.height);}
  assert.equal(after.headingAfter,'8px');assert.equal(after.overflow,false);
  assert.equal(await page.evaluate(()=>window.retainedSidebarRow===document.querySelector('.sidebar-activity-item')),true,'No remount from density CSS');
  // A negative control above used the old values. The balanced shared tokens must
  // drive the real grouped catalogs and rows, not a local lookalike fixture.
  const assets=page.getByRole('button',{name:'Assets',exact:true});await assets.focus();await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>window.fixture.actions),['Assets']);
  const group=page.locator('.sidebar-thread-group-toggle').filter({hasText:'Recent'});
  await group.focus();await page.keyboard.press('Enter');assert.equal(await group.getAttribute('aria-expanded'),'false');
  await page.keyboard.press('Enter');assert.equal(await group.getAttribute('aria-expanded'),'true');await group.evaluate(n=>n.blur());
  const last=page.locator('.sidebar-activity-item').last();await last.scrollIntoViewIfNeeded();
  if(after.mobile){
   const clear=await page.evaluate(()=>{const row=[...document.querySelectorAll('.sidebar-activity-item')].at(-1).getBoundingClientRect();const footer=document.querySelector('.shell-sidebar__footer').getBoundingClientRect();return row.bottom<=footer.top+1});
   assert.equal(clear,true,'Last conversation scrolls above floating actions');
  }
  const viewport=page.locator(after.mobile?'.shell-sidebar__scroll':'.sidebar-activity-list');await viewport.evaluate(n=>n.scrollTop=0);
  await page.screenshot({path:output+'/'+width+'-'+(touch?'touch':'pointer')+'-'+theme+'-after.png'});
  results.push({width,touch,theme,before,after});await context.close();
 }
 assert.deepEqual(errors,[]);await writeFile(output+'/metrics.json',JSON.stringify(results,null,2));console.log(JSON.stringify({passed:results.length,output}));
}finally{await browser?.close();await vite.close()}
