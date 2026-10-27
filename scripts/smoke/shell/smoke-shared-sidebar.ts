import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_SHARED_SIDEBAR_OUTPUT ?? "/tmp/opencraft-shared-sidebar";
const source = `
import React,{useEffect,useState}from'react';import{createIntlTestRoot as createRoot}from'/tests/fixtures/intl-root.tsx';
import{frame}from'@opencraft/design-system/tokens';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{AppShellHeader}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{ApplicationBrand}from'/apps/workbench-web/src/components/application-brand.tsx';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();let mounts=0;const actions=[];
function Context(){const [expanded,setExpanded]=useState(true);useEffect(()=>{mounts++},[]);return <div style={{height:'100%',display:'flex',flexDirection:'column'}}><input aria-label='Sidebar filter' defaultValue='Keep filter'/><button onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>Local</button><div data-scroll-list style={{overflowY:'auto',flex:1,minHeight:0}}>{expanded?Array.from({length:80},(_,i)=><div key={i} style={{padding:12}}>Task {i}</div>):null}</div></div>}
function App(){const[open,setOpen]=useState(true);const[width,setWidth]=useState(frame.sidebarUnifiedDefaultWidth);const[context,setContext]=useState(true);const[accountName,setAccountName]=useState(null);
window.fixture={setOpen,setContext,setWidth,setAccountName,width,setThemePreference,mounts:()=>mounts,actions};
return <AppShell navigation={{layout:'unified',actions:[{id:'chat',title:'Chat',icon:'chat',onInvoke:()=>actions.push('Chat')}],settingsActive:false,onOpenSettings:()=>actions.push('Settings'),account:{snapshot:{phase:accountName?'authenticated':'anonymous',name:accountName,avatarUrl:null},onOpen:()=>actions.push('Sign in'),onRefresh:async()=>{},onSignOut:async()=>{}}}}
layoutScope='test' mainContentLayout='default' sidebarOpen={open} sidebarWidth={width} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={v=>v!==null&&setWidth(v)} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}}
header={<AppShellHeader navigationBrand={<ApplicationBrand/>} title={null} project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
floatingSidebarHeader={dock=><button onClick={dock}>固定侧栏</button>}
leftPanel={context?<Context/>:null}>
<div style={{padding:28}} onClick={()=>actions.push('Main')}><h1>Workspace</h1><input aria-label='Main draft' defaultValue='Keep draft'/></div></AppShell>}
createRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), publicDir: "apps/workbench-web/public", logLevel: "error", resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-shared-sidebar", esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@tanstack/react-query"] },
  plugins: [{ name: "shared-sidebar-fixture", resolveId: id => id === "/shared-probe.tsx" ? id : null, load: id => id === "/shared-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("content-type", "text/html"); res.end('<div id="root"></div><script type="module" src="/shared-probe.tsx"></script>'); }); },
  }],
});
let browser: any; const errors: string[] = [], evidence: unknown[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();

  // Managed website updates: the mobile drawer overlays the list with the
  // update entrance, so the scroll track must reserve two floating actions
  // while a notice is visible and must shrink back when it disappears.
  {
    const mobileStatus = {
      none: { current: { version: '0.1.12', buildId: 'build-running' }, latest: { version: '0.1.12', buildId: 'build-running' }, updateAvailable: false },
      available: { current: { version: '0.1.12', buildId: 'build-running' }, latest: { version: '0.1.13', buildId: 'build-next' }, updateAvailable: true },
      stale: { current: { version: '0.1.12', buildId: 'build-server' }, latest: null, updateAvailable: false },
    };
    let updateState = 'available';
    const mobileSource = `
import React,{useState}from'react';import{createIntlTestRoot as createRoot}from'/tests/fixtures/intl-root.tsx';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{AppShellHeader,AppShellNavigationControls}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{Sidebar}from'/apps/workbench-web/src/components/sidebar.tsx';
import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import{legacyDirectServerProjectionFromHost}from'@opencraft/workbench-runtime';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();const actions=[];const updateActions=[];
const initial=Array.from({length:60},(_,i)=>({id:'t'+i,title:'Conversation '+i,project:'workspace',status:'ready',updatedAt:Date.now()/1000-i,connectionHostId:'local',connectionHostLabel:'Local',...legacyDirectServerProjectionFromHost({hostId:'local',hostKind:'local',label:'Local'})}));
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async()=>{}});
const threadActions={onRename:async()=>{},onFork:async()=>{},onArchive:async()=>actions.push(['archive']),onDelete:async()=>{},onSetPinned:async()=>actions.push(['pin'])};
const capabilities=()=>({pin:true,rename:true,fork:true,archive:true,delete:true});
const queryClient=new QueryClient();
function Drawer(){const[open,setOpen]=useState(true);
 window.fixture={setOpen,actions,updateActions,openUpdates:()=>updateActions.push(['openUpdates']),setUpdateState:name=>(async()=>{await fetch('/__opencraft_updates/fixture-state?state='+name,{method:'POST'});await queryClient.invalidateQueries({queryKey:['web-deployment-updates']})})()};
 return <QueryClientProvider client={queryClient}><AppShell navigation={{layout:'unified',settingsActive:false,updatesActive:false,actions:[{id:'chat',title:'Chat',icon:'chat',onInvoke:()=>actions.push(['chat'])}],account:{snapshot:{name:'OpenCraft Workspace',phase:'ready',avatarUrl:null,planLabel:'Launch',usageRemainingPercent:69},onOpen:()=>{updateActions.push(['account'])},onRefresh:async()=>{},onSignOut:async()=>{}},onOpenSettings:()=>{updateActions.push(['openSettings'])},onOpenUpdates:()=>{updateActions.push(['openUpdates'])}}} layoutScope='managed-updates' mainContentLayout='default' sidebarOpen={open} sidebarWidth={275} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={()=>{}} onRightPanelOpenChange={()=>{}} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} header={<AppShellHeader title={null} project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>{}} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>} floatingSidebarHeader={dock=><AppShellNavigationControls hostRole='transient' sidebarOpen={false} canGoBack={false} canGoForward={false} onToggleSidebar={dock} onHome={()=>{}} onBack={()=>{}} onForward={()=>{}} actions={['sidebar-toggle']}/>} leftPanel={<Sidebar threads={initial} activeHostId='local' activeThreadId='t0' sidebarLayout={layout} threadActions={threadActions} threadCapabilities={capabilities} pendingTitle={()=>null} onSelectThread={(_,id)=>{actions.push(['select',id]);setOpen(false)}} onNewTask={()=>{updateActions.push(['newTask'])}} onOpenSettings={()=>{}} showFooter={false} showStart={false} showNewChat/>}><div style={{padding:24}}>Managed website content</div></AppShell></QueryClientProvider>}
createRoot(document.getElementById('root')).render(<Drawer/>);`;
    const managedVite = await createServer({ configFile: false, root: process.cwd(), publicDir: 'apps/workbench-web/public', logLevel: 'error',
      resolve: { dedupe: ['react', 'react-dom'] }, cacheDir: 'node_modules/.vite-shared-sidebar-managed', esbuild: { jsx: 'automatic' },
      server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: { include: ['react', 'react-dom/client', '@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-popover', '@tanstack/react-query'] },
      plugins: [{ name: 'shared-sidebar-managed-fixture', resolveId: id => id === '/managed-probe.tsx' ? id : null, load: id => id === '/managed-probe.tsx' ? mobileSource : null,
        configureServer(server) { server.middlewares.use((req, res, next) => {
          const url = req.url ?? '';
          if (url.startsWith('/__opencraft_updates/fixture-state')) { updateState = new URLSearchParams(url.split('?')[1] ?? '').get('state') ?? 'none'; res.setHeader('content-type', 'text/plain'); res.end('ok'); return; }
          if (url.startsWith('/__opencraft_updates')) { res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ schemaVersion: 1, enabled: true, localInstall: true, authenticated: false, ...(mobileStatus[updateState as 'none' | 'available' | 'stale'] ?? mobileStatus.none), checking: false, checkedAt: '2026-10-22T00:00:00.000Z', checkError: null, checkErrorCode: null, canRollback: false, execution: null, packageName: '@opencraft-app/opencraft', channel: 'stable', job: null })); return; }
          if (url !== '/' && !url.startsWith('/?')) return next();
          res.setHeader('content-type', 'text/html');
          res.end('<!doctype html><meta name="opencraft-web-updates" content="/__opencraft_updates"><meta name="opencraft-build-id" content="build-running"><div id="root"></div><script type="module" src="/managed-probe.tsx"></script>');
        }); } }],
    });
    await managedVite.listen();
    const port = (managedVite.httpServer!.address() as { port: number }).port;
    const managedBrowser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
    try {
      const scrollProbe = (page: any, next: 'none' | 'available' | 'stale' | null) => page.evaluate(async (next: string | null) => {
        const fixture = (window as any).fixture;
        if (next) await fixture.setUpdateState(next);
        if (!document.querySelector('.shell-sidebar__column[data-navigation-layout="mobile"]')) return { error: 'no mobile column' };
        fixture.setOpen(true);
        await new Promise(resolve => setTimeout(resolve, 650));
        const track = document.querySelector<HTMLElement>('.shell-sidebar__scroll')!;
        const view = track.clientHeight;
        const listHeight = track.scrollHeight;
        track.scrollTop = track.scrollHeight;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        track.scrollTop = track.scrollHeight;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const style = getComputedStyle(track);
        const last = [...track.querySelectorAll('.sidebar-activity-item')].pop() as HTMLElement | undefined;
        if (!last) return { error: 'no rows', listHeight, view };
        const rowBox = last.getBoundingClientRect();
        const rowHit = document.elementFromPoint(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
        // The row's right side hosts its actions, where the corner entrance stacks.
        const rightHit = document.elementFromPoint(rowBox.right - 24, rowBox.y + rowBox.height / 2);
        const updates = document.querySelector('.shell-navigation__entrance--update');
        return { state: next, view, listHeight, tallerThanViewport: listHeight > view,
          atBottom: Math.abs(listHeight - track.scrollTop - view) < 2,
          padEnd: style.paddingBlockEnd, scrollPadEnd: style.scrollPaddingBlockEnd,
          updateEntranceVisible: updates !== null,
          rowHitInsideRow: rowHit !== null && (last.contains(rowHit) || rowHit === last),
          rowHitIsUpdateButton: updates !== null && (rowHit === updates || updates.contains(rowHit)),
          rightHitInsideRow: rightHit !== null && (last.contains(rightHit) || rightHit === last),
          rightHitIsUpdateButton: updates !== null && (rightHit === updates || updates.contains(rightHit)) };
      }, next);
      for (const [width, height] of [[390, 844], [390, 568]] as const) {
        const page = await managedBrowser.newPage({ viewport: { width, height } }); page.setDefaultTimeout(12000);
        await page.addInitScript('window.__name=value=>value');
        const scrollErrors: string[] = []; page.on('pageerror', error => scrollErrors.push(error.message));; page.on('pageerror', error => console.log('PR385-PAGEERROR', error.message)); page.on('console', message => { const text = message.text(); if (message.type() === 'error' && !text.startsWith('Failed to load resource')) console.log('PR385-CONSOLE', text.slice(0, 300)); });
        try {
          await page.goto(`http://127.0.0.1:${port}/`, { timeout: 90000 });
          await page.waitForSelector('.app-shell-root');
          // The drawer opens through the real chrome toggle; the feed starts "available".
          await page.locator('[data-chrome-action-id="sidebar-toggle"]').click();
          await page.locator('.shell-sidebar__column[data-navigation-layout="mobile"]').waitFor();
          await page.locator('.sidebar-activity-item').first().waitFor();
          await page.locator('.shell-sidebar__column[data-navigation-layout="mobile"]').waitFor();
          // Reveal the whole production list through real pagination callbacks.
          while (await page.getByRole('button', { name: 'Show more', exact: true }).count()) {
            await page.getByRole('button', { name: 'Show more', exact: true }).click();
            await page.waitForTimeout(250);
          }
          const visibleRows = await page.locator('.sidebar-activity-item').count();
          assert.ok(visibleRows >= 30, `expected the production list to show at least 30 rows, got ${visibleRows}`);
          const available = await scrollProbe(page, 'available');
          assert.ok(available.tallerThanViewport, `list must outgrow the viewport: ${JSON.stringify(available)}`);
          assert.ok(available.atBottom, `the probe must reach the real list end: ${JSON.stringify(available)}`);
          assert.equal(available.padEnd, '144px', `notice must reserve both floating actions: ${JSON.stringify(available)}`);
          assert.equal(available.scrollPadEnd, '144px');
          assert.equal(available.updateEntranceVisible, true);
          assert.equal(available.rowHitInsideRow, true, 'last row must stay reachable by pointer: ' + JSON.stringify(available));
          assert.equal(available.rowHitIsUpdateButton, false, 'the floating update button must not cover the last row');
          assert.equal(available.rightHitInsideRow, true, 'the row actions must stay reachable by pointer: ' + JSON.stringify(available));
          assert.equal(available.rightHitIsUpdateButton, false, 'the floating update button must not cover the row actions');
          await page.screenshot({ path: `${output}/pr385-mobile-${height}-available.png` });
          // A real row tap answers the conversation, not the floating entrance.
          const lastRow = await page.evaluate(() => {
            const item = [...document.querySelectorAll('.sidebar-activity-item')].pop() as HTMLElement;
            item.scrollIntoView({ block: 'center' });
            const box = item.getBoundingClientRect();
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          });
          await page.mouse.click(lastRow.x, lastRow.y);
          await page.waitForTimeout(600);
          assert.equal((await page.evaluate(() => (window as any).fixture.updateActions)).filter((entry: string[]) => entry[0] === 'openUpdates').length, 0, 'a row tap must not route to updates');
          assert.ok((await page.evaluate(() => (window as any).fixture.actions)).some((entry: string[]) => entry[0] === 'select'), 'the visible last row must answer its tap');
          // The entrance still routes to settings/updates and dismisses the drawer.
          await page.locator('[data-chrome-action-id="sidebar-toggle"]').click();
          await page.locator('.shell-sidebar__column[data-navigation-layout="mobile"]').waitFor();
          await page.waitForTimeout(250);
          await page.locator('.shell-navigation__entrance--update').click();
          await page.waitForTimeout(600);
          assert.ok((await page.evaluate(() => (window as any).fixture.updateActions)).some((entry: string[]) => entry[0] === 'openUpdates'), 'the update entrance must invoke its open callback');
          await page.locator('.app-shell-floating-left-panel').waitFor({ state: 'hidden' });
          await page.locator('[data-chrome-action-id="sidebar-toggle"]').click();
          await page.locator('.shell-sidebar__column[data-navigation-layout="mobile"]').waitFor();
          // The stale variant replaces the download entrance with the refresh state.
          const stale = await scrollProbe(page, 'stale');
          assert.equal(stale.padEnd, '144px'); assert.equal(stale.scrollPadEnd, '144px');
          assert.equal(stale.updateEntranceVisible, true);
          assert.equal(stale.rowHitInsideRow, true); assert.equal(stale.rowHitIsUpdateButton, false);
          await page.screenshot({ path: `${output}/pr385-mobile-${height}-stale.png` });
          // Removing the notice recovers the single-button space and the geometry.
          const recovered = await scrollProbe(page, 'none');
          assert.equal(recovered.padEnd, '88px', `no notice must not keep two-button padding: ${JSON.stringify(recovered)}`);
          assert.equal(recovered.scrollPadEnd, '88px');
          assert.equal(recovered.updateEntranceVisible, false, 'the notice must disappear live');
          assert.equal(recovered.rowHitInsideRow, true); assert.equal(recovered.rowHitIsUpdateButton, false);
          assert.equal(recovered.tallerThanViewport, true, 'without the notice the production list still outgrows the viewport');
          await page.screenshot({ path: `${output}/pr385-mobile-${height}-none.png` });
          assert.deepEqual(scrollErrors, []);
          evidence.push({ case: `managed-mobile-drawer-${height}`, passed: true, rows: visibleRows, available, stale, recovered });
        } finally { await page.close(); }
      }
      // Desktop available regression: the same managed scene at docked geometry.
      const desktop = await managedBrowser.newPage({ viewport: { width: 1100, height: 800 } }); desktop.setDefaultTimeout(12000);
      await desktop.addInitScript('window.__name=value=>value');
      const desktopErrors: string[] = []; desktop.on('pageerror', error => desktopErrors.push(error.message));
      try {
        await desktop.goto(`http://127.0.0.1:${port}/`, { timeout: 90000 });
        await desktop.locator('.shell-navigation__footer--unified').waitFor();
        // The mobile recovery parked the feed on "none"; this page pins "available".
        await desktop.evaluate(() => (window as any).fixture.setUpdateState('available'));
        const entrance = desktop.locator('.shell-navigation__entrance--update');
        await entrance.waitFor();
        assert.equal(await entrance.count(), 1);
        assert.match(await entrance.getAttribute('aria-label') ?? '', /v0\.1\.13/);
        await desktop.screenshot({ path: `${output}/pr385-desktop-available.png` });
        assert.deepEqual(desktopErrors, []);
        evidence.push({ case: 'managed-desktop-available', passed: true });
      } finally { await desktop.close(); }
    } finally { await managedBrowser.close(); await managedVite.close(); }
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1300, height: 760 }, reducedMotion: process.env.OPENCRAFT_REDUCED_MOTION === "1" ? "reduce" : "no-preference" }); page.setDefaultTimeout(8000);
  await page.addInitScript("window.__name=value=>value;localStorage.setItem('opencraft.shell-navigation.v2',JSON.stringify({applications:true,account:false,railDetent:'expanded'}))");
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`, {timeout:90000});
  await page.waitForLoadState('networkidle');
  await page.getByRole("button", { name: "Chat", exact: true }).waitFor();
  // The same header action must remain beside the brand throughout motion.
  const toggle = page.locator('[data-chrome-action-id="sidebar-toggle"]:visible');
  await toggle.waitFor();
  await page.evaluate(() => {
    const button = document.querySelector('[data-chrome-action-id="sidebar-toggle"]')!;
    const brand = document.querySelector('.app-shell-header__window-controls .application-brand')!;
    (window as any).toggleIdentity = button;
    (window as any).toggleStart = button.getBoundingClientRect().toJSON();
    (window as any).toggleFrames = [];
    (window as any).recordToggle = true;
    const sample = () => {
      const box = button.getBoundingClientRect();
      const label = brand.getBoundingClientRect();
      (window as any).toggleFrames.push({ same: button === (window as any).toggleIdentity && button.isConnected,
        x: box.x, y: box.y, gap: box.left - label.right, hit: button.contains(document.elementFromPoint(box.x+box.width/2, box.y+box.height/2)),
        count: [...document.querySelectorAll('[data-chrome-action-id="sidebar-toggle"]')].filter(el => el.getBoundingClientRect().width > 0).length });
      if ((window as any).recordToggle) requestAnimationFrame(sample);
    };
    sample();
  });
  for (let cycle = 0; cycle < 3; cycle++) {
    await toggle.click(); await page.waitForTimeout(500);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(500);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  }
  const stationary = await page.evaluate(() => {
    (window as any).recordToggle = false;
    return { start: (window as any).toggleStart, frames: (window as any).toggleFrames };
  });
  assert.ok(stationary.frames.length > 5);
  for (const frame of stationary.frames) {
    assert.equal(frame.same, true); assert.equal(frame.count, 1); assert.equal(frame.hit, true);
    assert.ok(Math.abs(frame.x-stationary.start.x)<1 && Math.abs(frame.y-stationary.start.y)<1, JSON.stringify(frame));
    assert.ok(frame.gap>=0 && frame.gap<20, 'toggle immediately follows the brand');
  }
  evidence.push({ case: 'persistent-toggle-beside-brand-through-animation', frames: stationary.frames.length });
  await page.screenshot({ path: `${output}/header-expanded.png` });
  if (process.env.OPENCRAFT_HEADER_TOGGLE_ONLY !== "1") {
  const measureFooter = () => page.evaluate(() => {
    const footer = document.querySelector<HTMLElement>('.shell-navigation__footer')!;
    const track = footer.closest('.shell-sidebar__rail-footer')!.getBoundingClientRect();
    const app = footer.querySelector<HTMLElement>('[data-surface="settings"]')!.getBoundingClientRect();
    const account = footer.querySelector<HTMLElement>('[data-surface="account"]')!.getBoundingClientRect();
    const style = getComputedStyle(footer);
    return { trackWidth: track.width, rightInset: track.right - account.right, inset: parseFloat(style.paddingRight),
      gap: Math.abs(account.y-app.y)<1 ? account.left-app.right : account.top-app.bottom,
      expectedGap: parseFloat(style.gap), appWidth: app.width, appHeight: app.height, appX: app.x,
      accountWidth: account.width, position: style.position,
      iconCount: footer.querySelectorAll('[data-surface="settings"] svg').length,
      sharedIcon: !!footer.querySelector('[data-surface="settings"] [data-navigation-glyph-variant]') };
  });
  const assertFooter = async () => {
    const box = await measureFooter();
    assert.ok(Math.abs(box.rightInset-box.inset)<1, JSON.stringify(box));
    assert.ok(Math.abs(box.gap-box.expectedGap)<1 && box.gap>=0, JSON.stringify(box));
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
    await page.evaluate(() => (window as any).fixture.setWidth(323));await page.waitForTimeout(600);
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
  const held=await assertFooter();assert.equal(held.appX,beforeDrag.appX);assert.equal(held.accountWidth,beforeDrag.accountWidth,"account stays in the fixed rail while list width changes");
  const growing = await contextGeometry();assert.ok(Math.abs(growing.viewport-growing.frame)<1 && Math.abs(growing.content+48-growing.frame)<1,JSON.stringify(growing));
  assert.equal(await page.evaluate(()=>(window as any).fixture.width),323);
  await page.mouse.move(handle.x-34,200,{steps:8});await page.waitForTimeout(150);
  const shrinking = await contextGeometry();assert.equal(shrinking.committed,323);assert.ok(Math.abs(shrinking.viewport-shrinking.frame)<1 && shrinking.frame<323,JSON.stringify(shrinking));
  // Hold across repeated direction changes. No release is allowed to repair layout.
  for (const offset of [35, -20, 55, -34]) {
    await page.mouse.move(handle.x+offset,200,{steps:6});await page.waitForTimeout(100);
    const frame=await contextGeometry();assert.equal(frame.committed,323);
    assert.ok(Math.abs(frame.viewport-frame.frame)<1 && Math.abs(frame.content+48-frame.frame)<1,JSON.stringify(frame));
  }
  const beforeRelease=await contextGeometry();
  await page.mouse.up();await page.waitForTimeout(150);const released=await contextGeometry();assert.ok(Math.abs(released.frame-released.viewport)<1);
  assert.ok(Math.abs(released.viewport-beforeRelease.viewport)<1,"release must not perform deferred reflow");
  await page.evaluate(() => { (window as any).recordDragGeometry=false; });
  const dragFrames=await page.evaluate(()=>(window as any).dragGeometryFrames);
  assert.ok(dragFrames.length>5 && dragFrames.every((frame:any)=>Math.abs(frame.viewport-frame.frame)<1 && Math.abs(frame.content+48-frame.viewport)<1));
  await writeFile(`${output}/drag-geometry-frames.json`,JSON.stringify(dragFrames));
  evidence.push({case:'context-geometry-growing-contracting-and-release',passed:true,growing,shrinking,released,frames:dragFrames.length});
  await page.evaluate(() => { (window as any).fixture.setAccountName(null); (window as any).fixture.setWidth(323); });await page.waitForTimeout(600);
  evidence.push({case:'rail-footer-normal-flow-spacing-and-stable-account-including-held-drag',passed:true});
  await page.getByLabel("Sidebar filter").fill("Preserve sidebar state"); await page.getByLabel("Main draft").fill("Preserve chat draft");
  await page.evaluate(() => { (window as any).contextNode = document.querySelector('[data-sidebar-content="context"]'); document.querySelector('[data-scroll-list]')!.scrollTop = 500; });
  await page.waitForTimeout(100); await page.screenshot({ path: `${output}/docked.png` });
  const showFloating = async () => { await page.evaluate(() => (window as any).fixture.setOpen(false)); await page.waitForTimeout(700); await page.mouse.move(600,170); await page.waitForTimeout(50); await page.mouse.move(2, 170); await page.locator('.app-shell-floating-left-panel').waitFor(); await page.mouse.move(100, 170); await page.waitForTimeout(250); };
  await showFloating();
  const floating = page.locator('.app-shell-floating-left-panel');
  const floatingHandle=await floating.getByRole('separator',{name:'Resize sidebar',exact:true}).boundingBox();assert.ok(floatingHandle);
  await page.mouse.move(floatingHandle.x+1,200);await page.mouse.down();await page.mouse.move(floatingHandle.x+61,200,{steps:8});await page.waitForTimeout(150);
  const floatingGrowing=await contextGeometry();assert.ok(Math.abs(floatingGrowing.frame-floatingGrowing.viewport)<1,JSON.stringify(floatingGrowing));
  await page.mouse.move(floatingHandle.x-34,200,{steps:8});await page.waitForTimeout(150);
  const floatingShrinking=await contextGeometry();assert.ok(Math.abs(floatingShrinking.frame-floatingShrinking.viewport)<1 && floatingShrinking.frame<323,JSON.stringify(floatingShrinking));
  // A browser-dispatched pointercancel uses the real handler without persisting the preview width.
  await floating.getByRole('separator',{name:'Resize sidebar',exact:true}).dispatchEvent('pointercancel',{pointerId:1});await page.mouse.up();await page.waitForTimeout(150);
  const cancelled=await contextGeometry();assert.equal(cancelled.committed,323);assert.ok(Math.abs(cancelled.frame-323)<1 && Math.abs(cancelled.viewport-323)<1,JSON.stringify(cancelled));
  await page.mouse.move(100,170);
  evidence.push({case:'floating-context-geometry-and-cancel',passed:true,floatingGrowing,floatingShrinking,cancelled});
  await assertFooter();
  for (const name of ['Chat', 'Settings', 'Sign in']) assert.equal(await floating.getByRole('button', { name, exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => (window as any).contextNode === document.querySelector('[data-sidebar-content="context"]')), true);
  assert.equal(await page.evaluate(() => (window as any).fixture.mounts()), 1);
  assert.equal(await page.getByLabel('Sidebar filter').inputValue(), 'Preserve sidebar state');
  assert.equal(await page.locator('[data-scroll-list]').evaluate((el: Element) => el.scrollTop), 500);
  await page.screenshot({ path: `${output}/floating-expanded.png` });
  assert.equal(await floating.getByRole('button', { name: 'Applications', exact: true }).count(),0);
  assert.equal(await floating.count(), 1);
  await assertFooter();
  for (const name of ['Chat', 'Settings', 'Sign in']) {
    if(!await floating.isVisible())await showFloating();
    await floating.getByRole('button', { name, exact: true }).click();
    await page.waitForTimeout(600);
  }
  if(!await floating.isVisible())await showFloating();
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
  const topFooter=await assertFooter();assert.ok(topFooter.trackWidth>48);
  const bounds = await floating.boundingBox(); assert.ok(bounds && bounds.width <= 516);
  await page.evaluate(() => (window as any).fixture.setThemePreference('dark')); await page.screenshot({ path: `${output}/narrow-dark.png` });
  for (const name of ['Chat', 'Settings']) assert.equal(await floating.getByRole('button', { name, exact: true }).count(), 1);
  const exitFrame = await page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>('.app-shell-floating-sidebar-dismiss')!.click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const panel = document.querySelector('.app-shell-floating-left-panel');
    const content = document.querySelector('[data-sidebar-content="context"]');
    return { panelPresent: panel !== null, contentInsidePanel: panel?.contains(content) ?? false,
      dismissPresent: document.querySelector('.app-shell-floating-sidebar-dismiss') !== null,
      mounts: (window as any).fixture.mounts() };
  });
  if(process.env.OPENCRAFT_REDUCED_MOTION!=='1') {
    assert.deepEqual(exitFrame, { panelPresent:true, contentInsidePanel:true, dismissPresent:true, mounts:1 },
      'exit motion must retain its content and outside hit surface until completion');
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-app-shell-sidebar-trigger]')!.click());
    assert.equal(await page.evaluate(() => {
      const panel = document.querySelector('.app-shell-floating-left-panel');
      return panel?.contains(document.querySelector('[data-sidebar-content="context"]')) ?? false;
    }), true, 'reopening during exit must keep the same content owner');
  } else {
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).click(); await floating.waitFor();
  }
  await floating.waitFor();
  // Browser surfaces are hosted in a body-level fixed portal, outside the
  // Shell tree. Reproduce that stacking and hit-testing boundary on mobile.
  await page.evaluate(() => {
    const root = document.createElement('div');
    root.className = 'web-browser-presentation-root';
    root.id = 'sidebar-browser-layer-probe';
    const surface = document.createElement('div');
    surface.className = 'web-browser-surface';
    surface.style.cssText = 'inset:0;pointer-events:auto';
    surface.onclick = () => { (window as any).browserSurfaceClicks = ((window as any).browserSurfaceClicks ?? 0) + 1; };
    root.append(surface); document.body.append(root);
    (window as any).browserSurfaceNode = surface;
  });
  const layer = await page.evaluate(() => {
    const sidebar = document.querySelector('.app-shell-floating-left-panel')!;
    const inside = document.elementFromPoint(100, 620);
    const outside = document.elementFromPoint(530, 400);
    return { insideSidebar: sidebar.contains(inside), outsideDismiss: outside?.classList.contains('app-shell-floating-sidebar-dismiss') };
  });
  assert.deepEqual(layer, { insideSidebar: true, outsideDismiss: true }, 'floating sidebar and its dismiss surface must cover the browser portal');
  await page.mouse.click(530, 200); await floating.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => (window as any).browserSurfaceClicks ?? 0), 0, 'the closing tap must not reach the browser');
  assert.equal(await page.evaluate(() => document.querySelector('.web-browser-surface') === (window as any).browserSurfaceNode), true, 'closing the sidebar must retain the browser surface');
  await page.mouse.click(530, 400);
  assert.equal(await page.evaluate(() => (window as any).browserSurfaceClicks ?? 0), 1, 'the retained browser becomes interactive after sidebar exit');
  await page.evaluate(() => document.querySelector('#sidebar-browser-layer-probe')?.remove());
  assert.equal((await page.evaluate(() => (window as any).fixture.actions)).includes('Main'), false,
    'an outside tap must not activate the covered conversation');
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click(); await floating.waitFor();
  evidence.push({ case: 'mobile-outside-dismiss-retains-content-and-consumes-tap', passed: true });
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
    await page.evaluate(() => document.documentElement.style.setProperty('--gap-control-group','12px'));
    assert.equal((await assertFooter()).gap,4);
    await page.evaluate(() => document.documentElement.style.removeProperty('--gap-control-group'));
    evidence.push({case:'rail-footer-navigation-only-and-theme-token-override',passed:true});
  }
  assert.equal(await page.getByRole('separator',{name:'Resize applications',exact:true}).count(),0);
  assert.equal(await page.locator('.shell-sidebar__navigation').evaluate(e=>e.getBoundingClientRect().width),48);
  evidence.push({case:'unified-rail-has-no-independent-resizer',passed:true});
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify(evidence));
} finally { await writeFile(`${output}/report.json`, JSON.stringify({ evidence, errors }, null, 2)); await browser?.close(); await vite.close(); }
