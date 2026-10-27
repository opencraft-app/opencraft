import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only the catalog/host boundary is synthetic; render the real Sidebar and preferences.
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import {UiPreferencesProvider,openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_,v)=>v});
const preferences=await openWorkbenchUiPreferences();
const now=new Date();now.setHours(12,0,0,0);const today=now.getTime()/1000;
const base={project:'opencraft',status:'ready',connectionHostId:'host',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'host',hostKind:'local',label:'Local'})};
const initial=[...Array.from({length:12},(_,i)=>({...base,id:'done'+i,title:'Done '+i,updatedAt:today-i,createdAt:1,unread:true})),
{...base,id:'older-run',title:'Older running',status:'running',createdAt:10,updatedAt:today-86400},
{...base,id:'newer-run',title:'Newer running',status:'running',createdAt:20,updatedAt:today-86400+1},
{...base,id:'pin',title:'Pinned running',status:'running',pinned:true,createdAt:1,updatedAt:today-86400},
{...base,id:'wait',title:'Waiting',status:'review',createdAt:1,updatedAt:today}];
function Fixture(){const [rows,setRows]=React.useState(initial);const [selected,select]=React.useState('done0');
window.patch=(id,values)=>setRows(rows=>rows.map(row=>row.id===id?{...row,...values}:row));
return <UiPreferencesProvider runtime={preferences}><div style={{width:320,height:'100vh',display:'flex',flexDirection:'column'}}><Sidebar threads={rows} activeHostId='host' activeThreadId={selected} sidebarLayout={layout} onSelectThread={(_,id)=>select(id)} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/><output data-selected>{selected}</output></div></UiPreferencesProvider>};
createIntlTestRoot(document.getElementById('root')).render(<Fixture/>);`;
const vite = await createServer({ configFile:false, root:process.cwd(), logLevel:'error', resolve:{dedupe:['react','react-dom']}, esbuild:{jsx:'automatic'}, server:{host:'127.0.0.1',port:0,hmr:false}, plugins:[{
  name:'active-order-fixture', resolveId:id=>id==='/fixture.tsx'?id:null, load:id=>id==='/fixture.tsx'?source:null,
  configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>');});},
}] });
let browser:any;
try {
  await vite.listen();
  const pw=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');
  browser=await (pw.default??pw).chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  const output=await mkdtemp(join(tmpdir(),'sidebar-active-order-'));
  for(const touch of [false,true]) for(const theme of ['light','dark']) {
    const page=await browser.newPage({viewport:{width:touch?390:1000,height:1000},hasTouch:touch,isMobile:touch});
    const errors:string[]=[]; page.on('pageerror',(e:Error)=>errors.push(e.message));
    await page.addInitScript(t=>{(window as any).__name=(v:any)=>v;localStorage.setItem('opencraft.appearance-theme',t);},theme);
    await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port);
    const recent=page.getByRole('region',{name:'Recent',exact:true});
    const rows=recent.locator('.sidebar-activity-item');
    await rows.first().waitFor({timeout:60000});
    // Read the visible title text independent of title truncation markup.
    const order=()=>rows.evaluateAll((nodes:any[])=>nodes.map(n=>n.textContent));
    let text=await order();assert.equal(text.length,10);assert.match(text[0],/Newer running/);assert.match(text[1],/Older running/);
    assert.equal(await page.getByRole('region',{name:'Pinned',exact:true}).locator('.sidebar-activity-item').count(),1);
    assert.equal(await page.getByRole('region',{name:'Needs your attention',exact:true}).locator('.sidebar-activity-item').count(),1);
    const patch=async(id:string,values:object)=>{await page.evaluate(([id,v])=>(window as any).patch(id,v),[id,values]);};
    await patch('older-run',{updatedAt:new Date().setHours(20,0,0,0)/1000});
    await page.waitForFunction(()=>document.querySelector('[data-selected]')?.textContent==='done0');
    await page.waitForFunction(()=>document.querySelector('[aria-label="Recent"] .sidebar-activity-item')?.textContent?.includes('Older running'));
    assert.match((await order())[0],/Older running/);
    await patch('newer-run',{status:'ready',updatedAt:new Date().setHours(21,0,0,0)/1000});
    await page.waitForFunction(()=>document.querySelector('[aria-label="Recent"] .sidebar-activity-item')?.textContent?.includes('Older running'));
    text=await order();assert.match(text[0],/Older running/);assert.match(text[1],/Newer running/);
    await patch('newer-run',{unread:false});assert.deepEqual(await order(),text);
    await patch('older-run',{status:'ready',updatedAt:1});
    await page.waitForFunction(()=>document.querySelector('[aria-label="Recent"] .sidebar-activity-item')?.textContent?.includes('Newer running'));
    assert.ok(!(await order()).some(t=>t.includes('Older running')),'completed old row falls outside first page');
    await recent.getByRole('button',{name:'Show more',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('[aria-label="Recent"] .sidebar-activity-item').length===14);
    assert.equal(await rows.count(),14);assert.match((await order()).at(-1)!,/Older running/);
    await recent.getByRole('button',{name:'Show less',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('[aria-label="Recent"] .sidebar-activity-item').length===10);
    assert.equal(await rows.count(),10);
    assert.equal(await page.locator('[data-selected]').textContent(),'done0');
    if(touch) await rows.first().tap(); else await rows.first().click();
    await page.waitForFunction(()=>document.querySelector('[data-selected]')?.textContent==='newer-run');
    assert.deepEqual(errors,[]);await page.screenshot({path:join(output,theme+(touch?'-touch':'-desktop')+'.png')});await page.close();
  }
  console.log(JSON.stringify({passed:true,output}));
} finally {await browser?.close();await vite.close();}
