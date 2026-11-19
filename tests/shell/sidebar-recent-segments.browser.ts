import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/sidebar-recent-segments");
// Production Shell/Sidebar/Intl/preferences/menu and scroll owners. Only the
// catalog and clock are synthetic; no authenticated server or physical device.
const fixture = `
import React,{useState,useEffect}from'react';
import{createClientRuntime}from'/apps/workbench-web/src/runtime/client-runtime.ts';
import{bindInteractionDensity}from'/apps/workbench-web/src/runtime/interaction-density.ts';
import{useUiPreferencesRuntime}from'/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import{sidebarScrollViewport}from'/apps/workbench-web/src/components/use-sidebar-accordion.ts';
const client=createClientRuntime(document);client.start();
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{AppShellHeader}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{Sidebar}from'/apps/workbench-web/src/components/sidebar.tsx';
import{frame}from'@opencraft/design-system/tokens';
import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import{legacyDirectServerProjectionFromHost}from'@opencraft/workbench-runtime';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_,v)=>v});
const today=new Date(2026,10,17,23,55).getTime()/1000,yesterday=new Date(2026,10,16,22).getTime()/1000;
let scans=0,ownerRenders=0,timestampReads=0;const track=rows=>new Proxy(rows,{get(target,key,receiver){if(key==='filter')scans++;return Reflect.get(target,key,receiver)}});
const initial=Array.from({length:200},(_,i)=>({id:'r'+i,title:['Current work','Overnight work','Today conversation','Yesterday conversation'][i]??'History '+i,project:'',status:i<2?'running':'ready',updatedAt:i===0?today:i===1?yesterday:i===2?today+60:yesterday-i,connectionHostId:'fixture',connectionHostLabel:'Fixture',...legacyDirectServerProjectionFromHost({hostId:'fixture',hostKind:'local',label:'Fixture'})}));
for(const row of initial){const at=row.updatedAt;Object.defineProperty(row,'updatedAt',{enumerable:true,get(){timestampReads++;return at}})}
const actions={onRename:async()=>{},onFork:async()=>{},onArchive:async()=>{},onDelete:async()=>{},onSetPinned:async()=>{}};
const caps=()=>({rename:true,fork:true,archive:true,delete:true,pin:true});
function Demo(){ownerRenders++;const preferences=useUiPreferencesRuntime();useEffect(()=>bindInteractionDensity(document,preferences),[preferences]);const[threads,setRows]=useState(()=>track(initial)),[open,setOpen]=useState(true),[selected,setSelected]=useState('r2');
window.fixture={setThemePreference,locale:locale=>preferences.set('locale.override',locale),scrollViewport:()=>sidebarScrollViewport(document.querySelector('.sidebar-content-scroll'),document.querySelector('.sidebar-activity-list')),counts:()=>({scans,ownerRenders,timestampReads}),finish:()=>setRows(rows=>track(rows.map(r=>r.id==='r1'?{...r,status:'ready'}:r))),start:()=>setRows(rows=>track(rows.map(r=>r.id==='r1'?{...r,status:'running'}:r)))};
const navigation={layout:'unified',account:null,onOpenSettings:()=>{},actions:[{id:'shell.start',title:'Start',icon:'start',active:true,onInvoke:()=>{}}]};
return <AppShell navigation={navigation} layoutScope='Chat' mainContentLayout='default' header={<AppShellHeader title='Recent activity' project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} onToggleSidebar={()=>setOpen(v=>!v)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>} floatingSidebarHeader={()=>null}
leftPanel={<Sidebar threads={threads} activeHostId='fixture' activeThreadId={selected} sidebarLayout={layout} threadActions={actions} threadCapabilities={caps} showStart={false} showFooter={false} onSelectThread={(_,id)=>setSelected(id)} onNewTask={()=>{}} onOpenSettings={()=>{}}/>} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} sidebarOpen={open} sidebarWidth={frame.sidebarUnifiedDefaultWidth} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={()=>{}} onRightPanelOpenChange={()=>{}}><textarea aria-label='Conversation draft' defaultValue='Keep this draft'/></AppShell>}
createIntlTestRoot(document.getElementById('root'),undefined,new URLSearchParams(location.search).get('locale')??'en-US').render(<Demo/>);
`;
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: ".local/sidebar-segments-vite",
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "sidebar-segments",
      resolveId: (id) => (id === "/fixture.tsx" ? id : null),
      load: (id) => (id === "/fixture.tsx" ? fixture : null),
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.headers.accept?.includes("text/html")) return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>',
          );
        });
      },
    },
  ],
});
await mkdir(output, { recursive: true });
await vite.listen();
const browser = await chromium.launch({
  executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
  args: ["--no-sandbox"],
});
const evidence: unknown[] = [];
try {
  for (const width of [390, 1280])
    for (const theme of ["light", "dark"]) {
      const locale = theme === "light" ? "en-US" : "zh-CN";
      const text =
        locale === "en-US"
          ? ["In progress", "Today", "Yesterday", "Recent", "Show more"]
          : ["进行中", "今天", "昨天", "最近", "查看更多"];
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        hasTouch: width === 390,
        isMobile: width === 390,
        timezoneId: "Asia/Shanghai",
        reducedMotion: "reduce",
      });
      const page = await context.newPage(),
        errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.clock.install({ time: new Date("2026-11-17T15:50:00Z") });
      await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?locale=${locale}`);
      await page.waitForFunction(() => Boolean((window as any).fixture));
      await page.evaluate((t) => (window as any).fixture.setThemePreference(t), theme);
      if (!(await page.locator(".sidebar-activity-item").first().isVisible()))
        await page.locator("[data-chrome-action-id=sidebar-toggle]").first().click();
      await page.locator(".sidebar-activity-item").first().waitFor();
      const recent = page.getByRole("region", { name: text[3], exact: true });
      const headings = () => recent.locator("h4.sidebar-activity-group__heading").allTextContents();
      assert.deepEqual(await headings(), text.slice(0, 3));
      await page.screenshot({ path: resolve(output, `${width}-${theme}-initial.png`) });
      assert.equal(await recent.locator(".sidebar-activity-item").count(), 10);
      const firstRow = await recent.locator("[data-thread-id=r1] .sidebar-activity-item").elementHandle();
      const draft = await page.getByLabel("Conversation draft").elementHandle();
      await page.evaluate(() => {
        (window as any).rowIdentity = document.querySelector("[data-thread-id=r1] .sidebar-activity-item");
      });
      const before = await page.evaluate(() => (window as any).fixture.counts());
      // Open a real Radix menu, then let the one midnight timer fire.
      await recent
        .locator("[data-thread-id=r0] .sidebar-activity-item")
        .dispatchEvent("contextmenu", { clientX: 120, clientY: 160, button: 2 });
      await page.getByRole("menu").waitFor();
      const menuFocus = await page.evaluateHandle(() => document.activeElement);
      await page.clock.fastForward(600_000);
      await page.waitForFunction(
        (label) =>
          [...document.querySelectorAll("h4.sidebar-activity-group__heading")].some((h) => h.textContent === label),
        text[2],
      );
      assert.ok(
        !(await headings()).includes(text[1]),
        "midnight refresh does not require catalog data or another user action",
      );
      assert.equal((await headings())[0], text[0]);
      assert.equal(await page.getByRole("menu").count(), 1, "calendar-only commit retains the menu lease");
      assert.equal(
        await menuFocus.evaluate((el) => el === document.activeElement),
        true,
        "midnight preserves menu focus",
      );
      assert.deepEqual(
        await page.evaluate(() => (window as any).fixture.counts()),
        before,
        "calendar tick never revisits timestamps, scans the full catalog or rerenders its owner",
      );
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "hidden" });
      assert.equal(await firstRow!.evaluate((el) => el === (window as any).rowIdentity), true);
      // Reordering after actual completion moves the same keyed DOM, not an owner.
      await page.evaluate(() => (window as any).fixture.finish());
      await page.waitForFunction(() => !document.querySelector("[data-thread-id=r1] .is-running"));
      assert.equal(await firstRow!.evaluate((el) => el.isConnected && el === (window as any).rowIdentity), true);
      assert.equal(await recent.locator("[data-thread-id=r1]").count(), 1);
      await page.evaluate(() => (window as any).fixture.start());
      await page.waitForFunction(() => Boolean(document.querySelector("[data-thread-id=r1] .is-running")));
      assert.equal(await firstRow!.evaluate((el) => el.isConnected), true);
      // Existing shared ten-row budget, not a second independent running page.
      const more = recent.getByRole("button", { name: text[4], exact: true });
      if (width === 390) await more.tap();
      else await more.click();
      await page.clock.runFor(100);
      await page.waitForFunction(() => document.querySelectorAll(".sidebar-activity-item").length === 20);
      assert.equal(await recent.locator(".sidebar-activity-item").count(), 20);
      await page.evaluate(() => {
        (window as any).fixture.scrollViewport().dataset.testScrollOwner = "true";
      });
      const scroll = page.locator("[data-test-scroll-owner=true]");
      await scroll.evaluate((el) => {
        el.scrollTop = 150;
      });
      const scrollBefore = await scroll.evaluate((el) => el.scrollTop);
      assert.ok(scrollBefore > 100, "exercise the actual nonzero scroll owner");
      const counters = await page.evaluate(() => (window as any).fixture.counts());
      // A suspended document skips timers; visibility/focus reconciles its calendar.
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.clock.setSystemTime(new Date("2026-11-20T04:00:00Z"));
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });
      await page.waitForFunction(
        (labels) =>
          ![...document.querySelectorAll("h4.sidebar-activity-group__heading")].some((h) =>
            labels.includes(h.textContent!),
          ),
        text.slice(1, 3),
      );
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.counts()), counters);
      assert.equal(
        await scroll.evaluate((el) => el.scrollTop),
        scrollBefore,
        "calendar relabel never reveals selection or resets scroll",
      );
      assert.equal(await draft!.evaluate((el) => (el as HTMLTextAreaElement).value), "Keep this draft");
      assert.equal(await firstRow!.evaluate((el) => el.isConnected), true);
      await scroll.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
      const finalHeadings = await headings();
      const alternateLocale = locale === "en-US" ? "zh-CN" : "en-US";
      await page.evaluate((l) => (window as any).fixture.locale(l), alternateLocale);
      await page.waitForFunction(
        (label) => document.querySelector("h4.sidebar-activity-group__heading")?.textContent === label,
        alternateLocale === "zh-CN" ? "进行中" : "In progress",
      );
      assert.equal(await firstRow!.evaluate((el) => el.isConnected), true, "locale switch keeps the row DOM");
      assert.equal(await draft!.evaluate((el) => (el as HTMLTextAreaElement).value), "Keep this draft");
      assert.deepEqual(errors, []);
      evidence.push({
        width,
        theme,
        locale,
        rows: 200,
        visible: 20,
        headings: finalHeadings,
        localeSwitch: true,
        midnight: true,
        resume: true,
        rowIdentity: true,
        menuRetained: true,
        sharedPagination: true,
        catalogScansOnClock: 0,
        scrollBefore,
        errors,
      });
      await context.close();
    }
  await writeFile(resolve(output, "results.json"), JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({ passed: true, cases: evidence.length, syntheticCatalog: true, actualSidebarAndShell: true }),
  );
} catch (error) {
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      await page.screenshot({ path: resolve(output, "failure.png") });
      await writeFile(resolve(output, "failure.txt"), await page.locator("body").innerText());
    }
  throw error;
} finally {
  await browser.close();
  await vite.close();
}
