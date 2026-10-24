import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = "/tmp/opencraft-workspace-presentation";
const source = `
import React,{useSyncExternalStore,useState} from 'react';import{createIntlTestRoot as createRoot}from'/tests/fixtures/intl-root.tsx';
import{Context}from'@deepseek-ai/cordis';import{WorkbenchPanelService}from'@opencraft/workbench-panels';
import{WorkbenchPanelRendererRegistryService}from'@opencraft/workbench-panels-react';
import{createConversationBindingStore}from'@opencraft/workbench-runtime';
import{BrowserEnvironmentProvider,BrowserPresentationRoot}from'/apps/workbench-web/src/browser/browser-runtime-context.tsx';
import{WebIframeSurfaceHost}from'/apps/workbench-web/src/browser/web-browser-surface-host.ts';
import{WebBrowserPageRuntime}from'/apps/workbench-web/src/browser/web-browser-runtime.ts';
import{BrowserPresentationCoordinator}from'/apps/workbench-web/src/browser/browser-presentation-coordinator.ts';
import{BrowserWorkbenchCoordinator}from'/apps/workbench-web/src/browser/browser-workbench-coordinator.ts';
import{createBrowserWorkbenchPanelPlugin}from'/apps/workbench-web/src/browser/browser-panel-plugin.tsx';
import{createComposerController}from'@opencraft/composer-core';import{createConversationKey}from'@opencraft/chat-core';
import{OpenCraftComposer}from'@opencraft/composer-editor';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{RightPanel}from'/apps/workbench-web/src/components/right-panel.tsx';
import{ThreadComposerPresentation}from'/apps/workbench-web/src/components/thread-composer-presentation.tsx';
import{TimelineBlockRendererProvider,TimelineBlockRendererRegistryService}from'@opencraft/timeline-render-react';
import{BuiltinTimelineRendererPlugin}from'/apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();const ctx=new Context();await ctx.plugin(WorkbenchPanelService);const panels=ctx.workbenchPanels;const key=createConversationKey('fixture-host','parent');
const controller=createComposerController({type:'existing-thread',key},{now:Date.now,createId:()=>crypto.randomUUID()});const closed=[];const submitted=[];
await ctx.plugin(WorkbenchPanelRendererRegistryService);
await ctx.plugin(TimelineBlockRendererRegistryService);await ctx.plugin(BuiltinTimelineRendererPlugin);
const surfaces=new WebIframeSurfaceHost();const pages=new WebBrowserPageRuntime(surfaces);const presentations=new BrowserPresentationCoordinator(pages,surfaces);
const workbench=new BrowserWorkbenchCoordinator(pages,panels,createConversationBindingStore());
await ctx.plugin(createBrowserWorkbenchPanelPlugin(workbench,()=>{}));
panels.register({kind:'terminal',createTab:({id})=>({id,resource:id,kind:'terminal',region:'right',title:'Terminal',icon:'terminal',closable:true,preview:false}),disposeTab:t=>closed.push(t.resource)});
panels.open('scope','terminal',{id:'terminal:one'});
function Tool(){return <div style={{height:'100%',padding:20}}><input aria-label='Terminal input' defaultValue='process alive'/></div>}
const renderers=[{kind:'terminal',Component:Tool},...ctx.workbenchPanelRenderers.getSnapshot()];
const subscribe=f=>panels.subscribeOwner('scope',f),get=()=>panels.getOwnerSnapshot('scope');
function App(){const state=useSyncExternalStore(subscribe,get);const [sidebar,setSidebar]=useState(false);const [width,setWidth]=useState(275);const [enabled,setEnabled]=useState(true);
window.fixture={state,closed,submitted,controller,panels,setThemePreference,setEnabled,pages,openBrowser:()=>workbench.open('scope',{initialUrl:location.origin+'/browser-fixture',panelOwnerId:'scope'})};
const panel=()=> <RightPanel state={state} presentationId='view' renderers={renderers} toolbarActions={[]} toolbarActionContext={{ownerId:'scope',resourceOwnerId:'scope',hostId:'fixture-host',cwd:null}} onAction={a=>panels.dispatch('scope',a)} onCloseTab={t=>panels.close('scope',t.region,t.id)}/>;
return <AppShell layoutScope='scope' mainContentLayout='default' header={<span>Fixture workspace</span>} floatingSidebarHeader={()=>null} leftPanel={<p>Navigation</p>} sidebarOpen={sidebar} sidebarWidth={width} onSidebarCollapse={()=>setSidebar(false)} onSidebarExpand={()=>setSidebar(true)} onSidebarResizeEnd={setWidth} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanel={panel('right')} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onRightPanelOpenChange={open=>panels.dispatch('scope',{type:'set-region-open',region:'right',open})}>
<div style={{height:'100%',display:'flex',flexDirection:'column'}}><p style={{flex:1}}>Parent conversation</p>
<ThreadComposerPresentation scopeId='scope' controller={controller} activeTabId={state.right.activeTabId} enabled={enabled} timeline={{key,revision:1,phase:'live',authoritative:true,anchorFrameIds:new Map(),frames:[{id:'user-frame',type:'user',turnId:'turn',status:'complete',durationMs:null,hookStats:null,anchors:[],blocks:[{id:'user-block',type:'text',text:'User intro must not be duplicated',sourceItemIds:[],streaming:false}]},{id:'assistant-frame',type:'assistant',turnId:'turn',status:'complete',durationMs:1000,hookStats:null,anchors:[],blocks:[{id:'answer',type:'text',text:'Latest answer preview\\n\\n'+('A bounded response paragraph.\\n\\n'.repeat(40)),sourceItemIds:['answer'],streaming:false,completed:true,phase:'final_answer'}]}]}} documentContext={{conversationId:'parent',hostId:'fixture-host',cwd:null,theme:'light'}}>
<div className='thread-composer-region'><OpenCraftComposer controller={controller} onSubmit={async intent=>{submitted.push(intent.target)}} onCancel={()=>{}} /></div>
</ThreadComposerPresentation></div></AppShell>}
createRoot(document.getElementById('root')).render(<TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}><BrowserEnvironmentProvider pages={pages} surfaces={surfaces} presentations={presentations} workbench={workbench}><App/><BrowserPresentationRoot/></BrowserEnvironmentProvider></TimelineBlockRendererProvider>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", cacheDir: "node_modules/.vite-workspace-presentation", resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0 }, optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@tanstack/react-query"] }, plugins: [{ name: "workspace-presentation-fixture", resolveId: id => id === "/workspace-probe.tsx" ? id : null, load: id => id === "/workspace-probe.tsx" ? source : null, configureServer(server) { server.middlewares.use((req,res,next) => { if (req.url === "/browser-fixture") { res.setHeader("content-type","text/html"); res.end('<title>Fixture web page</title><button onclick="this.textContent=String.fromCharCode(80,97,103,101,32,99,111,117,110,116,32)+(++window.count)">Page count 0</button><script>window.count=0</script>'); return; } if(req.url !== "/") return next();res.setHeader("content-type","text/html");res.end('<div id="root"></div><script type="module" src="/workspace-probe.tsx"></script>'); }); } }] });
let browser: any;
const errors: string[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, reducedMotion: process.env.OPENCRAFT_REDUCED_MOTION === "0" ? "no-preference" : "reduce" });
  page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript("window.__name=value=>value");
  await page.goto(vite.resolvedUrls!.local[0]!, { timeout: 60000 }); await page.waitForLoadState("networkidle", { timeout: 60000 });
  const editor = page.locator('[contenteditable="true"]:visible');
  await editor.fill("Keep this parent draft");
  await page.getByRole("button", { name: "Maximize panel", exact: true }).click();
  const overlay = page.getByTestId("right-panel-composer-overlay-host"); await overlay.waitFor();
  await page.waitForFunction(() => document.querySelector('.main-content-viewport')!.getBoundingClientRect().width < 1);
  assert.equal(await editor.count(), 1); assert.match(await editor.innerText(), /Keep this parent draft/);
  assert.equal(await editor.evaluate(element => element.closest("[inert]") !== null), false);
  await page.getByRole("textbox", { name: "Terminal input" }).fill("Still interactive behind overlay");
  // Non-browser tools use the default overlay, without browser peek handles.
  assert.equal(await page.getByRole("button", { name: "Hide chat input" }).count(), 0);
  assert.match(await editor.innerText(), /Keep this parent draft/);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => (window as any).fixture.setThemePreference(theme), theme);
    await page.setViewportSize({ width: theme === "light" ? 1280 : 800, height: 850 });
    await page.waitForTimeout(120);
    const bounds = await overlay.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= (theme === "light" ? 1280 : 800) + 1);
    await page.screenshot({ path: output + "/" + theme + ".png" });
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.getByRole("button", { name: "Restore panel", exact: true }).click();
  assert.equal(await page.locator('.app-shell-bottom-panel, [data-panel-region="bottom"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: /Move .* to bottom panel|Show bottom panel/ }).count(), 0);
  assert.equal(await page.evaluate(() => (window as any).fixture.closed.length), 0);
  assert.match(await editor.innerText(), /Keep this parent draft/);
  await page.screenshot({ path: output + "/restored.png" });
  await page.evaluate(() => (window as any).fixture.openBrowser());
  const frame = page.frameLocator('iframe').first();
  const counter = frame.getByRole('button', { name: /Page count/ });
  await counter.click(); assert.equal(await counter.innerText(), 'Page count 1');
  await page.getByRole('button', { name: 'Maximize panel', exact: true }).click();
  await counter.click(); assert.equal(await counter.innerText(), 'Page count 2');
  await editor.focus();
  await page.waitForFunction(() => document.querySelector('.thread-composer-overlay__content')?.getAttribute('data-density') === 'expanded');
  await page.getByRole('button', { name: 'Latest turn', exact: true }).click();
  const response = page.locator('.thread-composer-overlay__response'); await response.waitFor();
  await page.waitForFunction(() => document.querySelector('.thread-composer-overlay__response')?.textContent?.includes('Latest answer preview'));
  assert.match(await response.innerText(), /Latest answer preview/);
  assert.doesNotMatch(await response.innerText(), /User intro must not be duplicated/);
  const responseBox = await response.boundingBox(); assert.ok(responseBox && responseBox.height <= 361);
  await page.screenshot({ path: output + '/latest-turn.png' });
  // Scrolling the preview consumes its own scroll; it must not hide/expand input.
  await response.hover(); await page.mouse.wheel(0, 100); await page.waitForTimeout(100);
  assert.equal(await page.getByRole('button', { name: 'Latest turn', exact: true }).getAttribute('aria-expanded'), 'true');
  await page.getByRole('button', { name: 'Hide chat input', exact: true }).click();
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.opencraft-composer-editor').evaluate(e => Boolean(e.closest('[inert]'))), true);
  const reveal = page.getByRole('button', { name: 'Show chat input', exact: true });
  await reveal.focus(); await reveal.press('Enter'); await page.waitForTimeout(180);
  assert.match(await editor.innerText(), /Keep this parent draft/);
  assert.equal(await page.evaluate(() => (window as any).fixture.pages.listForOwner('scope').length), 1);
  await page.getByRole('button', { name: 'Restore panel', exact: true }).click();
  await page.evaluate(() => (window as any).fixture.panels.dispatch('scope', { type: 'set-region-open', region: 'right', open: false }));
  // Parked iframe resources keep their viewport dimensions; visibility and
  // interaction, not a zero width, define the hidden presentation.
  await page.waitForFunction(() => { const f = document.querySelector('iframe'); return !f || f.getAttribute('aria-hidden') === 'true'; });
  await page.evaluate(() => (window as any).fixture.panels.dispatch('scope', { type: 'set-region-open', region: 'right', open: true }));
  await counter.click(); assert.equal(await counter.innerText(), 'Page count 3');
  await page.screenshot({ path: output + "/browser-right.png" });
  await page.locator('[data-panel-region="right"] .right-panel-tab[data-active="true"] .right-panel-tab__close').click();
  assert.equal(await page.evaluate(() => (window as any).fixture.pages.listForOwner('scope').length), 0);
  await page.getByRole('button', { name: 'Maximize panel', exact: true }).click();
  await overlay.waitFor();
  await editor.press('Enter');
  await page.waitForFunction(() => (window as any).fixture.submitted.length === 1);
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.submitted[0]), { type: 'existing-thread', key: { hostId: 'fixture-host', threadId: 'parent' } });
  assert.deepEqual(errors, []);
  await writeFile(output + "/result.json", JSON.stringify({ result: "passed", invariants: ["WSP-01", "WSP-02", "WSP-05", "WSP-06", "WSP-10", "WSP-14"], bottomPanelAbsent: true, browserCounterSurvivedMaximizeAndHide: true, errors }, null, 2));
  console.log("Workspace presentation smoke passed: " + output);
} finally { await browser?.close(); await vite.close(); }
