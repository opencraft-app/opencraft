import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = "/tmp/opencraft-sign-in-menu";
const source = `
import React,{useState,useSyncExternalStore}from'react';import{createIntlTestRoot as createRoot}from'/tests/fixtures/intl-root.tsx';
import{Context}from'@deepseek-ai/cordis';import{AuthenticationService,AuthenticationFlowService}from'/packages/workbench-runtime/src/index.ts';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{useAuthenticationPresentation}from'/apps/workbench-web/src/runtime/use-authentication-presentation.tsx';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();const ctx=new Context();await ctx.plugin(AuthenticationService);await ctx.plugin(AuthenticationFlowService);
let session={status:'anonymous',epoch:0};let snapshot={phase:'anonymous',name:null};const listeners=new Set(),attempts=[];let cancellations=0;
const update=()=>{snapshot={phase:session.status,name:session.status==='authenticated'?'Test user':null};listeners.forEach(fn=>fn())};
ctx.authentication.register('fixture',{id:'test',getSession:()=>session,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
signIn:optionId=>new Promise((resolve,reject)=>attempts.push({optionId,resolve,reject})),cancelSignIn:async()=>{cancellations++}});
const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
function App(){const[open,setOpen]=useState(true);const accountSnapshot=useSyncExternalStore(subscribe,()=>snapshot,()=>snapshot);
const projection={provider:{authenticationProviderId:'test',signInOptions:[{id:'cn',label:'国内账号登录',description:'lightvela.com'},{id:'intl',label:'国际账号登录',description:'lightvela.ai'}]},snapshot:accountSnapshot};
const presentation=useAuthenticationPresentation(ctx.authenticationFlows,projection,'chat');
window.fixture={setOpen,setThemePreference,attempts:()=>attempts.map(a=>a.optionId),cancellations:()=>cancellations,
complete:index=>{session={status:'authenticated',epoch:session.epoch+1};update();attempts[index].resolve({status:'authenticated',epoch:session.epoch})},
late:index=>attempts[index].resolve({status:'cancelled'}),fail:index=>attempts[index].reject(Error('fixture failure')),
signOut:()=>{session={status:'anonymous',epoch:session.epoch+1};update()}};
return <AppShell navigation={{actions:[{id:'chat',title:'Chat',icon:'chat',onInvoke:()=>{}}],settingsActive:false,onOpenSettings:()=>{},account:{snapshot:accountSnapshot,signIn:presentation.signIn,onOpen:()=>{throw Error('unexpected account dialog')},onRefresh:async()=>{},onSignOut:async()=>{}}}}
layoutScope='test' mainContentLayout='default' sidebarOpen={open} sidebarWidth={275} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}}
onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={()=>{}} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}}
header={<button onClick={()=>setOpen(!open)}>Toggle sidebar</button>} floatingSidebarHeader={dock=><button onClick={dock}>固定侧栏</button>} leftPanel={<div>Local tasks</div>}>
<main style={{padding:32}}><h1>What should we work on?</h1><input aria-label='Draft' defaultValue='Keep draft'/></main></AppShell>}
createRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom", "@deepseek-ai/cordis"] },
  optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu"] },
  cacheDir: "node_modules/.vite-sign-in-menu", esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "sign-in-menu-fixture", resolveId: id => id === "/menu-probe.tsx" ? id : null, load: id => id === "/menu-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("content-type", "text/html"); res.end('<div id="root"></div><script type="module" src="/menu-probe.tsx"></script>'); }); },
  }],
});
let browser: any; const errors: string[] = [], evidence: string[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } }); page.setDefaultTimeout(8000);
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript("window.__name=value=>value;");
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
  const trigger = page.locator('.shell-navigation__entrance[data-surface="account"]');
  await trigger.click();
  const menu = page.getByRole("menu", { name: "登录", exact: true }); await menu.waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.attempts()), []);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    await page.screenshot({ path: `${output}/${theme}.png` });
  }
  await page.keyboard.press("Escape"); await menu.waitFor({ state: "detached" });
  assert.equal(await trigger.evaluate(e => document.activeElement === e), true);
  await trigger.press("Enter"); await menu.waitFor();
  await page.keyboard.press("Home"); await page.keyboard.press("Enter");
  await menu.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.attempts()), ["cn"]);
  await page.getByRole("button", { name: "正在登录…", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  evidence.push("menu-only selection; keyboard/focus; domestic browser handoff; light/dark");
  await trigger.click(); await page.getByRole("menuitem", { name: "重新登录", exact: true }).click();
  await menu.waitFor({ state: "detached" });
  await page.waitForFunction(() => (window as any).fixture.attempts().length === 2);
  assert.equal(await page.evaluate(() => (window as any).fixture.cancellations()), 1);
  await page.evaluate(() => (window as any).fixture.late(0));
  assert.equal(await trigger.textContent(), "正在登录…");
  await page.evaluate(() => (window as any).fixture.fail(1));
  await page.getByRole("button", { name: "登录未完成", exact: true }).waitFor();
  await trigger.click(); await menu.waitFor();
  await page.screenshot({ path: `${output}/error.png` });
  await page.getByRole("menuitem", { name: "取消登录", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  evidence.push("pending retry serializes cancellation; late result ignored; error and cancel remain accessible");
  await page.evaluate(() => (window as any).fixture.setOpen(false));
  await page.waitForTimeout(700); await page.mouse.move(2,170);
  const floating = page.locator('.app-shell-floating-left-panel'); await floating.waitFor();
  await floating.getByRole("button", { name: "Sign in", exact: true }).click(); await menu.waitFor();
  const box = await menu.boundingBox();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1101 && box.y + box.height <= 761);
  await page.screenshot({ path: `${output}/floating.png` });
  await page.getByRole("menuitem", { name: /国际账号登录/ }).click();
  await page.waitForFunction(() => (window as any).fixture.attempts().length === 3);
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.attempts()), ["cn", "cn", "intl"]);
  await page.evaluate(() => (window as any).fixture.complete(2));
  await page.getByRole("button", { name: "Test user", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.getByRole("textbox", { name: "Draft", exact: true }).inputValue(), "Keep draft");
  evidence.push("floating menu respects bounds and survives pointer handoff; international completion preserves draft without modal");
  assert.deepEqual(errors, []); console.log(JSON.stringify({ evidence, errors }, null, 2));
} finally { await writeFile(`${output}/report.json`, JSON.stringify({ evidence, errors }, null, 2)); await browser?.close(); await vite.close(); }
