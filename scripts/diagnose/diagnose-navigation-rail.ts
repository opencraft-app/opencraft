import assert from "node:assert/strict";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {UserMessageNavigationRail} from '/apps/workbench-web/src/components/user-message-navigation-rail.tsx';
import '/apps/workbench-web/src/styles/app.scss';
const anchors=Array.from({length:100},(_,i)=>({id:'anchor-'+i,itemId:'item-'+i,turnKey:'turn-'+i,order:i,label:'Prompt '+i,isLoaded:true,isHeartbeat:false}));
const api={positionTarget:async()=> 'positioned'};
let releasePreview;
function makeSource(generation) {
 const snapshot={revision:1,phase:'ready',generation,completeness:'complete',anchors,error:null};
 return {getSnapshot:()=>snapshot,subscribe:()=>()=>{},prepare:async()=>{},
 loadPreview:()=>new Promise(resolve=>{releasePreview=()=>resolve({label:generation+' old preview',response:'',outputs:[]})}),prepareTarget:async()=>null,dispose:()=>{}};
}
const sourceA=makeSource('A'),sourceB=makeSource('B');
function App(){
 const scroll=React.useRef(null);
 const [wide,setWide]=React.useState(false),[tick,setTick]=React.useState(0),[source,setSource]=React.useState(sourceA);
 const stableGet=React.useCallback(()=>scroll.current,[]);
 const inline=new URLSearchParams(location.search).has('inline');
 React.useLayoutEffect(()=>{scroll.current.scrollTop=scroll.current.scrollHeight},[]);
 window.probe={show:()=>setWide(true),hide:()=>setWide(false),rerender:()=>setTick(x=>x+1),switchSource:()=>setSource(sourceB),resolvePreview:()=>releasePreview?.()};
 return <div style={{position:'relative',height:400,width:900}} data-tick={tick}>
 <div ref={scroll} style={{height:400,overflow:'auto'}}>
 <div data-thread-user-message-navigation-content style={{marginLeft:wide?80:0}}>
 {anchors.map(a=><section key={a.id} data-turn-key={a.turnKey} style={{height:100}}><div data-content-search-unit-key={a.itemId}>Prompt {a.order}</div></section>)}
 </div></div>
 <UserMessageNavigationRail source={source} getScrollElement={inline?()=>scroll.current:stableGet} virtualizedTurnListApi={api}/>
 </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  cacheDir: "node_modules/.vite-navigation-diagnosis", server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "navigation-rail-diagnosis",
    resolveId: id => id === "/rail-probe.tsx" ? id : null,
    load: id => id === "/rail-probe.tsx" ? fixture : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/?")) return next();
      res.setHeader("content-type", "text/html");
      res.end('<div id="root"></div><script type="module" src="/rail-probe.tsx"></script>');
    }); },
  }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript(`globalThis.__name=value=>value;
    window.observerCount=0; const Native=window.IntersectionObserver;
    window.IntersectionObserver=class extends Native {constructor(...args){super(...args);window.observerCount++}};`);
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  for (const mode of ["stable", "inline"]) {
    await page.goto(url + "/?" + mode);
    await page.waitForFunction(() => (window as any).probe);
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).probe.show());
    await page.locator(".conversation-navigation-rail").waitFor();
    await page.waitForTimeout(300);
    console.log(JSON.stringify({ mode, geometry: await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>(".conversation-navigation-rail__list")!;
      const active = list.querySelector<HTMLElement>('[aria-current="true"]')!;
      return { railScrollTop: list.scrollTop, railHeight: list.clientHeight, activeTop: active.offsetTop,
        activeInRail: active.offsetTop >= list.scrollTop && active.offsetTop < list.scrollTop + list.clientHeight,
        activeId: active.dataset.threadUserMessageNavigationItemId };
    }) }));
    const observersBefore = await page.evaluate(() => (window as any).observerCount);
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => (window as any).probe.rerender());
      await page.waitForTimeout(40);
    }
    console.log(JSON.stringify({ mode, observersCreatedByTenRenders: await page.evaluate(() => (window as any).observerCount) - observersBefore }));
    await page.locator('.conversation-navigation-rail__item').first().hover();
    await page.waitForTimeout(200);
    await page.evaluate(() => (window as any).probe.switchSource());
    await page.waitForTimeout(200);
    await page.evaluate(() => (window as any).probe.resolvePreview());
    await page.waitForTimeout(200);
    console.log(JSON.stringify({ mode, tooltipAfterSourceSwitch: await page.locator('[role="tooltip"]').textContent() }));
  }
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await vite.close(); }
