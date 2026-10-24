import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const source=`
import React from 'react';import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {QueryClient} from '@tanstack/react-query';
import {ThreadPinWriter} from '/apps/workbench-web/src/runtime/thread-pin-writer.ts';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import {UiPreferencesProvider,openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import '/apps/workbench-web/src/styles/app.scss';initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_,v)=>v});const preferences=await openWorkbenchUiPreferences();
const makeRows=(n)=>[...Array.from({length:n},(_,i)=>({id:'pin'+i,title:'Pinned '+String(i+1).padStart(2,'0'),pinned:true})),{id:'recent',title:'Recent conversation'}].map((row,i)=>({...row,project:'opencraft',status:'ready',connectionHostId:'host',connectionHostLabel:'Local',updatedAt:Date.now()/1000-i,...legacyDirectServerProjectionFromHost({hostId:'host',hostKind:'local',label:'Local'})}));
function Fixture(){
const [rows,setRows]=React.useState(makeRows(19));
const [query]=React.useState(()=>new QueryClient());
const queryKey=['appserver','host','threads','sidebar'];
const [writer]=React.useState(()=>new ThreadPinWriter(query,{capture:()=>()=>true,persist:async(key,pinned)=>{
 await new Promise((resolve,reject)=>{window.finishPin=fail=>fail?reject(new Error('denied')):resolve()});
 setRows(previous=>{const next=previous.map(row=>row.id===key.threadId?{...row,pinned}:row);query.setQueryData(queryKey,{data:next});return next});
}}));
React.useSyncExternalStore(writer.subscribe,writer.getSnapshot,writer.getSnapshot);
window.setCount=n=>{const next=makeRows(n);query.setQueryData(queryKey,{data:next});setRows(next)};
const actions={onRename:async()=>{},onFork:async()=>{},onArchive:async()=>{},onDelete:async()=>{},onSetPinned:(key,pinned)=>writer.set(key,pinned)};
return <UiPreferencesProvider runtime={preferences}><div style={{width:320,height:'100vh',display:'flex',flexDirection:'column'}}><Sidebar threads={rows.map(row=>writer.project({hostId:'host',threadId:row.id},row))} activeHostId='host' activeThreadId='recent' sidebarLayout={layout} threadActions={actions} threadCapabilities={()=>({pin:true})} onSelectThread={()=>{}} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/></div></UiPreferencesProvider>};createIntlTestRoot(document.getElementById('root'),undefined,new URLSearchParams(location.search).get('locale')??'en-US').render(<Fixture/>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'fixture',resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>')})}}]});
let browser:any;
try{await vite.listen();const pw=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');const {chromium}=pw.default??pw;browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});const output=await mkdtemp(join(tmpdir(),'sidebar-pinned-pages-'));
for(const touch of [false,true])for(const theme of ['light','dark'])for(const locale of ['en-US','zh-CN']){
const page=await browser.newPage({viewport:{width:touch?390:1000,height:900},hasTouch:touch,isMobile:touch});const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.addInitScript(t=>{(window as any).__name=(v:any)=>v;localStorage.setItem('opencraft.appearance-theme',t)},theme);await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port+'/?locale='+locale);
const pinned=page.getByRole('region',{name:/^(Pinned|置顶)$/,exact:true});const rows=pinned.locator('.sidebar-activity-item');const more=pinned.getByRole('button',{name:/^(Show more|查看更多)$/,exact:true});const less=pinned.getByRole('button',{name:/^(Show less|收起)$/,exact:true});try { await rows.first().waitFor({timeout:60000}); } catch(error) { await page.screenshot({path:join(output,'failure.png')}); console.error(JSON.stringify({touch,theme,locale,errors,body:await page.locator('body').innerText(),output})); throw error; }
const expectRows=async(count:number)=>{const until=Date.now()+5000;while(await rows.count()!==count&&Date.now()<until)await page.waitForTimeout(16);assert.equal(await rows.count(),count);};
const activate=async(button:any)=>{if(touch)await button.tap();else{await button.focus();await button.press('Enter');}};
assert.equal(await rows.count(),6);assert.equal(await less.count(),0);
if(locale==='zh-CN')assert.equal(await page.locator('.sidebar-list-toolbar > span').innerText(),'协同对话');
const typography=await more.evaluate(el=>{const probe=document.createElement('span');probe.style.color='var(--color-text-tertiary)';el.parentElement!.append(probe);const expected=getComputedStyle(probe).color;probe.remove();const style=getComputedStyle(el),heading=getComputedStyle(document.querySelector('.sidebar-list-toolbar > span')!);return {size:parseFloat(style.fontSize),headingSize:parseFloat(heading.fontSize),weight:style.fontWeight,color:style.color,expected,height:el.getBoundingClientRect().height}});assert.ok(typography.size<typography.headingSize);assert.equal(typography.weight,'400');assert.equal(typography.color,typography.expected);assert.ok(typography.height>=30);console.log(JSON.stringify({touch,theme,locale,typography}));

for(const count of [12,18,19]){await activate(more);await expectRows(count);assert.equal(await less.count(),1);assert.equal(await page.locator('.sidebar-activity-item').filter({hasText:'Recent conversation'}).count(),1);}
assert.equal(await more.count(),0);const last=await rows.last().boundingBox();const bottom=await less.boundingBox();assert.ok(bottom!.y>=last!.y+last!.height-1,'controls follow last pin');await less.scrollIntoViewIfNeeded();await page.screenshot({path:join(output,locale+'-'+theme+'-'+(touch?'touch':'desktop')+'.png')});await activate(less);await expectRows(6);assert.equal(await less.count(),0);await activate(more);await expectRows(12);await pinned.getByRole('button',{name:/^(Pinned|置顶)$/,exact:true}).click();assert.equal(await more.isVisible(),false);await pinned.getByRole('button',{name:/^(Pinned|置顶)$/,exact:true}).click();assert.equal(await rows.count(),12);await activate(less);
for(const count of [6,7,0]){await page.evaluate(n=>(window as any).setCount(n),count);await page.waitForTimeout(30);assert.equal(await rows.count(),Math.min(count,6));assert.equal(await more.count(),count>6?1:0);assert.equal(await less.count(),0);}
// A deliberately stalled metadata write must not stall membership feedback.
const menuTrigger=page.locator('.sidebar-activity-row').filter({has:page.getByRole('button',{name:/Recent conversation/,exact:false})}).locator('.sidebar-activity-item__menu-trigger');
await activate(menuTrigger);await page.getByRole('menuitem',{name:/^(Pin|置顶)$/,exact:true}).click();
await rows.first().waitFor();assert.equal(await rows.count(),1,'pin paints before metadata acknowledgement');
await page.evaluate(()=>(window as any).finishPin(true));await rows.first().waitFor({state:'hidden'});
await activate(menuTrigger);await page.getByRole('menuitem',{name:/^(Pin|置顶)$/,exact:true}).click();
await rows.first().waitFor();await page.evaluate(()=>(window as any).finishPin(false));
await page.waitForTimeout(50);assert.equal(await rows.count(),1);
await activate(menuTrigger);await page.getByRole('menuitem',{name:/^(Unpin|取消置顶)$/,exact:true}).click();
await rows.first().waitFor({state:'hidden'});await page.evaluate(()=>(window as any).finishPin(false));
assert.deepEqual(errors,[]);await page.close();}
console.log(JSON.stringify({passed:true,output}));}finally{await browser?.close();await vite.close();}
