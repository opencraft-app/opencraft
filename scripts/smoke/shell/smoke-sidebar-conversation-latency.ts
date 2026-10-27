import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const output = process.env.OPENCRAFT_SIDEBAR_UPDATE_OUTPUT ?? "/tmp/opencraft-sidebar-conversation-latency";
const sampleCount = Number(process.env.OPENCRAFT_PERFORMANCE_SAMPLES ?? 3);
assert.ok(Number.isSafeInteger(sampleCount) && sampleCount >= 3 && sampleCount <= 100);
const initialMatchingCount = (rows: number) => Array.from({length: rows}, (_, i) => `Conversation ${i}`).filter(title => title.includes("Conversation 1")).length;
const source = `
import React,{useState,useMemo,useCallback} from 'react';
import {useSidebarCommands} from '/apps/workbench-web/src/components/use-sidebar-commands.ts';
import * as Popover from '@radix-ui/react-popover';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async()=>{}});
const count=Number(new URL(location.href).searchParams.get('rows')||200);
const initial=Array.from({length:count},(_,i)=>({id:'t'+i,title:'Conversation '+i,project:'workspace',status:'ready',updatedAt:Date.now()/1000-i,connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
let snapshot={revision:0,mode:'creator',modes:[{id:'creator',label:'By creator'}],hideRowBadge:false,notice:null};
const listeners=new Set();const publish=patch=>{snapshot={...snapshot,...patch,revision:snapshot.revision+1};for(const listener of listeners)listener()};
const grouping={id:'probe',getSnapshot:()=>snapshot,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},watch:()=>()=>{},project:refs=>{window.projections++;return[{id:'all',label:'All conversations',avatarUrl:null,collapsed:false,threads:refs}]},setMode:mode=>publish({mode}),toggleGroup:()=>{}};
// Synthetic badge content; the controlled plugin contract and Radix popover are real.
const badge={id:'probe',Component:({threadId,open,onOpenChange,onCloseAutoFocus,portalContainer})=><Popover.Root open={open} onOpenChange={onOpenChange}><Popover.Trigger asChild><button aria-label={'People '+threadId}>People</button></Popover.Trigger><Popover.Portal container={portalContainer}><Popover.Content onCloseAutoFocus={onCloseAutoFocus}>Participants {threadId}</Popover.Content></Popover.Portal></Popover.Root>};
window.rowsProcessed=0;window.projections=0;window.actions=[];
const actions={onRename:async()=>{},onFork:async()=>{},onArchive:async()=>window.actions.push('archive'),onDelete:async()=>{},onSetPinned:async()=>window.actions.push('pin')};
const capabilities=()=>({pin:true,rename:true,fork:true,archive:true,delete:true});
function App(){
 const[rows,setRows]=useState(initial);const[active,setActive]=useState('t0');const[tick,setTick]=useState(0);
 const[title,setTitle]=useState(null);const[canRename,setCanRename]=useState(true);
 const[canPin,setCanPin]=useState(true);
 const commands=useSidebarCommands({
  threadActions:{...actions,onArchive:async()=>window.actions.push(['archive',tick]),onSetPinned:canPin?async()=>window.actions.push(['pin',tick]):undefined},
  onSelectThread:(_,id)=>{window.actions.push(['select',tick,id]);setActive(id)},onNewTask:()=>window.actions.push(['new',tick]),onOpenSettings:()=>window.actions.push(['settings',tick]),
  onRetryThreadCatalog:()=>window.actions.push(['retry',tick]),onRetryThreadCatalogDiscovery:()=>window.actions.push(['discovery',tick]),
 });
 const readTitle=useCallback((_,threadId)=>{window.rowsProcessed++;return threadId==='t0'?title:null},[title]);
 const readCapabilities=useCallback(()=>({...capabilities(),rename:canRename}),[canRename]);
 const catalogStates=useMemo(()=>[],[]);
 window.fixture={publish:()=>setTick(t=>t+1),setRows,setActive,initial,setThemePreference,setMode:grouping.setMode,setTitle,setCanRename,setCanPin};
 return <div style={{width:320,height:800,display:'flex'}}><Sidebar threads={rows} activeHostId='local' activeThreadId={active} sidebarLayout={layout}
  {...commands} threadBadge={badge} threadListGrouping={grouping} threadCapabilities={readCapabilities} pendingTitle={readTitle}
  threadCatalogs={catalogStates} showFooter={false}/></div>
}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;

const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-sidebar-menu-latency",
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "@radix-ui/react-context-menu", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@tanstack/react-query", "hoist-non-react-statics", "react-is", "scheduler"] },
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{
    name: "sidebar-menu-latency-fixture",
    resolveId: id => id === "/fixture.tsx" ? id : null,
    load: id => id === "/fixture.tsx" ? source : null,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/?")) return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>');
      });
    },
  }],
});
let browser: any;
const evidence: unknown[] = [];
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  const pw = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await pw.chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const rows of [30, 200]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 844 } });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=v=>v");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?rows=${rows}`);
    await page.locator(".sidebar-activity-item").first().waitFor();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const samples = [];
    for (let i = 0; i < sampleCount; i++) {
      const sample = await page.evaluate(async () => {
        const w = window as any;
        const before = { rows: w.rowsProcessed, projections: w.projections };
        const start = performance.now();
        w.fixture.publish();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return { ms: performance.now() - start, rowsProcessed: w.rowsProcessed - before.rows, projections: w.projections - before.projections };
      });
      assert.equal(sample.rowsProcessed,0,'conversation publication must not rebuild unrelated Sidebar rows');
      assert.equal(sample.projections,0,'conversation publication must not regroup the catalog');
      samples.push(sample);
    }
    const searchSamples = [];
    const search = page.getByRole('searchbox', { name: 'Search conversations', exact: true });
    const firstRow = page.locator('.sidebar-activity-item').first();
    await firstRow.evaluate(node => { (window as any).originalSearchRow = node; });
    for (let i = 0; i < sampleCount; i++) {
      const before = await page.evaluate(() => ({ rows: (window as any).rowsProcessed, start: performance.now() }));
      await search.fill(i % 2 ? 'Conversation ' : 'conversation');
      const sample = await page.evaluate(async before => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { ms: performance.now() - before.start, rowsProcessed: (window as any).rowsProcessed - before.rows };
      }, before);
      assert.equal(sample.rowsProcessed, 0, 'search retaining a row must not rebuild its menu and content');
      assert.equal(await firstRow.evaluate(node => node === (window as any).originalSearchRow), true);
      assert.equal(await search.evaluate(node => node === document.activeElement), true, 'search keeps focus');
      searchSamples.push(sample);
    }
    await search.fill('Conversation 1');
    assert.equal(await page.locator('.sidebar-activity-item').count(), initialMatchingCount(rows));
    await search.fill('');
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
    // Cached command identity still dispatches to the latest committed render.
    await page.locator('.sidebar-activity-item').first().click({button:'right'});
    await page.getByRole('menuitem',{name:'Archive',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>(window as any).actions),[['archive',sampleCount]]);
    await page.evaluate(()=>(window as any).fixture.setTitle('Renamed in flight'));
    await page.getByText('Renamed in flight',{exact:true}).first().waitFor();
    await page.evaluate(()=>(window as any).fixture.setCanRename(false));
    await page.locator('.sidebar-activity-item').first().click({button:'right'});
    await page.getByRole('menu').waitFor();
    assert.equal(await page.getByRole('menuitem',{name:'Rename',exact:true}).count(),0);
    await page.keyboard.press('Escape');
    // Optional pin support must invalidate the action object when it changes.
    await page.evaluate(()=>(window as any).fixture.setCanPin(false));
    await page.locator('.sidebar-activity-item').first().click({button:'right'});
    await page.getByRole('menu').waitFor();
    assert.equal(await page.getByRole('menuitem',{name:'Pin',exact:true}).count(),0);
    await page.keyboard.press('Escape');
    await page.locator('.sidebar-activity-item').nth(1).click();
    assert.deepEqual((await page.evaluate(()=>(window as any).actions))[1],['select',sampleCount,'t1']);
    await page.evaluate(()=>(window as any).fixture.setRows((window as any).fixture.initial.filter((r:any)=>r.id!=='t0')));
    await page.waitForFunction(count=>document.querySelectorAll('.sidebar-activity-item').length===count-1,rows);
    assert.deepEqual(errors,[]);evidence.push({rows,samples,searchSamples});await page.close();
  }
  await writeFile(output+'/results.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser?.close();await vite.close()}
