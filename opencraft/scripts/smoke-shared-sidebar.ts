import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = "/tmp/opencraft-shared-sidebar";
const source = `
import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{AppShellHeader}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();let mounts=0;const actions=[];
function Context(){const [expanded,setExpanded]=useState(true);useEffect(()=>{mounts++},[]);return <div style={{height:'100%',display:'flex',flexDirection:'column'}}><input aria-label='Sidebar filter' defaultValue='Keep filter'/><button onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>Local</button><div data-scroll-list style={{overflowY:'auto',flex:1,minHeight:0}}>{expanded?Array.from({length:80},(_,i)=><div key={i} style={{padding:12}}>Task {i}</div>):null}</div></div>}
function App(){const[open,setOpen]=useState(true);const[width,setWidth]=useState(275);const[context,setContext]=useState(true);const[accountName,setAccountName]=useState(null);
window.fixture={setOpen,setContext,setWidth,setAccountName,width,setThemePreference,mounts:()=>mounts,actions};
return <AppShell navigation={{actions:[{id:'chat',title:'Chat',icon:'chat',onInvoke:()=>actions.push('Chat')}],settingsActive:false,onOpenSettings:()=>actions.push('Settings'),account:{snapshot:{phase:accountName?'authenticated':'anonymous',name:accountName,avatarUrl:null},onOpen:()=>actions.push('Sign in'),onRefresh:async()=>{},onSignOut:async()=>{}}}}
layoutScope='test' mainContentLayout='default' sidebarOpen={open} sidebarWidth={width} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={v=>v!==null&&setWidth(v)} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}}
header={<AppShellHeader title={null} project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
floatingSidebarHeader={dock=><button onClick={dock}>固定侧栏</button>}
leftPanel={context?<Context/>:null}>
<div style={{padding:28}}><h1>Workspace</h1><input aria-label='Main draft' defaultValue='Keep draft'/></div></AppShell>}
createRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-shared-sidebar", esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@tanstack/react-query"] },
  plugins: [{ name: "shared-sidebar-fixture", resolveId: id => id === "/shared-probe.tsx" ? id : null, load: id => id === "/shared-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("content-type", "text/html"); res.end('<div id="root"></div><script type="module" src="/shared-probe.tsx"></script>'); }); },
  }],
});
let browser: any; const errors: string[] = [], evidence: unknown[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1300, height: 760 }, reducedMotion: process.env.OPENCRAFT_REDUCED_MOTION === "1" ? "reduce" : "no-preference" }); page.setDefaultTimeout(8000);
  await page.addInitScript("window.__name=value=>value;localStorage.setItem('opencraft.shell-navigation.v2',JSON.stringify({applications:true,account:false,railDetent:'expanded'}))");
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole("button", { name: "Chat", exact: true }).waitFor();
  const measureFooter = () => page.evaluate(() => {
    const footer = document.querySelector<HTMLElement>('.shell-navigation__footer')!;
    const track = footer.closest('.app-shell-sidecar__footer')!.getBoundingClientRect();
    const app = footer.querySelector<HTMLElement>('[data-surface="applications"]')!.getBoundingClientRect();
    const account = footer.querySelector<HTMLElement>('[data-surface="account"]')!.getBoundingClientRect();
    const style = getComputedStyle(footer);
    return { trackWidth: track.width, rightInset: track.right - account.right, inset: parseFloat(style.paddingRight),
      gap: Math.abs(account.y-app.y)<1 ? account.left-app.right : account.top-app.bottom,
      expectedGap: parseFloat(style.gap), appWidth: app.width, appHeight: app.height, appX: app.x,
      accountWidth: account.width, position: style.position,
      iconCount: footer.querySelectorAll('[data-surface="applications"] svg').length,
      sharedIcon: !!footer.querySelector('[data-surface="applications"] [data-sidebar-toggle-icon-state]') };
  });
  const assertFooter = async () => {
    const box = await measureFooter(); assert.ok(Math.abs(box.rightInset-box.inset)<1, JSON.stringify(box));
    assert.ok(Math.abs(box.gap-box.expectedGap)<1 && box.gap>0, JSON.stringify(box));
    assert.ok(Math.abs(box.appWidth-box.appHeight)<1); assert.equal(box.position,'relative');
    assert.equal(box.iconCount,1); assert.equal(box.sharedIcon,true); return box;
  };
  for (const name of [null, 'Jindong Zhang', 'A very long account name that must remain inside the sidebar']) {
    await page.evaluate(name => (window as any).fixture.setAccountName(name),name);
    await page.waitForTimeout(50);const before=await assertFooter();
    await page.evaluate(() => (window as any).fixture.setWidth(425));await page.waitForTimeout(600);const after=await assertFooter();
    assert.ok(Math.abs((after.accountWidth-before.accountWidth)-(after.trackWidth-before.trackWidth))<1);
    assert.equal(after.appWidth,before.appWidth);assert.equal(after.appX,before.appX);
    await page.locator('.shell-navigation__entrance[data-surface="account"]').hover();
    await page.screenshot({path:`${output}/footer-${name===null?'anonymous':name==='Jindong Zhang'?'signed-in':'long-name'}.png`});
    if(name==='Jindong Zhang') {
      await page.locator('.shell-navigation__entrance[data-surface="account"]').click();
      await page.locator('.shell-navigation__peek').waitFor();
      const openBox=await assertFooter();assert.equal(openBox.trackWidth,after.trackWidth);assert.equal(openBox.accountWidth,after.accountWidth);
      assert.equal(await page.locator('.shell-navigation__peek').evaluate((el:Element)=>getComputedStyle(el).position),'absolute');
      await page.screenshot({path:`${output}/footer-menu.png`});await page.keyboard.press('Escape');
    }
    await page.evaluate(() => (window as any).fixture.setWidth(275));await page.waitForTimeout(600);
  }
  const beforeDrag=await assertFooter();
  const contextGeometry = () => page.evaluate(() => {
    const floating = document.querySelector('.app-shell-floating-left-panel');
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().width;
    return { frame: rect(floating ? '.floating-sidebar-context' : '.app-shell-left-panel'),
      viewport: rect(floating ? '.floating-sidebar-context__viewport' : '.app-shell-left-panel__viewport'),
      content: rect('[data-scroll-list]'), committed: (window as any).fixture.width };
  });
  await page.evaluate(() => {
    (window as any).dragGeometryFrames = [];
    (window as any).recordDragGeometry = true;
    const sample = () => {
      const w = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().width ?? 0;
      (window as any).dragGeometryFrames.push({ frame: w('.app-shell-left-panel'), viewport: w('.app-shell-left-panel__viewport'), content: w('[data-scroll-list]') });
      if ((window as any).recordDragGeometry) requestAnimationFrame(sample);
    }; requestAnimationFrame(sample);
  });
  const handle=await page.getByRole('separator',{name:'Resize sidebar',exact:true}).boundingBox();assert.ok(handle);
  // Grab the in-pane part of the separator, not the main surface beside it.
  await page.mouse.move(handle.x+1,200);await page.mouse.down();await page.mouse.move(handle.x+61,200,{steps:8});
  await page.waitForTimeout(200);
  const held=await assertFooter();assert.equal(held.appX,beforeDrag.appX);assert.ok(held.accountWidth>beforeDrag.accountWidth+50,JSON.stringify({beforeDrag,held}));
  const growing = await contextGeometry();assert.ok(Math.abs(growing.viewport-growing.frame)<1 && Math.abs(growing.content-growing.frame)<1,JSON.stringify(growing));
  assert.equal(await page.evaluate(()=>(window as any).fixture.width),275);
  await page.mouse.move(handle.x-34,200,{steps:8});await page.waitForTimeout(150);
  const shrinking = await contextGeometry();assert.equal(shrinking.committed,275);assert.ok(Math.abs(shrinking.viewport-shrinking.frame)<1 && shrinking.frame<275,JSON.stringify(shrinking));
  // Hold across repeated direction changes. No release is allowed to repair layout.
  for (const offset of [35, -20, 55, -34]) {
    await page.mouse.move(handle.x+offset,200,{steps:6});await page.waitForTimeout(100);
    const frame=await contextGeometry();assert.equal(frame.committed,275);
    assert.ok(Math.abs(frame.viewport-frame.frame)<1 && Math.abs(frame.content-frame.frame)<1,JSON.stringify(frame));
  }
  const beforeRelease=await contextGeometry();
  await page.mouse.up();await page.waitForTimeout(150);const released=await contextGeometry();assert.ok(Math.abs(released.frame-released.viewport)<1);
  assert.ok(Math.abs(released.viewport-beforeRelease.viewport)<1,"release must not perform deferred reflow");
  await page.evaluate(() => { (window as any).recordDragGeometry=false; });
  const dragFrames=await page.evaluate(()=>(window as any).dragGeometryFrames);
  assert.ok(dragFrames.length>5 && dragFrames.every((frame:any)=>Math.abs(frame.viewport-frame.frame)<1 && Math.abs(frame.content-frame.viewport)<1));
  await writeFile(`${output}/drag-geometry-frames.json`,JSON.stringify(dragFrames));
  evidence.push({case:'context-geometry-growing-contracting-and-release',passed:true,growing,shrinking,released,frames:dragFrames.length});
  await page.evaluate(() => { (window as any).fixture.setAccountName(null); (window as any).fixture.setWidth(275); });await page.waitForTimeout(600);
  evidence.push({case:'footer-normal-flow-shared-spacing-and-elastic-account-including-held-drag',passed:true});
  await page.getByLabel("Sidebar filter").fill("Preserve sidebar state"); await page.getByLabel("Main draft").fill("Preserve chat draft");
  await page.evaluate(() => { (window as any).contextNode = document.querySelector('[data-sidebar-content="context"]'); document.querySelector('[data-scroll-list]')!.scrollTop = 500; });
  await page.waitForTimeout(100); await page.screenshot({ path: `${output}/docked.png` });
  const showFloating = async () => { await page.evaluate(() => (window as any).fixture.setOpen(false)); await page.waitForTimeout(700); await page.mouse.move(2, 170); await page.locator('.app-shell-floating-left-panel').waitFor(); await page.mouse.move(100, 170); await page.waitForTimeout(250); };
  await showFloating();
  const floating = page.locator('.app-shell-floating-left-panel');
  const floatingHandle=await floating.getByRole('separator',{name:'Resize sidebar',exact:true}).boundingBox();assert.ok(floatingHandle);
  await page.mouse.move(floatingHandle.x+1,200);await page.mouse.down();await page.mouse.move(floatingHandle.x+61,200,{steps:8});await page.waitForTimeout(150);
  const floatingGrowing=await contextGeometry();assert.ok(Math.abs(floatingGrowing.frame-floatingGrowing.viewport)<1,JSON.stringify(floatingGrowing));
  await page.mouse.move(floatingHandle.x-34,200,{steps:8});await page.waitForTimeout(150);
  const floatingShrinking=await contextGeometry();assert.ok(Math.abs(floatingShrinking.frame-floatingShrinking.viewport)<1 && floatingShrinking.frame<275,JSON.stringify(floatingShrinking));
  // A browser-dispatched pointercancel uses the real handler without persisting the preview width.
  await floating.getByRole('separator',{name:'Resize sidebar',exact:true}).dispatchEvent('pointercancel',{pointerId:1});await page.mouse.up();await page.waitForTimeout(150);
  const cancelled=await contextGeometry();assert.equal(cancelled.committed,275);assert.ok(Math.abs(cancelled.frame-275)<1 && Math.abs(cancelled.viewport-275)<1,JSON.stringify(cancelled));
  await page.mouse.move(100,170);
  evidence.push({case:'floating-context-geometry-and-cancel',passed:true,floatingGrowing,floatingShrinking,cancelled});
  await assertFooter();
  for (const name of ['Chat', 'Settings', 'Sign in']) assert.equal(await floating.getByRole('button', { name, exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => (window as any).contextNode === document.querySelector('[data-sidebar-content="context"]')), true);
  assert.equal(await page.evaluate(() => (window as any).fixture.mounts()), 1);
  assert.equal(await page.getByLabel('Sidebar filter').inputValue(), 'Preserve sidebar state');
  assert.equal(await page.locator('[data-scroll-list]').evaluate((el: Element) => el.scrollTop), 500);
  await page.screenshot({ path: `${output}/floating-expanded.png` });
  await floating.getByRole('button', { name: 'Applications', exact: true }).click();
  assert.equal(await floating.count(), 1);
  await assertFooter();
  for (const name of ['Chat', 'Settings', 'Sign in']) await floating.getByRole('button', { name, exact: true }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.actions), ['Chat', 'Settings', 'Sign in']);
  await page.screenshot({ path: `${output}/floating.png` });
  console.log(JSON.stringify(await page.evaluate(() => ({ main: document.querySelector('.main-content-surface')?.getBoundingClientRect().toJSON(), scrollX, scrollY }))));
  await floating.getByRole('button', { name: '固定侧栏', exact: true }).click(); await floating.waitFor({ state: 'hidden' }); await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => (window as any).fixture.mounts()), 1);
  assert.equal(await page.locator('[data-scroll-list]').evaluate((el: Element) => el.scrollTop), 500);
  assert.equal(await page.getByLabel('Main draft').inputValue(), 'Preserve chat draft');
  evidence.push({ case: 'single-owner-parity-state-scroll-and-actions', passed: true });
  await page.getByRole('button', { name: 'Local', exact: true }).click();
  await page.setViewportSize({ width: 540, height: 720 }); await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click(); await floating.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Local', exact: true }).getAttribute('aria-expanded'), 'false');
  const bounds = await floating.boundingBox(); assert.ok(bounds && bounds.width <= 516);
  await page.evaluate(() => (window as any).fixture.setThemePreference('dark')); await page.screenshot({ path: `${output}/narrow-dark.png` });
  for (const name of ['Chat', 'Settings']) assert.equal(await floating.getByRole('button', { name, exact: true }).count(), 1);
  await page.keyboard.press('Escape'); await floating.waitFor({ state: 'hidden' });
  await page.mouse.move(530, 200); await page.mouse.move(2, 200); await floating.waitFor();
  await page.mouse.move(100, 200); await page.keyboard.press('Escape'); await floating.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1300, height: 760 }); await page.evaluate(() => (window as any).fixture.setOpen(true)); await page.waitForTimeout(700);
  assert.equal(await page.getByRole('button', { name: 'Local', exact: true }).getAttribute('aria-expanded'), 'false');
  evidence.push({ case: 'narrow-dark-escape-and-return', passed: true });
  await page.evaluate(() => (window as any).fixture.setContext(false)); await showFloating();
  for (const name of ['Chat', 'Settings']) await floating.getByRole('button', { name, exact: true }).waitFor();
  evidence.push({ case: 'navigation-only-floating', passed: true });
  await page.evaluate(() => (window as any).fixture.setOpen(true)); await floating.waitFor({state:'hidden'}); await page.waitForTimeout(700);
  await assertFooter(); await page.screenshot({path:`${output}/footer-navigation-only.png`});
  // Test-only CSS injection is a separate normal-theme check. The reduced-motion
  // pass tests layout/visibility without racing an injected style against reparenting.
  if(process.env.OPENCRAFT_REDUCED_MOTION!=='1') {
    await page.evaluate(() => document.documentElement.style.setProperty('--gap-sidebar-entrances','12px'));
    assert.equal((await assertFooter()).gap,12);
    await page.evaluate(() => document.documentElement.style.removeProperty('--gap-sidebar-entrances'));
    evidence.push({case:'footer-navigation-only-and-theme-token-override',passed:true});
  }
  const primaryHandle=page.getByRole('separator',{name:'Resize applications',exact:true});
  if(await primaryHandle.count()===0)await page.locator('.shell-navigation__entrance[data-surface="applications"]').click();
  await primaryHandle.press('End');await page.waitForTimeout(600);
  const primaryBox=await primaryHandle.boundingBox();assert.ok(primaryBox);
  const primaryGeometry=()=>page.evaluate(()=>({frame:document.querySelector('.shell-navigation__dock').getBoundingClientRect().width,
    viewport:document.querySelector('.shell-navigation__viewport').getBoundingClientRect().width}));
  await page.mouse.move(primaryBox.x+1,200);await page.mouse.down();
  for(const dx of [-5,-10,-3]){await page.mouse.move(primaryBox.x+1+dx,200,{steps:5});await page.waitForTimeout(100);
    const geometry=await primaryGeometry();assert.ok(Math.abs(geometry.frame-geometry.viewport)<1,JSON.stringify(geometry));}
  await primaryHandle.dispatchEvent('pointercancel',{pointerId:1});await page.mouse.up();await page.waitForTimeout(600);
  // Interrupt a compact->expanded settle and take over from its physical frame.
  await primaryHandle.press('Home');await page.waitForTimeout(600);
  await primaryHandle.press('ArrowRight');await page.waitForTimeout(35);
  const movingBox=await primaryHandle.boundingBox();assert.ok(movingBox);
  await page.mouse.move(movingBox.x+1,200);await page.mouse.down();
  // The hit target itself is moving between automation round trips. If it
  // moved off the pointer, target pointerdown while the real mouse is held so
  // browser pointer capture and the production transaction still execute.
  if(await primaryHandle.getAttribute('data-resizing')!=='true')await primaryHandle.dispatchEvent('pointerdown',{pointerId:1,button:0,clientX:movingBox.x+1,clientY:200});
  assert.equal(await primaryHandle.getAttribute('data-resizing'),'true');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const takeover=await primaryGeometry();
  await page.mouse.move(movingBox.x+3,200);await page.waitForTimeout(100);const next=await primaryGeometry();
  assert.ok(Math.abs(next.frame-Math.min(137,takeover.frame+2))<1,JSON.stringify({takeover,next}));
  await primaryHandle.dispatchEvent('pointercancel',{pointerId:1});await page.mouse.up();await page.waitForTimeout(600);
  evidence.push({case:'primary-normal-resize-and-in-flight-takeover',passed:true,takeover,next});
  assert.deepEqual(errors, []); console.log(JSON.stringify(evidence));
} finally { await writeFile(`${output}/report.json`, JSON.stringify({ evidence, errors }, null, 2)); await browser?.close(); await vite.close(); }
