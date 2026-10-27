import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { pluginBranding } from "../../apps/workbench-web/plugin-branding.vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_HEADER_MEASURE_OUTPUT ?? "/tmp/opencraft-header-measurement";
interface HeaderFixtureWindow extends Window {
  fixture: { setActions(actions: readonly string[]): void; setBrand(brand: string | null): void; readFitWidth(): number };
}
const source = `
import React,{useState}from'react';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{AppShell,useAppShellLayoutMotion}from'/apps/workbench-web/src/components/app-shell.tsx';
import{AppShellHeader}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const fixture=window.fixture={setThemePreference};const noop=()=>{};
const navigation={layout:'unified',actions:[],onOpenSettings:noop,account:{snapshot:{phase:'authenticated',name:'Synthetic employee',avatarUrl:null},onOpen:noop,onRefresh:async()=>{}}};
function Receipt(){const{headerLeftFitWidth}=useAppShellLayoutMotion();fixture.readFitWidth=()=>headerLeftFitWidth.get();return null}
function App(){const[open,setOpen]=useState(false),[revision,setRevision]=useState(0),[brand,setBrand]=useState('Brand'),[actions,setActions]=useState(['sidebar-toggle']);Object.assign(fixture,{setOpen,setBrand,setActions,rerender:()=>setRevision(n=>n+1)});
return <AppShell layoutScope='measurement' navigation={navigation} mainContentLayout='default' sidebarOpen={open} sidebarWidth={335} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={noop} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={noop}
header={<><AppShellHeader navigationBrand={brand===null?undefined:<span data-probe-brand style={{whiteSpace:'nowrap',fontSize:14}}>{brand}</span>} title='Measurement' project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={noop} onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={[...actions]}/><Receipt/></>}
floatingSidebarHeader={()=>null} leftPanel={<div>Sidebar</div>}><input aria-label='Draft' defaultValue='Keep draft'/><div data-pad style={{height:300}}>Swipe here</div></AppShell>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-header-measurement", esbuild: { jsx: "automatic", target: "esnext" }, optimizeDeps: { entries: [], include: ["react", "react-dom/client", "react-intl", "@radix-ui/react-tooltip", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@radix-ui/react-alert-dialog", "@deepseek-ai/cordis", "@radix-ui/react-context-menu", "marked", "mermaid", "motion/react", "react-dom", "sonner", "tslib"] }, server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [pluginBranding(process.cwd(), ["join.server"]), { name: "header-measurement-fixture", resolveId: id => id === "/header-fixture.tsx" ? id : null, load: id => id === "/header-fixture.tsx" ? source : null, configureServer(server) { server.middlewares.use((req,res,next) => { if (req.url !== "/") return next(); res.setHeader("content-type","text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/header-fixture.tsx"></script>'); }); } }] });
let browser: any;
const evidence: any[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const fallback of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: fallback ? "reduce" : "no-preference" });
    await context.addInitScript((fallback: boolean) => {
      (window as any).__name = (value: unknown) => value;
      const audit = (window as any).audit = { reads: 0, observes: 0, disconnects: 0 };
      const measured = (e: Element) => e.classList.contains("app-shell-header__window-controls-measure");
      const rect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () { if (measured(this)) audit.reads++; return rect.call(this); };
      const Native = ResizeObserver;
      window.ResizeObserver = class extends Native {
        owned = false;
        constructor(callback: ResizeObserverCallback) { super((entries, observer) => callback(fallback ? entries.map(entry => new Proxy(entry, { get(target, key) { return key === "borderBoxSize" ? undefined : Reflect.get(target,key,target); } })) : entries, observer)); }
        observe(target: Element, options?: ResizeObserverOptions) { if (measured(target)) { this.owned = true; audit.observes++; } super.observe(target, options); }
        disconnect() { if (this.owned) audit.disconnects++; super.disconnect(); }
      };
    }, fallback);
    const page = await context.newPage(); const errors: string[] = [];
    let rejectPageError: (error: Error) => void;
    const pageError = new Promise<never>((_, reject) => { rejectPageError = reject; });
    page.on("pageerror", error => { errors.push(error.message); rejectPageError(error); });
    page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
    await Promise.race([page.getByLabel("Draft").waitFor({ timeout: 60000 }), pageError]);
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300);
    const sample = async () => page.evaluate(() => {
      const measure = document.querySelector<HTMLElement>(".app-shell-header__window-controls-measure")!;
      // offsetWidth is intentionally separate from the audited product read.
      return { width: measure.offsetWidth, fit: (window as any).fixture.readFitWidth(), audit: { ...(window as any).audit } };
    });
    const correct = async (label: string) => { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); await page.waitForFunction(() => Math.abs(document.querySelector<HTMLElement>(".app-shell-header__window-controls-measure")!.offsetWidth - (window as any).fixture.readFitWidth()) < 0.6); const value = await sample(); evidence.push({fallback,label,...value}); return value; };
    const assertEmptyTitleAlignment = async () => {
      const alignment=await page.locator('.thread-header-title').evaluate((title:HTMLElement)=>{
        const context=title.closest<HTMLElement>('.app-shell-header__context')!;
        return { offset:title.getBoundingClientRect().x-context.getBoundingClientRect().x,
          inset:parseFloat(getComputedStyle(context).paddingLeft) };
      });
      assert.ok(Math.abs(alignment.offset-alignment.inset)<0.6, JSON.stringify(alignment));
    };
    await correct("initial");
    await page.evaluate(() => { (window as any).editor = document.querySelector("input"); });
    const before = await sample();
    for (let i=0;i<5;i++) { await page.evaluate(() => (window as any).fixture.rerender()); await page.waitForTimeout(30); }
    const same = await sample();
    assert.deepEqual(same.audit, before.audit, "equivalent action arrays/brand elements must not remeasure or resubscribe");
    const cdp = await context.newCDPSession(page);
    const touch = (type: string,x=0) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{x,y:230,id:1}] });
    for (const open of [true,false,true,false]) {
      const start=open?90:270, end=open?310:50; await touch("touchStart", start);
      for(let i=1;i<=8;i++){await touch("touchMove",start+(end-start)*i/8);await page.waitForTimeout(20)}
      await touch("touchEnd"); await page.waitForTimeout(650);
      const x=await page.locator(".app-shell-row").evaluate((e:HTMLElement)=>e.getBoundingClientRect().x);
      const sidebarWidth=open?await page.locator(".app-shell-floating-left-panel").evaluate((e:HTMLElement)=>e.getBoundingClientRect().width):0;
      if(open) assert.ok(sidebarWidth>0 && sidebarWidth<390, "mobile sidebar leaves a visible page strip");
      assert.ok(Math.abs(x-(open?sidebarWidth:0))<1, `page x=${x}, sidebar width=${sidebarWidth}`); await correct("swipe-"+open);
    }
    const afterSwipes = (await sample()).audit;
    assert.equal(afterSwipes.observes, before.audit.observes);
    assert.equal(afterSwipes.disconnects, before.audit.disconnects);
    // The mobile rail really changes width. Legacy entries must read it, while
    // native borderBoxSize supplies the same size without another layout read.
    if (!fallback) assert.equal(afterSwipes.reads, before.audit.reads);
    for (const theme of ["light","dark"]) {
      await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme); await correct(theme);
    }
    await page.evaluate(() => (window as any).fixture.setBrand("A much longer brand label"));
    const brand=await correct("brand-change"); assert.ok(brand.width>before.width+30);
    await page.locator(".app-shell-header__window-controls-measure [data-probe-brand]").evaluate((e:HTMLElement)=>e.style.fontSize="22px");
    const font=await correct("font-size"); assert.ok(font.width>brand.width+20);
    await page.setViewportSize({width:1280,height:844});
    const desktopBefore=await correct("desktop-before-actions");
    await page.evaluate(() => (window as any).fixture.setActions(["sidebar-toggle","back","forward"]));
    const actions=await correct("actions-change"); assert.ok(actions.width>desktopBefore.width+30);
    await page.locator(".app-shell-header__window-controls-measure").evaluate((e:HTMLElement)=>{e.style.paddingRight="24px";e.style.borderRight="3px solid transparent"});
    const border=await correct("padding-and-border"); assert.ok(Math.abs(border.width-actions.width-27)<1);
    await page.setViewportSize({width:1280,height:844}); await correct("desktop");
    await page.evaluate(() => (window as any).fixture.setOpen(true)); await page.waitForTimeout(650); await correct("docked");
    await page.evaluate(() => (window as any).fixture.setOpen(false)); await page.waitForTimeout(650); await correct("undocked");
    await page.setViewportSize({width:390,height:844}); await correct("mobile-again");
    assert.equal((await sample()).audit.observes, before.audit.observes, "actual geometry changes must retain the observer");
    // Explicitly removing all navigation content is a real zero-width rail,
    // unlike a transient zero measurement of a populated/detached header.
    await page.evaluate(() => {
      (window as HeaderFixtureWindow).fixture.setActions([]); (window as HeaderFixtureWindow).fixture.setBrand(null);
      const measure=document.querySelector<HTMLElement>(".app-shell-header__window-controls-measure")!;
      measure.style.paddingRight=""; measure.style.borderRight="";
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({width,height:844});
      const empty=await correct("empty-"+width);
      assert.equal(empty.width,0); assert.equal(empty.fit,0);
      if(width===1280) await assertEmptyTitleAlignment();
    }
    await page.evaluate(() => { (window as HeaderFixtureWindow).fixture.setBrand("Restored brand"); (window as HeaderFixtureWindow).fixture.setActions(["sidebar-toggle"]); });
    assert.ok((await correct("content-restored")).width>0);
    assert.equal(await page.evaluate(() => (window as any).editor===document.querySelector("input")),true);
    assert.equal(await page.getByLabel("Draft").inputValue(),"Keep draft");
    // A host may mount the same Shell under its own ShadowRoot without marking
    // the outer document as a browser Shell. Geometry belongs to the Shell root.
    await page.setViewportSize({width:1280,height:844});
    await page.evaluate(() => {
      const host=document.createElement("section");
      const shadow=host.attachShadow({mode:"open"});
      for(const style of document.querySelectorAll("style")) shadow.append(style.cloneNode(true));
      shadow.append(document.getElementById("root")!); document.body.append(host);
      document.documentElement.removeAttribute("data-opencraft-window-type");
      (window as HeaderFixtureWindow).fixture.setActions([]); (window as HeaderFixtureWindow).fixture.setBrand(null);
    });
    await page.waitForFunction(() => (window as HeaderFixtureWindow).fixture.readFitWidth()===0);
    assert.equal(await page.locator('.app-shell-header__window-controls-measure').evaluate((e:HTMLElement)=>e.offsetWidth),0);
    await assertEmptyTitleAlignment();
    await page.screenshot({path:output+'/'+(fallback?'fallback':'native')+'-shadow.png'});
    assert.deepEqual(errors,[]);
    await page.screenshot({path:output+"/"+(fallback?"fallback":"native")+".png"});
    await context.close();
  }
  console.log(JSON.stringify({ok:true,evidence}));
} finally { await writeFile(output+"/result.json", JSON.stringify(evidence,null,2)); await browser?.close(); await vite.close(); }
