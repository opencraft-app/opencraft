import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const output = process.env.OPENCRAFT_TOUCH_MENU_OUTPUT ?? "/tmp/opencraft-sidebar-menu-touch";
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {UiPreferencesProvider,openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {legacyDirectServerProjectionFromHost} from '@opencraft/workbench-runtime';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();window.setTheme=setThemePreference;window.actions=[];
const preferences=await openWorkbenchUiPreferences();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async()=>{}});
const rows=Array.from({length:60},(_,i)=>({id:'t'+i,title:'Conversation '+i,project:'workspace',status:'ready',updatedAt:Date.now()/1000-i,connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
const grouping={id:'touch-test',getSnapshot:()=>snapshot,subscribe:()=>()=>{},watch:()=>()=>{},project:refs=>[{id:'all',label:'All conversations',avatarUrl:null,collapsed:false,threads:refs}],setMode:()=>{},toggleGroup:()=>{}};
const snapshot={revision:0,mode:'all',modes:[{id:'all',label:'All'}],hideRowBadge:false,notice:null};
const actions={onRename:async()=>{},onFork:async()=>{},onArchive:async()=>window.actions.push('archive'),onDelete:async()=>{},onSetPinned:async()=>window.actions.push('pin')};
createIntlTestRoot(document.getElementById('root')).render(<UiPreferencesProvider runtime={preferences}><div style={{width:320,height:'100vh',display:'flex'}}><Sidebar threads={rows} activeHostId='local' activeThreadId='t0' sidebarLayout={layout} threadActions={actions} threadListGrouping={grouping} threadCapabilities={()=>({pin:true,rename:true,fork:true,archive:true,delete:true})} onSelectThread={()=>window.actions.push('navigate')} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/></div></UiPreferencesProvider>);`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-sidebar-menu-touch", esbuild: { jsx: "automatic" },
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "@radix-ui/react-context-menu", "@radix-ui/react-dropdown-menu", "@tanstack/react-query"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "sidebar-touch-fixture", resolveId: id => id === "/fixture.tsx" ? id : null, load: id => id === "/fixture.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>');
    }); }, }],
});
let browser: any;
const results = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true });
    page.setDefaultTimeout(15_000);
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=v=>v");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
    const trigger = page.getByRole("button", { name: "Actions for Conversation 3", exact: true });
    await trigger.waitFor(); await page.evaluate(theme => (window as any).setTheme(theme), theme);
    const cdp = await page.context().newCDPSession(page);
    const point = async () => { const b = (await trigger.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }; };
    const send = (type: string, points: any[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    const closed = async () => assert.equal(await page.getByRole("menu").count(), 0, "scroll/hold/cancel must not open a menu");
    let p = await point(); await send("touchStart", [p]); await page.waitForTimeout(120);
    await page.screenshot({ path: `${output}/${theme}-held.png` }); await closed();
    // Native scrolling starts inside the real 44px More hit area.
    const scroll = await trigger.evaluate(el => { let p = el.parentElement; while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement; (window as any).scrollport = p; return p?.scrollTop ?? 0; });
    for (const dy of [15, 35, 65, 100]) { await send("touchMove", [{ ...p, y: p.y - dy }]); await page.waitForTimeout(24); }
    await send("touchEnd", []); await page.waitForTimeout(120); await closed();
    assert.ok(await page.evaluate(() => (window as any).scrollport.scrollTop) > scroll + 20, "native list scroll must remain usable");
    await page.evaluate(() => (window as any).scrollport.scrollTop = 0); await page.waitForTimeout(350);
    p = await point(); await send("touchStart", [p]); await send("touchMove", [{ ...p, x: p.x - 16 }]); await send("touchMove", [p]); await send("touchEnd", []); await closed();
    p = await point(); await send("touchStart", [p]); await send("touchCancel", []); await closed();
    p = await point(); await send("touchStart", [p]); await page.waitForTimeout(650); await send("touchEnd", []); await closed();
    p = await point(); await send("touchStart", [p]); await send("touchStart", [p, { ...p, x: 100, id: 2 }]); await send("touchEnd", []); await closed();
    // The toolbar filter is the same direct-touch rule, with uncontrolled Radix state.
    const filter = page.locator('.sidebar-list-mode-trigger');
    const fb = (await filter.boundingBox())!; p = { x: fb.x + fb.width / 2, y: fb.y + fb.height / 2, id: 1 };
    await send('touchStart', [p]); await page.waitForTimeout(120); await closed();
    await send('touchCancel', []); await closed();
    await filter.tap(); await page.getByRole('menu').waitFor();
    await page.keyboard.press('Escape'); await closed();
    // A fresh ordinary tap still opens immediately, once, and invokes one action.
    await trigger.tap(); await page.getByRole("menuitem", { name: "Pin", exact: true }).waitFor();
    assert.equal(await page.getByRole("menu").count(), 1);
    await page.screenshot({ path: `${output}/${theme}-tap.png` });
    await page.getByRole("menuitem", { name: "Pin", exact: true }).tap(); await closed();
    assert.deepEqual(await page.evaluate(() => (window as any).actions), ["pin"]);
    await trigger.focus(); await page.keyboard.press("Enter"); await page.getByRole("menu").waitFor(); await page.keyboard.press("Escape"); await closed();
    // Existing row right-click and long-press remain Radix-owned.
    const row = page.locator(".sidebar-activity-item").filter({ has: page.locator(".sidebar-activity-item__title", { hasText: /^Conversation 3$/ }) });
    await row.click({ button: "right" }); await page.getByRole("menu").waitFor(); await page.keyboard.press("Escape"); await closed();
    const rb = (await row.boundingBox())!; p = { x: rb.x + 60, y: rb.y + rb.height / 2, id: 1 };
    await send("touchStart", [p]); await page.getByRole("menu").waitFor(); await send("touchEnd", []); await page.keyboard.press("Escape"); await closed();
    assert.deepEqual(errors, []); results.push({ theme, heldClosed: true, nativeScroll: true, dragCancelHoldMulti: true, tapAndAction: true, keyboardAndContext: true });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2)); console.log(JSON.stringify({ passed: true, output, results }));
} finally { await browser?.close(); await vite.close(); }
