import assert from "node:assert/strict";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
// Production navigation/resource owners and actual application buttons; no
// authentication, user storage, external Host or model requests are involved.
const source = `
import React,{useSyncExternalStore} from 'react';
import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {NavigationContent} from '/apps/workbench-web/src/components/shell-navigation/navigation-content.tsx';
import {Sidebar} from '/apps/workbench-web/src/components/sidebar.tsx';
import {SidebarLayoutStore} from '@opencraft/sidebar-layout';
import {createConversationBindingStore,createWorkbenchThreadLocation,threadServerOrigin} from '/packages/workbench-runtime/src/index.ts';
import '/apps/workbench-web/src/styles/app.scss';
import {readWorkbenchBootstrapLocation} from '/apps/workbench-web/src/runtime/workbench-navigation.ts';
import {resolveRetainedWorkbenchLocation} from '/apps/workbench-web/src/runtime/workbench-location-restoration.ts';
import {createNavigationRestorationSession} from '/tests/fixtures/navigation-restoration-session.ts';
const scenario=sessionStorage.getItem('scenario')??'draft';
const held=sessionStorage.getItem('hold')==='true';
const candidate=readWorkbenchBootstrapLocation(new URL(location.href),history.state);
const bindings=createConversationBindingStore();
const restored=candidate===null?null:resolveRetainedWorkbenchLocation(candidate,{hasHost:id=>id==='local',bindings,scopes:null});
bindings.dispose();
// Global last-used preferences can change in another tab. Current entry wins.
const preferred=scenario==='draft'?null:createWorkbenchThreadLocation('local',sessionStorage.getItem('enteredSettings')==='true'&&scenario==='thread-drift'?'other-tab-thread':'remembered-thread');
const session=createNavigationRestorationSession({initialThread:restored??preferred??undefined,connect:held?()=>new Promise(()=>{}):undefined,router:{mode:'browser'}});
const errors=[];
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_,value)=>value});
const threads=session.initial.kind==='thread'?[{id:session.initial.key.threadId,title:'Remembered task',project:'fixture',lineage:'root',time:'now',updatedAt:Date.now()/1000,unread:false,status:'ready',connectionHostId:'local',connectionHostLabel:'Fixture',serverOrigin:threadServerOrigin({serverId:'fixture',label:'Fixture'}),serverRouteLocality:'local'}]:[];
window.fixture={...session,errors};
function Demo(){
 const snapshot=useSyncExternalStore(session.navigation.subscribe,session.navigation.getSnapshot,session.navigation.getSnapshot);
 return <><NavigationContent config={{actions:[{id:'chat',title:'Chat',icon:'chat',active:snapshot.applicationRoute.kind==='conversation',onInvoke:()=>session.navigation.openChat().catch(e=>errors.push(e.message))}],settingsActive:snapshot.applicationRoute.kind==='settings',account:null,onOpenSettings:()=>session.navigation.openSettings('appearance')}} surface="applications" onInvoke={action=>action()}/><output data-testid="route">{snapshot.applicationRoute.kind}</output><div style={{width:275,height:520}}><Sidebar threads={threads} activeHostId='local' activeThreadId={session.initial.kind==='thread'?session.initial.key.threadId:''} sidebarLayout={layout} onSelectThread={(host,id)=>session.navigation.selectConversation(createWorkbenchThreadLocation(host,id)).catch(e=>errors.push(e.message))} onNewTask={()=>{}} onOpenSettings={()=>session.navigation.openSettings('appearance')} showFooter={false}/></div></>;
}
createRoot(document.getElementById('root')).render(<Demo/>);
window.ready=true;
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "route-restoration-smoke",
    resolveId: id => id === "/route-probe.tsx" ? id : null,
    load: id => id === "/route-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((request, response, next) => {
      const pathname = request.url?.split("?")[0];
      if (pathname !== "/" && !pathname?.startsWith("/settings/") && !pathname?.startsWith("/local/")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<div id="root"></div><script type="module" src="/route-probe.tsx"></script>');
    }); },
  }] });
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  const results: unknown[] = [];
  for (const touch of [false, true]) for (const scenario of ["draft", "thread", "thread-drift"]) for (const hold of [false, true]) for (const via of ["chat", "sidebar"]) {
    if (via === "sidebar" && scenario === "draft") continue;
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 800 }, hasTouch: touch });
    try {
      const page = await context.newPage();
      page.on("console", (message: any) => { if (message.type() === "error") console.error("Route restoration browser console", message.text()); });
      page.on("requestfailed", (request: any) => console.error("Route restoration request failed", request.url(), request.failure()?.errorText));
      const pageErrors: string[] = []; page.on("pageerror", (error: Error) => {
        pageErrors.push(error.message);
        console.error("Route restoration page error", { touch, scenario, hold, via, message: error.message });
      });
      await page.addInitScript(({ scenario, hold }: { scenario: string; hold: boolean }) => {
        (window as any).__name = (fn: unknown) => fn;
        sessionStorage.setItem("scenario", scenario); sessionStorage.setItem("hold", String(hold));
      }, { scenario, hold });
      await page.goto(origin); await page.waitForFunction(() => (window as any).ready);
      const before = await page.evaluate(() => (window as any).fixture.initial);
      const press = async (name: string) => {
        const button = page.getByRole("button", { name, exact: true });
        if (touch) await button.tap(); else await button.click();
      };
      await press("Settings");
      await page.getByTestId("route").filter({ hasText: "settings" }).waitFor();
      await page.evaluate(() => sessionStorage.setItem("enteredSettings", "true"));
      await page.reload(); await page.waitForFunction(() => (window as any).ready);
      const reloaded = await page.evaluate(() => ({ initial: (window as any).fixture.initial,
        route: (window as any).fixture.navigation.getSnapshot() }));
      assert.equal(reloaded.route.applicationRoute.kind, "settings", "bootstrap correction retains Settings destination");
      assert.deepEqual(reloaded.route.location, reloaded.initial, "Router and resource bootstrap agree");
      if (scenario === "draft") assert.notEqual(reloaded.initial.draftId, before.draftId);
      else assert.deepEqual(reloaded.initial, before, "entry identity wins over other-tab preferences");
      const returnToChat = async () => {
        if (via === "chat") return press("Chat");
        const row = page.getByRole("button", { name: /^Remembered task\b/ });
        if (touch) await row.tap(); else await row.click();
      };
      await returnToChat();
      await page.getByTestId("route").filter({ hasText: "conversation" }).waitFor();
      const returned = await page.evaluate(() => (window as any).fixture.navigation.getSnapshot());
      assert.deepEqual(returned.location, reloaded.initial);
      assert.equal(returned.routeScopeId, reloaded.route.routeScopeId);
      // Settings entry and earlier invalid Draft entries must both remain usable
      // on real Browser POP, not only on explicit openChat.
      await page.goBack();
      await page.getByTestId("route").filter({ hasText: "settings" }).waitFor();
      await page.goBack();
      await page.getByTestId("route").filter({ hasText: "conversation" }).waitFor();
      const popped = await page.evaluate(() => ({ route: (window as any).fixture.navigation.getSnapshot(),
        active: (window as any).fixture.coordinator.getSnapshot(), errors: (window as any).fixture.errors }));
      assert.deepEqual(popped.route.location, reloaded.initial);
      assert.deepEqual(popped.active.location, popped.route.location);
      assert.equal(popped.active.viewId, popped.route.routeScopeId);
      await page.goForward(); await page.getByTestId("route").filter({ hasText: "settings" }).waitFor();
      await returnToChat(); await page.getByTestId("route").filter({ hasText: "conversation" }).waitFor();
      const errors = await page.evaluate(() => (window as any).fixture.errors);
      assert.deepEqual(errors, []); assert.deepEqual(pageErrors, []);
      results.push({ touch, scenario, hold, via, bootstrapAgreement: true, chatReturned: true, popAndForward: true });
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ passed: true, cases: results.length, realHostWrites: false, results }, null, 2));
} finally { await browser?.close(); await vite.close(); }
