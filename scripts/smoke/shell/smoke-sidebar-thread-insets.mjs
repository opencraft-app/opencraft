import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const output = process.env.OPENCRAFT_THREAD_INSET_REPORT ?? "/tmp/opencraft-sidebar-thread-insets";
const source = `
import React,{useState} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {frame} from '@opencraft/design-system/tokens';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_scope,doc)=>doc});
const threads=['Short conversation','A deliberately long synthetic conversation title that must truncate','Review result'].map((title,i)=>({id:'thread-'+i,title,project:i===1?'long-synthetic-project':'workspace',status:i===1?'running':'ready',updatedAt:Date.now()/1000-i*86400,connectionHostId:'fixture',connectionHostLabel:'Synthetic server',...legacyDirectServerProjectionFromHost({hostId:'fixture',hostKind:'remote-ssh',label:'Synthetic server'})}));
const snapshot={settingsPages:[{contribution:{id:'example.tools.skills',title:'Skills',icon:'sparkles',viewId:'skills'}}]};
const contributions={subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const renames=[],deletes=[],forks=[];const threadActions={onRename:async(_target,title)=>{renames.push(title);},onFork:()=>new Promise(resolve=>{forks.push(resolve);}),onArchive:async()=>{},onDelete:async(target)=>{deletes.push(target.threadId);window.fixture.remove(target.threadId);},onSetPinned:async()=>{}};
function Demo(){const [open,setOpen]=useState(true),[selected,setSelected]=useState('thread-0'),[actionsAvailable,setActionsAvailable]=useState(true),[visibleThreads,setThreads]=useState(threads);window.fixture={resetThreads:()=>setThreads(threads),setThemePreference,setActionsAvailable,setThreads,setSelected,renames,deletes,forks,remove:id=>setThreads(rows=>rows.filter(row=>row.id!==id)),setStatus:(id,status)=>setThreads(rows=>rows.map(row=>row.id===id?{...row,status}:row))};
const navigation={layout:'unified',account:null,onOpenSettings:()=>{},actions:[{id:'shell.start',title:'Start',icon:'start',active:true,onInvoke:()=>{}},{id:'opencraft.tasks.navigation',title:'Tasks',icon:'columns',onInvoke:()=>{}},{id:'example.workspace.navigation',title:'Collaboration',icon:'collaboration',onInvoke:()=>{}},{id:'skills',title:'Skills',icon:'sparkles',onInvoke:()=>{}}]};
return <AppShell navigation={navigation} layoutScope='Chat' mainContentLayout='default' header={<AppShellHeader title='Synthetic workspace' project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} onToggleSidebar={()=>setOpen(v=>!v)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle','back','forward']}/>} floatingSidebarHeader={()=>null}
leftPanel={<Sidebar threads={visibleThreads} activeHostId='fixture' activeThreadId={selected} sidebarLayout={layout} showStart={false} showFooter={false} threadActions={threadActions} threadBadge={{Component:()=> <button style={{width:28,height:28,borderRadius:'50%'}} aria-label='Synthetic badge'>+1</button>}} threadCapabilities={()=>({rename:actionsAvailable,archive:actionsAvailable,fork:actionsAvailable,delete:actionsAvailable,pin:actionsAvailable})} onSelectThread={(_host,id)=>setSelected(id)} onNewTask={()=>{}} onOpenSettings={()=>{}}/>} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} sidebarOpen={open} sidebarWidth={frame.sidebarUnifiedDefaultWidth} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={()=>{}} onRightPanelOpenChange={()=>{}}><p>Synthetic content only</p></AppShell>}
createIntlTestRoot(document.getElementById('root')).render(<Demo/>);`;
const vite = await createServer({configFile:false,root:process.cwd(),logLevel:"error",resolve:{dedupe:["react","react-dom"]},cacheDir:"node_modules/.vite-thread-insets",esbuild:{jsx:"automatic",target:"esnext"},server:{host:"127.0.0.1",port:0,hmr:false},plugins:[{name:"thread-inset-fixture",resolveId:id=>id==="/probe.tsx"?id:null,load:id=>id==="/probe.tsx"?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=="/")return next();res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/probe.tsx"></script>');});}}]});
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??"playwright");
let browser;
const results=[],errors=[];
try {
  await mkdir(output,{recursive:true});await vite.listen();
  browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:["--no-sandbox"]});
  for(const width of [1280,390])for(const theme of ["light","dark"]){
    const context=await browser.newContext({viewport:{width,height:1000},deviceScaleFactor:2,isMobile:width<640,hasTouch:width<640});
    const page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
    await page.waitForFunction(()=>Boolean(window.fixture));await page.evaluate(t=>window.fixture.setThemePreference(t),theme);
    if(!await page.locator(".sidebar-activity-item").first().isVisible())await page.locator("[data-chrome-action-id=sidebar-toggle]").first().click();
    await page.locator(".sidebar-activity-item").first().waitFor();await page.waitForTimeout(400);
    await page.locator(".sidebar-activity-row").nth(1).hover();
    const measurement=await page.evaluate(()=>{
      const box=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return{x:r.x,right:r.right,y:r.y,bottom:r.bottom,height:r.height,width:r.width,paddingLeft:s.paddingLeft,paddingRight:s.paddingRight,marginLeft:s.marginLeft,background:s.backgroundColor};};
      const textX=e=>{const range=document.createRange();range.selectNodeContents(e);return range.getBoundingClientRect().x;};
      const nav=[...document.querySelectorAll(".shell-sidebar-navigation .shell-navigation__items--applications>button")].map(e=>({box:box(e),icon:box(e.querySelector("svg")),label:box(e.querySelector("span"))}));
      const headings=[...document.querySelectorAll(".sidebar-activity-group__heading")].map(e=>({box:box(e),textX:textX(e)}));
      const rows=[...document.querySelectorAll(".sidebar-activity-item")].map(e=>({box:box(e.parentElement),title:box(e.querySelector(".sidebar-activity-item__title")),project:box(e.querySelector(".sidebar-activity-item__metadata")),trailing:box(e.querySelector(".sidebar-activity-item__trailing")),status:box(e.querySelector(".sidebar-activity-item__status")),origin:box(e.querySelector(".sidebar-activity-item__server-origin")),dot:box(e.querySelector(".sidebar-activity-item__server-dot")),originInMetadata:!!e.querySelector(".sidebar-activity-item__metadata .sidebar-activity-item__server-origin"),badge:box(e.parentElement.querySelector(".sidebar-activity-item__badge-slot"))}));
      const menus=[...document.querySelectorAll(".sidebar-activity-item__menu-trigger")].map(box);
      const list=box(document.querySelector('.shell-sidebar__context'));
      const rail=box(document.querySelector('.shell-sidebar__navigation'));
      const dates=[...document.querySelectorAll('.sidebar-activity-date')].map(box);
      const column=box(document.querySelector('.shell-sidebar__column'));
      const drawer=document.querySelector('.app-shell-floating-left-panel');
      return{nav,headings,rows,menus,list,rail,dates,column,drawerWidth:drawer?.getBoundingClientRect().width,floating:Boolean(document.querySelector(".app-shell-floating-left-panel .sidebar-panel"))};
    });
    results.push({width,theme,...measurement});
    await page.screenshot({path:`${output}/${width}-${theme}.png`});
    if(!process.argv.includes("--record-before")){
      const first=measurement.nav[0];assert.ok(first);
      assert.ok(width===390 ? Math.abs(measurement.list.width-measurement.drawerWidth)<.1 : Math.abs(measurement.rail.width-48)<.1, "mobile list is full width; desktop rail retains 48px");
      assert.equal(measurement.rows.length,3);assert.equal(measurement.headings.length,2);
      for(const nav of measurement.nav)assert.ok(nav.box.x>=measurement.rail.x && nav.box.right<=measurement.rail.right);
      if(width===1280) {
        await page.locator('[data-row-lines="two"]').first().screenshot({path:`${output}/1280-${theme}-two-line.png`});
        await page.locator('[data-row-lines="one"]').first().screenshot({path:`${output}/1280-${theme}-one-line.png`});
      }
      const heights=await page.locator('.sidebar-activity-item-container').evaluateAll(rows=>rows.map(row=>({lines:row.getAttribute('data-row-lines'),height:row.getBoundingClientRect().height})));
      assert.ok(heights.every(r=>r.lines==='one'?r.height===(width===390?44:32):r.height>=(width===390?56:48)),'row heights follow density token '+JSON.stringify(heights));
      const firstRow=measurement.rows[0];
      for(const row of measurement.rows){
        assert.ok(Math.abs(row.box.x-firstRow.box.x)<.1 && Math.abs(row.box.right-firstRow.box.right)<.1,"single/two-line row frames share list inset");
        assert.ok(Math.abs(row.title.x-firstRow.title.x)<.1,"titles share leading edge");
        assert.ok(row.trailing.right<=row.box.right);
        assert.ok(Math.abs(row.trailing.width-18)<.1 && row.originInMetadata);
        assert.ok(row.origin.y>=row.project.y && row.origin.bottom<=row.project.bottom && row.origin.width>=12 && row.origin.height>=12);
        assert.ok(row.dot.width===7 && row.dot.height===7);
        assert.ok(Math.abs(row.trailing.right-firstRow.trailing.right)<.1 && Math.abs(row.project.right-firstRow.project.right)<.1,"single/two-line metadata and trailing right edges match");
        assert.ok(row.title.right<=row.trailing.x+.1,"long title cannot overlap trailing slots");
        assert.ok(Math.abs(row.trailing.right+4-row.badge.x)<.1,"status and badge retain 4px gap");
        assert.ok(Math.abs(row.badge.width-28)<.1,"product badge uses intrinsic content width");
      }
      for(const date of measurement.dates)assert.ok(Math.abs(date.x+Number.parseFloat(date.paddingLeft)-firstRow.title.x)<.1,"date and title share list inset");
      for(const [i,row] of measurement.rows.entries())assert.ok(row.badge.right+4<=measurement.menus[i].x+.1,"badge and menu have separate slots");
      assert.equal(measurement.menus.length,3);for(const menu of measurement.menus)assert.ok(menu.right<=measurement.rows[0].box.right+.1);
    }
    for (const available of [false,true,false,true]) {
      await page.evaluate(v=>window.fixture.setActionsAvailable(v),available);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));
      const current=await page.evaluate(()=>[...document.querySelectorAll('.sidebar-activity-item')].map(e=>{const rect=selector=>{const r=e.querySelector(selector).getBoundingClientRect();return {x:r.x,right:r.right};};return {title:rect('.sidebar-activity-item__title'),trailing:rect('.sidebar-activity-item__trailing')};}));
      assert.equal(current.length,measurement.rows.length);
      for(const [i,row] of current.entries())for(const part of ['title','trailing'])for(const edge of ['x','right'])assert.ok(Math.abs(row[part][edge]-measurement.rows[i][part][edge])<.1,'Host capabilities must not move '+part);
      assert.equal(await page.locator('.sidebar-activity-item__menu-trigger').count(),available?3:0);
    }
    // Collapsed task-flow headings and more/less form one compact, touch-safe rhythm.
    await page.evaluate(()=>window.fixture.setThreads([
      ...['running','review','ready'].map((status,i)=>({id:'density-'+i,title:'Density '+i,project:'workspace',status,pinned:i===2,updatedAt:Date.now()/1000,connectionHostId:'fixture',connectionHostLabel:'Fixture',serverOrigin:{serverId:'fixture',label:'Fixture',kind:'remote-ssh'},serverRouteLocality:'remote'})),
      ...Array.from({length:12},(_,i)=>({id:'density-recent-'+i,title:'Recent '+i,project:'workspace',status:'ready',updatedAt:Date.now()/1000-i,connectionHostId:'fixture',connectionHostLabel:'Fixture',serverOrigin:{serverId:'fixture',label:'Fixture',kind:'remote-ssh'},serverRouteLocality:'remote'}))
    ]));
    const densityToggles=page.locator('.sidebar-thread-group-toggle');
    await densityToggles.first().waitFor();
    assert.equal(await densityToggles.count(),4);
    for(const toggle of await densityToggles.all())if(await toggle.getAttribute('aria-expanded')==='true')await toggle.click();
    const density=await page.evaluate(()=>{
      const box=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);return{top:r.top,bottom:r.bottom,height:r.height,size:c.fontSize,lineHeight:c.lineHeight,weight:c.fontWeight}};
      return {groups:[...document.querySelectorAll('.sidebar-activity-group')].map(box),buttons:[...document.querySelectorAll('.sidebar-thread-group-toggle')].map(box),more:box(document.querySelector('.sidebar-activity-more')),hidden:[...document.querySelectorAll('.sidebar-activity-group__items')].every(e=>getComputedStyle(e).display==='none')};
    });
    assert.ok(density.hidden,'Collapsed contents have no layout footprint');
    for(let i=1;i<density.groups.length;i++)assert.equal(density.groups[i].top-density.groups[i-1].bottom,4,'Folded group gaps remain compact');
    assert.equal(density.more.top-density.groups.at(-1).bottom,4,'More/less shares the compact rhythm');
    for(const button of [...density.buttons,density.more]){
      assert.ok(button.height>=(width===390?44:30),'Hit targets survive density reduction');
      assert.equal(button.size,width===390?'16px':'13px');assert.equal(button.lineHeight,width===390?'22px':'18px');
    }
    await page.screenshot({path:`${output}/${width}-${theme}-collapsed-density.png`});
    await densityToggles.first().click();
    const expandedGap=await page.evaluate(()=>{const groups=document.querySelectorAll('.sidebar-activity-group');return groups[1].getBoundingClientRect().top-groups[0].getBoundingClientRect().bottom;});
    assert.equal(expandedGap,12,'Expanded content has a distinct section boundary');
    await page.screenshot({path:`${output}/${width}-${theme}-expanded-density.png`});
    for(const toggle of await densityToggles.all())if(await toggle.getAttribute("aria-expanded")==="false")await toggle.click();
    await page.evaluate(()=>window.fixture.resetThreads());
    results.push({width,theme,density,expandedGap});
    // The rename dialog and its draft survive the task-flow regroup when the running conversation finishes.
    await page.locator('.sidebar-activity-group[aria-label="In progress"] .sidebar-activity-row').hover();
    await page.locator('.sidebar-activity-group[aria-label="In progress"] .sidebar-activity-item__menu-trigger').click();
    await page.getByRole('menuitem',{name:'Rename'}).click();
    const renameInput=page.getByRole('textbox',{name:'Conversation name'});
    await renameInput.fill('Renamed while finishing');
    await page.evaluate(()=>window.fixture.setStatus('thread-1','ready'));
    await page.waitForFunction(()=>!document.querySelector('.sidebar-activity-group[aria-label="In progress"]'));
    assert.equal(await renameInput.inputValue(),'Renamed while finishing','Rename draft survives the section move');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await renameInput.waitFor({state:'detached'});
    assert.deepEqual(await page.evaluate(()=>window.fixture.renames.splice(0)),['Renamed while finishing']);
    // Row-level fork feedback (busy/forking) survives the same regroup until the operation settles.
    const running='.sidebar-activity-group[aria-label="In progress"]';
    await page.evaluate(()=>window.fixture.setStatus('thread-1','running'));
    await page.locator(`${running} .sidebar-activity-row`).hover();
    await page.locator(`${running} .sidebar-activity-item__menu-trigger`).click();
    await page.getByRole('menuitem',{name:'Create branch'}).click();
    const forking=page.locator('.sidebar-activity-item__menu-trigger[data-forking="true"]');
    await forking.waitFor();
    await page.evaluate(()=>window.fixture.setStatus('thread-1','ready'));
    await page.waitForFunction(()=>!document.querySelector('.sidebar-activity-group[aria-label="In progress"]'));
    assert.equal(await forking.count(),1,'Fork feedback survives the section move');
    assert.equal(await forking.isDisabled(),true,'Row stays busy across the remount');
    await page.evaluate(()=>window.fixture.forks.splice(0).forEach(resolve=>resolve()));
    await forking.waitFor({state:'detached'});
    // Delete confirmation survives the regroup and search hiding; it closes once the thread leaves the catalog.
    await page.evaluate(()=>window.fixture.setStatus('thread-1','running'));
    await page.locator(`${running} .sidebar-activity-row`).hover();
    await page.locator(`${running} .sidebar-activity-item__menu-trigger`).click();
    await page.getByRole('menuitem',{name:'Delete'}).click();
    const confirmDelete=page.getByRole('button',{name:'Delete',exact:true});
    await confirmDelete.waitFor();
    await page.evaluate(()=>window.fixture.setStatus('thread-1','ready'));
    await page.waitForFunction(()=>!document.querySelector('.sidebar-activity-group[aria-label="In progress"]'));
    assert.equal(await confirmDelete.count(),1,'Delete confirmation survives the section move');
    // Newer activity pushes the target behind the Recent budget: still in the catalog, so the dialog stays.
    await page.evaluate(()=>window.fixture.setThreads(rows=>[...Array.from({length:12},(_,i)=>({...rows[0],id:'newer-'+i,title:'Newer conversation '+i,updatedAt:Date.now()/1000+i+1})),...rows]));
    await page.waitForFunction(()=>![...document.querySelectorAll('.sidebar-activity-item')].some(item=>item.textContent.includes('A deliberately long')));
    assert.equal(await confirmDelete.count(),1,'Hiding the target behind the Recent budget keeps the dialog');
    await confirmDelete.click();
    await confirmDelete.waitFor({state:'detached'});
    assert.deepEqual(await page.evaluate(()=>window.fixture.deletes.splice(0)),['thread-1']);
    await page.evaluate(()=>window.fixture.setThreads(rows=>rows.filter(row=>!row.id.startsWith('newer-'))));
    await page.waitForFunction(()=>document.querySelectorAll('.sidebar-activity-item').length===2);
    await page.locator('.sidebar-activity-row',{hasText:'Short conversation'}).hover();
    await page.locator('.sidebar-activity-row',{hasText:'Short conversation'}).locator('.sidebar-activity-item__menu-trigger').click();
    await page.getByRole('menuitem',{name:'Rename'}).click();
    await renameInput.waitFor();
    await page.evaluate(()=>window.fixture.remove('thread-0'));
    await renameInput.waitFor({state:'detached'});
    await page.evaluate(()=>window.fixture.setThreads(Array.from({length:35},(_,i)=>({
      id:'scroll-'+i,title:'Conversation '+i,project:'workspace',status:'ready',pinned:true,
      updatedAt:Date.now()/1000-i,connectionHostId:'fixture',connectionHostLabel:'Synthetic server',
      serverOrigin:{serverId:'fixture',label:'Synthetic server',kind:'remote-ssh'},serverRouteLocality:'remote'
    }))));
    const scroll=page.locator('.sidebar-activity-list');
    const start=page.getByRole('button',{name:'Start',exact:true});
    const before=await start.boundingBox();
    const fixedControls=await page.locator('.sidebar-list-toolbar').boundingBox();
    await scroll.hover();await page.mouse.wheel(0,500);
    await page.waitForFunction(()=>document.querySelector('.sidebar-activity-list').scrollTop>200);
    const scrolled=await page.evaluate(()=>{
      const viewport=document.querySelector('.sidebar-activity-list');
      return {top:viewport.scrollTop,outerScroll:document.querySelector('.sidebar-content-scroll').scrollTop};
    });
    assert.equal(scrolled.outerScroll,0,'Only the activity list scrolls');
    assert.deepEqual(await start.boundingBox(),before,'Icon rail must stay fixed');
    assert.deepEqual(await page.locator('.sidebar-list-toolbar').boundingBox(),fixedControls,'List controls stay fixed');
    await page.screenshot({path:`${output}/${width}-${theme}-scrolled.png`});
    await page.evaluate(()=>window.fixture.setSelected('scroll-34'));
    await page.waitForTimeout(150);
    const revealed=await page.locator('.sidebar-activity-item.is-selected').boundingBox();
    const viewport=await scroll.boundingBox();
    assert.ok(revealed.y>=viewport.y-1&&revealed.y+revealed.height<=viewport.y+viewport.height+1,'Selected conversation must be revealed');
    // Same selection and row count: a status change moves the selected row across sections and must keep it revealed.
    for(const [status,group] of [['running','In progress'],['ready','Pinned']]){
      await page.evaluate(s=>window.fixture.setStatus('scroll-34',s),status);
      await page.locator(`.sidebar-activity-group[aria-label="${group}"] .sidebar-activity-item.is-selected`).waitFor();
      await page.waitForTimeout(150);
      const moved=await page.locator('.sidebar-activity-item.is-selected').boundingBox();
      const movedViewport=await scroll.boundingBox();
      assert.ok(moved.y>=movedViewport.y-1&&moved.y+moved.height<=movedViewport.y+movedViewport.height+1,`Selected conversation stays revealed after moving to ${group}`);
    }
    // Hidden by search and shown again, the selected row is revealed; unrelated rows moving or groups collapsing never scroll to it.
    await scroll.evaluate(el=>{el.scrollTop=0});
    const searchBox=page.getByRole('searchbox',{name:'Search conversations'});
    await searchBox.fill('Conversation 1');
    await page.waitForFunction(()=>document.querySelectorAll('.sidebar-activity-item').length===11&&!document.querySelector('.sidebar-activity-item.is-selected'));
    await searchBox.fill('');
    await page.locator('.sidebar-activity-item.is-selected').waitFor();
    await page.waitForTimeout(150);
    const reappeared=await page.locator('.sidebar-activity-item.is-selected').boundingBox();
    const reappearedViewport=await scroll.boundingBox();
    assert.ok(reappeared.y>=reappearedViewport.y-1&&reappeared.y+reappeared.height<=reappearedViewport.y+reappearedViewport.height+1,'Selected conversation is revealed when it reappears after search');
    await scroll.evaluate(el=>{el.scrollTop=0});
    await page.evaluate(()=>window.fixture.setStatus('scroll-0','running'));
    await page.locator('.sidebar-activity-group[aria-label="In progress"]').waitFor();
    await page.waitForTimeout(150);
    assert.equal(await scroll.evaluate(el=>el.scrollTop),0,'Another row changing section must not scroll to the selection');
    await page.locator('.sidebar-activity-group[aria-label="In progress"] .sidebar-thread-group-toggle').click();
    await page.waitForTimeout(150);
    assert.equal(await scroll.evaluate(el=>el.scrollTop),0,'Collapsing another group must not scroll to the selection');
    await scroll.evaluate(el=>{el.scrollTop=0});
    await page.getByRole('button',{name:/^Tasks/}).click();
    if(width<640) {
      await page.locator('[data-chrome-action-id=sidebar-toggle]').first().click();
      await start.waitFor();
    }
    results.push({width,theme,scroll:scrolled,selectionRevealed:true});
    await context.close();
  }
  assert.deepEqual(errors,[]);console.log("Real Shell navigation/date/thread/project insets passed");
} finally {
  await writeFile(`${output}/result.json`,JSON.stringify({results,errors},null,2));await browser?.close();await vite.close();
}
