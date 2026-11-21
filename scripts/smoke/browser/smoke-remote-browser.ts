import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SessionCapabilities } from '../../../packages/session-capabilities/src/index.js';
import { SessionCapabilityMcp } from '../../../packages/session-capabilities/src/mcp.js';
import { RemoteBrowserCapabilities } from '../../../apps/headless-server/src/remote-browser/capabilities.js';
import { createWorkbenchWebServer } from "../../../apps/headless-server/src/serve-workbench-web.mjs";
import { RemoteBrowserService } from "../../../apps/headless-server/src/remote-browser-service.mjs";
import { packageBrowserRuntime } from "../../package-browser-runtime.mjs";
import { connectBrowserOwner } from "../../../apps/headless-server/src/remote-browser-owner.mjs";
import { runCodexBrowserCli } from './codex-browser-cli.js';
import { runCodexBrowserAdmission } from './codex-browser-admission.js';

const root = resolve('.');
const temporary = await mkdtemp(join(tmpdir(), 'opencraft-remote-browser-smoke-'));
const web = join(temporary, 'web'); await mkdir(web);
const runtimeRoot = join(temporary, 'browser-runtime');
await packageBrowserRuntime(join(runtimeRoot, 'runtime/browser'));
let privateOwner: any;
const service = new RemoteBrowserService({ root: runtimeRoot, dataDirectory: temporary,
  ...(process.env.OPENCRAFT_SMOKE_PRIVATE_OWNER === '1' ? { ownerConnector: async () => {
    assert.equal(process.env.OPENCRAFT_SMOKE_AUTOMATION_ONLY, '1');
    if (!privateOwner) {
      const profile = join(temporary, 'owner-profile'); await mkdir(profile, { recursive: true });
      const { createBrowserOwner } = createRequire(import.meta.url)('../../../apps/headless-server/src/remote-browser/owner.cjs');
      const env = { ...process.env, OPENCRAFT_BROWSER_DATA_DIR: profile };
      for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DISPLAY', 'WAYLAND_DISPLAY']) delete env[name];
      privateOwner = await createBrowserOwner({ socketPath: join(temporary, 'owner.sock'), spawnWorker: () =>
        spawn(join(runtimeRoot, 'runtime/browser/electron/electron'), ['--ozone-platform=headless', '--ozone-override-screen-size=1920,1080',
          '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
          join(runtimeRoot, 'runtime/browser/worker.cjs')], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json' }) });
    }
    return connectBrowserOwner(join(temporary, 'owner.sock'));
  } } : {}),
});
let frames = 0, streamBytes = 0;
const receive = service.receive.bind(service);
service.receive = message => { if (message.type === 'frame') { frames++; streamBytes += Buffer.from(message.bytes, 'base64').length; } receive(message); };
// A real typed bridge, Page runtime, manager/use claims and Dynamic Tool Host.
const source = `
import {RemoteBrowserStorage} from ${JSON.stringify(join(root, 'apps/workbench-web/src/browser/remote-browser-storage.ts'))};
import {RemoteBrowserSurfaceHost} from ${JSON.stringify(join(root, 'apps/workbench-web/src/browser/remote-browser-surface-host.ts'))};
import {WebBrowserPageRuntime} from ${JSON.stringify(join(root, 'apps/workbench-web/src/browser/web-browser-runtime.ts'))};
import {BrowserPresentationCoordinator} from ${JSON.stringify(join(root, 'apps/workbench-web/src/browser/browser-presentation-coordinator.ts'))};
import {BrowserWorkbenchCoordinator} from ${JSON.stringify(join(root, 'apps/workbench-web/src/browser/browser-workbench-coordinator.ts'))};
import {subscribeBrowserMetadata} from ${JSON.stringify(join(root, 'apps/workbench-web/src/browser/browser-metadata-sync.ts'))};
import {WebBrowserDynamicToolHost} from ${JSON.stringify(join(root, 'apps/workbench-web/src/browser/web-browser-tool-host.ts'))};
import {createConversationBindingStore} from '@opencraft/workbench-runtime';
import {createConversationKey} from '@opencraft/chat-core';
import {browserMetadataKeys} from '@opencraft/workbench-runtime/browser-metadata-identity';
import {serverStorageKey} from ${JSON.stringify(join(root, 'apps/workbench-web/src/runtime/server-context.ts'))};
void(async()=>{
const storage=await RemoteBrowserStorage.create();
const surfaces=new RemoteBrowserSurfaceHost(storage,'opencraft.remote-browser-storage.v1'); surfaces.setRoot(document.getElementById('root'));
const pages=new WebBrowserPageRuntime(surfaces,null,()=>null,storage);
const presentations=new BrowserPresentationCoordinator(pages,surfaces);
const bindingKey=serverStorageKey(browserMetadataKeys.bindings);
const bindings=createConversationBindingStore({persistence:{load:()=>JSON.parse(storage.getItem(bindingKey)??'[]'),save:values=>storage.setItem(bindingKey,JSON.stringify(values))}});bindings.bind('scope',createConversationKey('host','thread'));
const panels={open:()=>({id:'panel'}),close(){},dispatch(){},ensureOwner(){}};
const workbench=new BrowserWorkbenchCoordinator(pages,panels,bindings,storage);
const releaseMetadata=subscribeBrowserMetadata(storage,bindings,surfaces,pages,workbench);
const tool=new WebBrowserDynamicToolHost(pages,workbench);
const context={hostId:'host',threadId:'thread',turnId:'turn',callId:'call'};
const previous=workbench.listForOwner('scope')[0];
const tab=previous?{tabId:previous.tab.id}:tool.open(context,{url:location.origin+'/demo.html',visible:false});
const page=workbench.getTabSnapshot(tab.tabId).pageId;
const slot=document.createElement('div'); slot.style.position='fixed';slot.style.pointerEvents='none'; document.body.append(slot); let presentation;
pages.prepareSurface(page);
window.poc={storage,surfaces,pages,workbench,presentations,tool,context,tab,page,async use(args){return tool.browserUse(context,{...args,tab_id:tab.tabId});},show(width=1280,height=720){slot.style.width=width+'px';slot.style.height=height+'px';if(!presentation)presentation=presentations.present({pageId:page,tabId:tab.tabId,viewId:'proof',surface:'right-panel',slot,viewportMode:{type:'responsive'}});else presentation.measure();},showMode(mode){this.show();presentation.updateViewportMode(mode);},hide(){presentation?.dispose();presentation=null;},async detach(){releaseMetadata();presentation?.dispose();presentations.dispose();workbench.dispose();pages.dispose();surfaces.dispose();await storage.flush();storage.dispose();}};
})();
`;
await build({ stdin: { contents: source, resolveDir: root, sourcefile: 'remote-browser-fixture.ts', loader: 'ts' }, outfile: join(web, 'smoke.js'), bundle: true, format: 'iife', platform: 'browser', target: 'chrome130' });
await writeFile(join(web, 'index.html'), '<!doctype html><style>html,body{margin:0}#root{position:fixed;inset:0}.web-browser-surface{position:absolute}</style><div id="root"></div><script src="/smoke.js"></script>');
await writeFile(join(web, 'demo.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote browser proof</title><style>input,button{font-size:24px}body{font:24px sans-serif;margin:30px}pre{white-space:pre-wrap;overflow-wrap:anywhere}#result{margin-top:20px}</style><label>Name <input aria-label="Name" id="name"></label><button onclick="document.querySelector(\'#result\').textContent=\'Hello \'+document.querySelector(\'#name\').value">Submit</button><input type="password" aria-label="Password" value="never-export-this"><div id="result">Ready</div><div id="geometry"></div><script>const update=()=>document.querySelector("#geometry").textContent="Viewport "+innerWidth+"x"+innerHeight+" DPR "+devicePixelRatio;addEventListener("resize",update);update()</script><pre id="device"></pre><div id="input-kind">Pointer none</div><script>document.addEventListener("pointerdown",event=>{document.querySelector("#input-kind").textContent="Pointer "+event.pointerType})</script><button style="position:fixed;left:10px;top:180px" ontouchstart="this.textContent=\'Touched\'">Untouched</button><script>function reportDevice(){let ua=navigator.userAgent;let profile=ua.includes("iPhone")?"iphone":ua.includes("iPad")?"ipad":ua.includes("Android")?(ua.includes("Mobile")?"android-phone":"android-tablet"):"desktop";const target=document.querySelector("#device"),text="Device "+profile+" "+innerWidth+"x"+innerHeight+" DPR"+devicePixelRatio+" touch"+navigator.maxTouchPoints+" coarse:"+matchMedia("(pointer:coarse)").matches+" orientation:"+screen.orientation.type+" hint:"+navigator.userAgentData?.mobile;if(target.textContent!==text)target.textContent=text}addEventListener("resize",reportDevice);setInterval(reportDevice,100);reportDevice()</script>' );
await writeFile(join(web, 'version.json'), '{}');
await writeFile(join(web, 'cli-navigation.html'), '<!doctype html><title>CLI navigation destination</title><h1>Codex CLI navigation destination</h1>');
const gateway = await createWorkbenchWebServer({ root: web, loopbackOnly: true, remoteBrowserService: service });
const address = await gateway.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${address.port}`;
let browser;
try {
  const forbidden = new WebSocket(origin.replace('http:', 'ws:') + '/__opencraft_browser/stream', { origin: 'https://untrusted.invalid' });
  await assert.rejects(new Promise((done, reject) => { forbidden.on('open', done); forbidden.on('error', reject); }), /403/);
  const fresh = new WebSocket(origin.replace('http:', 'ws:') + '/__opencraft_browser/stream', { origin });
  const pendingFresh = new Map<string, {resolve(value:any):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
  fresh.on('message', (data,binary) => { if(binary)return;const message=JSON.parse(data.toString());if(message.type!=='result')return;const pending=pendingFresh.get(message.id);if(!pending)return;clearTimeout(pending.timer);pendingFresh.delete(message.id);message.error?pending.reject(new Error(message.error.message)):pending.resolve(message.value); });
  await new Promise<void>((resolve,reject)=>{fresh.once('open',resolve);fresh.once('error',reject);});
  const freshCall = (method:string,input?:unknown):Promise<any> => new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>reject(new Error('Fresh mobile open timed out')),20000);pendingFresh.set(id,{resolve,reject,timer});fresh.send(JSON.stringify({id,method,input}));});
  try {
    const config=await freshCall('open',{lease:crypto.randomUUID(),viewport:{width:430,height:932,deviceProfile:'iphone'}});
    assert.equal(config.deviceProfile,'iphone');assert.equal(config.dpr,1);
    await freshCall('navigate',{url:origin+'/demo.html'});
    await freshCall('automation',{method:'wait',input:{text:'Device iphone 430x932 DPR1 touch10 coarse:true',timeoutMs:5000}});
    await freshCall('close');
  } finally {fresh.terminate();for(const request of pendingFresh.values())clearTimeout(request.timer);}
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, headless: true, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  const view = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, hasTouch: true });
  if (process.env.OPENCRAFT_TEST_MSE === '1') await view.addInitScript(() => { delete (window as any).VideoDecoder; });
  const errors: string[] = []; view.on('pageerror', error => errors.push(error.message));
  await view.goto(origin);
  await view.waitForFunction(() => (window as any).poc);
  await view.evaluate(async () => { const p = (window as any).poc; await p.surfaces.waitUntilReady(p.page); });
  const inspection = await view.evaluate(async () => (window as any).poc.use({ action: 'inspect' }));
  assert.equal(inspection.title, 'Remote browser proof');
  const name = inspection.elements.find((e: any) => e.name === 'Name');
  const password = inspection.elements.find((e: any) => e.name === 'Password');
  assert(name); assert(password);
  const sensitive = await view.evaluate(async ({ ref, revision }) => { try { await (window as any).poc.use({ action: 'fill', ref, expected_revision: revision, value: 'blocked' }); return null; } catch (e: any) { return e.code; } }, { ref: password.ref, revision: inspection.revision });
  assert.equal(sensitive, 'POLICY_BLOCKED');
  await view.evaluate(async ({ ref, revision }) => (window as any).poc.use({ action: 'fill', ref, expected_revision: revision, value: 'Agent' }), { ref: name.ref, revision: inspection.revision });
  const afterFill = await view.evaluate(async () => (window as any).poc.use({ action: 'inspect' }));
  await view.evaluate(async ({ ref, revision }) => (window as any).poc.use({ action: 'click', ref, expected_revision: revision }), { ref: afterFill.elements.find((e: any) => e.name === 'Submit').ref, revision: afterFill.revision });
  await view.evaluate(async () => (window as any).poc.use({ action: 'wait', text: 'Hello Agent' }));
  const context = await view.evaluate(async () => { const p = (window as any).poc; return p.tool.getTabContext(p.context, { tab_id: p.tab.tabId }); });
  assert(!JSON.stringify(context).includes('never-export-this'));
  const crossThread = await view.evaluate(async () => { const p = (window as any).poc; try { await p.tool.browserUse({ ...p.context, threadId: 'other' }, { action: 'inspect', tab_id: p.tab.tabId }); return null; } catch (e: any) { return e.code; } });
  assert(crossThread);
  if (process.env.OPENCRAFT_SMOKE_AUTOMATION_ONLY === '1') {
    assert.equal(await view.evaluate(() => (window as any).poc.surfaces.automation((window as any).poc.page).capabilities.backend), 'electron-cdp');
    assert.deepEqual(errors, []);
    await view.evaluate(async () => (window as any).poc.detach());
    const page = [...service.pages.values()].find((page: any) => page.live) as any;
    for (let attempt = 0; service.viewers(page).size && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(service.viewers(page).size, 0);
    const catalog = await service.catalog(page.ownerId, () => {}), link = catalog.sessions.find((entry: any) => entry.sessionId === page.id)?.link;
    assert(link?.hostId);
    const binding = { ownerId: page.ownerId, lease: JSON.parse(page.key)[1], scopeId: link.scopeId, hostId: link.hostId, authorize() {} };
    const inspect = await service.invokeAutomation(binding, 'inspect', {}) as any;
    await service.invokeAutomation(binding, 'fill', { ref: inspect.elements.find((element: any) => element.name === 'Name').ref, expectedRevision: inspect.revision, value: 'Service' });
    await service.invokeAutomation(binding, 'click', { ref: inspect.elements.find((element: any) => element.name === 'Submit').ref, expectedRevision: inspect.revision });
    await service.invokeAutomation(binding, 'wait', { text: 'Hello Service', timeoutMs: 5000 });
    const controller = new AbortController(), started = Date.now();
    const cancelled = service.invokeAutomation(binding, 'wait', { text: 'never present', timeoutMs: 60000 }, { signal: controller.signal });
    const rejected = assert.rejects(cancelled, { code: 'CDP_ABORTED', retryable: false, outcome: 'unknown' });
    const timer = setTimeout(() => controller.abort(), 100);
    try { await rejected; } finally { clearTimeout(timer); }
    await service.invokeAutomation(binding, 'inspect', {});
    assert(Date.now() - started < 5000, 'cancelled native wait must release the automation queue');
    assert.equal(service.viewers(page).size, 0); assert.equal(page.controller, null);
    const capabilities = new SessionCapabilities(), session = { serverId: 'fixture-server', threadId: 'thread', execution: { turnId: 'fixture-turn' } };
    // The execution engine is a fixture; MCP, provider, owned tab selection,
    // private transport and native Electron actions are real.
    const provider = new RemoteBrowserCapabilities(capabilities, service, async scope => {
      assert.equal(scope.serverId, session.serverId); assert.equal(scope.threadId, session.threadId);
      return { ownerId: page.ownerId, hostId: link.hostId, threadId: scope.threadId, turnId: 'fixture-turn', authorize() {} };
    });
    const capabilityGateway = new SessionCapabilityMcp(capabilities, randomBytes(32)), client = new Client({ name: 'browser-smoke', version: '1' });
    try {
      await capabilities.refresh(session); await capabilityGateway.listen(); const config = capabilityGateway.config(session) as any;
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } }));
      assert.equal((await client.listTools()).tools.length, 3);
      if (process.env.OPENCRAFT_SMOKE_CODEX_CLI === '1') {
        const runs = [];
        for (const directory of [temporary, join(temporary, 'second-client')]) {
          const cli = await runCodexBrowserCli(directory, config, origin + '/demo.html?created=codex-cli'); runs.push(cli);
          assert(service.store.current.closedTabs.some((receipt: any) => receipt.tabId === cli.tabId && receipt.status === 'closed'));
          assert(![...service.pages.values()].some((page: any) => page.link?.tabId === cli.tabId));
          const retired = service.store.current.closedTabs.find((receipt: any) => receipt.tabId === cli.tabId);
          assert(!(await service.request(undefined, 'inventory') as any[]).some(native => native.id === createHash('sha256').update(retired.key).digest('hex')));
        }
        assert.notEqual(runs[0].tabId, runs[1].tabId, 'independent CLI clients sharing one execution credential must get separate invocations');
        await writeFile(join(temporary, 'codex-browser-invocation-evidence.json'), JSON.stringify({
          sameExecutionCredential: true, independentCliClients: 2, distinctTabIds: runs.map(run => run.tabId),
          cliRuns: runs.map(run => run.evidence), nativeCloseConfirmed: true,
        }, null, 2));
        console.log('CODEX_BROWSER_CLI_NATIVE_CLOSE_CONFIRMED');
        await runCodexBrowserAdmission(temporary, service, page.ownerId, link.hostId, link.tabId, origin + '/demo.html?created=codex-admission');
      }
      const call = (args: Record<string, unknown>) => client.callTool({ name: 'opencraft_browser_browser_use', arguments: args });
      const listed = await call({ action: 'list_tabs' });
      const tabId = JSON.parse((listed.content as any[])[0].text).tabs[0].tabId;
      const inspected = await call({ action: 'inspect', tab_id: tabId }), inspectedPage = JSON.parse((inspected.content as any[])[0].text);
      assert.equal((await call({ action: 'fill', tab_id: tabId, ref: inspectedPage.elements.find((element: any) => element.name === 'Name').ref, expected_revision: inspectedPage.revision, value: 'MCP' })).isError, false);
      assert.equal((await call({ action: 'click', tab_id: tabId, ref: inspectedPage.elements.find((element: any) => element.name === 'Submit').ref, expected_revision: inspectedPage.revision })).isError, false);
      assert.equal((await call({ action: 'wait', tab_id: tabId, text: 'Hello MCP' })).isError, false);
      const image = await call({ action: 'screenshot', tab_id: tabId }), block = (image.content as any[])[0];
      assert.equal(image.isError, false); assert.equal(block.type, 'image'); assert.equal(block.mimeType, 'image/png');
      const png = Buffer.from(block.data, 'base64'); assert.equal(png.readUInt32BE(16), page.viewport.width); assert.equal(png.readUInt32BE(20), page.viewport.height);
      const read = await client.callTool({ name: 'opencraft_browser_get_tab_context', arguments: { tab_id: tabId } });
      assert(!JSON.stringify(read.content).includes('never-export-this')); assert(JSON.stringify(read.content).includes('Hello MCP'));
      await view.reload(); await view.waitForFunction(() => (window as any).poc);
      await view.evaluate(async () => {
        const p = (window as any).poc; await p.surfaces.waitUntilReady(p.page);
        const draft = document.createElement('textarea'); draft.id = 'local-draft'; draft.value = 'unsaved client draft';
        draft.style.cssText = 'position:fixed;z-index:10;left:10px;top:10px'; document.body.append(draft); draft.focus(); draft.setSelectionRange(2, 7);
      });
      const opened = await client.callTool({ name: 'opencraft_app_open_in_opencraft', arguments: { url: origin + '/demo.html?created=service', visible: false } });
      assert.equal(opened.isError, false, JSON.stringify(opened));
      const created = JSON.parse((opened.content as any[])[0].text); assert.equal(created.visible, false);
      await view.waitForFunction(({ tabId, pageId }) => {
        const p = (window as any).poc;
        return p.workbench.getTabSnapshot(tabId)?.pageId === pageId && p.workbench.getConversationTabs('host', 'thread').some((tab: any) => tab.tabId === tabId)
          && p.surfaces.existingStorageId(pageId);
      }, created);
      assert.deepEqual(await view.evaluate(() => { const input = document.querySelector('#local-draft') as HTMLTextAreaElement;
        return [document.activeElement === input, input.value, input.selectionStart, input.selectionEnd]; }), [true, 'unsaved client draft', 2, 7]);
      const createdNative = [...service.pages.values()].find((candidate: any) => candidate.link?.tabId === created.tabId) as any;
      assert(createdNative); assert.equal(service.viewers(createdNative).size, 0);
      assert.equal(await view.evaluate(pageId => (window as any).poc.surfaces.existingStorageId(pageId), created.pageId), JSON.parse(createdNative.key)[1]);
      const createdUse = (args: Record<string, unknown>) => call({ ...args, tab_id: created.tabId });
      assert.equal((await createdUse({ action: 'wait', text: 'Ready' })).isError, false);
      const createdInspect = await createdUse({ action: 'inspect' }), createdPage = JSON.parse((createdInspect.content as any[])[0].text);
      assert.equal((await createdUse({ action: 'fill', ref: createdPage.elements.find((element: any) => element.name === 'Name').ref, expected_revision: createdPage.revision, value: 'Created' })).isError, false);
      assert.equal((await createdUse({ action: 'click', ref: createdPage.elements.find((element: any) => element.name === 'Submit').ref, expected_revision: createdPage.revision })).isError, false);
      assert.equal((await createdUse({ action: 'wait', text: 'Hello Created' })).isError, false);
      assert.equal(service.viewers(createdNative).size, 0);
      const staleTabs = await view.evaluate(() => (window as any).poc.storage.getItem('opencraft.browser-tabs.v1'));
      const closed = await createdUse({ action: 'close' }); assert.equal(closed.isError, false, JSON.stringify(closed));
      assert.equal(JSON.parse((closed.content as any[])[0].text).closed, true);
      await view.waitForFunction(({ tabId, pageId }) => {
        const p = (window as any).poc;
        return p.workbench.getTabSnapshot(tabId) === null && p.pages.getSnapshot(pageId) === null && p.surfaces.existingStorageId(pageId) === null;
      }, created);
      await view.evaluate(async value => { const p = (window as any).poc; p.storage.setItem('opencraft.browser-tabs.v1', value); await p.storage.flush(); }, staleTabs);
      assert.equal(await view.evaluate(tabId => (window as any).poc.workbench.getTabSnapshot(tabId), created.tabId), null);
      assert.deepEqual(await view.evaluate(() => { const input = document.querySelector('#local-draft') as HTMLTextAreaElement;
        return [document.activeElement === input, input.value, input.selectionStart, input.selectionEnd]; }), [true, 'unsaved client draft', 2, 7]);
      assert.equal((await createdUse({ action: 'close' })).isError, false, 'closed receipt remains callable after the directory row disappears');
      assert.equal((await service.request(undefined, 'inventory') as any[]).some(native => native.id === createdNative.id), false);
      await view.evaluate(async () => (window as any).poc.detach());
      for (let attempt = 0; service.viewers(page).size && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      const accepted = async (action: string, extra: Record<string, unknown> = {}) => {
        const result = await call({ action, tab_id: tabId, ...extra });
        assert.equal(result.isError, false, JSON.stringify(result));
        const body = JSON.parse((result.content as any[])[0].text); assert.equal(body.accepted, true); assert.equal(body.completed, undefined);
      };
      const loaded = async (url: string) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const result = await call({ action: 'inspect', tab_id: tabId });
          if (!result.isError) {
            const body = JSON.parse((result.content as any[])[0].text);
            if (body.url === url && body.elements.some((element: any) => element.name === 'Name')) return body;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Native navigation did not commit the expected URL');
      };
      const firstUrl = origin + '/demo.html?step=first', secondUrl = origin + '/demo.html?step=second';
      await accepted('navigate', { url: firstUrl }); await loaded(firstUrl);
      const oldRef = await call({ action: 'fill', tab_id: tabId, ref: inspectedPage.elements.find((element: any) => element.name === 'Name').ref, expected_revision: inspectedPage.revision, value: 'stale' });
      assert.equal(oldRef.isError, true);
      await accepted('navigate', { url: secondUrl }); await loaded(secondUrl);
      await accepted('back'); await loaded(firstUrl);
      await accepted('forward'); const beforeReload = await loaded(secondUrl);
      await accepted('reload');
      // A fresh document must invalidate the old references even at the same URL.
      await loaded(secondUrl);
      const afterReload = await call({ action: 'fill', tab_id: tabId, ref: beforeReload.elements.find((element: any) => element.name === 'Name').ref, expected_revision: beforeReload.revision, value: 'stale' });
      assert.equal(afterReload.isError, true); await accepted('stop');
      if (privateOwner) {
        // Real Worker termination/restart. No viewer reconnect participates in
        // recovery; the same gateway/provider and saved logical tab survive.
        await service.persist(); const oldDocument = page.document, oldOwner = privateOwner;
        const exited = once(oldOwner.child, 'exit'); await oldOwner.close(); privateOwner = undefined; await exited;
        for (let attempt = 0; service.child && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(service.child, null);
        const recovered = await loaded(secondUrl);
        assert.notEqual(page.document, oldDocument); assert.equal(recovered.title, 'Remote browser proof');
        assert.equal(service.viewers(page).size, 0); assert.equal(service.sockets.size, 0);
        const recoveredImage = await call({ action: 'screenshot', tab_id: tabId });
        assert.equal(recoveredImage.isError, false); assert.equal((recoveredImage.content as any[])[0].type, 'image');
      }
      assert.equal(service.viewers(page).size, 0); assert.equal(page.controller, null);
      await view.reload(); await view.waitForFunction(() => (window as any).poc);
      await view.evaluate(async () => { const p = (window as any).poc; await p.surfaces.waitUntilReady(p.page); });
      assert.equal(service.viewers(page).size, 1);
      const finalClose = await call({ action: 'close', tab_id: tabId }); assert.equal(finalClose.isError, false, JSON.stringify(finalClose));
      await view.waitForFunction(tabId => (window as any).poc.workbench.getTabSnapshot(tabId) === null, tabId);
      assert.deepEqual(await service.request(undefined, 'inventory'), []);
      await view.evaluate(async () => (window as any).poc.detach());
    } finally { await client.close(); await provider.close(); await capabilityGateway.close(); }
    console.log('REMOTE_CDP_AUTOMATION_SMOKE_OK: packaged Worker, gateway, Dynamic Tool Host, provider/MCP creation and close with client synchronization/focus preservation, stale-metadata protection, native input, navigation, Worker restart recovery, PNG capture, sensitive policy, ownership and cancellation');
  } else {
  await view.evaluate(() => (window as any).poc.show());
  await view.waitForFunction(() => { const p = (window as any).poc; const canvas = p.surfaces.presentationPort(p.page).guest; const video = document.querySelector('video'); if (canvas.width !== 1280 || canvas.height !== 720) return false; if (video) return video.videoWidth === 1280 && video.videoHeight === 720 && video.readyState >= 2; const data = canvas.getContext('2d').getImageData(0, 0, 1280, 720).data; return data.some((v: number, i: number) => i % 4 !== 3 && v > 100); });
  await view.mouse.click(170, 47); await view.keyboard.press('Control+A'); await view.keyboard.type('Human'); await view.mouse.click(430, 47);
  await view.evaluate(async () => (window as any).poc.use({ action: 'wait', text: 'Hello Human' }));
  const screenshot = await view.evaluate(async () => (window as any).poc.use({ action: 'screenshot' }));
  assert(screenshot.imageUrl.startsWith('data:image/png;base64,'));
  await writeFile(join(temporary, 'target.png'), Buffer.from(screenshot.imageUrl.split(',')[1], 'base64'));

  // Tear down every local browser projection. Then clear localStorage and
  // restore using only the authenticated Server metadata and live WebContents.
  const identity = await view.evaluate(async () => { const p=(window as any).poc; await p.storage.flush(); return {page:p.page,tab:p.tab.tabId}; });
  await view.evaluate(async () => { await (window as any).poc.detach(); localStorage.clear(); });
  // Exceed the former 60-second eviction window with no presentation/socket.
  await new Promise(resolve => setTimeout(resolve, 61000));
  await view.reload(); await view.waitForFunction(() => (window as any).poc);
  assert.deepEqual(await view.evaluate(() => {const p=(window as any).poc;return {page:p.page,tab:p.tab.tabId};}),identity);
  await view.evaluate(async () => (window as any).poc.use({action:'wait',text:'Hello Human',timeout_ms:10000}));
  await view.evaluate(() => (window as any).poc.show());

  // Park retains the actual DOM but shuts off the video producer.
  await view.evaluate(() => { const p = (window as any).poc; p.hide(); });
  await view.evaluate(async () => (window as any).poc.use({ action: 'wait', text: 'Hello Human' }));
  await view.evaluate(() => (window as any).poc.show());
  await view.evaluate(async dataUrl => { const image = new Image(); image.src = dataUrl; await image.decode(); (window as any).poc.reference = image; }, screenshot.imageUrl);
  // Reject stale pre-park frames, not merely successful decoding. Compare the
  // visible human-edited text against a fresh capture of that same WebContents.
  await view.waitForFunction(() => { const p = (window as any).poc, surface = p.surfaces.presentationPort(p.page).guest;
    const displayed = document.querySelector('video') ?? surface;
    const actual = document.createElement('canvas'); actual.width = 300; actual.height = 50;
    const expected = document.createElement('canvas'); expected.width = 300; expected.height = 50;
    actual.getContext('2d')!.drawImage(displayed, 100, 20, 300, 50, 0, 0, 300, 50);
    expected.getContext('2d')!.drawImage(p.reference, 100, 20, 300, 50, 0, 0, 300, 50);
    const a = actual.getContext('2d')!.getImageData(0, 0, 300, 50).data, b = expected.getContext('2d')!.getImageData(0, 0, 300, 50).data;
    let difference = 0; for (let i = 0; i < a.length; i++) difference += Math.abs(a[i]! - b[i]!);
    return difference / a.length < 3;
  });
  // Actual layout pixels, not a scaled 720p canvas and not viewer DPR=2.
  const sizes = [[460, 820], [1024, 600], [480, 860]];
  for (const [width, height] of sizes) {
    await view.evaluate(({ width, height }) => (window as any).poc.show(width, height), { width, height });
    await view.evaluate(async ({ width, height }) => (window as any).poc.use({ action: 'wait', text: `Viewport ${width}x${height} DPR 1`, timeout_ms: 10000 }), { width, height });
    await view.waitForFunction(({ width, height }) => {
      const canvas = (window as any).poc.surfaces.presentationPort((window as any).poc.page).guest;
      const video = document.querySelector('video');
      return canvas.width === width && canvas.height === height && (video ? video.videoWidth === width && video.videoHeight === height && video.readyState >= 2 : canvas.getContext('2d').getImageData(40, 40, 1, 1).data[3] === 255);
    }, { width, height });
    await view.evaluate(async () => (window as any).poc.use({ action: 'wait', text: 'Hello Human', timeout_ms: 5000 }));
  }
  // Coalesce held drag updates while ensuring the final reverse resize lands.
  await view.evaluate(async () => { for (const width of [700, 680, 620, 580, 640, 720, 900, 800]) {
    (window as any).poc.show(width, 720); await new Promise(resolve => setTimeout(resolve, 35));
  } });
  await view.evaluate(async () => (window as any).poc.use({ action: 'wait', text: 'Viewport 800x720 DPR 1', timeout_ms: 10000 }));
  await view.waitForFunction(() => { const video = document.querySelector('video'); const canvas = (window as any).poc.surfaces.presentationPort((window as any).poc.page).guest; return video ? video.videoWidth === 800 && video.videoHeight === 720 && video.readyState >= 2 : canvas.width === 800 && canvas.height === 720; });
  await view.mouse.click(170, 47); await view.keyboard.press('Control+A'); await view.keyboard.type('Resized'); await view.mouse.click(430, 47);
  await view.evaluate(async () => (window as any).poc.use({ action: 'wait', text: 'Hello Resized', timeout_ms: 5000 }));
  // Real Chromium semantics, not just an identically sized desktop picture.
  const device = async (presetId: string, width: number, height: number, expected: string, deviceProfile?: string) => {
    await view.evaluate(mode => (window as any).poc.showMode(mode), {type:'device',presetId,width,height,...(deviceProfile?{deviceProfile}:{})});
    await view.evaluate(async text => (window as any).poc.use({action:'wait',text,timeout_ms:10000}), expected);
    await view.waitForFunction(({width,height}) => {const v=document.querySelector('video');const c=document.querySelector('canvas')!;return c.width===width&&c.height===height&&(!v||(v.videoWidth===width&&v.videoHeight===height&&v.readyState>=2));},{width:Math.round(width/2)*2,height:Math.round(height/2)*2});
    await view.evaluate(async () => (window as any).poc.use({action:'wait',text:'Hello Resized',timeout_ms:5000}));
  };
  await device('iphone-15-pro-max',430,932,'Device iphone 430x932 DPR1 touch10 coarse:true orientation:portrait-primary hint:true');
  const touchCanvas = await view.locator('canvas').boundingBox();
  assert(touchCanvas); const scale = touchCanvas.width / 430;
  const touchPoint = { x: touchCanvas.x + 30 * scale, y: touchCanvas.y + 200 * scale };
  // A mobile target does not convert an explicit physical mouse into touch.
  await view.mouse.click(touchPoint.x, touchPoint.y);
  await view.evaluate(async () => (window as any).poc.use({action:'wait',text:'Pointer mouse',timeout_ms:5000}));
  const mouseInspection = await view.evaluate(async () => (window as any).poc.use({action:'inspect'}));
  assert(mouseInspection.elements.some((element: any) => element.name === 'Untouched'), 'explicit mouse must not synthesize touchstart');
  // Exercise the viewer's real pointerType=touch path through the same canvas,
  // authenticated controller and native dispatcher, rather than a DOM event.
  await view.touchscreen.tap(touchPoint.x, touchPoint.y);
  await view.evaluate(async () => (window as any).poc.use({action:'wait',text:'Pointer touch',timeout_ms:5000}));
  await view.evaluate(async () => (window as any).poc.use({action:'wait',text:'Touched',timeout_ms:5000}));
  await view.screenshot({ path: join(temporary, 'input-kinds.png') });
  await device('iphone-15-pro-max',932,430,'Device iphone 932x430 DPR1 touch10 coarse:true orientation:landscape-primary');
  await device('responsive',480,860,'Device iphone 480x860 DPR1 touch10 coarse:true','iphone');
  await device('pixel-8',412,916,'Device android-phone 412x916 DPR1 touch10 coarse:true');
  await view.evaluate(async () => (window as any).poc.use({action:'wait',text:'hint:true',timeout_ms:5000}));
  await device('ipad-air',820,1180,'Device ipad 820x1180 DPR1 touch10 coarse:true');
  await device('laptop',1024,768,'Device desktop 1024x768 DPR1 touch0 coarse:false');
  await view.evaluate(() => (window as any).poc.showMode({type:'responsive'}));
  await view.evaluate(async () => (window as any).poc.use({action:'wait',text:'Device desktop 1280x720 DPR1 touch10 coarse:true',timeout_ms:10000}));
  await view.screenshot({ path: join(temporary, 'remote-tab.png') });
  await view.waitForTimeout(350); const before = frames; await view.waitForTimeout(1200); const staticFrames = frames - before;
  assert.equal(staticFrames, 0, 'unchanged page must not send video keepalive frames');
  assert.deepEqual(errors, []);
  // Restart only this isolated browser worker. URL/config/profile restore is
  // explicit, and the in-memory form must reset: this is not a JS heap snapshot.
  const previousConnection = await view.evaluate(() => {const p=(window as any).poc;return p.surfaces.pages.get(p.page).connection;});
  const exited = once(service.child, 'exit'); service.child.stdin.end(); await exited;
  await view.waitForFunction(previous => { const p=(window as any).poc, surface=p.surfaces.pages.get(p.page); return surface.connection>previous && surface.opened; }, previousConnection, {timeout:30000});
  await view.evaluate(async () => (window as any).poc.use({ action: 'wait', text: 'Ready', timeout_ms: 10000 }));
  // A new viewer has no measured layout yet. It must preserve the remote
  // mobile configuration rather than send its 720p desktop fallback on open.
  await view.evaluate(() => (window as any).poc.showMode({type:'device',presetId:'iphone-15-pro-max',width:430,height:932}));
  await view.evaluate(async () => (window as any).poc.use({action:'wait',text:'Device iphone 430x932 DPR1 touch10 coarse:true',timeout_ms:10000}));
  await view.evaluate(async () => { await (window as any).poc.detach(); localStorage.clear(); });
  await view.reload(); await view.waitForFunction(() => (window as any).poc);
  await view.evaluate(async () => {const p=(window as any).poc;await p.surfaces.waitUntilReady(p.page);});
  const recoveredViewport = [...service.pages.values()][0].viewport;
  assert.deepEqual(recoveredViewport, {width:430,height:932,deviceProfile:'iphone'});
  await view.evaluate(async () => (window as any).poc.use({ action: 'close' }));
  console.log(JSON.stringify({ ok: true, origin, evidence: temporary, codec: 'H264', software: true, staticFrames, frames, streamBytes, decoder: process.env.OPENCRAFT_TEST_MSE ? 'MSE' : 'WebCodecs', sandbox: 'dynamic-user', checks: ['fresh-mobile-before-navigation','cross-origin-denied','real-dynamic-tool-host','sensitive-fill-blocked','context-redacted','thread-scope-denied','H264-decoded','human-canvas-input','screenshot','server-metadata-with-empty-client-storage','application-detach-preserves-tab','reattach-without-navigation','disconnected-over-60-seconds','browser-process-restart-restores-url-config','restart-does-not-claim-heap-restore','unmeasured-viewer-preserves-remote-mobile-viewport','park-preserves-dom','visible-frame-matches-target','responsive-portrait-and-wide','DPR1-on-DPR2-viewer','resize-preserves-dom','held-drag-final-size','resized-input','mobile-ua-metrics-touch','mobile-explicit-mouse','mobile-real-touch','rotate-preserves-profile','custom-resize-preserves-profile','android-client-hints','tablet-profile','desktop-preset-restoration','responsive-hybrid-restoration','static-zero-frames','explicit-close'], errors }));
  }
} finally { await browser?.close(); service.close(); await gateway.close(); await privateOwner?.close(); }
