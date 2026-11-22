import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.OPENCRAFT_BOTTOM_NAV_OUTPUT ?? '/tmp/opencraft-sidebar-bottom-navigation';
const source = `
import React,{useState,useEffect} from 'react';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density.ts';
import {useUiPreferencesRuntime} from '/apps/workbench-web/src/runtime/ui-preferences-runtime';
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
function Fixture(){const preferences=useUiPreferencesRuntime();useEffect(()=>bindInteractionDensity(document,preferences),[preferences]);const[open,setOpen]=useState(true),[width,setWidth]=useState(335),[context,setContext]=useState(true),[active,setActive]=useState('home'),[showcase,setShowcase]=useState(false);
window.fixture={setDensity:value=>preferences.set('interface.touchFriendly',value),setOpen,setWidth,setContext,setThemePreference,setActive,setShowcase,calls,mounts:()=>mounts};
const destinations=(showcase?[['home','Home','home'],['tasks','Board','columns'],['servers','Test environments','server']]:[['home','Home','home'],['tasks','Tasks','tasks'],['servers','Servers','servers'],['shell.search','Search','search'],['shell.applications','Applications','grid']]).map(([id,title,icon])=>({id,title,icon,active:active===id,onInvoke:()=>{calls.push(id);setActive(id)}}));
return <AppShell navigation={{actions:destinations,account:{snapshot:{phase:'authenticated',name:'Alex Chen with a very long account name',avatarUrl:null},onRefresh:async()=>{},onOpen:()=>calls.push('account')},onOpenSettings:()=>calls.push('settings')}} layoutScope='bottom-navigation-smoke' mainContentLayout='default' sidebarOpen={open} sidebarWidth={width} onSidebarResizeEnd={v=>v!==null&&setWidth(v)} onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>calls.push('window')} header={<AppShellHeader navigationBrand={<ApplicationBrand/>} title={null} project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>calls.push('window')} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>} floatingSidebarHeader={dock=><AppShellNavigationControls hostRole='transient' sidebarOpen={false} onToggleSidebar={dock} onHome={()=>{}} onBack={()=>{}} onForward={()=>{}} canGoBack={false} canGoForward={false} actions={['sidebar-toggle']}/>} leftPanel={context?<Context/>:null}><div style={{padding:32}}><h1>Sidebar redesign</h1><p>The conversation uses the full sidebar width.</p><textarea aria-label='Main draft' defaultValue='Keep this draft'/></div></AppShell>}
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
  const inputTheme=process.env.OPENCRAFT_SIDEBAR_INPUT_THEME??'light';
  await page.evaluate(theme=>(window as any).fixture.setThemePreference(theme),inputTheme);
  if (process.env.OPENCRAFT_BOTTOM_NAV_WRAP_NEGATIVE_CONTROL === '1') {
    await page.addStyleTag({content: '.shell-sidebar__column:not([data-navigation-layout="mobile"]) .shell-sidebar-navigation .shell-navigation__items--applications { flex-wrap: wrap !important; gap: 4px !important; }'});
  }
  await page.getByLabel('Sidebar filter').fill('Keep filter');
  await page.getByLabel('Main draft').fill('Keep original draft');
  await page.locator('[data-test-list]').evaluate(el=>el.scrollTop=400);
  await page.evaluate(()=>{(window as any).contextNode=document.querySelector('[data-sidebar-content="context"]')});
  if (process.env.OPENCRAFT_SIDEBAR_INPUT_ONLY !== "1") {
  const check = async (glyphSize = 20) => {
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
    assert.ok(geometry.glyphs.length>=5 && geometry.glyphs.every(rect=>rect.width===glyphSize && rect.height===glyphSize),'destination and settings glyphs share their density canvas');
    assert.ok(geometry.avatar.width>=24 && geometry.avatar.height>=24,'compact account avatar remains legible');
    assert.ok(Math.abs(geometry.nav.bottom-geometry.footer.bottom)<1);
    assert.ok(geometry.nav.right<=geometry.footer.x+1);
    assert.ok(geometry.controls.every(rect=>Math.abs(rect.y-geometry.controls[0].y)<1),'destinations, Settings and account share one row at every sidebar width');
    const navigationTrack = page.locator('.shell-sidebar__navigation');
    const overflows = await navigationTrack.evaluate(el => el.scrollWidth > el.clientWidth);
    if (overflows) {
      await page.locator('.shell-sidebar-navigation [data-action-id]').last().scrollIntoViewIfNeeded();
      assert.ok(await navigationTrack.evaluate(el => el.scrollLeft > 0), 'the track can reveal overflowing destinations');
      await navigationTrack.evaluate(el => { el.scrollLeft = 0; });
    } else {
      assert.ok(geometry.buttons.every(rect => rect.x >= geometry.nav.x && rect.right <= geometry.nav.right + 1));
      assert.equal(await page.locator('.shell-sidebar-navigation [data-action-id]').evaluateAll(elements => elements.every(el => {
        const rect = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      })), true, 'every visible destination is directly clickable');
    }
    assert.equal(await page.locator('.shell-navigation-strip__previous,.shell-navigation-strip__next').count(), 0, 'no paging arrows');
    await page.screenshot({path:output+'/current.png'});
    assert.ok(geometry.app.right<=geometry.window.x+1,JSON.stringify(geometry));
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
  // Touch density retains 44px targets. In a physically too-narrow dock the
  // destinations scroll on one axis while Settings/account remain fixed.
  await page.evaluate(()=>{document.documentElement.dataset.uiDensity='touch';(window as any).fixture.setWidth(335)});
  await page.waitForTimeout(450); await check(24);
  assert.ok(await page.locator('.shell-sidebar-navigation [data-action-id],.shell-navigation__footer--unified > button').evaluateAll(es=>es.every(e=>{const r=e.getBoundingClientRect();return r.width>=44&&r.height>=44})));
  await page.evaluate(()=>(window as any).fixture.setWidth(240)); await page.waitForTimeout(450);
  const touchRows=await page.locator('.shell-sidebar-navigation [data-action-id],.shell-navigation__footer--unified > button').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().y));
  assert.ok(touchRows.every(y=>Math.abs(y-touchRows[0])<1));
  assert.ok(await page.locator('.shell-sidebar__navigation').evaluate(e=>e.scrollWidth>e.clientWidth));
  await page.locator('[data-action-id="shell.search"]').focus(); await page.waitForTimeout(100);
  assert.ok(await page.locator('.shell-sidebar__navigation').evaluate(e=>e.scrollLeft>0),'keyboard reaches overflow destinations without wrapping');
  await page.screenshot({path:output+'/desktop-touch-narrow.png'});
  await page.evaluate(()=>{document.documentElement.dataset.uiDensity='compact';(window as any).fixture.setWidth(335)});
  await page.waitForTimeout(450); await check();
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
  }
  await page.setViewportSize({width:480,height:820});
  await page.waitForTimeout(500);
  await page.locator('[data-chrome-action-id="sidebar-toggle"][data-chrome-action-host-role="persistent"]').click();
  // Capacity changes placement, never input preference. Narrow pointer browsers
  // keep the desktop footer, ordinary floating dismissal and retained content.
  await page.getByLabel('Sidebar filter').waitFor({state:'visible'});await page.waitForTimeout(600);
  assert.equal(await page.locator('.shell-sidebar__column[data-navigation-layout="mobile"]').count(),0,'narrow pointer is not a touch drawer');
  assert.equal(await page.locator('.app-shell-floating-overlay-root[data-mobile-sidebar]').count(),0);
  assert.equal(await page.locator('.app-shell-mobile-page-dismiss,.app-shell-mobile-page-wash,.shell-sidebar__footer').count(),0);
  assert.equal(await page.locator('.app-shell-floating-sidebar-dismiss').isVisible(),true,'pointer drawer keeps existing outside dismissal');
  const integrated=page.locator('.shell-navigation__footer--unified > button');
  assert.ok(await integrated.count()>=2);
  assert.ok(await integrated.evaluateAll(es=>es.every(e=>e.getAttribute('data-control-surface')==='integrated')));
  const pointerRects=await page.locator('.shell-sidebar-navigation [data-action-id]').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().y));
  assert.ok(pointerRects.length>=3&&pointerRects.every(y=>Math.abs(y-pointerRects[0])<1),'pointer navigation stays horizontal');
  await page.getByLabel('Sidebar filter').fill('Narrow retained filter');
  await page.locator('[data-test-list]').evaluate(e=>e.scrollTop=250);
  await page.evaluate(()=>{(window as any).retainedFilter=document.querySelector('[aria-label="Sidebar filter"]');(window as any).retainedDraft=document.querySelector('[aria-label="Main draft"]')});
  await page.screenshot({path:output+'/narrow-desktop.png'});
  // Keyboard dismissal/reopen still works, without replacing the draft owner.
  await page.keyboard.press('Escape');await page.waitForTimeout(500);
  assert.equal(await page.locator('.app-shell-floating-sidebar-dismiss').count(),0);
  await page.locator('[data-chrome-action-id="sidebar-toggle"][data-chrome-action-host-role="persistent"]').click();
  await page.getByLabel('Sidebar filter').waitFor({state:'visible'});
  for(const width of [720,430,900,480,1440]) {
    await page.setViewportSize({width,height:900});
    await page.waitForTimeout(600);
    if(!await page.getByLabel('Sidebar filter').isVisible()) {
      await page.locator('[data-chrome-action-id="sidebar-toggle"][data-chrome-action-host-role="persistent"]').click();
      await page.getByLabel('Sidebar filter').waitFor({state:'visible'});await page.waitForTimeout(500);
    }
    assert.equal(await page.locator('.shell-sidebar__column[data-navigation-layout="mobile"]').count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.uiDensity),'compact');
    assert.equal(await page.getByLabel('Sidebar filter').inputValue(),'Narrow retained filter');
    assert.equal(await page.getByLabel('Main draft').inputValue(),'Keep original draft');
    assert.equal(await page.evaluate(()=>(window as any).retainedFilter===document.querySelector('[aria-label="Sidebar filter"]')&&(window as any).retainedDraft===document.querySelector('[aria-label="Main draft"]')),true,'resize retains input DOM');
    assert.equal(await page.locator('[data-test-list]').evaluate(e=>e.scrollTop),250,'resize preserves list scroll');
  }
  // Real coarse-capability context consumes the same preference owner, not width
  // or a UA test. Explicit compact/on overrides also remain authoritative.
  for(const hasTouch of [false,true]) {
    const context=await browser.newContext({viewport:{width:480,height:820},hasTouch});
    const probe=await context.newPage();probe.on('pageerror',e=>errors.push(e.message));
    await probe.addInitScript('window.__name=value=>value');
    await probe.goto(page.url());await probe.getByLabel('Main draft').waitFor();
    await probe.evaluate(theme=>(window as any).fixture.setThemePreference(theme),inputTheme);
    await probe.evaluate(()=>(window as any).fixture.setDensity('auto'));await probe.waitForTimeout(600);
    assert.equal(await probe.evaluate(()=>document.documentElement.dataset.uiDensity),hasTouch?'touch':'compact');
    const toggle=probe.locator('[data-chrome-action-id="sidebar-toggle"][data-chrome-action-host-role="persistent"]');
    if(hasTouch)await toggle.tap();else await toggle.click();
    await probe.getByLabel('Sidebar filter').waitFor({state:'visible'});await probe.waitForTimeout(500);
    assert.equal(await probe.locator('.shell-sidebar__column[data-navigation-layout="mobile"]').count(),hasTouch?1:0);
    await probe.getByLabel('Main draft').evaluate(e=>(e as HTMLTextAreaElement).value='Retained capability draft');
    for(const choice of ['on','off','auto']) {
      await probe.evaluate(choice=>(window as any).fixture.setDensity(choice),choice);await probe.waitForTimeout(600);
      const mobile=choice==='on'||choice==='auto'&&hasTouch;
      assert.equal(await probe.locator('.shell-sidebar__column[data-navigation-layout="mobile"]').count(),mobile?1:0,'preference '+choice+' touch '+hasTouch);
      const settings=probe.locator('.shell-navigation__footer--unified > [data-surface="settings"]');
      assert.equal(await settings.getAttribute('data-control-surface'),mobile?'floating':'integrated');
      assert.equal(await probe.getByLabel('Main draft').inputValue(),'Retained capability draft');
    }
    if(hasTouch) {
      await probe.locator('.shell-navigation__footer--unified > [data-surface="account"]').tap();
      await probe.locator('.shell-navigation__peek').waitFor();await probe.keyboard.press('Escape');
      assert.equal(await probe.getByLabel('Main draft').inputValue(),'Retained capability draft');
    }
    await probe.screenshot({path:output+'/'+(hasTouch?'touch':'pointer')+'-auto-narrow.png'});
    await probe.setViewportSize({width:1440,height:900});await probe.evaluate(()=>(window as any).fixture.setOpen(true));await probe.waitForTimeout(600);
    assert.equal(await probe.locator('.shell-sidebar__column[data-navigation-layout="mobile"]').count(),0,'wide touch can dock without phone action layout');
    assert.equal(await probe.locator('.shell-navigation__footer--unified > [data-surface="settings"]').getAttribute('data-control-surface'),'integrated');
    await context.close();
  }
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
  console.log(JSON.stringify({passed:true,desktopCases:evidence.length,actions:true,retainedDraftAndPortal:true,capacityAndInputIndependent:true,trueTouchAndOverrides:true,output}));
} finally {await browser?.close();await vite.close();}
