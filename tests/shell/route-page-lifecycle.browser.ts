import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
import { navigationLifecycleFixture as source } from "../fixtures/navigation-lifecycle";
const output = resolve(process.env.OPENCRAFT_NAVIGATION_LIFECYCLE_OUTPUT ?? ".local/navigation-lifecycle-evidence");
// Actual Shell, IM views and Router; account/RPC transport is synthetic.

// Fixed-size pages expose retained DOM growth independently of network data.
const memorySource = "\nimport React,{useState}from'react';import{createRoot}from'react-dom/client';import{useMotionValue}from'motion/react';import{RouteStackMotion}from'/apps/workbench-web/src/components/route-stack-motion.tsx';import{RouteViewStack}from'/apps/workbench-web/src/components/route-view-stack.tsx';import'/apps/workbench-web/src/styles/app.scss';\nfunction App(){const[depth,setDepth]=useState(1),[scope,setScope]=useState(0),pageX=useMotionValue(0);window.depth=setDepth;window.resetScope=()=>setScope(x=>x+1);const path=Array.from({length:depth},(_,i)=>({id:'p'+i,route:{kind:'extension-view',viewId:'p'+i,resourceUri:null},routeScopeId:'scope'}));return <div style={{position:'absolute',inset:0}}><RouteStackMotion key={scope} current={'p'+(depth-1)} path={path.map(p=>p.id)} pageX={pageX} overlay={null}><RouteViewStack key={scope} navigation={{navigationPath:path,applicationRoute:path.at(-1).route,routeScopeId:'scope'}}><div data-page={depth}>{Array.from({length:500},(_,i)=><p key={i}>Retained page {depth} row {i}</p>)}</div></RouteViewStack></RouteStackMotion></div>};createRoot(document.getElementById('root')).render(<App/>);\n";
const server=await createServer({root:process.cwd(),configFile:false,cacheDir:'node_modules/.vite-page-lifecycle',publicDir:process.cwd()+'/apps/workbench-web/public',logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['prosemirror-state','prosemirror-view','prosemirror-model','prosemirror-transform','prosemirror-commands','prosemirror-history','prosemirror-keymap','prosemirror-inputrules','prosemirror-schema-list','@dnd-kit/core','@dnd-kit/sortable','@dnd-kit/utilities','react','react-dom','react-dom/client','react/jsx-runtime','motion/react','@tanstack/react-query','react-intl','@radix-ui/react-dialog','@radix-ui/react-dropdown-menu','@radix-ui/react-popover','@radix-ui/react-alert-dialog','tslib']},plugins:[{name:'navigation-probe',resolveId:id=>id==='/navigation-probe.tsx'||id==='/memory-probe.tsx'?id:null,load:id=>id==='/navigation-probe.tsx'?source:id==='/memory-probe.tsx'?memorySource:null,configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/@')||req.url?.startsWith('/node_modules')||req.url?.startsWith('/apps/')||req.url?.startsWith('/packages/')||req.url?.startsWith('/plugins/')||req.url?.startsWith('/memory-probe.tsx')||req.url?.startsWith('/navigation-probe.tsx')||req.url?.startsWith('/products/'))return next();if(req.headers.accept?.includes('text/html')){res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="'+(req.url?.startsWith('/memory')?'/memory-probe.tsx':'/navigation-probe.tsx')+'"></script>')}else next()})}}]});

let browser: any;
try {
  await mkdir(output, { recursive: true }); await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const url = server.resolvedUrls!.local[0]!;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage(); const errors: string[] = [];
  await page.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(url); await page.getByRole('button', {name:'Open Inbox',exact:true}).click();
  await page.getByRole('button',{name:/Navigation group 0\b/}).first().tap();
  await page.locator('.im-channel-chat__conversation').waitFor();
  const cdp = await context.newCDPSession(page);
  const send = (type: string, x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type==='touchEnd'||type==='touchCancel'?[]:[{x,y,id:1}] });
  const destinations: unknown[] = [];
  for (const group of [1,2,3]) {
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.page-stack > .page-stack__live')!.inert);
    await send('touchStart',70,330);
    for (const x of [110,150,190,230,270,310]) { await send('touchMove',x,330); await page.waitForTimeout(25); }
    await send('touchEnd',310,330);
    await page.waitForFunction(() => (window as any).navigationProbe.getSnapshot().applicationRoute.viewId==='opencraft.im.people');
    const target = await page.evaluate(group => {
      const root=document.querySelector('.page-stack > .page-stack__live')!;
      const row=[...root.querySelectorAll<HTMLButtonElement>('.people-page--inbox button')].find(x=>x.textContent?.includes('Navigation group '+group)&&x.getBoundingClientRect().width>0)!;
      const box=row.getBoundingClientRect(),x=90,y=box.y+box.height/2;
      return {x,y,hit:row.contains(document.elementFromPoint(x,y)),owners:[...(window as any).routeOwners]};
    },group);
    assert.equal(target.hit,true,'the revealed parent must own its visible rows');
    assert.deepEqual(target.owners,[null],'the parent is the sole live renderer after semantic return');
    const accepted=await page.evaluate(()=>(window as any).returnReceipts.at(-1));
    assert.ok(accepted.x>0&&accepted.x<accepted.width*.9,JSON.stringify(accepted));
    await send('touchStart',target.x,target.y); await page.waitForTimeout(60); await send('touchEnd',target.x,target.y);
    await page.waitForFunction(group => (window as any).navigationProbe.getSnapshot().url.includes('opencraft-channel%3Ag'+group),group);
    await page.waitForTimeout(650);
    const receipt=await page.evaluate(() => ({url:(window as any).navigationProbe.getSnapshot().url,title:document.querySelector('.page-stack > .page-stack__live .app-shell-header__route')?.textContent,owners:[...(window as any).routeOwners]}));
    assert.ok(receipt.title?.includes('Navigation group '+group));
    assert.deepEqual(receipt.owners,['opencraft-channel:g'+group]); destinations.push(receipt);
  }
  assert.deepEqual(errors,[]); await page.screenshot({path:resolve(output,'correct-destination.png')});
  await context.close();
  const memoryContext=await browser.newContext({viewport:{width:390,height:844}}), memoryPage=await memoryContext.newPage();
  await memoryPage.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
  await memoryPage.goto(url+'memory'); await memoryPage.waitForFunction(()=>!!(window as any).depth);
  const heap=await memoryContext.newCDPSession(memoryPage); const counts: {depth:number;nodes:number;documents:number;jsEventListeners:number}[]=[];
  for(const depth of [1,2,3,4,5,6,7,8]) {
    await memoryPage.evaluate(depth=>(window as any).depth(depth),depth); await memoryPage.waitForTimeout(750);
    await heap.send('HeapProfiler.collectGarbage'); counts.push({depth,...await heap.send('Memory.getDOMCounters')});
  }
  const first=counts[2]!.nodes-counts[1]!.nodes,last=counts.at(-1)!.nodes-counts.at(-2)!.nodes;
  assert.ok(last/first<1.15,JSON.stringify({first,last,counts}));
  await memoryPage.evaluate(()=>(window as any).resetScope()); await memoryPage.waitForTimeout(750); await heap.send('HeapProfiler.collectGarbage');
  const cleared=await heap.send('Memory.getDOMCounters'); assert.ok(cleared.nodes<counts[0]!.nodes*1.4,JSON.stringify(cleared));
  await memoryContext.close();
  await writeFile(resolve(output,'evidence.json'),JSON.stringify({destinations,counts,cleared},null,2));
  console.log(JSON.stringify({correctDestinations:true,retiredChildEffects:true,linearSnapshotRetention:true,scopeClearsOldPages:true,output}));
} finally { await browser?.close(); await server.close(); }
