import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { once } from 'node:events';
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";
import { RemoteBrowserService } from "../../remote-browser-service.mjs";
import { packageBrowserRuntime } from "../../package-browser-runtime.mjs";

const root = resolve('.');
const temporary = await mkdtemp(join(tmpdir(), 'opencraft-remote-browser-smoke-'));
const web = join(temporary, 'web'); await mkdir(web);
const runtimeRoot = join(temporary, 'browser-runtime');
await packageBrowserRuntime(join(runtimeRoot, 'runtime/browser'));
const service = new RemoteBrowserService({ root: runtimeRoot, dataDirectory: temporary });
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
import {WebBrowserDynamicToolHost} from ${JSON.stringify(join(root, 'apps/workbench-web/src/browser/web-browser-tool-host.ts'))};
import {createConversationBindingStore} from '@opencraft/workbench-runtime';
import {createConversationKey} from '@opencraft/chat-core';
void(async()=>{
const storage=await RemoteBrowserStorage.create();
const surfaces=new RemoteBrowserSurfaceHost(storage,'opencraft.remote-browser-storage.v1'); surfaces.setRoot(document.getElementById('root'));
const pages=new WebBrowserPageRuntime(surfaces,null,()=>null,storage);
const presentations=new BrowserPresentationCoordinator(pages,surfaces);
const bindings=createConversationBindingStore();bindings.bind('scope',createConversationKey('host','thread'));
const panels={open:()=>({id:'panel'}),close(){},dispatch(){},ensureOwner(){}};
const workbench=new BrowserWorkbenchCoordinator(pages,panels,bindings,storage);
const tool=new WebBrowserDynamicToolHost(pages,workbench);
const context={hostId:'host',threadId:'thread',turnId:'turn',callId:'call'};
const previous=workbench.listForOwner('scope')[0];
const tab=previous?{tabId:previous.tab.id}:tool.open(context,{url:location.origin+'/demo.html',visible:false});
const page=workbench.getTabSnapshot(tab.tabId).pageId;
const slot=document.createElement('div'); slot.style.position='fixed';slot.style.pointerEvents='none'; document.body.append(slot); let presentation;
pages.prepareSurface(page);
window.poc={storage,surfaces,pages,presentations,tool,context,tab,page,async use(args){return tool.browserUse(context,{...args,tab_id:tab.tabId});},show(width=1280,height=720){slot.style.width=width+'px';slot.style.height=height+'px';if(!presentation)presentation=presentations.present({pageId:page,tabId:tab.tabId,viewId:'proof',surface:'right-panel',slot,viewportMode:{type:'responsive'}});else presentation.measure();},showMode(mode){this.show();presentation.updateViewportMode(mode);},hide(){presentation?.dispose();presentation=null;},async detach(){presentation?.dispose();presentations.dispose();workbench.dispose();pages.dispose();surfaces.dispose();await storage.flush();storage.dispose();}};
})();
`;
await build({ stdin: { contents: source, resolveDir: root, sourcefile: 'remote-browser-fixture.ts', loader: 'ts' }, outfile: join(web, 'smoke.js'), bundle: true, format: 'iife', platform: 'browser', target: 'chrome130' });
await writeFile(join(web, 'index.html'), '<!doctype html><style>html,body{margin:0}#root{position:fixed;inset:0}.web-browser-surface{position:absolute}</style><div id="root"></div><script src="/smoke.js"></script>');
await writeFile(join(web, 'demo.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote browser proof</title><style>input,button{font-size:24px}body{font:24px sans-serif;margin:30px}pre{white-space:pre-wrap;overflow-wrap:anywhere}#result{margin-top:20px}</style><label>Name <input aria-label="Name" id="name"></label><button onclick="document.querySelector(\'#result\').textContent=\'Hello \'+document.querySelector(\'#name\').value">Submit</button><input type="password" aria-label="Password" value="never-export-this"><div id="result">Ready</div><div id="geometry"></div><script>const update=()=>document.querySelector("#geometry").textContent="Viewport "+innerWidth+"x"+innerHeight+" DPR "+devicePixelRatio;addEventListener("resize",update);update()</script><pre id="device"></pre><button style="position:fixed;left:10px;top:180px" ontouchstart="this.textContent=\'Touched\'">Untouched</button><script>function reportDevice(){let ua=navigator.userAgent;let profile=ua.includes("iPhone")?"iphone":ua.includes("iPad")?"ipad":ua.includes("Android")?(ua.includes("Mobile")?"android-phone":"android-tablet"):"desktop";const target=document.querySelector("#device"),text="Device "+profile+" "+innerWidth+"x"+innerHeight+" DPR"+devicePixelRatio+" touch"+navigator.maxTouchPoints+" coarse:"+matchMedia("(pointer:coarse)").matches+" orientation:"+screen.orientation.type+" hint:"+navigator.userAgentData?.mobile;if(target.textContent!==text)target.textContent=text}addEventListener("resize",reportDevice);setInterval(reportDevice,100);reportDevice()</script>' );
await writeFile(join(web, 'version.json'), '{}');
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
    await freshCall('automation',{method:'wait',input:{text:'Device iphone 430x932 DPR1 touch1 coarse:true',timeoutMs:5000}});
    await freshCall('close');
  } finally {fresh.terminate();for(const request of pendingFresh.values())clearTimeout(request.timer);}
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, headless: true, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  const view = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
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
  await device('iphone-15-pro-max',430,932,'Device iphone 430x932 DPR1 touch1 coarse:true orientation:portrait-primary hint:true');
  const touchCanvas = await view.locator('canvas').boundingBox();
  assert(touchCanvas); const scale = touchCanvas.width / 430;
  await view.mouse.click(touchCanvas.x+30*scale,touchCanvas.y+200*scale);
  await view.evaluate(async () => (window as any).poc.use({action:'wait',text:'Touched',timeout_ms:5000}));
  await device('iphone-15-pro-max',932,430,'Device iphone 932x430 DPR1 touch1 coarse:true orientation:landscape-primary');
  await device('responsive',480,860,'Device iphone 480x860 DPR1 touch1 coarse:true','iphone');
  await device('pixel-8',412,916,'Device android-phone 412x916 DPR1 touch1 coarse:true');
  await view.evaluate(async () => (window as any).poc.use({action:'wait',text:'hint:true',timeout_ms:5000}));
  await device('ipad-air',820,1180,'Device ipad 820x1180 DPR1 touch1 coarse:true');
  await device('laptop',1024,768,'Device desktop 1024x768 DPR1 touch0 coarse:false');
  await view.evaluate(() => (window as any).poc.showMode({type:'responsive'}));
  await view.evaluate(async () => (window as any).poc.use({action:'wait',text:'Device desktop 1280x720 DPR1 touch0 coarse:false',timeout_ms:10000}));
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
  await view.evaluate(async () => (window as any).poc.use({action:'wait',text:'Device iphone 430x932 DPR1 touch1 coarse:true',timeout_ms:10000}));
  await view.evaluate(async () => { await (window as any).poc.detach(); localStorage.clear(); });
  await view.reload(); await view.waitForFunction(() => (window as any).poc);
  await view.evaluate(async () => {const p=(window as any).poc;await p.surfaces.waitUntilReady(p.page);});
  const recoveredViewport = [...service.pages.values()][0].viewport;
  assert.deepEqual(recoveredViewport, {width:430,height:932,deviceProfile:'iphone'});
  await view.evaluate(async () => (window as any).poc.use({ action: 'close' }));
  console.log(JSON.stringify({ ok: true, origin, evidence: temporary, codec: 'H264', software: true, staticFrames, frames, streamBytes, decoder: process.env.OPENCRAFT_TEST_MSE ? 'MSE' : 'WebCodecs', sandbox: 'dynamic-user', checks: ['fresh-mobile-before-navigation','cross-origin-denied','real-dynamic-tool-host','sensitive-fill-blocked','context-redacted','thread-scope-denied','H264-decoded','human-canvas-input','screenshot','server-metadata-with-empty-client-storage','application-detach-preserves-tab','reattach-without-navigation','disconnected-over-60-seconds','browser-process-restart-restores-url-config','restart-does-not-claim-heap-restore','unmeasured-viewer-preserves-remote-mobile-viewport','park-preserves-dom','visible-frame-matches-target','responsive-portrait-and-wide','DPR1-on-DPR2-viewer','resize-preserves-dom','held-drag-final-size','resized-input','mobile-ua-metrics-touch','mobile-mouse-touch-event','rotate-preserves-profile','custom-resize-preserves-profile','android-client-hints','tablet-profile','desktop-restoration','static-zero-frames','explicit-close'], errors }));
} finally { await browser?.close(); service.close(); await gateway.close(); }
