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
const root=createIntlTestRoot(document.getElementById('root'));window.dispose=()=>root.unmount();root.render(<UiPreferencesProvider runtime={preferences}><div style={{width:320,height:'100vh',display:'flex'}}><Sidebar threads={rows} activeHostId='local' activeThreadId='t0' sidebarLayout={layout} threadActions={actions} threadListGrouping={grouping} threadCapabilities={()=>({pin:true,rename:true,fork:true,archive:true,delete:true})} onSelectThread={()=>window.actions.push('navigate')} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/></div></UiPreferencesProvider>);`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: `node_modules/.vite-sidebar-menu-touch-${process.env.OPENCRAFT_SMOKE_ENGINE??"chromium"}`, esbuild: { jsx: "automatic" },
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "@radix-ui/react-context-menu", "@radix-ui/react-dropdown-menu", "@radix-ui/react-compose-refs", "@tanstack/react-query"] },
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
  const { chromium, webkit } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  const webkitMode = process.env.OPENCRAFT_SMOKE_ENGINE === "webkit";
  const outsideOnly = process.argv.includes("--outside-contract-only");
  browser = await (webkitMode ? webkit : chromium).launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const theme of ["light", "dark"]) for (const touch of (outsideOnly ? [true, false] : [true])) {
    const page = await browser.newPage({ viewport: { width: touch ? 390 : 1280, height: 760 }, hasTouch: touch, isMobile: touch });
    page.setDefaultTimeout(15_000);
    const errors: string[] = []; page.on("pageerror", (error: Error) => { errors.push(error.message); console.error("PAGE ERROR",error.message); });
    await page.addInitScript("window.__name=v=>v");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
    const trigger = page.getByRole("button", { name: "Actions for Conversation 3", exact: true });
    await trigger.waitFor({timeout:60000}).catch(async error => { console.error('INITIAL BODY', await page.locator('body').innerText()); throw error; }); await page.evaluate(theme => (window as any).setTheme(theme), theme);
    if (outsideOnly) {
      const activate = async (element: any) => touch ? element.tap() : element.click();
      const outside = page.getByText("Conversation 1", { exact: true });
      const outsideContact = async () => {
        const b = (await outside.boundingBox())!;
        const x = b.x + b.width / 2, y = b.y + b.height / 2;
        // Native coordinates must reach the row on the first outside contact.
        if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
      };
      const open = async () => {
        if (!touch) await page.getByText("Conversation 3", { exact: true }).hover();
        await activate(trigger); await page.getByRole("menu").waitFor();
      };
      await open();
      await page.screenshot({ path: `${output}/outside-${theme}-${touch}.png` });
      assert.equal(await page.locator('[data-menu-dismiss-surface]').count(), 0, "open menu has no full-page dismiss surface");
      const position = (await outside.boundingBox())!;
      const scrollBefore = await outside.evaluate(el => {
        let parent = el.parentElement;
        while (parent && parent.scrollHeight <= parent.clientHeight) parent = parent.parentElement;
        (window as any).outsideScrollport = parent;
        return parent?.scrollTop ?? 0;
      });
      await page.mouse.move(position.x + 10, position.y + position.height / 2);
      await page.mouse.wheel(0, 40);
      await page.waitForFunction(before => (window as any).outsideScrollport.scrollTop > before + 10, scrollBefore);
      await page.evaluate(before => (window as any).outsideScrollport.scrollTop = before, scrollBefore);
      await page.getByRole("menu").waitFor();
      await outsideContact(); await page.getByRole("menu").waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => (window as any).actions), ["navigate"], "first outside contact navigates once and dismisses");
      await page.evaluate(() => (window as any).actions = []);
      // Context entry uses the same outside contract and keeps its opening release inert.
      const row = page.getByText("Conversation 3", { exact: true });
      if (touch) {
        if (!webkitMode) {
          const cdp = await page.context().newCDPSession(page);
          const b = (await row.boundingBox())!;
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: b.x + 20, y: b.y + b.height / 2, id: 1 }] });
          await page.getByRole("menu").waitFor();
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await cdp.detach();
        } else await row.click({ button: "right" }); // Native desktop context entry in WebKit's touch-capable context.
      } else await row.click({ button: "right" });
      await page.getByRole("menu").waitFor().catch(async error => {
        console.log("context-release", await page.evaluate(() => ({ actions: (window as any).actions, body: document.body.style.pointerEvents, menus: [...document.querySelectorAll('[role="menu"]')].map(el => el.outerHTML.slice(0,400)) })));
        throw error;
      }); await outsideContact();
      await page.getByRole("menu").waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => (window as any).actions), ["navigate"], "context outside contact navigates once and dismisses");
      await page.evaluate(() => (window as any).actions = []);
      const listTrigger = page.locator('.sidebar-list-toolbar').getByText('Conversations', { exact: true });
      if (touch && !webkitMode) {
        const session = await page.context().newCDPSession(page);
        const b = (await listTrigger.boundingBox())!;
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: b.x + 10, y: b.y + b.height / 2, id: 2 }] });
        await page.getByRole("menu").waitFor();
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await session.detach();
      } else await listTrigger.click({ button: "right" });
      await page.getByRole("menu").waitFor();
      assert.deepEqual(await page.evaluate(() => (window as any).actions), [], "list context opening release cannot navigate");
      await outsideContact(); await page.getByRole("menu").waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => (window as any).actions), ["navigate"], "list context first outside contact navigates");
      // Selecting Rename transfers focus to the existing Dialog, without a stale blocker.
      await open(); await activate(page.getByRole("menuitem", { name: "Rename", exact: true }));
      await page.getByRole("dialog").waitFor();
      assert.equal(await page.locator('[data-menu-dismiss-surface]').count(), 0);
      await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({ state: "hidden" });
      await open(); await page.evaluate(() => (window as any).dispose());
      assert.equal(await page.locator('[data-menu-dismiss-surface]').count(), 0, "root unmount removes surface");
      await page.waitForFunction(() => document.body.style.pointerEvents === "", { timeout: 3000 }).catch(async error => {
        console.log("unmounted-body", await page.evaluate(() => ({ body: document.body.outerHTML.slice(0,1800), dialogs: document.querySelectorAll('[role="dialog"]').length })));
        throw error;
      });
      assert.deepEqual(errors, []);
      results.push({ theme, touch, engine: webkitMode ? "webkit" : "chromium", outsideOnly: true });
      await page.close(); continue;
    }
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
    p = await point(); await send("touchStart", [p]); await page.waitForTimeout(650); await closed();
    await send("touchEnd", []); await page.getByRole("menu").waitFor();
    assert.equal(await page.getByRole("menu").count(), 1, "native click after a deliberate press opens once");
    await page.keyboard.press("Escape"); await closed();
    // Synthetic context-menu delivery isolates browser-recognized hold cancellation.
    p = await point(); await send("touchStart", [p]);
    await trigger.dispatchEvent("contextmenu", { bubbles: true, cancelable: true });
    await send("touchEnd", []); await closed();
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
