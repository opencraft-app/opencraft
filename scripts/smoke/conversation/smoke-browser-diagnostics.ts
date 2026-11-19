import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/browser-diagnostics";
const source = `
import React,{useState,useEffect} from 'react';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{AppShell}from'/apps/workbench-web/src/components/app-shell.tsx';
import{AppShellHeader}from'/apps/workbench-web/src/components/app-shell-header.tsx';
import{ConversationTaskMenu}from'/apps/workbench-web/src/components/conversation-task-menu.tsx';
import{ConversationSummaryButton,ConversationSummarySurface,ConversationSummaryLayout,useConversationSummary}from'/apps/workbench-web/src/components/conversation-summary.tsx';
import{createWorkbenchPanelReactRuntime}from'@opencraft/workbench-panels-react';
import{ThreadSummaryPlugin}from'@opencraft/plugin-thread-summary';
import{WorkbenchPanelRuntimeProvider}from'/apps/workbench-web/src/runtime/panel-runtime-context';
import{useUiPreferencesRuntime}from'/apps/workbench-web/src/runtime/ui-preferences-runtime';
import{bindInteractionDensity}from'/apps/workbench-web/src/runtime/interaction-density';
import{initializeAppearanceTheme,setThemePreference,setAppearanceThemeId,coreThemeId}from'/apps/workbench-web/src/appearance-theme';
import'/apps/workbench-web/src/styles/app.scss';
import {useTimelineViewportHost} from '/apps/workbench-web/src/timeline-viewport';
import {captureViewportHistory} from '/apps/workbench-web/src/runtime/viewport-history';
window.readViewportHistory=captureViewportHistory;
import {recordRuntimeDiagnosticConsole,startRuntimeDiagnosticCollection} from '/apps/workbench-web/src/runtime-diagnostics';
import {captureLocalDiagnostics,getLocalDiagnosticsState} from '/apps/workbench-web/src/runtime/local-diagnostics';
import {setTimelineDiagnosticObserver,WebConversationViewportOwner} from '@opencraft/timeline-host-web';
import {subscribeLocalDiagnostics,isLocalDiagnosticsEnabled,recordLocalDiagnostic} from '/apps/workbench-web/src/runtime/local-diagnostics';
startRuntimeDiagnosticCollection();
const update=()=>setTimelineDiagnosticObserver(isLocalDiagnosticsEnabled()?recordLocalDiagnostic:undefined);
subscribeLocalDiagnostics(update);update();
window.localDiagnostics=captureLocalDiagnostics;
window.diagnosticState=getLocalDiagnosticsState;
window.exerciseScroll=()=>{
 const root=document.createElement('div');root.style.cssText='height:120px;width:200px;overflow:auto;display:flex;flex-direction:column-reverse;position:absolute;left:0;top:0;visibility:hidden';
 const row=document.createElement('div');row.style.cssText='height:1200px;flex-shrink:0';root.append(row);document.body.append(root);
 const owner=new WebConversationViewportOwner(0);owner.attachScrollElement(root);owner.observeTurn('private-turn-id',row);owner.bindScrollBehavior({});
 root.dispatchEvent(new TouchEvent('touchstart'));root.dispatchEvent(new TouchEvent('touchend'));
 owner.scrollController.scrollToDistanceFromBottomPx(120,'instant');
 owner.observeTurn('private-turn-id',null);owner.dispose();root.remove();
};
initializeAppearanceTheme();
const runtime=await createWorkbenchPanelReactRuntime();await runtime.install(ThreadSummaryPlugin);
const client=new QueryClient();const noop=()=>{};
function App(){const[right,setRight]=useState(false),[full,setFull]=useState(false),[foreground,setForeground]=useState('primary'),[sidebar,setSidebar]=useState(false),[scope,setScope]=useState('a');
 const preferences=useUiPreferencesRuntime();useEffect(()=>bindInteractionDensity(document,preferences),[preferences]);
 useTimelineViewportHost({kind:'browser',platform:'linux',safeArea:{left:0,right:0}});
 const summary=useConversationSummary(scope,true);
 window.fixture={configureDock:()=>preferences.set("shell.toolbarDocks",{[JSON.stringify(["a","conversation-header"])]:["share-link","rename","pin","fork"]}),setRight,setFull,setForeground,setSidebar,setScope,setThemePreference,setAppearanceThemeId,coreThemeId,setDensity:value=>preferences.set('interface.touchFriendly',value)};
 return <AppShell navigation={{layout:'unified',actions:[],onOpenSettings:noop,account:{snapshot:{phase:'anonymous'},onOpen:noop}}}
 layoutScope='ownership' sceneOwnerId='ownership' mainContentLayout='thread-edge-scroll' sidebarOpen={sidebar} sidebarWidth={275} onSidebarCollapse={()=>setSidebar(false)} onSidebarExpand={()=>setSidebar(true)} onSidebarResizeEnd={noop}
 foreground={foreground} onForegroundChange={setForeground} rightPanel={<div data-tool style={{height:'100%'}}>Browser / terminal / file viewport<input aria-label='Tool state' defaultValue='Alive'/></div>} rightPanelKeepMounted rightPanelOpen={right} rightPanelFullWidth={full} onRightPanelOpenChange={setRight}
 windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} floatingSidebarHeader={()=>null} leftPanel={<div>Conversations</div>}
 header={<AppShellHeader conversationHeader primaryActionFixedSlots={2} title={'Conversation '+scope} project='Workspace' primaryAction={<span className='conversation-header-actions'><ConversationSummaryButton controller={summary}/><ConversationTaskMenu scope={scope} serverId='local' threadId={scope} title={'Conversation '+scope} shareUrl='https://example.test' onRename={async()=>{}} onSetPinned={async()=>{}} onFork={async()=>{}} verifyConversation={async()=>{}} onOpenTasks={noop}/></span>}
 sidebarOpen={sidebar} rightPanelOpen={right} rightPanelFullWidth={full} onToggleSidebar={()=>setSidebar(v=>!v)} onToggleRightPanel={()=>setRight(v=>!v)} onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={['sidebar-toggle']}/>}
 ><ConversationSummaryLayout controller={summary}><div className='conversation-summary-reading'><div style={{height:'100%',padding:32}}><h1>Conversation {scope}</h1><div className='opencraft-composer-shell'><textarea aria-label='Draft' defaultValue='Keep this draft'/></div></div></div><ConversationSummarySurface controller={summary} context={{scopeKey:scope,title:'Conversation '+scope,timeline:null,goal:null,current:true,onOpenResource:noop,onOpenThread:noop}}/></ConversationSummaryLayout></AppShell>;
}
createIntlTestRoot(document.getElementById('root'),undefined,window.fixtureLocale??'en-US').render(<QueryClientProvider client={client}><WorkbenchPanelRuntimeProvider runtime={runtime}><App/></WorkbenchPanelRuntimeProvider></QueryClientProvider>);
window.diagnosticWarning=()=>recordRuntimeDiagnosticConsole("console.warn",["synthetic diagnostic warning"]);

`;
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-browser-diagnostics",
  esbuild: { jsx: "automatic" },
  optimizeDeps: { entries: [] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "diagnostic-fixture",
      resolveId: (id) => (id === "/fixture.tsx" ? id : null),
      load: (id) => (id === "/fixture.tsx" ? source : null),
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/__opencraft_apphost_diagnostic") {
            res.statusCode = 202;
            res.end("{}");
            return;
          }
          if (req.url !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="opencraft-source-revision" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"><div id="root"></div><script type="module" src="/fixture.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
const evidence = [];
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  for (const item of [
    { width: 390, touch: true, theme: "light", locale: "en-US" },
    { width: 1440, touch: false, theme: "dark", locale: "en-US" },
    { width: 390, touch: true, theme: "light", locale: "zh-CN" },
  ]) {
    const context = await browser.newContext({
      viewport: { width: item.width, height: 900 },
      hasTouch: item.touch,
      isMobile: item.touch,
      userAgent: item.touch
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
        : "diagnostic-desktop",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("PAGEERROR", e.message);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) console.error("HTTP", response.status(), response.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error") console.error("BROWSER", message.text());
    });
    await page.addInitScript((locale) => {
      (window as any).__name = (v: any) => v;
      (window as any).fixtureLocale = locale;
    }, item.locale);
    await page.goto(vite.resolvedUrls!.local[0]!, { waitUntil: "commit" });
    const draft = page.getByRole("textbox", { name: "Draft", exact: true });
    await draft.waitFor({ timeout: 30000 }).catch(async (error) => {
      await writeFile(output + "/failed.html", await page.content());
      await page.screenshot({ path: output + "/failed.png" });
      throw error;
    });
    await page.evaluate((item) => {
      const w = window as any;
      w.fixture.setDensity(item.touch ? "on" : "off");
      w.fixture.setThemePreference(item.theme);
      w.draft = document.querySelector("[aria-label=Draft]");
    }, item);
    const more = page.getByRole("button", {
      name: item.locale === "zh-CN" ? "会话操作" : "Conversation actions",
      exact: true,
    });
    const openMenu = async () => {
      if (item.touch) await more.tap();
      else {
        await more.focus();
        await page.keyboard.press("Enter");
      }
    };
    assert.equal(await page.evaluate(() => (window as any).diagnosticState().enabled), false);
    const uploads: string[] = [];
    page.on("request", (req) => {
      if (/__opencraft_(apphost_diagnostic|runtime_error|observe\/events)/.test(req.url())) uploads.push(req.url());
    });
    await page.evaluate(() => (window as any).exerciseScroll());
    assert.equal(await page.evaluate(() => (window as any).localDiagnostics().samples.length), 0);
    await openMenu();
    const enable = page.getByRole("menuitem", {
      name: item.locale === "zh-CN" ? "启用本地诊断" : "Enable local diagnostics",
      exact: true,
    });
    if (item.touch) await enable.tap();
    else await enable.click();
    await page.waitForFunction(() => (window as any).diagnosticState().enabled);
    await page.evaluate(() => {
      (window as any).diagnosticWarning();
      (window as any).exerciseScroll();
    });
    await draft.focus();
    await draft.fill("private draft survives export");
    if (item.touch) {
      await draft.tap();
      await page.waitForFunction(() => Boolean((window as any).readViewportHistory().lastEditing));
    }
    await page.waitForFunction(
      () => document.querySelector("html")?.dataset.timelineTracksVisualViewport === "true" || window.innerWidth > 600,
    );
    await openMenu();
    const download = page.getByRole("menuitem", {
      name: item.locale === "zh-CN" ? "下载诊断信息" : "Download diagnostics",
      exact: true,
    });
    await download.waitFor();
    await page.screenshot({ path: output + "/" + item.width + "-" + item.theme + "-" + item.locale + "-menu.png" });
    const waiting = page.waitForEvent("download");
    if (item.touch) await download.tap();
    else {
      await download.focus();
      await page.keyboard.press("Enter");
    }
    const file = await waiting;
    assert.match(file.suggestedFilename(), /^opencraft-diagnostics-.*\.json$/);
    const report = JSON.parse(await readFile((await file.path())!, "utf8"));
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.diagnostics.enabled, true);
    assert.equal(report.diagnostics.upload, false);
    assert.ok(report.diagnostics.samples.some((x: any) => x.kind === "scroll-write"));
    assert.ok(!JSON.stringify(report.diagnostics).includes("private-turn-id"));
    assert.ok(report.current.layout.elements.shell);
    assert.ok(report.runtime.errors.some((entry: any) => entry.message === "synthetic diagnostic warning"));
    assert.ok(!JSON.stringify(report).includes("private draft survives export"));
    if (item.touch) {
      assert.equal(report.viewport.lastEditing.geometry.editing, 1);
      assert.ok(report.viewport.lastEditing);
      assert.ok(report.viewport.samples.length > 0);
    }
    assert.equal(await page.locator("[aria-label=Draft]").inputValue(), "private draft survives export");
    assert.equal(await page.locator("[aria-label=Draft]").evaluate((e) => e === (window as any).draft), true);
    await openMenu();
    const disable = page.getByRole("menuitem", {
      name: item.locale === "zh-CN" ? "停用本地诊断" : "Disable local diagnostics",
      exact: true,
    });
    if (item.touch) await disable.tap();
    else await disable.click();
    assert.equal(await page.evaluate(() => (window as any).diagnosticState().enabled), false);
    const count = await page.evaluate(() => (window as any).localDiagnostics().samples.length);
    await page.evaluate(() => (window as any).exerciseScroll());
    assert.equal(await page.evaluate(() => (window as any).localDiagnostics().samples.length), count);
    assert.deepEqual(uploads, []);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: output + "/" + item.width + "-" + item.theme + "-" + item.locale + ".png" });
    evidence.push({ ...item, download: true, preservedEditing: Boolean(report.viewport.lastEditing), errors });
    await context.close();
  }
  await writeFile(output + "/result.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, evidence }));
} finally {
  await browser?.close();
  await vite.close();
}
