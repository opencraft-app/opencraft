import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Real Sidebar, preferences, theme and Shell scroll tracks. Only the catalog is
// synthetic; the A/B overrides below are diagnostic-only, never product logic.
const source = `
import React,{useState} from 'react';
import {createClientRuntime} from '/apps/workbench-web/src/runtime/client-runtime';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density';
const inputRuntime=createClientRuntime(document);inputRuntime.start();
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import {buildOpenCraftThemeCssProperties,porcelainThemePalette,longingThemePalette,lavenderThemePalette} from '@opencraft/design-system/theme-engine';
import {UiPreferencesProvider,openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const query=new URLSearchParams(location.search),mode=query.get('mode')??'light',mobile=query.get('layout')==='mobile';
const palette={porcelain:porcelainThemePalette,longing:longingThemePalette,lavender:lavenderThemePalette}[query.get('palette')??'porcelain'];
document.documentElement.dataset.theme=mode;
Object.entries(buildOpenCraftThemeCssProperties(mode,palette[mode])).forEach(([k,v])=>document.documentElement.style.setProperty(k,v));
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_,v)=>v});
const preferences=await openWorkbenchUiPreferences();
bindInteractionDensity(document,preferences);
const rows=Array.from({length:240},(_,i)=>({id:'row'+i,title:'Conversation '+i,pinned:i<8,project:'workspace',status:'ready',connectionHostId:'host',connectionHostLabel:'Local',updatedAt:Date.now()/1000-i,...legacyDirectServerProjectionFromHost({hostId:'host',hostKind:'local',label:'Local'})}));
const listeners=new Set();let groupingSnapshot={revision:0,mode:null,modes:[{id:'creators',label:'Creators'}],hideRowBadge:false,notice:null};
const grouping={id:'sticky-tail',getSnapshot:()=>groupingSnapshot,subscribe:l=>{listeners.add(l);return()=>listeners.delete(l)},watch:()=>()=>{},
project:refs=>[{id:'all',label:'All conversations',avatarUrl:null,collapsed:false,threads:refs},...Array.from({length:32},(_,i)=>({id:'tail'+i,label:'Other group '+i,avatarUrl:null,collapsed:true,threads:[]}))],
setMode:mode=>{groupingSnapshot={...groupingSnapshot,mode,revision:groupingSnapshot.revision+1};listeners.forEach(l=>l())},toggleGroup:()=>{}};
function Fixture(){const[active,setActive]=useState('row8');window.fixture={setActive,group:()=>grouping.setMode('creators')};return <UiPreferencesProvider runtime={preferences}>
<div className={'app-shell-root has-unified-sidebar'+(mobile?' app-shell-floating-overlay-root':'')} data-mobile-sidebar={mobile?true:undefined}>
<div className='shell-sidebar__column' data-navigation-layout={mobile?'mobile':'desktop'} style={{pointerEvents:'auto',width:320,height:'100vh',gridTemplateColumns:'minmax(0,1fr)',gridTemplateRows:'minmax(0,1fr)'}}>
<div className='shell-sidebar__scroll'><Sidebar threads={rows} activeHostId='host' activeThreadId={active} sidebarLayout={layout} threadListGrouping={grouping} threadActions={{onRename:async()=>{},onFork:async()=>{},onArchive:async()=>{},onDelete:async()=>{},onSetPinned:async()=>{}}} threadCapabilities={()=>({pin:true,rename:true,fork:true,archive:true,delete:true})} onSelectThread={(_,id)=>setActive(id)} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/></div></div>
<textarea aria-label='Main draft' defaultValue='Keep this draft' style={{position:'fixed',left:340,top:80,width:400,height:100}}/>
</div></UiPreferencesProvider>};
createIntlTestRoot(document.getElementById('root')).render(<Fixture/>);`;
const diagnostic = process.env.OPENCRAFT_SIDEBAR_SCROLL_AB === "1";
const output = process.env.OPENCRAFT_SIDEBAR_HEADING_OUTPUT ?? join(tmpdir(), "sidebar-heading-plane");
const evidence: unknown[] = [];
const vite = await createServer({
  configFile: false, root: process.cwd(), publicDir: "apps/workbench-web/public", logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] }, cacheDir: "node_modules/.vite-sidebar-heading-plane",
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "fixture", resolveId: id => id === "/fixture.tsx" ? id : null,
    load: id => id === "/fixture.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>');
    }); } }],
});
let browser: any;
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const cases = diagnostic
    ? ["original", "no-clip", "no-cv", "no-clip-no-cv"].map(ab => ({ touch: false, mode: "light", palette: "longing", ab }))
    : [false, true].flatMap(touch => ["light", "dark"].flatMap(mode => ["porcelain", "longing", "lavender"].map(palette => ({ touch, mode, palette, ab: "original" }))));
  for (const c of cases) {
    const context = await browser.newContext({ viewport: { width: c.touch ? 390 : 1000, height: 720 }, hasTouch: c.touch, isMobile: c.touch, reducedMotion: c.mode === "dark" ? "reduce" : "no-preference" });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.addInitScript("window.__name=x=>x");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?mode=${c.mode}&palette=${c.palette}&layout=${c.touch ? "mobile" : "desktop"}`, { waitUntil: "commit" });
    const recent = page.getByRole("region", { name: "Recent", exact: true });
    const heading = recent.locator(".sidebar-thread-group-heading");
    await heading.waitFor({ timeout: 120000 }); await page.evaluate(() => document.fonts.ready);
    for (let i = 0; i < 5; i++) await recent.getByRole("button", { name: "Show more", exact: true }).click();
    if (c.ab.includes("no-clip")) await page.addStyleTag({ content: ".sidebar-activity-group__items{clip-path:none!important}" });
    if (c.ab.includes("no-cv")) await page.addStyleTag({ content: ".sidebar-activity-row{content-visibility:visible!important}" });
    const track = page.locator(c.touch ? ".shell-sidebar__scroll" : ".sidebar-activity-list");
    const draft = await page.getByLabel("Main draft").elementHandle();
    const first = await recent.locator(".sidebar-activity-item").first().elementHandle();
    await track.evaluate(el => { el.scrollTop = 900; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Reverse the *real* scroll position and hit-test synchronously, before any
    // rAF can repair stale clipping. This rejects the original whole-group clip.
    const reverse = await track.evaluate(el => {
      el.scrollTop -= 500;
      const bounds = el.getBoundingClientRect(), group = el.querySelector('[aria-label="Recent"]')!;
      const header = group.querySelector(".sidebar-thread-group-heading")!.getBoundingClientRect();
      const rows = [...group.querySelectorAll<HTMLElement>(".sidebar-activity-item")].filter(row => {
        const b = row.getBoundingClientRect(); return b.top >= header.bottom + 1 && b.bottom <= bounds.bottom - 1;
      });
      const hitRows = rows.filter(row => { const b = row.getBoundingClientRect(); return row.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); }).length;
      const items = group.querySelector(".sidebar-activity-group__items")!;
      return { visibleRows: rows.length, hitRows, clip: getComputedStyle(items).clipPath, offset: getComputedStyle(items).getPropertyValue("--sidebar-heading-occlusion") };
    });
    if (diagnostic) { evidence.push({ ...c, reverse }); await context.close(); continue; }
    assert.ok(reverse.visibleRows >= 3, "the reading window contains real rows");
    assert.equal(reverse.hitRows, reverse.visibleRows, "reverse scroll cannot leave blank or untouchable rows before rAF");
    assert.equal(reverse.clip, "none", "no scroll-dependent whole-group clipping");
    await page.mouse.move(900, 20);
    // Native wheel input, abrupt reversals and settled frames, not a CSS-only screenshot.
    if (!c.touch) {
      const box = (await track.boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (const delta of [480, 720, -960, 550, -420]) { await page.mouse.wheel(0, delta); await page.waitForTimeout(45); }
    } else {
      await heading.getByRole("button").tap(); await heading.getByRole("button").tap();
      const session = await context.newCDPSession(page), box = (await track.boundingBox())!;
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 100, y: box.y + 250 }] });
      for (let i = 1; i <= 8; i++) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + 100, y: box.y + 250 - i * 18 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await session.detach();
      // Let the native gesture finish before testing a separate selection intent.
      await track.evaluate(el => new Promise<void>(resolve => {
        let previous = el.scrollTop, stableSince = performance.now();
        const deadline = performance.now() + 3000;
        const sample = () => {
          const now = performance.now();
          if (el.scrollTop !== previous) { previous = el.scrollTop; stableSince = now; }
          if (now - stableSince >= 150 || now >= deadline) resolve();
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }));
    }
    await track.evaluate(el => { el.scrollTop = 500; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometryReads = await track.evaluate(async el => {
      const original = Element.prototype.getBoundingClientRect; let reads = 0;
      Element.prototype.getBoundingClientRect = function () { if (this.matches(".sidebar-thread-group-heading, .sidebar-activity-group__items")) reads++; return original.call(this); };
      try { for (let i = 0; i < 20; i++) el.dispatchEvent(new Event("scroll")); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return reads; }
      finally { Element.prototype.getBoundingClientRect = original; }
    });
    assert.equal(geometryReads, 0, "scroll must not trigger heading/whole-group geometry projection");
    const before = await heading.screenshot();
    await recent.locator(".sidebar-activity-group__items").evaluate(el => (el as HTMLElement).style.background = "rgb(255, 0, 255)");
    const marked = await heading.screenshot();
    const changed = await page.evaluate(async ([a, b]) => {
      const decode = async (s: string) => { const image = new Image(); image.src = "data:image/png;base64," + s; await image.decode(); const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height; const g = canvas.getContext("2d")!; g.drawImage(image, 0, 0); return g.getImageData(0, 0, canvas.width, canvas.height).data; };
      const aa = await decode(a), bb = await decode(b); let changed = 0; for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) changed++; return changed;
    }, [before.toString("base64"), marked.toString("base64")]);
    assert.equal(changed, 0, "row backgrounds and avatar layers cannot tint the sticky label");
    await recent.locator(".sidebar-activity-group__items").evaluate(el => (el as HTMLElement).style.removeProperty("background"));
    assert.equal(await heading.evaluate(el => getComputedStyle(el).backdropFilter), "none");
    // Existing theme roles still own explicit colors, rather than being silently
    // bypassed by the new backing. Exercise the actual rendered legacy contract.
    if (!c.touch && c.mode === "light" && c.palette === "porcelain") {
      const previous = await page.evaluate(() => {
        const root=document.documentElement;
        const values=["--opencraft-sidebar-context-background","--opencraft-sidebar-heading-background"].map(k=>[k,root.style.getPropertyValue(k)]);
        root.style.setProperty("--opencraft-sidebar-context-background","#315171");
        root.style.setProperty("--opencraft-sidebar-heading-background","transparent"); return values;
      });
      const pixel = async () => { const png=await heading.screenshot(); return page.evaluate(async s=>{
        const image=new Image();image.src="data:image/png;base64,"+s;await image.decode();const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;const g=canvas.getContext("2d")!;g.drawImage(image,0,0);return [...g.getImageData(2,2,1,1).data];
      },png.toString("base64")); };
      assert.deepEqual(await pixel(),[49,81,113,255],"explicit context surface remains authoritative");
      await page.evaluate(()=>document.documentElement.style.setProperty("--opencraft-sidebar-heading-background","#154365"));
      assert.deepEqual(await pixel(),[21,67,101,255],"explicit heading surface stays above its context");
      await page.evaluate(values=>{for(const[k,v]of values)document.documentElement.style.setProperty(k,v)},previous);
    }
    // Explicit selection, keyboard focus, menus and resize must stay usable.
    await page.evaluate(() => (window as any).fixture.setActive("row16"));
    const selected = recent.locator(".sidebar-activity-item.is-selected"); await selected.waitFor();
    const reveal = await selected.evaluate(el => ({ row: el.getBoundingClientRect().top, heading: el.closest(".sidebar-activity-group")!.querySelector(".sidebar-thread-group-heading")!.getBoundingClientRect().bottom }));
    assert.ok(reveal.row >= reveal.heading - 1, "selection reveal clears the sticky label: " + JSON.stringify({c,reveal}));
    await selected.focus(); assert.ok(await selected.evaluate(el => el === document.activeElement));
    const focusTarget = recent.locator(".sidebar-activity-item").nth(4);
    await focusTarget.focus();
    const keyboard = await focusTarget.evaluate(el => ({ row: el.getBoundingClientRect().top, heading: el.closest(".sidebar-activity-group")!.querySelector(".sidebar-thread-group-heading")!.getBoundingClientRect().bottom }));
    assert.ok(keyboard.row >= keyboard.heading - 1, "keyboard reveal clears the sticky label: " + JSON.stringify({c,keyboard}));
    const menuTrigger = recent.getByRole("button", { name: "Actions for Conversation 16", exact: true });
    // Place the More button wholly inside the scrollport but behind the sticky
    // label. A generic focus of an offscreen row could pass without any margin.
    await menuTrigger.evaluate(el => {
      const viewport=el.closest(".shell-sidebar__column")!.getAttribute("data-navigation-layout")==="mobile"
        ? el.closest(".shell-sidebar__column")!.querySelector<HTMLElement>(".shell-sidebar__scroll")!
        : el.closest<HTMLElement>(".sidebar-activity-list")!;
      const row=el.getBoundingClientRect(),header=el.closest(".sidebar-activity-group")!.querySelector(".sidebar-thread-group-heading")!.getBoundingClientRect();
      viewport.scrollTop+=row.top-viewport.getBoundingClientRect().top-Math.max(0,(header.height-row.height)/2);
    });
    const covered=await menuTrigger.evaluate(el=>{
      const rect=el.getBoundingClientRect(),header=el.closest(".sidebar-activity-group")!.querySelector(".sidebar-thread-group-heading")!.getBoundingClientRect();
      return {insideHeader:rect.top>=header.top-1&&rect.bottom<=header.bottom+1,covered:!el.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2))};
    });
    assert.ok(covered.insideHeader&&covered.covered,"More starts inside the viewport, occluded by its own sticky label");
    await menuTrigger.focus();
    const menuFocus = await menuTrigger.evaluate(el => ({ top:el.getBoundingClientRect().top, bottom:el.closest(".sidebar-activity-group")!.querySelector(".sidebar-thread-group-heading")!.getBoundingClientRect().bottom }));
    assert.ok(menuFocus.top >= menuFocus.bottom - 1, "independent More button focus clears the sticky label");
    if (c.touch) await menuTrigger.tap(); else { await selected.hover(); await menuTrigger.click(); }
    await page.getByRole("menu").waitFor();
    assert.ok((await page.getByRole("menu").boundingBox())!.height > 0, "row menu escapes the scroll viewport through its existing portal");
    await page.keyboard.press("Escape");
    await heading.getByRole("button").click(); await heading.getByRole("button").click();
    assert.equal(await recent.locator(".sidebar-activity-item").first().evaluate((el, old) => el === old, first), true);
    assert.equal(await page.getByLabel("Main draft").evaluate((el, old) => el === old, draft), true);
    assert.equal(await page.getByLabel("Main draft").inputValue(), "Keep this draft");
    if (c.palette === "porcelain" && c.mode === "light") {
      // Real contributed groups allow the selected section to leave the viewport.
      // Re-select an early row: the heading will re-stick only after this scroll.
      await page.evaluate(() => (window as any).fixture.group());
      const all=page.getByRole("region",{name:"All conversations",exact:true});
      await all.locator('.sidebar-thread-group-toggle[aria-expanded="true"]').waitFor();
      await track.evaluate(el => { el.scrollTop = el.scrollHeight-el.clientHeight; });
      const departed=await all.locator(".sidebar-thread-group-heading").boundingBox();
      const viewport=(await track.boundingBox())!;
      assert.ok(departed && departed.y+departed.height<viewport.y,"section really left its viewport");
      await page.evaluate(() => (window as any).fixture.setActive("row8"));
      const returned=all.locator(".sidebar-activity-item.is-selected");await returned.waitFor();
      const back=await returned.evaluate(el=>({row:el.getBoundingClientRect().top,heading:el.closest(".sidebar-activity-group")!.querySelector(".sidebar-thread-group-heading")!.getBoundingClientRect().bottom}));
      assert.ok(back.row>=back.heading-1,"re-selected row clears a newly re-stuck heading: "+JSON.stringify(back));
    }
    await page.setViewportSize({ width: c.touch ? 420 : 900, height: 650 });
    await page.screenshot({ path: join(output, `${c.touch}-${c.mode}-${c.palette}.png`) });
    assert.deepEqual(errors, []); evidence.push({ ...c, reverse, geometryReads, changed, reveal, retained: true }); await context.close();
  }
  console.log(JSON.stringify({ output, diagnostic, evidence }));
} finally { await writeFile(join(output, "report.json"), JSON.stringify({ diagnostic, evidence }, null, 2)); await browser?.close(); await vite.close(); }
