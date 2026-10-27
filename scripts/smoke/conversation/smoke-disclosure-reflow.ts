import assert from "node:assert/strict";
import { createServer } from "vite";

const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const source = `
import React,{useEffect,useLayoutEffect,useRef,useState}from'react';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{ActivityDisclosure}from'/apps/workbench-web/src/components/conversation-renderers/activity/activity-disclosure.tsx';
import{AgentActivityGroupDisclosure}from'/apps/workbench-web/src/components/agent-activity-group-disclosure.tsx';
import{AgentActivity}from'/apps/workbench-web/src/components/conversation-renderers/activity/agent-activity-renderers.tsx';
import{DisclosureReflowContext}from'/apps/workbench-web/src/components/use-disclosure-reflow.ts';
import{createWebConversationViewportOwner}from'/packages/timeline-host-web/src/index.ts';
import{VirtualizedConversationTurns}from'/apps/workbench-web/src/components/conversation/virtualized-conversation-turns.tsx';
import'/apps/workbench-web/src/styles/app.scss';
function App(){
 const [owner]=useState(()=>createWebConversationViewportOwner(0));
 const [kind,setKind]=useState('group'),[height,setHeight]=useState(4000),[open,setOpen]=useState(false),[shown,setShown]=useState(true);
 const [virtualized,setVirtualized]=useState(true);
 const entries=React.useMemo(()=>['before','one','after'].map(id=>({type:'turn',turnKey:id,turnId:id,frames:[],status:'completed'})),[]);
 const leases=useRef([]).current;
 const acquire=React.useCallback(anchor=>{
  const lease=owner.beginReflowAnchor(anchor);if(!lease)return null;
  const entry={completed:false,cancelled:false};leases.push(entry);
  return{complete(){entry.completed=true;lease.complete()},cancel(){entry.cancelled=true;lease.cancel()}};
 },[owner,leases]);
 const attach=React.useCallback(el=>owner.attachScrollElement(el),[owner]);
 useEffect(()=>owner.bindScrollBehavior({}),[owner]);
 useEffect(()=>()=>owner.dispose(),[owner]);
 window.fixture={owner,leases,configure(nextKind,nextHeight,nextVirtualized=true){setShown(false);setKind(nextKind);setHeight(nextHeight);setOpen(false);setVirtualized(nextVirtualized)},show(){setShown(true)},hide(){setShown(false)},grow(){setHeight(h=>h+300)}};
 const item={type:'worked-for',status:'worked',startedAtMs:0,completedAtMs:342000};
 const contentUnits=[{type:'worked-for',id:'fixture-work',item}];
 const unit={type:'agent-activity',id:'fixture-work',blocks:[],collapsedItemCount:1,status:'complete',segmentEnd:'final-answer',contentUnits,inlineSubagentActivity:null,partitions:{workedForItem:item,collapsibleUnits:contentUnits,expandedUnits:contentUnits,persistentUnits:[],preToggleUnits:[]},hasFinalAssistantStarted:true,hasRenderableAgentItems:true,isTurnCancelled:false,forceExpanded:false,disableCollapse:false,preventAutoCollapse:false,phase:'before-final-answer',workedDurationMs:342000};
 const turn=<div data-turn-key="one" style={{flex:'none'}}>
    <div style={{height:700.35}}/>
    <div id="disclosure"><React.StrictMode>{shown?(kind==='group'?<AgentActivityGroupDisclosure summary="Read files and ran commands" summaryKey="fixture"><div style={{height}}><button data-group-action>Tool action</button></div></AgentActivityGroupDisclosure>:kind==='worked'?<AgentActivity persistedCollapsed={!open} onCollapsedChange={collapsed=>setOpen(!collapsed)} unit={unit} innerCollapsedById={{}} onInnerCollapsedChange={()=>{}}/>:<ActivityDisclosure icon={null} summary={kind==='read'?'Read file':'Bash command'} running={false} open={open} onOpenChange={setOpen} unmountBodyWhenCollapsed={kind==='bash'}><div style={{height}}/></ActivityDisclosure>):null}</React.StrictMode></div>
    <div id="after" style={{height:1000}}/>
   </div>;
 return <DisclosureReflowContext.Provider value={acquire}>
  <style>{'#disclosure .thread-agent-activity__content{height:'+height+'px}'}</style>
  <div id="scroll" ref={attach} onClickCapture={e=>owner.captureReflowAnchor(e.target)} style={{height:500,overflow:'auto',display:'flex',flexDirection:'column-reverse',overflowAnchor:'none',border:'1px solid transparent'}}>
   <div style={{flex:'none'}} data-thread-user-message-navigation-content="true">
    {virtualized?<VirtualizedConversationTurns entries={entries} timelineRevision={0} viewportOwner={owner} initialRestoreState={null} initialDistanceFromBottomPx={0} preserveMeasuredTurnViewport onApiChange={()=>{}} renderTurn={entry=>entry.turnKey==='one'?turn:<div data-turn-key={entry.turnKey} style={{height:450.35}}/>}/>:turn}
   </div>
  </div>
 </DisclosureReflowContext.Provider>;
}
document.documentElement.style.setProperty('--opencraft-chat-line-height','24px');
createIntlTestRoot(document.getElementById('root')).render(<App/>);
`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-disclosure-reflow-smoke",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "disclosure-reflow-smoke",
    resolveId: id => id === "/disclosure-probe.tsx" ? id : null,
    load: id => id === "/disclosure-probe.tsx" ? source : null,
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("content-type", "text/html");
        response.end('<div id="root"></div><script type="module" src="/disclosure-probe.tsx"></script>');
      });
    },
  }],
});
let browser: any;
const evidence: unknown[] = [];
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
   for (const touch of [false, true]) {
    const page = await browser.newPage({ viewport: { width: touch ? 390 : 1400, height: 700 },
      hasTouch: touch, deviceScaleFactor: touch ? 2 : 1, reducedMotion });
    const activate = () => touch ? heading.tap() : heading.click();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name = value => value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
    const heading = page.locator("#disclosure button[aria-expanded]").first();
    const settleLayout = () => page.evaluate(() => new Promise<void>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const alignHeading = () => page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>("#scroll")!;
      scroll.scrollTop += document.querySelector<HTMLElement>("#disclosure button")!.getBoundingClientRect().top - 240;
    });
    const growBody = async () => {
      const height = await page.locator("#disclosure .thread-agent-activity__content").evaluate((element: HTMLElement) => element.getBoundingClientRect().height);
      await page.evaluate(() => (window as any).fixture.grow());
      await page.waitForFunction((height: number) =>
        document.querySelector("#disclosure .thread-agent-activity__content")!.getBoundingClientRect().height === height + 300, height);
      await settleLayout();
    };
    await heading.waitFor();
    for (const [kind, height] of [["group", 80], ["group", 200], ["group", 4000], ["read", 2000], ["bash", 4000], ["worked", 2000]] as const) {
      await page.evaluate(([kind, height]) => (window as any).fixture.configure(kind, height), [kind, height]);
      await page.waitForTimeout(40);
      await page.evaluate(() => (window as any).fixture.show());
      await heading.waitFor();
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        const scroll = document.querySelector<HTMLElement>("#scroll")!;
        const heading = document.querySelector<HTMLElement>("#disclosure button[aria-expanded]")!;
        scroll.scrollTop += heading.getBoundingClientRect().top - 240;
      });
      for (const opening of [true, false]) {
        await page.evaluate(() => {
          const anchor = document.querySelector<HTMLElement>("#disclosure button[aria-expanded]")!;
          const label = document.querySelector<HTMLElement>("#disclosure .thread-activity-item__summary")
            ?? anchor.parentElement!;
          const initial = label.getBoundingClientRect().top;
          const samples: number[] = [];
          (window as any).samples = samples;
          const start = performance.now();
          const sample = () => requestAnimationFrame(() => setTimeout(() => {
            samples.push(label.getBoundingClientRect().top - initial);
            if (performance.now() - start < 650) sample();
          }, 0));
          sample();
        });
        await activate();
        if (kind === "group" && height === 80 && !opening && reducedMotion === "no-preference") {
          await heading.focus();
          await page.keyboard.press("Tab");
          assert.equal(await page.locator("[data-group-action]").evaluate(element => document.activeElement === element), false,
            "closing tool content must leave the Tab order immediately");
          assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[aria-hidden="true"]')), false);
        }
        await page.waitForTimeout(750);
        const observation = await page.evaluate(() => ({
          samples: (window as any).samples as number[],
          completed: (window as any).fixture.leases.at(-1)?.completed,
          expanded: document.querySelector("#disclosure button")?.getAttribute("aria-expanded"),
        }));
        assert.equal(observation.expanded, String(opening));
        assert.equal(observation.completed, true, `${kind} never finished its reflow lease`);
        const maxDrift = Math.max(...observation.samples.map(Math.abs));
        const peakToPeak = Math.max(...observation.samples) - Math.min(...observation.samples);
        assert.ok(maxDrift <= 0.02 && peakToPeak <= 0.02,
          JSON.stringify({ kind, height, reducedMotion, touch, opening, maxDrift, peakToPeak }));
        assert.equal(observation.samples.at(-1), 0);
        evidence.push({ kind, height, reducedMotion, touch, opening, maxDrift, peakToPeak,
          finalDrift: observation.samples.at(-1) });
        if (kind === "group" && height === 80 && opening) {
          await heading.focus();
          await page.keyboard.press("Tab");
          assert.equal(await page.locator("[data-group-action]").evaluate(element => document.activeElement === element), true,
            "expanded tool content must retain keyboard access");
          await heading.focus();
        }
      }
      // Reverse both opening and closing before their normal completion.
      await activate(); await page.waitForTimeout(70);
      await activate(); await page.waitForTimeout(70);
      await activate(); await page.waitForTimeout(600);
      assert.equal(await heading.getAttribute("aria-expanded"), "true");
      assert.equal(await page.evaluate(() => (window as any).fixture.leases.at(-1).completed), true);
      // Isolate local preservation from the virtualizer's normal growth policy.
      await page.evaluate(([kind,height]) => (window as any).fixture.configure(kind,height,false), [kind,height]);
      await page.waitForTimeout(40);
      await page.evaluate(() => (window as any).fixture.show());
      await heading.waitFor();
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        const scroll = document.querySelector<HTMLElement>("#scroll")!;
        scroll.scrollTop += document.querySelector<HTMLElement>("#disclosure button")!.getBoundingClientRect().top - 240;
      });
      await activate(); await page.waitForTimeout(600);
      // Once complete, later body growth must no longer pin this heading.
      const before = await heading.evaluate((element: HTMLElement) => element.getBoundingClientRect().top);
      await page.evaluate(() => (window as any).fixture.grow());
      await page.waitForTimeout(600);
      const after = await heading.evaluate((element: HTMLElement) => element.getBoundingClientRect().top);
      assert.ok(Math.abs(after - before) > 100, `${kind} retained its anchor after completion`);
    }
    // Keep a real viewport lease pending without an animation deadline, so a
    // later completion cannot conceal missing input/replacement cancellation.
    // The nonvirtualized control excludes ordinary Turn growth compensation.
    await alignHeading(); await settleLayout();
    const pinnedTop = await heading.evaluate((element: HTMLElement) => element.getBoundingClientRect().top);
    await page.evaluate(() => {
      const fixture = (window as any).fixture;
      if (!fixture.owner.beginReflowAnchor(document.querySelector("#disclosure button"))) throw new Error("Missing real viewport lease");
    });
    await growBody();
    assert.equal(await heading.evaluate((element: HTMLElement) => element.getBoundingClientRect().top), pinnedTop,
      "pending real viewport lease must compensate actual body growth");
    if (touch) {
      await page.touchscreen.tap(200, 350);
    } else {
      await page.mouse.move(200, 350);
      await page.mouse.wheel(0, -120);
      await page.waitForFunction((top: number) => Math.abs(document.querySelector("#disclosure button")!.getBoundingClientRect().top - top) > 40, pinnedTop);
      await settleLayout();
      assert.ok(Math.abs(await heading.evaluate((element: HTMLElement) => element.getBoundingClientRect().top) - pinnedTop) > 40,
        "wheel takeover must remain visible after viewport frames");
    }
    const inputTop = await heading.evaluate((element: HTMLElement) => element.getBoundingClientRect().top);
    await growBody();
    const growthTop = await heading.evaluate((element: HTMLElement) => element.getBoundingClientRect().top);
    assert.ok(Math.abs(growthTop - inputTop) > 100,
      `user input must retire the local anchor before later growth: ${JSON.stringify({ touch, reducedMotion, inputTop, growthTop, pinnedTop })}`);

    await alignHeading(); await settleLayout();
    const detachedTop = await heading.evaluate((element: HTMLElement) => element.getBoundingClientRect().top);
    await page.evaluate(() => {
      const fixture = (window as any).fixture;
      fixture.owner.beginReflowAnchor(document.querySelector("#disclosure button"));
      fixture.owner.attachScrollElement(null);
    });
    await growBody();
    assert.ok(Math.abs(await heading.evaluate((element: HTMLElement) => element.getBoundingClientRect().top) - detachedTop) > 100,
      "detaching the viewport must release its anchor even while the old DOM stays connected");
    await page.evaluate(() => (window as any).fixture.owner.attachScrollElement(document.querySelector("#scroll")));

    await page.evaluate(() => (window as any).fixture.configure("worked", 2000, false));
    await heading.waitFor({ state: "hidden" });
    await page.evaluate(() => (window as any).fixture.show()); await heading.waitFor();
    await alignHeading(); await activate();
    await page.evaluate(() => (window as any).fixture.hide());
    await heading.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => (window as any).fixture.leases.at(-1).cancelled), true,
      "actual disclosure hook teardown must cancel its lease");
    evidence.push({ reducedMotion, touch, input: touch ? "touch-pointer" : "wheel",
      pendingAnchor: true, inputRetirement: true, viewportDetachment: true, controlUnmount: true });
    assert.deepEqual(errors, []);
    await page.close();
   }
  }
  console.log(JSON.stringify({ result: "passed", evidence }));
} finally {
  await browser?.close();
  await vite.close();
}
