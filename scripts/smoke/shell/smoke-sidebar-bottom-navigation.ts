import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.OPENCRAFT_BOTTOM_NAV_OUTPUT ?? '/tmp/opencraft-sidebar-bottom-navigation';
const source = `
import React,{useState,useEffect} from 'react';
import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader,AppShellNavigationControls} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {WorkbenchPresentationContext,applyWorkbenchProductPresentation} from '/apps/workbench-web/src/workbench-product.ts';
import {resolveWorkbenchPresentation} from '/apps/workbench-web/src/workbench-presentation.ts';
import {ApplicationBrand} from '/apps/workbench-web/src/components/application-brand.tsx';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId,longingThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
const presentation=resolveWorkbenchPresentation({iconStyle:'classic'});applyWorkbenchProductPresentation(document.documentElement,'navigation-fixture',presentation);initializeAppearanceTheme();setAppearanceThemeId(longingThemeId); const calls=[]; let mounts=0;
function Context(){useEffect(()=>{mounts++},[]);return <div style={{height:'100%',display:'flex',flexDirection:'column',padding:12,boxSizing:'border-box'}}><input aria-label='Sidebar filter' defaultValue='Saved filter'/><div data-test-list style={{overflow:'auto',flex:1,minHeight:0}}>{Array.from({length:60},(_,i)=><div key={i} style={{padding:12}}>Conversation {i+1}</div>)}</div></div>}
function Fixture(){const[open,setOpen]=useState(true),[width,setWidth]=useState(335),[context,setContext]=useState(true),[active,setActive]=useState('home'),[showcase,setShowcase]=useState(false);
window.fixture={setOpen,setWidth,setContext,setThemePreference,setActive,setShowcase,calls,mounts:()=>mounts};
const destinations=(showcase?[['home','Home','home'],['tasks','Board','columns'],['servers','Test environments','server']]:[['home','Home','home'],['tasks','Tasks','tasks'],['servers','Servers','servers'],['activity','Activity','activity'],['shell.search','Search','search'],['shell.applications','Applications','grid']]).map(([id,title,icon])=>({id,title,icon,active:active===id,onInvoke:()=>{calls.push(id);setActive(id)}}));
return <AppShell navigation={{layout:'unified',actions:destinations,account:{snapshot:{phase:'authenticated',name:'Alex Chen with a very long account name',avatarUrl:null},onRefresh:async()=>{},onOpen:()=>calls.push('account')},onOpenSettings:()=>calls.push('settings')}} layoutScope='bottom-navigation-smoke' mainContentLayout='default' sidebarOpen={open} sidebarWidth={width} onSidebarResizeEnd={v=>v!==null&&setWidth(v)} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>calls.push('window')} header={<AppShellHeader navigationBrand={<ApplicationBrand/>} title={null} project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>calls.push('window')} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>} floatingSidebarHeader={dock=><AppShellNavigationControls hostRole='transient' sidebarOpen={false} onToggleSidebar={dock} onHome={()=>{}} onBack={()=>{}} onForward={()=>{}} canGoBack={false} canGoForward={false} actions={['sidebar-toggle']}/>} leftPanel={context?<Context/>:null}><div style={{padding:32}}><h1>Sidebar redesign</h1><p>The conversation uses the full sidebar width.</p><textarea aria-label='Main draft' defaultValue='Keep this draft'/></div></AppShell>}
createRoot(document.getElementById('root')).render(<WorkbenchPresentationContext.Provider value={presentation}><Fixture/></WorkbenchPresentationContext.Provider>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), publicDir: 'apps/workbench-web/public', logLevel: 'error', resolve: { dedupe: ['react', 'react-dom'] }, cacheDir: 'node_modules/.vite-bottom-navigation', esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['react', 'react-dom/client', '@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-popover', '@radix-ui/react-tooltip', '@tanstack/react-query'] }, plugins: [{ name: 'bottom-navigation-fixture', resolveId: id => id === '/bottom-navigation.tsx' ? id : null, load: id => id === '/bottom-navigation.tsx' ? source : null, configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/') return next(); res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/bottom-navigation.tsx"></script>'); }); } }] });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const evidence: unknown[] = [], errors: string[] = [];
try {
  await mkdir(output, {recursive:true}); await vite.listen();
  browser = await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror', error=>errors.push(error.message));
  await page.addInitScript('window.__name=value=>value');
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`);
  await page.getByLabel('Main draft').waitFor();
  await page.getByLabel('Sidebar filter').fill('Keep filter');
  await page.getByLabel('Main draft').fill('Keep original draft');
  await page.locator('[data-test-list]').evaluate(el=>el.scrollTop=400);
  await page.evaluate(()=>{(window as any).contextNode=document.querySelector('[data-sidebar-content="context"]')});
  const check = async () => {
    await page.waitForTimeout(200);
    const geometry = await page.evaluate(()=>{
      const rect=(selector:string)=>document.querySelector(selector)!.getBoundingClientRect().toJSON();
      return {column:rect('.shell-sidebar__column'),context:rect('.shell-sidebar__context'),nav:rect('.shell-sidebar__navigation'),footer:rect('.shell-sidebar__rail-footer'),app:rect('.app-shell-header__applications'),window:rect('button.app-shell-header__right-panel-toggle'),buttons:[...document.querySelectorAll('.shell-sidebar-navigation [data-action-id]')].map(el=>el.getBoundingClientRect().toJSON()),controls:[...document.querySelectorAll('.shell-sidebar-navigation [data-action-id],.shell-navigation__footer--unified > button')].map(el=>el.getBoundingClientRect().toJSON()),glyphs:[...document.querySelectorAll('.shell-sidebar-navigation [data-action-id] [data-navigation-glyph-variant],.shell-navigation__footer--unified [data-surface="settings"] [data-navigation-glyph-variant]')].map(el=>el.getBoundingClientRect().toJSON()),avatar:rect('.shell-navigation__footer--unified .sidebar-account__avatar')};
    });
    assert.ok(Math.abs(geometry.context.width-geometry.column.width)<1,JSON.stringify(geometry));
    assert.ok(geometry.nav.y>=geometry.context.bottom-1);
    assert.ok(geometry.nav.height>=44 && geometry.footer.height>=44,'compact bottom row retains its control and padding budget');
    assert.ok(geometry.controls.every(rect=>rect.width>=36 && rect.height>=36),'compact bottom controls use the shared application target');
    const family=await page.locator('.shell-sidebar-navigation [data-action-id],.shell-navigation__footer--unified > button').evaluateAll(elements=>elements.map(el=>({shared:el.classList.contains('ui-button'),surface:el.getAttribute('data-control-surface'),radius:getComputedStyle(el).borderRadius,height:el.getBoundingClientRect().height,glyphs:[...el.querySelectorAll('[data-navigation-glyph-variant]')].map(g=>({fill:g.getAttribute('fill'),stroke:g.getAttribute('stroke-width')}))})));
    assert.ok(family.every(control=>control.shared&&control.surface==='integrated'),'all bottom controls share Button surfaces');
    assert.equal(new Set(family.map(control=>control.radius)).size,1,'one corner treatment across destinations and account/settings');
    assert.equal(new Set(family.map(control=>control.height)).size,1,'one control height across both tracks');
    assert.ok(family.flatMap(control=>control.glyphs).every(g=>g.fill==='none'&&(g.stroke==='2'||g.stroke==='1.5')),'selection never fills or boldens destination artwork; shared gear keeps its optical weight');
    assert.ok(geometry.glyphs.length>=5 && geometry.glyphs.every(rect=>rect.width===20 && rect.height===20),'compact destination and settings glyphs share the 20px canvas');
    assert.ok(geometry.avatar.width>=24 && geometry.avatar.height>=24,'compact account avatar remains legible');
    assert.ok(Math.abs(geometry.nav.y-geometry.footer.y)<1);
    assert.ok(geometry.nav.right<=geometry.footer.x+1);
    assert.ok(geometry.buttons.every(rect=>Math.abs(rect.y-geometry.buttons[0].y)<1),'all destinations are horizontal');
    await page.screenshot({path:output+'/current.png'});
    assert.ok(geometry.app.right<=geometry.window.x+1 && geometry.window.x-geometry.app.right<24,JSON.stringify(geometry));
    assert.equal(await page.locator('.shell-sidebar-navigation [data-action-id="shell.applications"]').count(),0);
    for(const selector of ['[data-surface="settings"]','[data-surface="account"]']) {
      assert.equal(await page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),true);
    }
    return geometry;
  };
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>(window as any).fixture.setThemePreference(theme),theme);
    for(const width of [335,240,425]) {
      await page.evaluate(width=>(window as any).fixture.setWidth(width),width);
      await page.waitForTimeout(450); evidence.push({theme,width,geometry:await check()});
      await page.screenshot({path:`${output}/desktop-${theme}-${width}.png`});
    }
  }
  await page.locator('.app-shell-header__applications').click();
  assert.equal(await page.locator('.app-shell-header__applications').getAttribute('aria-current'),'page');
  await page.locator('.shell-sidebar-navigation [data-action-id="tasks"]').click();
  await page.locator('[data-surface="settings"]').click();
  await page.locator('[data-surface="account"]').click();
  await page.locator('.shell-navigation__peek').waitFor(); await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(()=>(window as any).fixture.calls),['shell.applications','tasks','settings']);
  const handle=await page.getByRole('separator',{name:'Resize sidebar',exact:true}).boundingBox();
  assert.ok(handle);
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);
  await page.mouse.down();
  await page.mouse.move(handle.x+50,handle.y+handle.height/2,{steps:6});
  await check();
  await page.mouse.move(handle.x-30,handle.y+handle.height/2,{steps:6});
  await check();
  await page.mouse.up();
  await page.getByRole('separator',{name:'Resize sidebar',exact:true}).focus();
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(250); await check();
  await page.evaluate(()=>(window as any).fixture.setOpen(false)); await page.waitForTimeout(600);
  assert.equal(await page.locator('.app-shell-header__applications').isVisible(),true,'Applications remains reachable with sidebar closed');
  await page.evaluate(()=>(window as any).fixture.setOpen(true)); await page.waitForTimeout(600);
  assert.equal(await page.getByLabel('Sidebar filter').inputValue(),'Keep filter');
  assert.equal(await page.getByLabel('Main draft').inputValue(),'Keep original draft');
  assert.equal(await page.locator('[data-test-list]').evaluate(el=>el.scrollTop),400);
  assert.equal(await page.evaluate(()=>(window as any).contextNode===document.querySelector('[data-sidebar-content="context"]')),true);
  assert.equal(await page.evaluate(()=>(window as any).fixture.mounts()),1);
  await page.evaluate(()=>(window as any).fixture.setContext(false));await page.waitForTimeout(450);await check();
  await page.evaluate(()=>(window as any).fixture.setContext(true));
  await page.setViewportSize({width:480,height:820});
  await page.waitForTimeout(500);
  await page.locator('[data-chrome-action-id="sidebar-toggle"][data-chrome-action-host-role="persistent"]').click();
  // On narrow browsers the same content moves into the existing mobile drawer.
  await page.getByLabel('Sidebar filter').waitFor({state:'visible'});await page.waitForTimeout(600);
  assert.equal(await page.locator('.shell-sidebar__column[data-navigation-layout="mobile"]').count(),1);
  assert.equal(await page.locator('.app-shell-header__applications').count(),0);
  assert.equal(await page.locator('.shell-sidebar__applications').isVisible(),true);
  const mobileRects=await page.locator('.shell-sidebar-navigation [data-action-id]').evaluateAll(elements=>elements.map(el=>el.getBoundingClientRect().y));
  assert.ok(mobileRects[1]>mobileRects[0],'mobile retains labeled vertical destinations');
  await page.screenshot({path:`${output}/mobile.png`});
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>{const f=(window as any).fixture;f.setOpen(true);f.setWidth(335);f.setActive('home');f.setShowcase(true);f.setContext(true);f.setThemePreference('light')});
  await page.locator('.shell-sidebar__column:not([data-navigation-layout="mobile"])').waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({path:output+'/showcase-light.png'});
  const rail=await page.locator('.shell-sidebar__navigation').boundingBox();
  const footer=await page.locator('.shell-sidebar__rail-footer').boundingBox();
  await page.screenshot({path:output+'/bottom-light.png',clip:{x:rail!.x,y:Math.min(rail!.y,footer!.y),width:footer!.x+footer!.width-rail!.x,height:Math.max(rail!.height,footer!.height)}});
  assert.deepEqual(errors,[]);
  await writeFile(`${output}/evidence.json`,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({passed:true,desktopCases:evidence.length,actions:true,retainedDraftAndPortal:true,mobile:true,output}));
} finally {await browser?.close();await vite.close();}
