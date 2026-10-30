import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";

const output = process.env.OPENCRAFT_FOOTER_DENSITY_OUTPUT ?? ".local/footer-density";
const source = `
import React,{useState} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {UiPreferencesProvider,openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density.ts';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();const preferences=await openWorkbenchUiPreferences();bindInteractionDensity(document,preferences);
const actions=[];
function App(){const[width,setWidth]=useState(340);window.fixture={preferences,setWidth,setThemePreference,actions};return <UiPreferencesProvider runtime={preferences}><AppShell navigation={{layout:'unified',actions:[['home','Home'],['columns','Workspace'],['server','Tools'],['activity','Activity'],['search','Search']].map(([icon,title],i)=>({id:icon,title,icon,active:i===0,onInvoke:()=>actions.push(title)})),settingsActive:false,onOpenSettings:()=>actions.push('Settings'),account:{snapshot:{phase:'authenticated',name:'Fixture user',avatarUrl:null,planLabel:'Workspace member',usageRemainingPercent:null},onOpen:()=>actions.push('Account'),onRefresh:async()=>{},onSignOut:async()=>{}}}} layoutScope='footer-density' mainContentLayout='default' sidebarOpen sidebarWidth={width} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>{}} onSidebarExpand={()=>{}} onSidebarResizeEnd={v=>v!==null&&setWidth(v)} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}} header={<div style={{height:44}}>Workspace</div>} leftPanel={<div style={{height:'100%',display:'flex',flexDirection:'column'}}><input aria-label='Sidebar filter' defaultValue='Keep filter'/><div data-sidebar-list style={{flex:1,overflow:'auto'}}>{Array.from({length:80},(_,i)=><div style={{padding:10}} key={i}>Conversation {i}</div>)}</div></div>}><textarea aria-label='Draft' defaultValue='Keep draft'/></AppShell></UiPreferencesProvider>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({ root: process.cwd(), configFile: false, logLevel: "error",
  cacheDir: "node_modules/.vite-footer-density", resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react-intl", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover"] },
  esbuild: { jsx: "automatic", target: "esnext" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "footer-density", resolveId: id => id === "/fixture.tsx" ? id : null,
    load: id => id === "/fixture.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next(); res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>');
    }); } }] });
let browser;
const results: unknown[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true });
  for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: touch ? 1024 : 1280, height: 850 }, hasTouch: touch });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(vite.resolvedUrls!.local[0]!, { waitUntil: "domcontentloaded", timeout: 90_000 });
    const home = page.locator('.shell-sidebar-navigation button').first();
    await home.waitFor({ timeout: 90_000 });
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    const mainDraft = await page.getByRole("textbox", { name: "Draft", exact: true }).elementHandle();
    const filter = await page.getByRole("textbox", { name: "Sidebar filter" }).elementHandle();
    await page.locator('[data-sidebar-list]').evaluate(el => { el.scrollTop = 240; });
    for (const preference of ["off", "on", "auto"] as const) {
      const expectedTouch = preference === "on" || preference === "auto" && touch;
      await page.evaluate(value => (window as any).fixture.preferences.set("interface.touchFriendly", value), preference);
      await page.waitForFunction(value => document.documentElement.dataset.uiDensity === value, expectedTouch ? "touch" : "compact");
      const metrics = await home.evaluate(el => {
        const box = el.getBoundingClientRect(), icon = el.querySelector('svg')!.getBoundingClientRect();
        const track = el.closest('.shell-sidebar__navigation')!;
        const style = getComputedStyle(track), row = el.closest('.shell-sidebar__column')!.getBoundingClientRect();
        const footer = document.querySelector('.shell-sidebar__rail-footer')!.getBoundingClientRect();
        return { width: box.width, height: box.height, icon: icon.width, padding: style.paddingTop,
          trackHeight: track.getBoundingClientRect().height, gap: getComputedStyle(el.parentElement!).gap,
          noOverlap: track.getBoundingClientRect().right <= footer.left + 1,
          withinViewport: row.left >= 0 && row.right <= innerWidth };
      });
      assert.equal(metrics.width, expectedTouch ? 44 : 36);
      assert.equal(metrics.height, expectedTouch ? 44 : 36);
      assert.equal(metrics.icon, expectedTouch ? 24 : 20);
      assert.equal(metrics.padding, expectedTouch ? "12px" : "4px");
      assert.equal(metrics.trackHeight, expectedTouch ? 68 : 44);
      assert.equal(metrics.gap, expectedTouch ? "8px" : "4px");
      assert.equal(metrics.noOverlap, true); assert.equal(metrics.withinViewport, true);
      if (touch) await home.tap(); else await home.click();
      await page.mouse.move(700, 100);
      assert.equal(await page.locator('html').getAttribute('data-ui-density'), expectedTouch ? "touch" : "compact", "input contact does not change the preference");
      assert.equal(await mainDraft!.evaluate(el => el === document.querySelector('textarea')), true);
      assert.equal(await filter!.evaluate(el => el === document.querySelector('[aria-label="Sidebar filter"]')), true);
      assert.equal(await page.locator('[data-sidebar-list]').evaluate(el => el.scrollTop), 240);
      assert.equal(await page.getByRole('textbox', { name: 'Draft', exact: true }).inputValue(), 'Keep draft');
      await page.screenshot({ path: `${output}/${touch ? 'touch' : 'mouse'}-${theme}-${preference}.png` });
      results.push({ touch, theme, preference, ...metrics });
    }
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions), ["Home", "Home", "Home"]);
    assert.deepEqual(errors, []); await page.close();
  }
  await writeFile(`${output}/result.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser?.close(); await vite.close(); }
