import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const output = await mkdtemp(join(tmpdir(), "opencraft-shell-material-edge-"));
const source = `
import React,{useEffect,useState,useSyncExternalStore} from 'react';
import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {RightPanel} from '/apps/workbench-web/src/components/right-panel.tsx';
import {Context as PluginContext} from '@deepseek-ai/cordis';
import {WorkbenchPanelService} from '@opencraft/workbench-panels';
import {WorkbenchPanelRuntimeProvider} from '/apps/workbench-web/src/runtime/panel-runtime-context.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import {buildOpenCraftThemeCssProperties,opencraftNeutralThemePalette,frostThemePalette,longingThemePalette,lavenderThemePalette,opencraftCanvasThemePalette,graphiteThemePalette} from '@opencraft/design-system/theme-engine';
import '/apps/workbench-web/src/styles/app.scss';
import '@fontsource-variable/noto-sans-sc';
initializeAppearanceTheme();
const panelContext=new PluginContext();await panelContext.plugin(WorkbenchPanelService);
const panels=panelContext.workbenchPanels;panels.ensureOwner('material-edge');
const subscribePanel=listener=>panels.subscribeOwner('material-edge',listener),getPanel=()=>panels.getOwnerSnapshot('material-edge');
let mounts=0,clicks=0;
const palettes={opencraftNeutral:opencraftNeutralThemePalette,frost:frostThemePalette,longing:longingThemePalette,lavender:lavenderThemePalette,opencraftCanvas:opencraftCanvasThemePalette,graphite:graphiteThemePalette};
function Context(){useEffect(()=>{mounts++},[]);return <div style={{display:'flex',height:'100%',flexDirection:'column'}}>
<input aria-label='Sidebar draft' defaultValue='侧栏内容保持不变' style={{margin:16}}/>
<button aria-label='Edge action' onClick={()=>clicks++} style={{marginTop:20,padding:12,textAlign:'right',background:'transparent',border:0}}>边缘操作</button>
</div>}
function App(){const [open,setOpen]=useState(true),[context,setContext]=useState(true),[width,setWidth]=useState(320),
[chrome,setChrome]=useState({kind:'browser',platform:'linux',safeArea:{left:0,right:0}});
const panelState=useSyncExternalStore(subscribePanel,getPanel);
window.fixture={setOpen,setContext,setWidth,setChrome,panels,width,mounts:()=>mounts,clicks:()=>clicks,
theme:(name,mode)=>{document.documentElement.dataset.theme=mode;Object.entries(buildOpenCraftThemeCssProperties(mode,palettes[name][mode])).forEach(([k,v])=>document.documentElement.style.setProperty(k,v))}};
return <AppShell layoutScope='material-edge' mainContentLayout='default' foreground={panelState.rightPanelFullWidth ? 'tools' : 'primary'} sidebarOpen={open} sidebarWidth={width}
navigation={{actions:[{id:'chat',title:'Chat',icon:'chat',onInvoke:()=>{}}],settingsActive:false,onOpenSettings:()=>{},account:{snapshot:{phase:'anonymous',name:null,avatarUrl:null},onOpen:()=>{},onRefresh:async()=>{},onSignOut:async()=>{}}}}
windowChrome={chrome}
onSidebarCollapse={()=>setOpen(false)} onSidebarExpand={()=>setOpen(true)} onSidebarResizeEnd={setWidth}
rightPanel={<RightPanel state={panelState} presentationId='material-edge' renderers={[]} toolbarActions={[]} toolbarActionContext={{ownerId:'material-edge',resourceOwnerId:'material-edge',hostId:'fixture',cwd:null}} onAction={action=>panels.dispatch('material-edge',action)} onCloseTab={tab=>panels.close('material-edge',tab.region,tab.id)}/>}
rightPanelOpen={panelState.right.open} rightPanelFullWidth={panelState.rightPanelFullWidth} onRightPanelOpenChange={open=>panels.dispatch('material-edge',{type:'set-region-open',region:'right',open,allowEmpty:true})}
header={<AppShellHeader title='协作自身优化' project={null} sidebarOpen={open} rightPanelOpen={panelState.right.open} rightPanelFullWidth={panelState.rightPanelFullWidth}
showRightPanelAction={false} onToggleSidebar={()=>setOpen(!open)} onToggleRightPanel={()=>{}} onHome={()=>{}}
canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
floatingSidebarHeader={dock=><button onClick={dock}>固定侧栏</button>}
leftPanel={context?<Context/>:null}>
<div style={{padding:28}}><h2>会话内容</h2><input aria-label='Main draft' defaultValue='保留输入草稿'/></div>
</AppShell>}
createRoot(document.getElementById('root')).render(<WorkbenchPanelRuntimeProvider runtime={{panels,context:panelContext}}><App/></WorkbenchPanelRuntimeProvider>);
`;

const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-shell-material-edge",
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react-intl", "sonner", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover"] },
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
  page.setDefaultTimeout(20000);
  await page.addInitScript("window.__name = value => value");
  page.on("pageerror", (error: Error) => errors.push(error.message));
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  await page.goto(url);
  page.on("response", response => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await page.getByLabel("Sidebar draft").waitFor().catch(error => {
    throw new Error(`Material check failed to mount: ${errors.join("; ")}`, { cause: error });
  });
  await page.evaluate(() => document.fonts.ready);
  await page.setViewportSize({width:1180,height:720});
  await page.evaluate(() => { const f=(window as any).fixture; f.setContext(true); f.setOpen(true); });
  await page.locator('.has-unified-sidebar .shell-sidebar__context').waitFor();
  for (const name of ['opencraftNeutral','frost','lavender','longing','opencraftCanvas']) for (const mode of ['light','dark']) {
    await page.evaluate(([name,mode]) => (window as any).fixture.theme(name,mode),[name,mode]);
    // Theme changes animate color; sample the final paint after those transitions.
    await page.locator('.shell-sidebar__context').evaluate(async el => {
      getComputedStyle(el).backgroundColor;
      await Promise.all(el.getAnimations().map(animation => animation.finished));
    });
    await page.locator('.main-content-frame').evaluate(async el=>{el.setAttribute('data-app-shell-thread-edge-divider','true');getComputedStyle(el).borderTopColor;await Promise.all(el.getAnimations().map(animation=>animation.finished));});
    const frameDivider=await page.locator('.main-content-frame').evaluate(el=>getComputedStyle(el).borderTopColor);
    const actual=await page.evaluate(() => {
      const pane=getComputedStyle(document.querySelector('.main-content-surface')!);
      const depth=getComputedStyle(document.querySelector('.app-shell-content-depth')!);
      return {shadow:depth.boxShadow==='none'?pane.boxShadow:depth.boxShadow,frameShadow:pane.boxShadow,
        depthTop:depth.top,depthLeft:depth.left,depthClip:depth.clipPath,depthPointer:depth.pointerEvents,
        context:getComputedStyle(document.querySelector('.app-shell-sidecar')!).backgroundColor,
        column:getComputedStyle(document.querySelector('.shell-sidebar__column')!).backgroundColor,
        list:getComputedStyle(document.querySelector('.shell-sidebar__context')!).backgroundColor,
        navigation:getComputedStyle(document.querySelector('.shell-sidebar__navigation')!).backgroundColor,
        footer:getComputedStyle(document.querySelector('.shell-sidebar__rail-footer')!).backgroundColor};
    });
    const header=await page.evaluate(() => {
      const el=document.querySelector('.app-shell-header')!,edge=document.querySelector('.app-shell-header__content-edge')!,main=document.querySelector('.main-content-surface')!;
      const css=getComputedStyle(el);
      return {background:css.backgroundColor,mainBackground:getComputedStyle(main).backgroundColor,edgeDisplay:getComputedStyle(edge).display,mainLeft:main.getBoundingClientRect().left};
    });
    assert.equal(actual.depthTop,'0px','column elevation reaches the top');
    assert.ok(Math.abs(parseFloat(actual.depthLeft)-header.mainLeft)<1);
    assert.equal(header.background,'rgba(0, 0, 0, 0)','header reuses the main surface');
    assert.notEqual(header.mainBackground,'rgba(0, 0, 0, 0)','main surface owns the complete right-column background');
    assert.equal(header.edgeDisplay,'none','no recessed toolbar corner remains');
    if(name==='longing') {
      assert.equal(actual.frameShadow,'none');
      assert.equal(actual.depthClip,'inset(0px -100% -100%)');
      assert.equal(actual.depthPointer,'none');
      assert.equal(frameDivider,'rgba(0, 0, 0, 0)');
    } else assert.notEqual(frameDivider,'rgba(0, 0, 0, 0)');
    if(name==='longing') { assert.notEqual(actual.shadow,'none','Longing glass edge survives unified layout'); assert.equal(actual.context,'rgba(0, 0, 0, 0)','context shares the glass plane'); }
    else { assert.equal(actual.shadow,'none'); assert.notEqual(actual.context,'rgba(0, 0, 0, 0)'); }
    for (const paint of [actual.column, actual.list, actual.navigation, actual.footer]) assert.equal(paint,'rgba(0, 0, 0, 0)','sidebar slots share one column background');
    if(name==='longing') {
      const retainedDraft=await page.getByLabel('Main draft').inputValue();
      const retainedNode=await page.getByLabel('Main draft').elementHandle();
      assert.equal(await page.locator('.main-content-frame').evaluate(el=>getComputedStyle(el).borderStartStartRadius),'0px');
      assert.equal(await page.locator('.app-shell-content-depth').evaluate(el=>getComputedStyle(el).borderStartStartRadius),'0px');
      const sampleDepth = () => page.evaluate(async () => {
        const frames=[];
        for(let i=0;i<12;i++) {
          await new Promise(requestAnimationFrame);
          const main=document.querySelector('.main-content-surface')!.getBoundingClientRect();
          const depth=document.querySelector('.app-shell-content-depth')!.getBoundingClientRect();
          frames.push({main:main.left,depth:depth.left});
        }
        return frames;
      });
      const assertDepth = (frames:Awaited<ReturnType<typeof sampleDepth>>) => {
        assert.ok(frames.every(f=>Math.abs(f.main-f.depth)<1),JSON.stringify(frames));
      };
      await page.emulateMedia({reducedMotion:'no-preference'});
      const saved=await page.evaluate(()=>(window as any).fixture.width);
      const handle=await page.getByRole('separator',{name:'Resize sidebar',exact:true}).boundingBox();
      assert.ok(handle); await page.mouse.move(handle.x+1,350); await page.mouse.down();
      for(const dx of [-50,40,-20]) {
        await page.mouse.move(handle.x+dx,350,{steps:5}); assertDepth(await sampleDepth());
        assert.equal(await page.evaluate(()=>(window as any).fixture.width),saved);
      }
      await page.mouse.up();
      await page.evaluate(()=>(window as any).fixture.setOpen(false));
      const collapse=await sampleDepth(); assertDepth(collapse);
      await page.evaluate(()=>(window as any).fixture.setOpen(true));
      const reverse=await sampleDepth(); assertDepth(reverse);
      await page.evaluate(()=>(window as any).fixture.setOpen(false));
      await page.waitForFunction(()=>document.querySelector('.main-content-surface')!.getBoundingClientRect().left<1);
      assertDepth(await sampleDepth());
      await page.screenshot({path:join(output,`collapsed-${mode}.png`)});
      await page.evaluate(()=>(window as any).fixture.setOpen(true));
      await page.waitForFunction(()=>document.querySelector('.main-content-surface')!.getBoundingClientRect().left>100);
      assertDepth(await sampleDepth());
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.evaluate(()=>(window as any).fixture.setOpen(false)); assertDepth(await sampleDepth());
      await page.evaluate(()=>(window as any).fixture.setOpen(true)); assertDepth(await sampleDepth());
      assert.equal(await page.getByLabel('Main draft').inputValue(),retainedDraft);
      assert.equal(await page.getByLabel('Main draft').evaluate((el,old)=>el===old,retainedNode),true);
      evidence.push({name,mode,liveDepthHeldDrag:true,collapse,reverse,reducedDepth:true});
    }
    const capture=await page.screenshot({path:join(output,`unified-${name}-${mode}.png`)});
    if(actual.context!=='rgba(0, 0, 0, 0)') {
      const pixels=await page.evaluate(async base64=>{
        const image=await createImageBitmap(await (await fetch('data:image/png;base64,'+base64)).blob());
        const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
        const context=canvas.getContext('2d')!;context.drawImage(image,0,0);
        const height=document.querySelector('.app-shell-header')!.getBoundingClientRect().height;
        return {brand:Array.from(context.getImageData(4,height-4,1,1).data),list:Array.from(context.getImageData(4,height+4,1,1).data)};
      },capture.toString('base64'));
      assert.deepEqual(pixels.brand,pixels.list,'no separate color band below brand/header');
    }
    evidence.push({name,mode,presentation:'unified',...actual});
  }
  await page.setViewportSize({width:1600,height:900});
  await page.evaluate(() => {
    const fixture=(window as any).fixture;
    fixture.theme('longing','light');
    fixture.panels.dispatch('material-edge',{type:'set-region-open',region:'right',open:true,allowEmpty:true});
  });
  await page.locator('.right-panel-toolbar:visible').waitFor();
  const assertBrowserHeaderPaint = async () => {
    const frames=await page.evaluate(async () => {
      const frames=[];
      for(let i=0;i<12;i++) {
        await new Promise(requestAnimationFrame);
        const header=document.querySelector('.app-shell-header')!,css=getComputedStyle(header);
        const main=document.querySelector('.main-content-surface')!,toolbar=document.querySelector('.right-panel-toolbar')!;
        frames.push({main:getComputedStyle(main).backgroundColor,top:main.getBoundingClientRect().top,header:css.backgroundColor,image:css.backgroundImage,toolbar:getComputedStyle(toolbar).backgroundColor,bodyShadow:getComputedStyle(document.querySelector('.right-panel-view')!).boxShadow});
      }
      return frames;
    });
    assert.ok(frames.every(frame=>frame.main!=='rgba(0, 0, 0, 0)'&&frame.top===0&&frame.header==='rgba(0, 0, 0, 0)'&&frame.image==='none'&&frame.toolbar==='rgba(0, 0, 0, 0)'),'main surface backs both transparent toolbars during layout changes');
    assert.ok(frames.every(frame=>frame.bodyShadow==='none'),'preview body must not cast a horizontal shadow into its toolbar');
    const capture=await page.screenshot();
    const pixels=await page.evaluate(async base64=>{
      const image=await createImageBitmap(await (await fetch('data:image/png;base64,'+base64)).blob());
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const context=canvas.getContext('2d')!;context.drawImage(image,0,0);
      const toolbar=document.querySelector('.right-panel-toolbar')!.getBoundingClientRect();
      const x=Math.round(toolbar.left+toolbar.width/2);
      return {header:Array.from(context.getImageData(x,Math.round(toolbar.top+toolbar.height/2),1,1).data),body:Array.from(context.getImageData(x,Math.round(toolbar.bottom+12),1,1).data)};
    },capture.toString('base64'));
    assert.deepEqual(pixels.header,pixels.body,'preview toolbar has no window-colored strip');
  };
  await assertBrowserHeaderPaint();
  await page.getByRole('button',{name:'Maximize panel',exact:true}).click();
  await assertBrowserHeaderPaint();
  await page.getByRole('button',{name:'Restore panel',exact:true}).click();
  await assertBrowserHeaderPaint();
  const browserPanelResize=await page.getByRole('separator',{name:'Resize preview panel',exact:true}).boundingBox();
  assert.ok(browserPanelResize);
  await page.mouse.move(browserPanelResize.x+8,350);await page.mouse.down();
  for(const dx of [-30,25,-50]){await page.mouse.move(browserPanelResize.x+8+dx,350,{steps:3});await assertBrowserHeaderPaint();}
  await page.mouse.up();
  await page.screenshot({path:join(output,'browser-columns-open-preview.png')});
  await page.evaluate(()=>(window as any).fixture.theme('longing','dark'));
  await page.locator('.main-content-surface').evaluate(async el=>{getComputedStyle(el).backgroundColor;await Promise.all(el.getAnimations().map(a=>a.finished))});
  await assertBrowserHeaderPaint();
  await page.screenshot({path:join(output,'browser-columns-open-preview-dark.png')});
  await page.evaluate(()=>(window as any).fixture.panels.dispatch('material-edge',{type:'set-region-open',region:'right',open:false}));
  evidence.push({presentation:'browser-columns-preview',fullWidth:true,heldResize:true,toolbarAperture:true});
  // Simulated native chrome proves Renderer paint ownership only. Actual
  // BrowserWindow translucency still needs the packaged macOS window check.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    const fixture = (window as any).fixture;
    fixture.setContext(true); fixture.setOpen(true);
    fixture.setChrome({ kind: 'electron', platform: 'darwin', safeArea: { left: 78, right: 0 } });
  });
  await page.locator('.app-shell-root[data-opencraft-window-type="electron"]').waitFor();
  await page.evaluate(() => { (window as any).nativeDraftNode = document.querySelector('[aria-label="Main draft"]'); });
  for (const name of ['opencraftNeutral', 'frost', 'opencraftCanvas']) {
    for (const mode of ['light', 'dark']) {
      await page.evaluate(([name, mode]) => (window as any).fixture.theme(name, mode), [name, mode]);
      await page.evaluate(async () => {
        const surfaces = [...document.querySelectorAll('.app-shell-sidecar, .shell-sidebar__column, .app-shell-header')];
        for (const surface of surfaces) getComputedStyle(surface).backgroundColor;
        await Promise.all(surfaces.flatMap(surface => surface.getAnimations().map(animation => animation.finished)));
      });
      const native = await page.evaluate(() => {
        const sidecar = getComputedStyle(document.querySelector('.app-shell-sidecar')!);
        const context = getComputedStyle(document.querySelector('.shell-sidebar__column')!);
        const header = getComputedStyle(document.querySelector('.app-shell-header')!);
        const root = document.querySelector('.app-shell-root')!;
        return { background: sidecar.backgroundColor, image: sidecar.backgroundImage, filter: sidecar.backdropFilter, context: context.backgroundColor, header: header.backgroundColor, platform: root.getAttribute('data-opencraft-platform'), kind: root.getAttribute('data-opencraft-window-type') };
      });
      assert.equal(native.background, 'rgba(0, 0, 0, 0)', `no full-height Sidebar tint through titlebar: ${name}/${mode} ${JSON.stringify(native)}`);
      assert.equal(native.filter, 'none', 'AppKit remains the single filter owner');
      assert.equal(native.header, 'rgba(0, 0, 0, 0)');
      if (name === 'opencraftCanvas') {
        assert.notEqual(native.context, 'rgba(0, 0, 0, 0)', 'opaque theme keeps its context surface');
      } else {
        assert.equal(native.context, 'rgba(0, 0, 0, 0)', 'context shares native translucency');
        assert.doesNotMatch(native.image, /rgb\((?:255|20|226)/u, 'no second colored veil');
      }
      assert.equal(await page.getByLabel('Main draft').evaluate(el => el === (window as any).nativeDraftNode), true);
      await page.screenshot({ path: join(output, `native-${name}-${mode}.png`) });
      evidence.push({ name, mode, presentation: 'native-renderer', ...native, draftIdentity: true });
    }
  }
  await page.setViewportSize({width:1600,height:900});
  await page.evaluate(() => {
    const fixture=(window as any).fixture;
    fixture.theme('longing','light');
    fixture.panels.dispatch('material-edge',{type:'set-region-open',region:'right',open:true,allowEmpty:true});
  });
  await page.locator('.right-panel-toolbar:visible').waitFor().catch(async error => {
    await page.screenshot({path:join(output,'native-panel-failure.png')});
    console.log(JSON.stringify(await page.evaluate(()=>({state:(window as any).fixture.panels.getOwnerSnapshot('material-edge'),panels:[...document.querySelectorAll('.app-shell-right-panel,.right-panel-content,.right-panel-toolbar')].map(el=>({className:el.className,rect:el.getBoundingClientRect().toJSON(),display:getComputedStyle(el).display,visibility:getComputedStyle(el).visibility,opacity:getComputedStyle(el).opacity}))}))));
    throw error;
  });
  await page.locator('.main-content-frame').evaluate(async el => {
    getComputedStyle(el).borderStartStartRadius;
    await Promise.all(el.getAnimations().map(animation => animation.finished));
  });
  const panelPaint = () => page.evaluate(() => {
    const selectors=['.app-shell-right-panel__clip','.app-shell-right-panel__surface','.right-panel-content','.right-panel-toolbar'];
    const chrome=selectors.map(selector=>({selector,background:getComputedStyle(document.querySelector(selector)!).backgroundColor}));
    const divider=document.querySelector('.right-panel-divider');
    const header=document.querySelector('.app-shell-header')!;
    return {chrome,body:getComputedStyle(document.querySelector('.right-panel-view')!).backgroundColor,
      previewRadius:getComputedStyle(document.querySelector('.right-panel-view')!).borderStartStartRadius,
      mainRadius:getComputedStyle(document.querySelector('.main-content-frame')!).borderStartStartRadius,
      divider:divider?{top:getComputedStyle(divider).top,clip:getComputedStyle(divider).clipPath}:null,
      headerHeight:header.getBoundingClientRect().height};
  });
  const assertPanelPaint = (paint: Awaited<ReturnType<typeof panelPaint>>) => {
    for(const surface of paint.chrome) assert.equal(surface.background,'rgba(0, 0, 0, 0)',surface.selector);
    assert.notEqual(paint.body,'rgba(0, 0, 0, 0)','preview body remains opaque');
    assert.equal(paint.previewRadius,'0px','preview meets the internal divider without rounding');
    assert.equal(paint.mainRadius,'12px','main reading plane retains the theme corner');
    if(paint.divider){assert.equal(paint.divider.top,`${paint.headerHeight}px`);assert.equal(paint.divider.clip,'inset(0px -100% -100%)');}
  };
  assertPanelPaint(await panelPaint());
  await page.getByRole('button',{name:'Maximize panel',exact:true}).click();
  await page.waitForFunction(()=>(window as any).fixture.panels.getOwnerSnapshot('material-edge').rightPanelFullWidth);
  assertPanelPaint(await panelPaint());
  await page.getByRole('button',{name:'Restore panel',exact:true}).click();
  const panelHandle=await page.getByRole('separator',{name:'Resize preview panel',exact:true}).boundingBox();
  assert.ok(panelHandle);
  await page.mouse.move(panelHandle.x+8,350);await page.mouse.down();
  for(const dx of [-30,20,-55,0]){await page.mouse.move(panelHandle.x+8+dx,350,{steps:3});assertPanelPaint(await panelPaint());}
  await page.mouse.up();
  await page.evaluate(()=>(window as any).fixture.setOpen(false));assertPanelPaint(await panelPaint());
  await page.evaluate(()=>(window as any).fixture.setOpen(true));assertPanelPaint(await panelPaint());
  for(let i=0;i<2;i++){
    await page.evaluate(()=>(window as any).fixture.panels.dispatch('material-edge',{type:'set-region-open',region:'right',open:false}));
    await page.evaluate(()=>(window as any).fixture.panels.dispatch('material-edge',{type:'set-region-open',region:'right',open:true,allowEmpty:true}));
    assertPanelPaint(await panelPaint());
  }
  assert.equal(await page.getByLabel('Main draft').evaluate(el=>el===(window as any).nativeDraftNode),true);
  await page.screenshot({path:join(output,'native-open-preview.png')});
  evidence.push({presentation:'native-panel',paint:await panelPaint(),fullWidth:true,heldResize:true,sidebarToggle:true,repeatedOpen:true,draftIdentity:true});
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ output, url, evidence, errors }));
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify({ evidence, errors }, null, 2));
  await browser?.close(); await vite.close();
}
