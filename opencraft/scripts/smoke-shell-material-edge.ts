import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const output = await mkdtemp(join(tmpdir(), "opencraft-shell-material-edge-"));
const source = `
import React,{useEffect,useState} from 'react';
import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import {buildCodexThemeCssProperties,codexThemePalette,frostThemePalette,lavenderThemePalette,velaThemePalette,zenCodeThemePalette} from '@opencraft/design-system/theme-engine';
import '/apps/workbench-web/src/styles/app.scss';
import '@fontsource-variable/noto-sans-sc';
initializeAppearanceTheme();
let mounts=0,clicks=0;
const palettes={codex:codexThemePalette,frost:frostThemePalette,lavender:lavenderThemePalette,vela:velaThemePalette,zen:zenCodeThemePalette};
function Context(){useEffect(()=>{mounts++},[]);return <div style={{display:'flex',height:'100%',flexDirection:'column'}}>
<input aria-label='Sidebar draft' defaultValue='侧栏内容保持不变' style={{margin:16}}/>
<button aria-label='Edge action' onClick={()=>clicks++} style={{marginTop:20,padding:12,textAlign:'right',background:'transparent',border:0}}>边缘操作</button>
</div>}
function App(){const [open,setOpen]=useState(true),[context,setContext]=useState(true),[width,setWidth]=useState(320),
[chrome,setChrome]=useState({kind:'browser',platform:'linux',safeArea:{left:0,right:0}});
window.fixture={setOpen,setContext,setWidth,setChrome,width,mounts:()=>mounts,clicks:()=>clicks,
theme:(name,mode)=>{document.documentElement.dataset.theme=mode;Object.entries(buildCodexThemeCssProperties(mode,palettes[name][mode])).forEach(([k,v])=>document.documentElement.style.setProperty(k,v))}};
return <AppShell layoutScope='material-edge' mainContentLayout='default' sidebarOpen={open} sidebarWidth={width}
navigation={{actions:[{id:'chat',title:'Chat',icon:'chat',onInvoke:()=>{}}],settingsActive:false,onOpenSettings:()=>{},account:{snapshot:{phase:'anonymous',name:null,avatarUrl:null},onOpen:()=>{},onRefresh:async()=>{},onSignOut:async()=>{}}}}
windowChrome={chrome}
onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={setWidth}
rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={()=>{}}
header={<AppShellHeader title='协作自身优化' project={null} sidebarOpen={open} rightPanelOpen={false} rightPanelFullWidth={false}
showRightPanelAction={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>{}} onHome={()=>{}}
canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
floatingSidebarHeader={dock=><button onClick={dock}>固定侧栏</button>}
leftPanel={context?<Context/>:null}>
<div style={{padding:28}}><h2>会话内容</h2><input aria-label='Main draft' defaultValue='保留输入草稿'/></div>
</AppShell>}
createRoot(document.getElementById('root')).render(<App/>);
`;

const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-shell-material-edge",
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react-intl", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover"] },
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "shell-material-edge-fixture",
    resolveId: id => id === "/material-edge.tsx" ? id : null,
    load: id => id === "/material-edge.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/material-edge.tsx"></script>');
    }); },
  }],
});
let browser: any;
const evidence: unknown[] = [], errors: string[] = [];
try {
  await vite.listen();
  const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1180, height: 720 }, hasTouch: true });
  page.setDefaultTimeout(10000);
  await page.addInitScript("window.__name = value => value");
  page.on("pageerror", (error: Error) => errors.push(error.message));
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  await page.goto(url);
  await page.getByLabel("Sidebar draft").waitFor();
  await page.evaluate(() => document.fonts.ready);
  const measure = () => page.evaluate(() => {
    const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON();
    const sidecar = document.querySelector(".app-shell-sidecar")!, main = document.querySelector(".main-content-surface")!;
    // Resolve the theme's actual shadow through the browser, not a second palette.
    const probe = document.createElement('div'); probe.style.boxShadow = 'var(--codex-main-surface-elevation)';
    probe.style.position = 'fixed'; probe.style.pointerEvents = 'none'; document.body.append(probe);
    const expectedShadow = getComputedStyle(probe).boxShadow; probe.remove();
    return { sidecar: rect(".app-shell-sidecar"), main: rect(".main-content-surface"),
      frame: rect(".app-shell-left-panel"), viewport: rect(".app-shell-left-panel__viewport"),
      background: getComputedStyle(sidecar).backgroundImage, shadow: getComputedStyle(main).boxShadow, expectedShadow };
  });
  await page.waitForFunction(() => document.querySelector('.app-shell-left-panel')!.getBoundingClientRect().width === 320);
  await page.getByLabel("Main draft").fill("这份草稿不会被材质变更重建");
  await page.evaluate(() => { (window as any).savedDraftNode = document.querySelector('[aria-label="Main draft"]'); });
  for (const name of ["codex", "frost", "lavender", "vela", "zen"]) {
    for (const mode of ["light", "dark"]) {
      await page.evaluate(([name, mode]: string[]) => (window as any).fixture.theme(name, mode), [name, mode]);
      await page.mouse.move(1000, 600);
      const before = await measure();
      assert.equal(before.shadow, before.expectedShadow, `theme owns elevation: ${name}/${mode}`);
      if (name === 'zen') assert.equal(before.shadow, 'none', 'flat themes must remain flat');
      else assert.notEqual(before.shadow, 'none', 'soft elevation and themed strokes must remain visible');
      assert.equal(before.background, 'none', `no gradient: ${name}/${mode}`);
      assert.equal(await page.locator('.app-shell-header').evaluate((el: Element) => parseFloat(getComputedStyle(el,'::before').width)),0);
      await page.screenshot({ path: join(output, `${name}-${mode}.png`) });
      evidence.push({ name, mode, presentation: 'context', noGradient: true, mainShadow: before.shadow, themeShadow: before.expectedShadow });
    }
  }
  // A control next to the plain body boundary remains hit-testable. The outermost
  // 8px are intentionally owned by the existing resize separator, not content.
  const action = await page.getByLabel("Edge action").boundingBox();
  assert.ok(action);
  await page.mouse.click(action.x + action.width - 12, action.y + action.height / 2);
  assert.equal(await page.evaluate(() => (window as any).fixture.clicks()), 1);
  const resize = await page.getByRole("separator", { name: "Resize sidebar", exact: true }).boundingBox();
  assert.ok(resize);
  await page.mouse.move(resize.x + 1, 350); await page.mouse.down();
  for (const dx of [45, -25, 65, -35]) {
    await page.mouse.move(resize.x + dx, 350, { steps: 5 });
    const held = await measure();
    assert.ok(Math.abs(held.frame.width - held.viewport.width) < 1);
    assert.ok(Math.abs(held.sidecar.right - held.main.left) < 1);
    assert.equal(held.shadow, held.expectedShadow);
    assert.equal(await page.evaluate(() => (window as any).fixture.width), 320);
  }
  await page.mouse.up();
  await page.emulateMedia({ forcedColors: "active" });
  const forced = await page.locator(".app-shell-sidecar").evaluate((el: Element) => {
    const rule = getComputedStyle(el, "::after");
    return { background: getComputedStyle(el).backgroundImage, border: rule.borderRightStyle, width: rule.borderRightWidth, pointerEvents: rule.pointerEvents };
  });
  assert.deepEqual(forced, { background: "none", border: "solid", width: "1px", pointerEvents: "none" });
  await page.screenshot({ path: join(output, "forced-colors.png") });
  await page.emulateMedia({ forcedColors: "none" });
  await page.evaluate(() => (window as any).fixture.setOpen(false));
  await page.waitForFunction(() => document.querySelector('.app-shell-sidecar')!.getBoundingClientRect().width === 0);
  assert.equal(await page.evaluate(() => document.querySelector('.main-content-surface')!.getBoundingClientRect().left), 0);
  await page.screenshot({ path: join(output, "hidden.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).tap();
  const floating = page.locator('.app-shell-floating-left-panel__surface'); await floating.waitFor();
  await page.waitForFunction(() => {
    const panel = document.querySelector('.app-shell-floating-left-panel');
    return panel !== null && getComputedStyle(panel).opacity === '1';
  });
  const floatingStyle = await floating.evaluate((el: Element) => ({ background: getComputedStyle(el).backgroundImage, shadow: getComputedStyle(el).boxShadow }));
  assert.equal(floatingStyle.background, "none"); assert.notEqual(floatingStyle.shadow, "none");
  await page.screenshot({ path: join(output, "mobile-floating.png") });
  await page.keyboard.press('Escape'); await floating.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1180, height: 720 });
  await page.evaluate(() => (window as any).fixture.setOpen(true));
  await page.getByLabel('Sidebar draft').waitFor();
  assert.equal(await page.evaluate(() => (window as any).savedDraftNode === document.querySelector('[aria-label="Main draft"]')), true);
  assert.equal(await page.getByLabel('Main draft').inputValue(), "这份草稿不会被材质变更重建");
  assert.equal(await page.evaluate(() => (window as any).fixture.mounts()), 1);
  // Compact primary + contextual pane is not compact-only. Keep context's
  // physical exit owner authoritative after content availability changes.
  if (await page.getByRole('separator',{name:'Resize applications',exact:true}).count() === 0) {
    await page.getByRole('button',{name:'Applications',exact:true}).click();
  }
  await page.getByRole('separator',{name:'Resize applications',exact:true}).press('Home');
  await page.waitForFunction(() => document.querySelector('.app-shell-root')!.getAttribute('data-sidecar-primary-detent') === 'compact');
  // The prior mobile return may still be opening context. Wait for the actual
  // source-frame endpoint, not the intent boolean, before measuring its exit.
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('.app-shell-header')!,'::before').width) === 0);
  assert.equal(await page.locator('.app-shell-header').evaluate((el: Element) => parseFloat(getComputedStyle(el,'::before').width)),0);
  const contextExit = await page.evaluate(async () => {
    (window as any).fixture.setContext(false);
    const samples=[];const start=performance.now();
    for(let i=0;i<30;i++) {
      await new Promise(requestAnimationFrame);
      const header=document.querySelector('.app-shell-header')!,surface=getComputedStyle(header,'::before');
      samples.push({ms:performance.now()-start,contextMounted:document.querySelector('.app-shell-left-panel')!==null,
        extensionLeft:parseFloat(surface.left),extensionWidth:parseFloat(surface.width),
        dividerProgress:parseFloat(getComputedStyle(header,'::after').opacity),
        sidecarRight:document.querySelector('.app-shell-sidecar')!.getBoundingClientRect().right});
    }
    return samples;
  });
  assert.ok(contextExit.some((s:any)=>s.contextMounted),'capture physical context exit');
  assert.ok(contextExit.some((s:any)=>s.contextMounted && s.extensionWidth>1),'white upper lip starts moving before pane retirement');
  assert.ok(contextExit.some((s:any)=>s.ms<100 && s.extensionWidth>1),'paint moves within initial frames, not after spring completion');
  for(const s of contextExit) assert.ok(Math.abs(s.extensionLeft+s.extensionWidth-s.sidecarRight)<1,'paint is adjacent to the same live main frame');
  await page.getByLabel('Sidebar draft').waitFor({ state: 'hidden' });
  // Content is removed before its exiting layout pane. Inspect the settled
  // navigation-only boundary, not the intentional intermediate two-pane frame.
  await page.waitForFunction(() => document.querySelector('.app-shell-left-panel') === null);
  assert.equal(await page.locator('.shell-navigation__dock').evaluate((el: Element) => getComputedStyle(el, '::before').display), 'none');
  await page.screenshot({ path: join(output, "navigation-only.png") });
  await page.waitForFunction(() => document.querySelector('.app-shell-root')!.getAttribute('data-sidecar-primary-detent') === 'compact'
    && document.querySelector('.app-shell-sidecar')!.getBoundingClientRect().width < 78);
  // Simulated native reservation is deliberately wider than the compact rail.
  // Do not paint replica traffic lights; verify real Header geometry and pixels.
  for(const chrome of [
    {kind:'browser',platform:'linux',safeArea:{left:0,right:0}},
    {kind:'electron',platform:'darwin',safeArea:{left:78,right:0}},
  ]) {
  await page.evaluate((chrome:unknown) => (window as any).fixture.setChrome(chrome),chrome);
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('.app-shell-header')!,'::before').width) === 52);
  for (const name of ["codex", "frost", "lavender", "vela", "zen"]) {
    for (const mode of ["light", "dark"]) {
      await page.evaluate(([name,mode]: string[]) => (window as any).fixture.theme(name,mode), [name,mode]);
      const png = await page.screenshot({path:join(output,`compact-${chrome.kind}-${name}-${mode}.png`)});
      const compact = await page.evaluate(async (png: string) => {
        const header = document.querySelector('.app-shell-header')!, sidecar = document.querySelector('.app-shell-sidecar')!;
        const main = document.querySelector('.main-content-surface')!, divider = getComputedStyle(sidecar,'::after'),horizontal=getComputedStyle(header,'::after'),lip=getComputedStyle(header,'::before');
        const probe = document.createElement('div'); probe.style.boxShadow = 'var(--codex-main-surface-elevation)';
        document.body.append(probe); const expectedShadow = getComputedStyle(probe).boxShadow; probe.remove();
        const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
        const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
        const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0);
        const edge=Math.floor(sidecar.getBoundingClientRect().right),height=header.getBoundingClientRect().height;
        const scan=(y:number)=>[1,20,edge-1,edge,edge+1,77,78,120,600,1178].map(x=>Array.from(ctx.getImageData(x,y,1,1).data));
        const action=document.querySelector('.app-shell-header__window-action')!;
        return {top:scan(3),bottom:scan(height-3),edge,height,headerWidth:header.getBoundingClientRect().width,
          dividerTop:divider.top,dividerWidth:divider.borderRightWidth,pointerEvents:divider.pointerEvents,
          horizontalHeight:horizontal.height,horizontalLeft:horizontal.left,horizontalOpacity:horizontal.opacity,
          shadow:getComputedStyle(main).boxShadow,lipShadow:lip.boxShadow,lipClip:lip.clipPath,expectedShadow,noGradient:getComputedStyle(sidecar).backgroundImage,
          actionLeft:action.getBoundingClientRect().left,safeInset:getComputedStyle(document.querySelector('.app-shell-root')!).getPropertyValue('--spacing-token-safe-header-left')};
      },png.toString('base64'));
      for (const scan of [compact.top,compact.bottom]) for (const pixel of scan) assert.deepEqual(pixel,scan[0],`continuous titlebar ${name}/${mode}`);
      assert.equal(compact.headerWidth,1180);assert.ok(compact.edge<78);
      assert.equal(compact.dividerTop,`${compact.height}px`);assert.equal(compact.dividerWidth,'1px');assert.equal(compact.pointerEvents,'none');
      assert.equal(compact.horizontalHeight,'1px');assert.equal(compact.horizontalLeft,'0px');assert.equal(compact.horizontalOpacity,'1');
      assert.equal(compact.shadow,compact.expectedShadow);assert.equal(compact.noGradient,'none');
      assert.equal(compact.lipShadow,compact.expectedShadow,'upper lip shares theme elevation');
      assert.notEqual(compact.lipClip,'none','joining edge does not cast a duplicate seam');
      assert.equal(compact.safeInset.trim(),`${chrome.safeArea.left}px`);
      assert.ok(compact.actionLeft>= (chrome.safeArea.left ? 84 : 8),'safe area is not compressed by the rail');
      let lipShadowPixels;
      if(chrome.kind==='browser') {
        // A controlled negative removes only the lip's shadow. Compare actual
        // pixels below it and inside its white join, not just computed CSS.
        await page.evaluate(()=>{const style=document.createElement('style');style.id='lip-shadow-negative';style.textContent='.app-shell-header::before{box-shadow:none!important}';document.head.append(style)});
        const flatPng=await page.screenshot();
        await page.evaluate(()=>document.getElementById('lip-shadow-negative')!.remove());
        lipShadowPixels=await page.evaluate(async ([painted,flat]:string[])=>{
          const canvas=document.createElement('canvas');const ctx=canvas.getContext('2d')!;
          const h=document.querySelector('.app-shell-header')!.getBoundingClientRect().height,edge=document.querySelector('.app-shell-sidecar')!.getBoundingClientRect().right;
          const points=[[2,h+2],[10,h+2],[20,h+6]],join=[[edge+2,3],[edge+8,h-3]];
          const sample=async(png:string)=>{const bitmap=await createImageBitmap(await(await fetch(`data:image/png;base64,${png}`)).blob());canvas.width=bitmap.width;canvas.height=bitmap.height;ctx.drawImage(bitmap,0,0);return{lower:points.map(([x,y])=>Array.from(ctx.getImageData(x,y,1,1).data)),join:join.map(([x,y])=>Array.from(ctx.getImageData(x,y,1,1).data))}};
          return{painted:await sample(painted!),flat:await sample(flat!)};
        },[png.toString('base64'),flatPng.toString('base64')]);
        assert.deepEqual(lipShadowPixels.painted.join,lipShadowPixels.flat.join,'no shadow seam within the white surface');
        if(['codex','frost','lavender'].includes(name))assert.notDeepEqual(lipShadowPixels.painted.lower,lipShadowPixels.flat.lower,'soft theme visibly casts below the lip');
        if(name==='zen')assert.deepEqual(lipShadowPixels.painted.lower,lipShadowPixels.flat.lower,'flat theme does not cast a shadow');
      }
      evidence.push({name,mode,chrome:chrome.kind,presentation:'compact',...compact,lipShadowPixels});
    }
  }
  }
  // Reverse before spring settlement: the upper lip must retain the current
  // physical origin instead of resetting to a semantic open/closed endpoint.
  const reversal = await page.evaluate(async () => {
    (window as any).fixture.setContext(true);
    const width=()=>parseFloat(getComputedStyle(document.querySelector('.app-shell-header')!,'::before').width);
    for(let i=0;i<8;i++) await new Promise(requestAnimationFrame);
    const origin=width();(window as any).fixture.setContext(false);
    const frames=[];
    for(let i=0;i<30;i++){await new Promise(requestAnimationFrame);frames.push(width());}
    return {origin,frames};
  });
  assert.ok(reversal.origin>0 && reversal.origin<52,'reverse in a real intermediate frame');
  assert.ok(Math.abs(reversal.frames[0]-reversal.origin)<15,'no endpoint snap at reversal');
  await page.waitForFunction(() => document.querySelector('.app-shell-left-panel')===null);
  assert.equal(await page.evaluate(() => (window as any).savedDraftNode === document.querySelector('[aria-label="Main draft"]')),true);
  // Motion samples the OS preference when hooks mount. A fresh renderer under
  // reduced motion is the supported input, not an in-place test-only toggle.
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByLabel('Sidebar draft').waitFor();
  if (await page.getByRole('separator',{name:'Resize applications',exact:true}).count()===0) {
    await page.getByRole('button',{name:'Applications',exact:true}).click();
  }
  await page.getByRole('separator',{name:'Resize applications',exact:true}).press('Home');
  await page.waitForFunction(() => document.querySelector('.shell-navigation__dock')!.getBoundingClientRect().width === 52);
  const reduced = await page.evaluate(async () => {
    const width=()=>parseFloat(getComputedStyle(document.querySelector('.app-shell-header')!,'::before').width);
    (window as any).fixture.setContext(true);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const open=width();(window as any).fixture.setContext(false);
    const frames=[];
    for(let i=0;i<8;i++){await new Promise(requestAnimationFrame);frames.push(width());}
    return {open,closed:width(),frames};
  });
  assert.equal(reduced.open,0);
  assert.equal(reduced.closed,52,JSON.stringify(reduced));
  assert.ok(reduced.frames.every((width:number)=>width===0 || width===52),'reduced motion skips interpolation');
  assert.deepEqual(errors, []);
  evidence.push({ edgeHitTest: true, heldResize: true, contextExit, reversal, reduced, forcedColors: forced, hiddenZeroWidth: true, floatingStyle, draftIdentity: true, navigationOnlyNoHardDivider: true });
  console.log(JSON.stringify({ output, url, evidence, errors }));
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify({ evidence, errors }, null, 2));
  await browser?.close(); await vite.close();
}
