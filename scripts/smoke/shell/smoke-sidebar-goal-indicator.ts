import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const output = await mkdtemp(join(tmpdir(), "opencraft-sidebar-goal-"));
const source = `
import React,{useState,useSyncExternalStore}from'react';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{Sidebar}from'/apps/workbench-web/src/components/sidebar.tsx';
import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import{ThreadGoalResource,legacyDirectServerProjectionFromHost}from'@opencraft/workbench-runtime';
import{observeSidebarThreadGoals,sidebarGoalSignature}from'/apps/workbench-web/src/runtime/sidebar-thread-goals.ts';
import{initializeAppearanceTheme,setThemePreference,setAppearanceThemeId}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_scope,doc)=>doc});
const statuses={goal:'running',normal:'running',gap:'ready',review:'review',error:'error',unread:'ready'};
const goal=(id,status='active')=>({threadId:id,objective:'Synthetic objective',status,tokenBudget:null,tokensUsed:3,timeUsedSeconds:2,createdAt:1,updatedAt:2});
const calls=[];
const goals=new ThreadGoalResource({capability:()=>({version:1,read:true,write:false}),get:async id=>{calls.push(id);return{goal:['goal','gap','review','error'].includes(id)?goal(id):null}},set:async()=>{throw Error('No writes')},clear:async()=>{throw Error('No writes')}});
const goalSource={goals,threadIds:Object.keys(statuses),isCurrent:()=>true};
const subscribe=listener=>observeSidebarThreadGoals(goalSource,listener),read=()=>sidebarGoalSignature([goalSource]);
const badge={Component:({threadId})=><span style={{display:'inline-flex',width:threadId==='normal'?44:24,height:24,alignItems:'center',justifyContent:'center',borderRadius:12,background:'var(--color-surface-secondary)',color:'var(--color-text-tertiary)'}} aria-label='Synthetic participant'>{threadId==='normal'?'AB':'A'}</span>};
function App(){useSyncExternalStore(subscribe,read,read);const[pending,setPending]=useState(null);const[chosen,setChosen]=useState('goal');
window.fixture={setThemePreference,setAppearanceThemeId,update:(id,status)=>goals.observe(id,status===null?null:goal(id,status)),reset:()=>goals.reset(),setPending,calls,chosen};
const threads=Object.entries(statuses).map(([id,status],i)=>({id,title:({goal:'持续推进目标',normal:'普通运行中',gap:'目标轮次间隙',review:'目标等待处理',error:'目标连接错误',unread:'普通未读会话'})[id],project:'workspace',pinned:true,status,updatedAt:1800000000-i,unread:id==='unread',goalActive:goals.getSnapshot(id).goal?.status==='active',connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
return <div style={{height:'100vh',width:300,display:'flex',flexDirection:'column'}}><Sidebar threads={threads} activeHostId='local' activeThreadId={chosen} pendingHostId={pending?'local':null} pendingThreadId={pending} sidebarLayout={layout} threadBadge={badge} onSelectThread={(_,id)=>setChosen(id)} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/></div>;}
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<App/>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-sidebar-goal", esbuild: { jsx: "automatic", target: "esnext" }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "sidebar-goal-fixture", resolveId: id => id === "/goal-probe.tsx" ? id : null, load: id => id === "/goal-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/goal-probe.tsx"></script>'); }); } }],
});
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
let browser: any;
const evidence: unknown[] = [];
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const touch of [false, true]) for (const theme of ["light", "dark", "lavender"]) for (const reduced of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 844 }, hasTouch: touch, isMobile: touch, reducedMotion: reduced ? "reduce" : "no-preference" });
    const page = await context.newPage(); const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value;");
    await page.goto(vite.resolvedUrls!.local[0]!);
    const row = (title: string) => page.locator("button.sidebar-activity-item").filter({ has: page.locator(".sidebar-activity-item__title", { hasText: title }) });
    const goalRow = row("持续推进目标"), normalRow = row("普通运行中");
    await goalRow.locator(".is-goal").waitFor();
    await page.evaluate(theme => {
      (window as any).fixture.setThemePreference(theme === "lavender" ? "light" : theme);
      if (theme === "lavender") (window as any).fixture.setAppearanceThemeId("opencraft.core.lavender");
    }, theme);
    await row("目标轮次间隙").locator(".is-goal").waitFor();
    assert.equal(await row("目标等待处理").locator(".is-review").count(), 1);
    assert.equal(await row("目标连接错误").locator(".is-error").count(), 1);
    assert.equal(await normalRow.locator(".is-running").count(), 1);
    const measure = () => page.locator(".sidebar-activity-item-container").evaluateAll(rows => rows.map(row => {
      const box = (selector: string) => { const rect = row.querySelector(selector)!.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; };
      return { body: box(".sidebar-activity-item__body"), slot: box(".sidebar-activity-item__trailing"), icon: box(".sidebar-activity-item__status") };
    }));
    const before = await measure();
    assert.ok(before.every(row => Math.abs(row.slot.x - before[0].slot.x) < 0.1));
    assert.ok(before.every(row => Math.abs(row.icon.x + row.icon.width / 2 - row.slot.x - row.slot.width / 2) < 0.1));
    const target = goalRow.locator(".is-goal");
    const glyph = await target.evaluate(el => ({ animation: getComputedStyle(el).animationName, color: getComputedStyle(el).color, mask: getComputedStyle(el).maskImage, svg: el.querySelector("svg")?.getAttribute("width") }));
    assert.equal(glyph.svg, "15");
    const name = `${theme}-${touch ? 390 : 1280}-${reduced ? "reduced" : "motion"}`;
    const motion = [];
    if (reduced) {
      assert.equal(glyph.animation, "none"); assert.equal(glyph.mask, "none");
      assert.equal(await target.evaluate(el => el.getAnimations().length), 0);
    } else {
      assert.notEqual(glyph.animation, "none");
      assert.notEqual(glyph.mask, "none");
      const initial = await target.evaluate(el => getComputedStyle(el).maskPosition);
      // Observe the running animation before controlling its clock for phase captures.
      await page.waitForFunction(previous => {
        const el = document.querySelector(".sidebar-activity-item__status.is-goal")!;
        return getComputedStyle(el).maskPosition !== previous;
      }, initial);
      const images = [];
      for (const phase of [0, 0.25, 0.5, 0.75]) {
        motion.push(await target.evaluate(async (el, phase) => {
          const animation = el.getAnimations()[0]!;
          animation.pause();
          const duration = Number(animation.effect!.getTiming().duration);
          animation.currentTime = duration * phase;
          await new Promise(requestAnimationFrame);
          const style = getComputedStyle(el), box = el.getBoundingClientRect();
          return { phase, duration, maskPosition: style.maskPosition, transform: style.transform, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
        }, phase));
        images.push(await target.screenshot({ path: `${output}/${name}-phase-${phase}.png` }));
      }
      assert.ok(motion.every(sample => sample.duration >= 2600), "Goal motion must remain slow");
      assert.ok(motion.every(sample => sample.transform === "none"), "Target cannot spin or scale");
      assert.ok(motion.every(sample => JSON.stringify(sample.box) === JSON.stringify(motion[0].box)), "shimmer cannot move the icon");
      assert.ok(new Set(motion.map(sample => sample.maskPosition)).size > 1);
      assert.ok(!images[0].equals(images[1]), "rendered pixels must change across the shimmer");
      // Simulate 120Hz display samples: a tiny decorative glyph should not
      // request a new mask paint for every subpixel frame. The same visual
      // sweep still has to advance throughout the second.
      const sampledPositions = await target.evaluate(el => {
        const animation = el.getAnimations()[0]!;
        const positions = new Set<string>();
        for (let time = 0; time <= 1000; time += 8) {
          animation.currentTime = time;
          positions.add(getComputedStyle(el).maskPosition);
        }
        return positions.size;
      });
      assert.ok(sampledPositions >= 12 && sampledPositions <= 24,
        `tiny Goal glyph must advance without display-rate mask repainting: ${sampledPositions}`);
      await target.evaluate(el => el.getAnimations()[0]!.play());
      for (const attribute of ["inert", "aria-hidden"]) {
        await goalRow.evaluate((el, attribute) => el.setAttribute(attribute, attribute === "inert" ? "" : "true"), attribute);
        assert.equal(await target.evaluate(el => getComputedStyle(el).animationPlayState), "paused");
        await goalRow.evaluate((el, attribute) => el.removeAttribute(attribute), attribute);
        assert.equal(await target.evaluate(el => getComputedStyle(el).animationPlayState), "running");
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await target.evaluate(el => getComputedStyle(el).maskImage), "none");
      assert.equal(await target.evaluate(el => el.getAnimations().length), 0);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      assert.equal(await target.evaluate(el => el.getAnimations().length), 1);
    }
    await page.screenshot({ path: `${output}/${name}.png` });
    for (const status of ["paused", "blocked", "budgetLimited", "usageLimited", "complete", null]) {
      await page.evaluate(status => (window as any).fixture.update("goal", status), status);
      await goalRow.locator(".is-running").waitFor();
      assert.equal(await goalRow.locator(".is-goal").count(), 0);
      assert.deepEqual((await measure()).map(({body,slot})=>({body,slot})), before.map(({body,slot})=>({body,slot})), "mode changes must retain row geometry");
    }
    await page.evaluate(() => (window as any).fixture.update("goal", "active")); await goalRow.locator(".is-goal").waitFor();
    await page.evaluate(() => (window as any).fixture.setPending("goal")); await goalRow.locator(".is-pending").waitFor();
    await page.evaluate(() => (window as any).fixture.setPending(null)); await goalRow.locator(".is-goal").waitFor();
    if (touch) await normalRow.tap(); else { await normalRow.focus(); await page.keyboard.press("Enter"); }
    await normalRow.locator(".sidebar-activity-item__title").waitFor();
    await page.waitForFunction(() => (window as any).fixture.chosen === "normal");
    assert.equal(await goalRow.locator(".is-goal").count(), 1, "selection cannot clear a Goal");
    await page.evaluate(() => (window as any).fixture.reset()); await goalRow.locator(".is-goal").waitFor();
    assert.deepEqual(errors, []);
    evidence.push({ name, geometry: before, glyph, motion, passed: true }); await context.close();
  }
  await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ output, scenarios: evidence.length, passed: true }));
} finally { await browser?.close(); await vite.close(); }
