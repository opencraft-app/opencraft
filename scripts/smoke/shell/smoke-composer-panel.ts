import assert from "node:assert/strict";

import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const browserName = process.env.OPENCRAFT_SMOKE_BROWSER ?? "chromium";
assert(["chromium", "webkit"].includes(browserName), "Select chromium or webkit");
const mobile = process.argv.includes("--mobile-browser");
const pagePresentation = process.argv.includes("--page-presentation");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-workspace-presentation";
async function settleMobileViewport(page: any) {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('.browser-panel[data-mobile-browser="true"]');
      if (!panel) return false;
      const bounds = panel.getBoundingClientRect();
      return Math.abs(bounds.width - innerWidth) < 1 && Math.abs(bounds.height - innerHeight) < 1;
    },
    undefined,
    { timeout: 5000 },
  );
}
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
import{ComposerPanelToggle}from'/apps/workbench-web/src/components/composer-panel-toggle.tsx';
import{AppShellHeader}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{RightPanel}from'/apps/workbench-web/src/components/right-panel.tsx';
import{useShellPresentation}from'/apps/workbench-web/src/components/shell-presentation.ts';
import{ThreadComposerPresentation}from'/apps/workbench-web/src/components/thread-composer-presentation.tsx';
import{TimelineBlockRendererProvider,TimelineBlockRendererRegistryService}from'@opencraft/timeline-render-react';
import{BuiltinTimelineRendererPlugin}from'/apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin';
import{initializeAppearanceTheme,setThemePreference}from'/apps/workbench-web/src/appearance-theme.ts';
import{AsyncNoticesProvider}from'/apps/workbench-web/src/components/async-notices.tsx';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();const ctx=new Context();await ctx.plugin(WorkbenchPanelService);const panels=ctx.workbenchPanels;const key=createConversationKey('fixture-host','parent');
const params=new URLSearchParams(location.search);const mobile=params.has('mobile');const topology=params.has('page-presentation');
if(mobile){document.documentElement.dataset.uiDensity='touch';;setThemePreference(params.get('theme')==='dark'?'dark':'light');}
const controller=createComposerController({type:'existing-thread',key},{now:Date.now,createId:()=>crypto.randomUUID()});const closed=[];const submitted=[];
await ctx.plugin(WorkbenchPanelRendererRegistryService);
await ctx.plugin(TimelineBlockRendererRegistryService);await ctx.plugin(BuiltinTimelineRendererPlugin);
const surfaces=new WebIframeSurfaceHost();const pages=new WebBrowserPageRuntime(surfaces);const presentations=new BrowserPresentationCoordinator(pages,surfaces);
const keyboardRequests=[];if(mobile){surfaces.keyboardState=()=>window.fixtureKeyboardState??'ready';surfaces.onKeyboardState=()=>()=>{};surfaces.showKeyboard=id=>keyboardRequests.push({id,gesture:navigator.userActivation.isActive});}
const workbench=new BrowserWorkbenchCoordinator(pages,panels,createConversationBindingStore());
await ctx.plugin(createBrowserWorkbenchPanelPlugin(workbench,()=>{workbench.open('scope',{initialUrl:location.origin+'/browser-fixture'});}));
panels.register({kind:'terminal',createTab:({id})=>({id,resource:id,kind:'terminal',region:'right',title:'Terminal',icon:'terminal',closable:true,preview:false}),disposeTab:t=>closed.push(t.resource)});
panels.open('scope','terminal',{id:'terminal:one'});
panels.register({kind:'fixture-document',createTab:({id})=>({id,resource:id,kind:'fixture-document',region:'right',title:'Notes',icon:'file',closable:true,preview:false}),disposeTab:t=>closed.push(t.resource)});
panels.registerToolbarAction({id:'fixture.new-document',region:'right',order:200,label:'New document tab',creationLabel:'Document',icon:'file',run:()=>{panels.open('scope','fixture-document',{id:'document:one'});}});
function Tool(){return <div style={{height:'100%',padding:20}}><input aria-label='Terminal input' defaultValue='process alive'/></div>}
function Document(){return <div>Document content</div>}
const renderers=[{kind:'fixture-document',Component:Document},{kind:'terminal',Component:Tool,residency:'while-tab-open'},...ctx.workbenchPanelRenderers.getSnapshot()];
const subscribe=f=>panels.subscribeOwner('scope',f),get=()=>panels.getOwnerSnapshot('scope');

function FixtureHeader(){const shell=useShellPresentation();return <AppShellHeader conversationHeader title='Conversation' project={null} sidebarOpen={false} rightPanelOpen={false} rightPanelFullWidth={false} rightPanelActionInComposer onToggleSidebar={()=>{}} onToggleRightPanel={()=>shell?.toggleRightPanel()} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={[]}/>;}
function App(){const state=useSyncExternalStore(subscribe,get);const [sidebar,setSidebar]=useState(false);const [width,setWidth]=useState(275);const [enabled,setEnabled]=useState(true);const[unified,setUnified]=useState(true);
window.fixture={state,closed,submitted,setSidebar,setUnified,controller,panels,keyboardRequests,setThemePreference,setEnabled,pages,openBrowser:()=>workbench.open('scope',{initialUrl:location.origin+'/browser-fixture',panelOwnerId:'scope'})};
const panel=()=> <RightPanel state={state} presentationId='view' renderers={renderers} toolbarActions={panels.getToolbarActionSnapshot()} toolbarActionContext={{ownerId:'scope',resourceOwnerId:'scope',hostId:'fixture-host',cwd:null}} onAction={a=>panels.dispatch('scope',a)} onCloseTab={t=>panels.close('scope',t.region,t.id)}/>;
const navigation=topology&&unified?{layout:'unified',actions:[],account:{snapshot:{phase:'anonymous'},onOpen:()=>{}},onOpenSettings:()=>{}}:undefined;
return <AppShell navigation={navigation} layoutScope='scope' mainContentLayout='default' header={<FixtureHeader/>} floatingSidebarHeader={()=>null} leftPanel={<div><p>Navigation</p><button data-fixture-drawer-action onClick={()=>closed.push("drawer-action")}>Drawer action</button></div>} sidebarOpen={sidebar} sidebarWidth={width} onSidebarCollapse={()=>setSidebar(false)} onSidebarExpand={()=>setSidebar(true)} onSidebarResizeEnd={setWidth} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanelKeepMounted={true} rightPanel={panel('right')} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onRightPanelOpenChange={open=>panels.dispatch('scope',{type:'set-region-open',region:'right',open})}>
<div style={{height:'100%',display:'flex',flexDirection:'column'}}><p style={{flex:1}}>Parent conversation</p>
<ThreadComposerPresentation scopeId='scope' controller={controller} activeTabId={state.right.activeTabId} enabled={enabled} timeline={{key,revision:1,phase:'live',authoritative:true,anchorFrameIds:new Map(),frames:[{id:'user-frame',type:'user',turnId:'turn',status:'complete',durationMs:null,hookStats:null,anchors:[],blocks:[{id:'user-block',type:'text',text:'User intro must not be duplicated',sourceItemIds:[],streaming:false}]},{id:'assistant-frame',type:'assistant',turnId:'turn',status:'complete',durationMs:1000,hookStats:null,anchors:[],blocks:[{id:'answer',type:'text',text:'Latest answer preview\\n\\n'+('A bounded response paragraph.\\n\\n'.repeat(40)),sourceItemIds:['answer'],streaming:false,completed:true,phase:'final_answer'}]}]}} documentContext={{conversationId:'parent',hostId:'fixture-host',cwd:null,theme:'light'}}>
<div className='thread-composer-region'><OpenCraftComposer controller={controller} entryActions={<ComposerPanelToggle/>} onSubmit={async intent=>{submitted.push(intent.target)}} onCancel={()=>{}} /></div>
</ThreadComposerPresentation></div></AppShell>}
createRoot(document.getElementById('root'),undefined,params.get('locale')??'en-US').render(<AsyncNoticesProvider><TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}><BrowserEnvironmentProvider pages={pages} surfaces={surfaces} presentations={presentations} workbench={workbench}><App/><BrowserPresentationRoot/></BrowserEnvironmentProvider></TimelineBlockRendererProvider></AsyncNoticesProvider>);`;
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  cacheDir: "node_modules/.vite-workspace-presentation",
  resolve: { dedupe: ["react", "react-dom"] },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@tanstack/react-query",
    ],
  },
  plugins: [
    {
      name: "workspace-presentation-fixture",
      resolveId: (id) => (id === "/workspace-probe.tsx" ? id : null),
      load: (id) => (id === "/workspace-probe.tsx" ? source : null),
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/browser-fixture") {
            res.setHeader("content-type", "text/html");
            res.end(
              '<title>Fixture web page</title><button onclick="this.textContent=String.fromCharCode(80,97,103,101,32,99,111,117,110,116,32)+(++window.count)">Page count 0</button><script>window.count=0</script>',
            );
            return;
          }
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/workspace-probe.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = await playwright.chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  for (const [width, touch] of [
    [390, true],
    [1280, false],
    [390, false],
    [1024, true],
  ] as const) {
    const page = await browser.newPage({
      viewport: { width, height: 844 },
      hasTouch: touch,
      isMobile: touch && width < 768,
      reducedMotion: "reduce",
    });
    page.on("pageerror", (e) => {
      throw e;
    });
    await page.addInitScript("window.__name=value=>value");
    await page.goto(vite.resolvedUrls!.local[0]! + (touch ? "?mobile=1" : ""));
    await page.waitForFunction(() => Boolean((window as any).fixture));
    await page.evaluate(() =>
      (window as any).fixture.panels.dispatch("scope", { type: "set-region-open", region: "right", open: false }),
    );
    const button = page.getByTestId("composer-panel-toggle"),
      header = page.locator("button.app-shell-header__right-panel-toggle");
    if (touch && width < 768) {
      await button.waitFor({ state: "visible" });
      assert.equal(await header.count(), 0);
      const box = (await button.boundingBox())!;
      assert.ok(box.width >= 44 && box.height >= 44, JSON.stringify(box));
      const editor = page.locator(".opencraft-composer-editor");
      await editor.click();
      await page.keyboard.insertText("Keep my draft");
      await page.screenshot({ path: output + "/mobile-input.png" });
      await button.tap();
      await header.waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Back to workspace", exact: true }).tap();
      await button.waitFor({ state: "visible" });
      assert.equal(await editor.textContent(), "Keep my draft");
    } else {
      assert.equal(await button.count(), 0);
      await header.waitFor({ state: "visible" });
    }
    console.log("PASS", width, touch ? "touch" : "pointer");
    await page.close();
  }
} finally {
  await browser?.close();
  await vite.close();
}
