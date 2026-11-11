import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";

// Real Shell, RightPanel, TerminalPanel, xterm and RPC client. Only the remote
// process service is synthetic; no user terminal or model is contacted.
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-terminal-recovery";
const source = `
import React,{useSyncExternalStore} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWorkbenchPanelReactRuntime} from '@opencraft/workbench-panels-react';
import {WorkbenchTerminalSessionRegistry,createTerminalWorkbenchPanelPlugin} from '/plugins/terminal/src/index.tsx';
import {AppServerTerminalController} from '@opencraft/workbench-runtime';
import {JsonRpcAppServerClient} from '@opencraft/appserver-client';
import {MemoryTransport} from '@opencraft/appserver-transport-memory';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {RightPanel} from '/apps/workbench-web/src/components/right-panel.tsx';
import {useShellPresentation} from '/apps/workbench-web/src/components/shell-presentation.ts';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
const params=new URLSearchParams(location.search);
document.documentElement.dataset.uiDensity=params.has('touch')?'touch':'pointer';
initializeAppearanceTheme();setThemePreference(params.get('theme')??'light');
const peers=new Set(),calls=[],spawns=[];
const client=new JsonRpcAppServerClient({hostId:'fixture',transport:new MemoryTransport({
  connected(peer){peers.add(peer)},
  receive(frame,peer){const message=JSON.parse(frame);if(message.id===undefined)return;
    calls.push(message.method);
    if(message.method==='process/spawn')spawns.push(message.params);
    const result=message.method==='initialize'?{userAgent:'native-fixture'}:{};
    peer.send(JSON.stringify({id:message.id,result}));
  }
})});
const connect=()=>client.connect({clientInfo:{name:'terminal-recovery-fixture',version:'1'}});
await connect();
const controller=new AppServerTerminalController('fixture',client);
const registry=new WorkbenchTerminalSessionRegistry(()=>({getSnapshot:()=>({phase:'ready'}),resources:{terminal:controller,host:{canRequest:()=>true}}}));
const runtime=await createWorkbenchPanelReactRuntime();
await runtime.install(createTerminalWorkbenchPanelPlugin(registry));
const first=registry.open({hostId:'fixture',cwd:'/workspace',threadId:'thread',projectId:'project',resourceOwnerId:'scope'});
await registry.get(first).resize(80,24);
for(const peer of peers)peer.send(JSON.stringify({method:'process/outputDelta',params:{processHandle:registry.get(first).processId,sequence:1,stream:'stdout',deltaBase64:btoa('Original terminal output is preserved.\\r\\n$ ')}}));
runtime.panels.open('scope','terminal',{sessionId:first});
const context={ownerId:'scope',resourceOwnerId:'scope',hostId:'fixture',cwd:'/workspace'};
function Header(){const shell=useShellPresentation();return <button onClick={()=>shell?.toggleRightPanel()}>Open terminal</button>}
function App(){const state=useSyncExternalStore(fn=>runtime.panels.subscribeOwner('scope',fn),()=>runtime.panels.getOwnerSnapshot('scope'));
  const panel=<RightPanel state={state} presentationId='fixture-view' renderers={runtime.renderers.getSnapshot()}
    toolbarActions={runtime.panels.getToolbarActionSnapshot()} toolbarActionContext={context}
    onAction={a=>runtime.panels.dispatch('scope',a)} onCloseTab={t=>runtime.panels.close('scope',t.region,t.id)}/>;
  return <AppShell layoutScope='scope' mainContentLayout='default' header={<Header/>}
    floatingSidebarHeader={()=>null} leftPanel={null} sidebarOpen={false} sidebarWidth={275}
    windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}}
    rightPanelKeepMounted rightPanel={panel} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth}
    onRightPanelOpenChange={open=>runtime.panels.dispatch('scope',{type:'set-region-open',region:'right',open})}>
      <p>Conversation</p>
    </AppShell>;
}
createIntlTestRoot(document.getElementById('root'),undefined,params.get('locale')??'zh-CN').render(<App/>);
window.fixture={calls,spawns,registry,first,runtime,
  async disconnect(){for(const peer of peers)peer.close('synthetic network loss');peers.clear();await connect();await controller.reconnect();},
  inspect(){return {calls:[...calls],spawns:[...spawns],firstOutput:registry.get(first).getSnapshot().output,
    firstPhase:registry.get(first).getSnapshot().phase,sessions:registry.listForOwner('scope')};}
};
`;
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  cacheDir: "node_modules/.vite-terminal-recovery", resolve: { dedupe: ["react", "react-dom"] },
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "terminal-recovery-fixture",
    resolveId: id => id === "/terminal-recovery-fixture.tsx" ? id : null,
    load: id => id === "/terminal-recovery-fixture.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/terminal-recovery-fixture.tsx"></script>');
    }); },
  }],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const touch of [true, false]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 844 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.addInitScript("window.__name=value=>value");
    const port = (server.httpServer!.address() as { port: number }).port;
    await page.goto(`http://127.0.0.1:${port}/?theme=${theme}${touch ? "&touch=1" : ""}`, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean((window as any).fixture));
    await page.getByRole("button", { name: "Open terminal", exact: true }).waitFor();
    if (!await page.locator(".xterm").isVisible()) await page.getByRole("button", { name: "Open terminal", exact: true }).click();
    await page.locator(".xterm").waitFor().catch(async error => {
      await page.screenshot({ path: `${output}/startup-failure.png` });
      console.error(await page.locator("body").innerText()); throw error;
    });
    await page.evaluate(() => (window as any).fixture.disconnect());
    const recovery = page.locator(".terminal-panel__recovery");
    await recovery.getByRole("button", { name: "新建终端", exact: true }).waitFor();
    await page.waitForFunction(() => {
      const bounds = document.querySelector(".terminal-panel__recovery")?.getBoundingClientRect();
      return bounds && bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
    }).catch(async error => {
      await page.screenshot({ path: `${output}/layout-failure.png` });
      console.error(await recovery.evaluate(element => ({ bounds: element.getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight })));
      throw error;
    });
    assert.match(await recovery.innerText(), /无法重新连接/);
    const geometry = await recovery.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, bottom: bounds.bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight, clipped: element.scrollWidth > element.clientWidth,
        whiteSpace: getComputedStyle(element).whiteSpace };
    });
    assert.equal(geometry.clipped, false);
    assert.equal(geometry.whiteSpace, "normal");
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewportWidth && geometry.bottom <= geometry.viewportHeight);
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-${theme}.png` });
    const button = recovery.getByRole("button", { name: "新建终端", exact: true });
    if (touch) await button.tap();
    else { await button.focus(); await page.keyboard.press("Enter"); }
    await page.waitForFunction(() => (window as any).fixture.inspect().spawns.length === 2);
    const result = await page.evaluate(() => (window as any).fixture.inspect());
    assert.equal(result.sessions.length, 2);
    assert.equal(result.firstPhase, "failed");
    assert.equal(result.firstOutput.length, 1);
    assert.ok(!result.calls.some((method: string) => ["process/attach", "process/list", "process/kill"].includes(method)));
    for (const spawn of result.spawns) {
      assert.equal(spawn.threadId, "thread"); assert.equal(spawn.projectId, "project");
      assert.equal(spawn.resourceOwnerId, "scope"); assert.equal(spawn.cwd, "/workspace");
    }
    await page.locator('.terminal-panel[data-phase="running"]').waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(`PASS: real Shell/Terminal recovery, localized wrapping, explicit new terminal, retained output and scope; touch + keyboard, light + dark. Images: ${output}`);
} finally { await browser?.close(); await server.close(); }
