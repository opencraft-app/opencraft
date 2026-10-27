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
const temporary = await mkdtemp(join(tmpdir(), 'opencraft-interaction-smoke-'));
const web = join(temporary, 'web'); await mkdir(web);
const runtimeRoot = join(temporary, 'browser-runtime');
await packageBrowserRuntime(join(runtimeRoot, 'runtime/browser'));
const service = new RemoteBrowserService({ root: runtimeRoot, dataDirectory: temporary });
const request = service.request.bind(service);
service.request = async (...args) => {
  if (args[1] === 'input') await new Promise(resolve => setTimeout(resolve, 40));
  return request(...args);
};
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
await writeFile(join(web, 'motion.html'), '<!doctype html><style>body{height:5000px;background:#123;color:white;font:40px sans-serif}#motion{position:fixed}</style><div id=motion></div><script>let i=0;setInterval(()=>{document.getElementById("motion").textContent=String(++i)+" Scroll "+scrollY},40)</script>');
await writeFile(join(web, 'version.json'), '{}');
const gateway = await createWorkbenchWebServer({ root: web, loopbackOnly: true, remoteBrowserService: service });
const address = await gateway.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${address.port}`;
let browser, slow;
try {
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, headless: true, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  const view = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = []; view.on('pageerror', error => errors.push(error.message));
  await view.goto(origin); await view.waitForFunction(() => (window as any).poc);
  await view.evaluate(async () => { const p=(window as any).poc; await p.surfaces.waitUntilReady(p.page); p.show(); });
  await view.evaluate(async url => (window as any).poc.use({action:'navigate',url}),origin+'/motion.html');
  await view.waitForFunction(() => {const p=(window as any).poc,s=p.surfaces.pages.get(p.page);return s.mediaReceiver?.negotiated && s.mediaReceiver.rendered!==null;});
  await view.evaluate(() => {const p=(window as any).poc;p.surfaces.takeControl(p.page);});
  await view.waitForFunction(() => {const p=(window as any).poc,s=p.surfaces.pages.get(p.page);return p.surfaces.controlState(p.page)==='human'&&!s.awaitingFrame&&!s.resizing;});
  const wheel = await view.evaluate(async () => {
    const p=(window as any).poc,s=p.surfaces.pages.get(p.page),send=s.socket.send.bind(s.socket);
    let max=0,writes=0;
    s.socket.send=(value:string)=>{if(JSON.parse(value).method==='input'){max=Math.max(max,s.inputCredits.size);writes++;}return send(value);};
    try {
      for(let i=0;i<1000;i++)s.canvas.dispatchEvent(new WheelEvent('wheel',{clientX:40,clientY:80,deltaY:1,bubbles:true,cancelable:true}));
      if(!await s.inputQueue.idle())throw Error('Wheel queue retired');
      return {max,writes,held:s.inputCredits.size,control:p.surfaces.controlState(p.page)};
    } finally {s.socket.send=send;}
  });
  assert(wheel.max<=12&&wheel.max>0);assert(wheel.writes<10);assert.equal(wheel.held,0);assert.equal(wheel.control,'human');
  await view.evaluate(async ()=>(window as any).poc.use({action:'wait',text:'Scroll 1000',timeout_ms:5000}));
  const initial = await view.evaluate(() => {const p=(window as any).poc,s=p.surfaces.pages.get(p.page);return {lease:s.lease,rendered:s.mediaReceiver.rendered};});
  slow = new WebSocket(origin.replace('http:','ws:')+'/__opencraft_browser/stream',{origin});
  const epochs = new Map<string,number>(); let epoch='',ready=0,control=false;
  const closed = new Promise<number>(resolve => slow!.once('close',code=>resolve(code)));
  slow.on('message',(data,binary)=>{
    if(binary){assert(epoch);epochs.set(epoch,(epochs.get(epoch)??0)+1);return;}
    const message=JSON.parse(data.toString());
    if(message.type==='media-config'){
      epoch=message.epoch;epochs.set(epoch,0);ready++;
      slow!.send(JSON.stringify({id:crypto.randomUUID(),method:'mediaFeedback',input:{version:1,epoch,ready:true,received:null,rendered:null}}));
    }
    if(message.type==='result' && message.id==='capture') {assert(!message.error);control=true;}
  });
  await once(slow,'open');
  slow.send(JSON.stringify({id:'open',method:'open',input:{lease:initial.lease,multiView:true,visible:true,mediaFeedback:1,mediaStage:'rendered'}}));
  // This peer receives real H264 chunks but never acknowledges rendering.
  await new Promise<void>((resolve,reject)=>{const end=Date.now()+10000;const timer=setInterval(()=>{if([...epochs.values()].some(n=>n===12)){clearInterval(timer);resolve();}else if(Date.now()>end){clearInterval(timer);reject(new Error('No bounded twelve-frame window'));}},50);});
  slow.send(JSON.stringify({id:'capture',method:'capture'}));
  const timeout=setTimeout(()=>slow!.terminate(),15000);
  const closeCode=await closed;clearTimeout(timeout);
  assert.equal(closeCode,1013);assert(control,'control replies bypass media credits');
  assert.equal(ready,4,'three recovery attempts after initial handshake');
  assert([...epochs.values()].every(n=>n<=12),'every media generation obeys actual frame credits');
  await view.waitForFunction(previous=>{const p=(window as any).poc;return p.surfaces.pages.get(p.page).mediaReceiver.rendered!==previous;},initial.rendered);
  const screenshot=await view.screenshot({path:join(temporary,'healthy-receiver.png')});assert(screenshot.length>1000);
  assert.deepEqual(errors,[]);
  await view.evaluate(async ()=>(window as any).poc.use({action:'close'}));
  console.log(JSON.stringify({ok:true,evidence:temporary,epochs:[...epochs.values()],wheel,checks:['actual-electron-h264','actual-chromium-webcodecs-render','1000-wheel-samples-native-distance','bounded-adaptive-input-credits','twelve-frame-window','control-bypasses-media-gate','bounded-recovery-close','same-tab-healthy-viewer-continues'],frames,streamBytes}));
} finally {slow?.terminate();await browser?.close();service.close();await gateway.close();}
