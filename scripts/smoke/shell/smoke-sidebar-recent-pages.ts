import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const source=`
import React from 'react';import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import {UiPreferencesProvider,openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import '/apps/workbench-web/src/styles/app.scss';initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_,v)=>v});const preferences=await openWorkbenchUiPreferences();
const makeRows=(n)=>[...Array.from({length:8},(_,i)=>({id:'pin'+i,title:'Pinned '+String(i+1).padStart(2,'0'),pinned:true})),...Array.from({length:n},(_,i)=>({id:'recent'+i,title:'Recent '+String(i+1).padStart(2,'0')}))].map((row,i)=>({...row,project:'opencraft',status:'ready',connectionHostId:'host',connectionHostLabel:'Local',updatedAt:Date.now()/1000-i*86400,...legacyDirectServerProjectionFromHost({hostId:'host',hostKind:'local',label:'Local'})}));
function Fixture(){const [rows,setRows]=React.useState(makeRows(31));window.setCount=n=>setRows(makeRows(n));return <UiPreferencesProvider runtime={preferences}><div className='shell-sidebar__column' data-navigation-layout={new URLSearchParams(location.search).get('layout')} style={{width:320,height:'100vh',gridTemplateColumns:'minmax(0,1fr)',gridTemplateRows:'minmax(0,1fr)'}}><div className='shell-sidebar__scroll'><Sidebar threads={rows} activeHostId='host' activeThreadId='recent30' sidebarLayout={layout} onSelectThread={()=>{}} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/></div></div></UiPreferencesProvider>};createIntlTestRoot(document.getElementById('root'),undefined,new URLSearchParams(location.search).get('locale')??'en-US').render(<Fixture/>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'fixture',resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>')})}}]});
let browser:any;
try{await vite.listen();const pw=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');const {chromium}=pw.default??pw;browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});const output=await mkdtemp(join(tmpdir(),'sidebar-recent-pages-'));
for(const touch of [false,true])for(const theme of ['light','dark'])for(const locale of ['en-US','zh-CN']){
console.log(JSON.stringify({touch,theme,locale}));
const page=await browser.newPage({viewport:{width:touch?390:1000,height:900},hasTouch:touch,isMobile:touch});const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.addInitScript(t=>{(window as any).__name=(v:any)=>v;localStorage.setItem('opencraft.appearance-theme',t)},theme);await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port+'/?locale='+locale+'&layout='+(touch?'mobile':'desktop'));
const waitRows=async(count:number)=>{await page.waitForFunction(n=>document.querySelectorAll('[aria-label="Recent"] .sidebar-activity-item, [aria-label="最近"] .sidebar-activity-item').length===n,count);};
const pinned=page.getByRole('region',{name:/^(Pinned|置顶)$/,exact:true});const recent=page.getByRole('region',{name:/^(Recent|最近)$/,exact:true});const rows=recent.locator('.sidebar-activity-item');const more=recent.getByRole('button',{name:/^(Show more|查看更多)$/,exact:true});const less=recent.getByRole('button',{name:/^(Show less|收起)$/,exact:true});await rows.first().waitFor({timeout:60000});
// Direct activation isolates click paging from scroll-to-control auto loading.
const activate=async(button:any)=>{await page.waitForFunction((el:HTMLButtonElement)=>!el.disabled,await button.elementHandle());await button.evaluate((el:HTMLButtonElement)=>el.click());};
assert.equal(await rows.count(),10,'selected recent row outside the page does not change page size');assert.equal(await less.count(),0);assert.equal(await pinned.locator('.sidebar-activity-item').count(),6);
await activate(pinned.getByRole('button',{name:/^(Show more|查看更多)$/}));await page.waitForFunction(()=>document.querySelectorAll('[aria-label="Pinned"] .sidebar-activity-item, [aria-label="置顶"] .sidebar-activity-item').length===8);assert.equal(await pinned.locator('.sidebar-activity-item').count(),8);assert.equal(await rows.count(),10,'pinned paging is independent');
const typography=await more.evaluate(el=>({size:getComputedStyle(el).fontSize,color:getComputedStyle(el).color,height:el.getBoundingClientRect().height}));assert.equal(typography.size,'12px');assert.ok(typography.height>=(touch?44:30));
for(const count of [20,30,31]){await activate(more);await waitRows(count);assert.equal(await rows.count(),count);assert.equal(await less.count(),1);assert.equal(await pinned.locator('.sidebar-activity-item').count(),8);}
assert.equal(await more.count(),0);assert.equal(await recent.getByRole('status').innerText(),locale==='zh-CN'?'没有更多了':'No more conversations');const last=await rows.last().boundingBox();const bottom=await less.boundingBox();assert.ok(bottom!.y>=last!.y+last!.height-1,'controls follow last recent row');await less.scrollIntoViewIfNeeded();await page.screenshot({path:join(output,locale+'-'+theme+'-'+(touch?'touch':'desktop')+'.png')});await activate(less);assert.equal(await rows.count(),10);assert.equal(await less.count(),0);await activate(more);await waitRows(20);assert.equal(await rows.count(),20);await recent.getByRole('button',{name:/^(Recent|最近)$/,exact:true}).click();assert.equal(await more.isVisible(),false);await recent.getByRole('button',{name:/^(Recent|最近)$/,exact:true}).click();assert.equal(await rows.count(),20);await activate(less);
// Reaching the boundary reveals a page without another wheel/touch event.
const scroll=page.locator(touch?'.shell-sidebar__scroll':'.sidebar-activity-list');
await scroll.evaluate(el=>{el.scrollTop=0;});await page.waitForTimeout(80);
const firstRow=await rows.first().elementHandle();
await page.evaluate(()=>{(window as any).busySeen=false;(window as any).spinnerSeen=false;new MutationObserver(records=>{const footer=document.querySelector('.sidebar-activity-pagination[aria-busy="true"]');if(footer?.querySelector('.is-spinning')&&footer.querySelector('button')?.disabled&&footer.querySelector('button')?.textContent==='')(window as any).spinnerSeen=true;for(const r of records)if((r.target as Element).getAttribute('aria-busy')==='true'||r.oldValue==='true')(window as any).busySeen=true;}).observe(document.querySelector('.sidebar-activity-list')!,{subtree:true,attributes:true,attributeFilter:['aria-busy'],attributeOldValue:true});});
await scroll.dispatchEvent('wheel',{deltaY:-20});await scroll.dispatchEvent('wheel',{deltaX:80,deltaY:5});await page.waitForTimeout(50);assert.equal(await rows.count(),10);
const topBefore=await scroll.evaluate(el=>{const bottom=el.scrollHeight-el.clientHeight;el.scrollTop=bottom;return bottom;});
await waitRows(20);await page.waitForTimeout(80);
assert.equal(await rows.count(),20,'scroll position alone loads exactly one page');
assert.equal(await firstRow!.evaluate(el=>el===document.querySelector('.sidebar-activity-group[aria-label="Recent"] .sidebar-activity-item, .sidebar-activity-group[aria-label="最近"] .sidebar-activity-item')),true,'existing row identity preserved');
const topAfter=await scroll.evaluate(el=>el.scrollTop);assert.ok(Math.abs(topAfter-topBefore)<2,`page reveal keeps scroll position ${touch}: ${topBefore} -> ${topAfter}`);
assert.equal(await page.evaluate(()=>(window as any).busySeen),true,'real transition publishes pending state');
assert.equal(await page.evaluate(()=>(window as any).spinnerSeen),true,'pending replaces label with spinner and disables the shared action');
await scroll.evaluate(el=>{el.scrollTop=0;});await page.waitForTimeout(30);assert.equal(await rows.count(),20,'upward scrolling does not load');
// Repeat with a real keyboard end scroll or native touch swipe.
if(touch){
 const box=await scroll.boundingBox();const x=box!.x+box!.width/2,y=box!.y+box!.height-80;
 // Start close enough that a single physical swipe reaches the existing end.
 await scroll.evaluate(el=>{el.scrollTop=el.scrollHeight-el.clientHeight-30;});await page.waitForTimeout(30);
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-100}]});
 await waitRows(30);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-150}]});
 assert.equal(await rows.count(),30,'one page per held touch');
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
}else{
 await scroll.evaluate(el=>{el.tabIndex=0;el.focus();});await page.keyboard.press('End');await waitRows(30);
}
await page.waitForTimeout(100);assert.equal(await rows.count(),30);
await scroll.evaluate(el=>{el.scrollTop=el.scrollHeight;});await waitRows(31);
assert.equal(await more.count(),0);assert.equal(await recent.getByRole('status').innerText(),locale==='zh-CN'?'没有更多了':'No more conversations');
await page.screenshot({path:join(output,locale+'-'+theme+'-'+(touch?'touch':'desktop')+'-auto.png')});
await activate(less);
// Move the same panel into another Shell host without remounting it.
await page.evaluate(()=>{
 const panel=document.querySelector('.sidebar-panel')!;const old=panel.closest('.shell-sidebar__column')!;
 const column=old.cloneNode(false) as HTMLElement;column.classList.add('owner-probe');column.style.position='fixed';column.style.inset='0';
 const scroll=document.createElement('div');scroll.className='shell-sidebar__scroll';column.append(scroll);old.parentElement!.append(column);scroll.append(panel);
});
const movedScroll=page.locator(touch?'.owner-probe .shell-sidebar__scroll':'.owner-probe .sidebar-activity-list');
await movedScroll.evaluate(el=>{el.scrollTop=0});await page.waitForTimeout(30);
await movedScroll.evaluate(el=>{el.scrollTop=el.scrollHeight});await waitRows(20);
assert.equal(await rows.count(),20,'scroll arrival follows retained panel into new Shell owner');
await activate(less);
for(const count of [10,11,0]){await page.evaluate(n=>(window as any).setCount(n),count);await page.waitForTimeout(30);assert.equal(await rows.count(),Math.min(count,10));assert.equal(await more.count(),count>10?1:0);assert.equal(await less.count(),0);}
assert.deepEqual(errors,[]);await page.close();}
console.log(JSON.stringify({passed:true,output}));}finally{await browser?.close();await vite.close();}
