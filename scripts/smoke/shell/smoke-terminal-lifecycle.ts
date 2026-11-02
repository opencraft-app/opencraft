import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'vite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DurableHostProcessService } from '../../../apps/local-agent-host/src/durable-process-service';
import { terminalOwnerLocation } from '../../../apps/local-agent-host/src/terminal-owner-runtime';
import { startTerminalPtyOwner } from '../../../apps/local-agent-host/src/terminal-pty-owner';

// Actual PTYs, RPC client, registry, Panel lifecycle and xterm renderer.
// Only account admission and fixed conversation identity are synthetic.
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? '/tmp/opencraft-terminal-lifecycle';
const root = await mkdtemp(join(tmpdir(), 'terminal-browser-owner-'));
const location = await terminalOwnerLocation(root);
const stopOwner = await startTerminalPtyOwner(location.directory, location.endpoint);
let processes = new DurableHostProcessService(root);
const server = createHttpServer();
const sockets = new WebSocketServer({ server });
sockets.on('connection', socket => {
  const off = processes.subscribe((method, params) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  });
  socket.on('close', off);
  socket.on('message', async data => {
    const request = JSON.parse(String(data));
    if (request.id === undefined) return;
    try {
      const result = request.method === 'initialize'
        ? { codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux', userAgent: 'isolated-pty' }
        : await processes.dispatch(request.method, request.params);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    } catch (error) {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: String(error) } }));
    }
  });
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address !== 'string');
const endpoint = `ws://127.0.0.1:${address.port}`;
const source = `
import React,{useSyncExternalStore} from 'react';
import{createIntlTestRoot as createRoot}from'/tests/fixtures/intl-root.tsx';
import{JsonRpcAppServerClient}from'@opencraft/appserver-client';
import{WebSocketTransport}from'@opencraft/appserver-transport-websocket';
import{AppServerTerminalController,ConversationTerminalSessionRegistry}from'@opencraft/workbench-runtime';
import{createWorkbenchPanelReactRuntime}from'@opencraft/workbench-panels-react';
import{createTerminalWorkbenchPanelPlugin}from'/plugins/terminal/src/index.tsx';
import{initializeAppearanceTheme}from'/apps/workbench-web/src/appearance-theme';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const owner='persisted-conversation';
const client=new JsonRpcAppServerClient({hostId:'isolated',transport:new WebSocketTransport({url:${JSON.stringify(endpoint)}})});
await client.connect({clientInfo:{name:'terminal-restart-smoke',version:'1'}});
const terminal=new AppServerTerminalController('isolated',client);
const registry=new ConversationTerminalSessionRegistry(()=>({resources:{terminal}}));
const runtime=await createWorkbenchPanelReactRuntime();
await runtime.install(createTerminalWorkbenchPanelPlugin(registry,undefined,async id=>{await registry.restore('isolated',id)}));
runtime.panels.ensureOwner(owner);
const Panel=runtime.renderers.resolve(runtime.renderers.getSnapshot(),'terminal');
const subscribe=f=>runtime.panels.subscribeOwner(owner,f),get=()=>runtime.panels.getOwnerSnapshot(owner);
window.fixture={registry,runtime,terminal,owner,send:async text=>{
 const id=registry.listForOwner(owner)[0];await registry.get(id).write(btoa(text));
},buffer:()=>registry.getSnapshotForConversation(owner)?.buffer??''};
function App(){const state=useSyncExternalStore(subscribe,get);return <>
<button onClick={()=>{const id=registry.open({hostId:'isolated',cwd:'/tmp',resourceOwnerId:owner,threadId:'thread',projectId:'project'});runtime.panels.open(owner,'terminal',{sessionId:id})}}>New terminal</button>
<button onClick={()=>runtime.panels.dispatch(owner,{type:'set-region-open',region:'right',open:!state.right.open})}>Toggle panel</button>
<button onClick={()=>{const tab=state.right.tabs[0];if(tab)runtime.panels.close(owner,'right',tab.id)}}>Close terminal</button>
<p data-tab-count={state.right.tabs.length} data-panel-open={state.right.open}>{state.right.tabs.length}</p>
{state.right.open&&state.right.tabs.map(tab=><div key={tab.id} style={{width:'100%',height:360}}><Panel ownerId={owner} presentationId='fixture' tab={tab}/></div>)}
</>}
createRoot(document.getElementById('root')).render(<App/>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', cacheDir: 'node_modules/.vite-terminal-lifecycle', resolve: { dedupe: ['react','react-dom'] }, esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'terminal-lifecycle-fixture', resolveId: id => id === '/terminal-lifecycle.tsx' ? id : null, load: id => id === '/terminal-lifecycle.tsx' ? source : null, configureServer(vite) { vite.middlewares.use((req,res,next) => { if(req.url?.split('?')[0] !== '/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/terminal-lifecycle.tsx"></script>'); }); } }] });
let browser: any;
const errors: string[] = [];
const launch = () => chromium.launch({ headless:true, args:['--no-sandbox'] });
const open = async (mobile: boolean) => {
  const context = await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1100,height:800},hasTouch:mobile,isMobile:mobile});
  await context.addInitScript(() => { (window as any).__name = (v: unknown) => v; });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(vite.resolvedUrls!.local[0]!); await page.waitForFunction(() => Boolean((window as any).fixture)); return page;
};
const directory = async () => (await processes.dispatch('process/list', {}) as any).processes;
try {
  await mkdir(output,{recursive:true}); await vite.listen(); browser = await launch();
  let page = await open(false);
  await page.getByRole('button',{name:'New terminal',exact:true}).click();
  await page.locator('.xterm-screen').waitFor();
  await page.evaluate(()=>(window as any).fixture.send("export RESTART_VALUE=browser_survived; printf 'BEFORE_PID=%s\\n' $$\n"));
  await page.waitForFunction(()=>/BEFORE_PID=\d+/.test((window as any).fixture.buffer()));
  const before = await page.evaluate(()=>(window as any).fixture.buffer().match(/BEFORE_PID=(\d+)/)[1]);
  const handle = (await directory())[0].processHandle;
  await page.getByRole('button',{name:'Toggle panel'}).click();
  assert.equal((await directory())[0].phase,'running');
  await browser.close(); browser = null;
  assert.equal((await directory())[0].processHandle,handle);assert.equal((await directory())[0].phase,'running');
  processes.close(); processes = new DurableHostProcessService(root);
  browser = await launch(); page = await open(true);
  await page.waitForFunction(()=>document.querySelector('[data-tab-count]')?.getAttribute('data-tab-count')==='1');
  assert.equal(await page.locator('[data-panel-open]').getAttribute('data-panel-open'),'false');
  await page.getByRole('button',{name:'Toggle panel'}).tap(); await page.locator('.xterm-screen').waitFor();
  await page.evaluate(()=>(window as any).fixture.send("printf 'AFTER_VALUE=%s PID=%s\\n' \"$RESTART_VALUE\" $$\n"));
  await page.waitForFunction(pid=>(window as any).fixture.buffer().includes('AFTER_VALUE=browser_survived PID='+pid),before);
  await page.screenshot({path:output+'/restored-mobile-terminal.png'});
  await page.getByRole('button',{name:'Close terminal',exact:true}).tap();
  await page.waitForFunction(()=>document.querySelector('[data-tab-count]')?.getAttribute('data-tab-count')==='0');
  const deadline=Date.now()+5000;while((await directory()).find((p:any)=>p.processHandle===handle)?.phase!=='exited') {assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10));}
  assert.deepEqual(errors,[]);
  await writeFile(output+'/result.json',JSON.stringify({passed:true,realBrowserRestart:true,hostAdapterReattached:true,originalShellPidRetained:true,environmentRetained:true,restoredOwner:true,restorationKeepsPanelClosed:true,explicitCloseTerminates:true,errors},null,2));
  console.log('Real browser restart and PTY continuity passed: '+output);
} finally {
  await browser?.close(); await vite.close(); for(const socket of sockets.clients)socket.terminate();
  await new Promise<void>(resolve=>sockets.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));processes.close(); await stopOwner(); await rm(root,{recursive:true,force:true}); await rm(dirname(location.endpoint),{recursive:true,force:true});
}
