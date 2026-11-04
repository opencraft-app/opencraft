import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
const root=resolve('.');
const out=await mkdtemp(join(tmpdir(),'opencraft-native-ime-activation-evidence-'));
console.log(JSON.stringify({event:'native_ime_activation_smoke_started',evidence:out}));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const distribution=process.env.OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION;
assert(distribution,'Select a verified fork19 distribution with OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION');
const artifact={distribution,source:JSON.parse(await readFile(join(distribution,'opencraft-electron-artifact.json'),'utf8')).source};
const require=createRequire(root+'/package.json'),{build}=require('esbuild'),{chromium}=require('playwright');
const{RemoteBrowserService}=await import(root+'/scripts/remote-browser-service.mjs');
const{createWorkbenchWebServer}=await import(root+'/scripts/serve-workbench-web.mjs');
const{packageBrowserRuntime}=await import(root+'/scripts/package-browser-runtime.mjs');
const temporary=await mkdtemp(join(tmpdir(),'oc-owned-oopif-client-'));
const web=join(temporary,'web'),runtimeRoot=join(temporary,'runtime-root');await mkdir(web);
process.env.OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION=artifact.distribution;
await packageBrowserRuntime(join(runtimeRoot,'runtime/browser'));

const service=new RemoteBrowserService({root:runtimeRoot,dataDirectory:temporary});
const baseline=[]; // Only this fixture's derived units are ever stopped.
const unitsFor=async()=>{let slots=['legacy'];try{slots=JSON.parse(await readFile(join(service.dataDirectory,'owner-pool.json'),'utf8')).slots}catch{}return slots.map(slot=>'opencraft-browser-'+createHash('sha256').update(slot==='legacy'?service.dataDirectory:join(service.dataDirectory,'owners',slot)).digest('hex').slice(0,16)+'-owner-v1.service')};
await writeFile(out+'/ownership.json',JSON.stringify({temporary,runtimeRoot,dataDirectory:service.dataDirectory,units:await unitsFor(),baseline,artifact},null,2));
let frames=0,bytes=0;const rendererGone=[],nativeErrors=[],clientErrors=[],reports=[],steps=[];
let holdIme=true,heldIme;const receive=service.receive.bind(service);service.receive=message=>{if(holdIme&&message.type==='ime-state'){heldIme=message;return}if(message.type==='frame'){frames++;bytes+=Buffer.from(message.bytes,'base64').length}if(message.type==='renderer-gone')rendererGone.push(message);if(message.error)nativeErrors.push({code:message.error.code,message:message.error.message});return receive(message)};
const fixture=createServer((request,response)=>{
 response.setHeader('Access-Control-Allow-Origin','*');response.setHeader('Cache-Control','no-store');
 if(request.url==='/report'&&request.method==='POST'){
  let text='';request.on('data',chunk=>{text+=chunk;if(text.length>32768)request.destroy()});request.on('end',()=>{try{reports.push(JSON.parse(text))}catch{}response.end('ok')});return;
 }
 if(request.url!=='/child'){response.writeHead(404);response.end();return}
 const reportUrl='http://127.0.0.1:'+fixture.address().port+'/report';response.setHeader('Content-Type','text/html; charset=utf-8');
 response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5"><style>body{margin:0;min-height:3000px;background:repeating-linear-gradient(#d6ffe0 0 99px,#88a 100px 101px)}input{position:absolute;left:20px;width:260px;height:40px;font-size:20px}#field{top:20px}#secure{top:80px}</style><input id="field"><input id="secure" type="password"><button style="position:absolute;left:340px;top:20px;width:200px;height:40px" onclick="field.oninput=()=>secure.focus()">Advance on input</button><script>const heap=crypto.randomUUID();let serial=0;function report(event){fetch(${JSON.stringify(reportUrl)},{method:'POST',body:JSON.stringify({serial:++serial,heap,event,value:field.value,secureLength:secure.value.length,active:document.activeElement.id,scrollY,scale:visualViewport?.scale})}).catch(()=>{})}for(const type of ['touchstart','touchend','mousedown','mouseup','input','focus','blur'])addEventListener(type,e=>report({type,target:e.target.id,trusted:e.isTrusted,x:e.touches?.[0]?.clientX??e.clientX,y:e.touches?.[0]?.clientY??e.clientY}),true);addEventListener('scroll',()=>report({type:'scroll'}));report({type:'loaded'});</script>`);
});await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const childUrl='http://localhost:'+fixture.address().port+'/child';
await writeFile(join(web,'demo.html'),`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5"><style>body{margin:0;background:white}iframe{position:absolute;left:20px;top:140px;width:600px;height:300px;border:0}#main{position:absolute;left:20px;top:20px;width:300px;height:40px;font-size:20px}</style><input id="main" value="根页面保留"><iframe src="${childUrl}"></iframe>`);
const smoke=await readFile(root+'/scripts/smoke/browser/smoke-remote-browser.ts','utf8');const begin=smoke.indexOf('const source = `');const body=smoke.slice(begin+'const source = '.length,smoke.indexOf('\nawait build(',begin)).trim().replace(/;$/,'');
const client=Function('root','join','return '+body)(root,join).replace("viewportMode:{type:'responsive'}","viewportMode:{type:'device',presetId:'custom',deviceProfile:'desktop-touch',width:720,height:540}");
await build({stdin:{contents:client,resolveDir:root,loader:'ts'},outfile:join(web,'smoke.js'),bundle:true,format:'iife',platform:'browser',target:'chrome130'});
await writeFile(join(web,'index.html'),'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}#root{position:fixed;inset:0}.web-browser-surface{position:absolute}</style><div id="root"></div><script src="/smoke.js"></script>');await writeFile(join(web,'version.json'),'{}');
const gateway=await createWorkbenchWebServer({root:web,loopbackOnly:true,remoteBrowserService:service});const address=await gateway.listen({host:'127.0.0.1',port:0});const origin='http://127.0.0.1:'+address.port;
let browser,a,b,context,cdp,success=false;
const until=async(read,accept,label)=>{const end=Date.now()+15000;while(Date.now()<end){const value=await read();if(accept(value))return value;await sleep(50)}throw Error(label)};
async function state(view){return view.evaluate(()=>{const p=poc.surfaces.pages.get(poc.page),r=p.canvas.getBoundingClientRect();return{document:p.document,lease:p.lease,tab:poc.tab.tabId,width:p.width,height:p.height,editor:p.editor,keyboard:p.keyboard,nativeImeActivation:p.nativeImeActivation,activation:p.activation,opened:p.opened,disconnected:p.disconnected,pending:p.pending.size,control:poc.surfaces.controlState(poc.page),videoReady:p.video?.readyState,videoOpacity:p.video?.style.opacity,decoder:!!p.decoder,media:!!p.media,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})}
async function settle(){await a.evaluate(async()=>{const p=poc.surfaces.pages.get(poc.page);await p.inputQueue.idle()})}
async function localPoint(x,y){const s=await state(a),r=s.rect;return{x:r.x+x*r.width/s.width,y:r.y+y*r.height/s.height}}
async function touch(x,y){const point=await localPoint(x,y);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:7,...point,radiusX:2,radiusY:2,force:.7}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle()}
async function mouse(x,y){const point=await localPoint(x,y);await a.mouse.click(point.x,point.y);await settle()}
async function compose(text){await a.evaluate(text=>{const p=poc.surfaces.pages.get(poc.page),r=p.receiver;r.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));r.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:text}));r.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:text}))},text);await settle()}
try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});context=await browser.newContext({viewport:{width:800,height:700},deviceScaleFactor:2,hasTouch:true});
 async function open(mse){const v=await context.newPage();if(mse)await v.addInitScript(()=>{Object.defineProperty(window,'VideoDecoder',{value:undefined});Object.defineProperty(window,'EncodedVideoChunk',{value:undefined})});v.on('pageerror',error=>clientErrors.push(error.message));await v.goto(origin);await v.waitForFunction(()=>window.poc);await v.evaluate(async()=>{await poc.surfaces.waitUntilReady(poc.page);poc.show(720,540)});return v}
 a=await open(false);await a.evaluate(async()=>{const p=poc.surfaces.pages.get(poc.page);await poc.surfaces.acquireControl(p,'human')});cdp=await context.newCDPSession(a);
 await until(()=>reports,r=>r.some(x=>x.event.type==='loaded'),'Native child fixture never loaded');
 await a.waitForFunction(()=>{const p=poc.surfaces.pages.get(poc.page);return p.width===720&&p.height===540&&poc.surfaces.acceptsPointer(p)},null,{timeout:30000});
 await writeFile(out+'/initial-client-state.json',JSON.stringify(await state(a),null,2));
 await a.screenshot({path:out+'/before-touch.png',fullPage:true});
 const heap=reports.find(x=>x.event.type==='loaded').heap;
 assert.equal((await state(a)).nativeImeActivation,true);
 await touch(100,180);assert.equal((await state(a)).editor,null,'Client hint must actually be withheld');assert((await state(a)).activation?.id);
 const first=await until(()=>reports,r=>r.some(x=>x.event.type==='touchstart'&&x.event.target==='field'),'Actual client touch never reached child');const event=first.find(x=>x.event.type==='touchstart'&&x.event.target==='field').event;assert(event.trusted);assert(Math.abs(event.x-80)<1&&Math.abs(event.y-40)<1,JSON.stringify(event));
 await compose('跨域中文');await until(()=>reports.at(-1),r=>r.value==='跨域中文','Native Chinese did not reach cross-site editor');steps.push({action:'touch-native-ime-before-first-hint',event,value:'跨域中文',localCompositionSynthetic:true});holdIme=false;if(heldIme)receive(heldIme);await until(()=>state(a),s=>s.editor&&s.keyboard?.kind==='text','Native first hint not released');
 const held=await localPoint(280,180);await a.mouse.move(held.x,held.y);await a.mouse.down();
 await compose('按住');await until(()=>reports.at(-1),r=>r.value==='跨域中文按住','Mouse-held native input waited incorrectly for release');
 await a.mouse.up();await settle();steps.push({action:'mouse-down-input-before-up',value:'跨域中文按住'});
 await a.evaluate(()=>{const r=poc.surfaces.pages.get(poc.page).receiver;for(const text of ['连续甲','连续乙']){r.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));r.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:text}))}});await settle();
 await until(()=>reports.at(-1),r=>r.value==='跨域中文按住连续甲连续乙','Rapid terminal input ordering failed');steps.push({action:'rapid-compositions',value:'跨域中文按住连续甲连续乙'});
 await mouse(100,240);await until(()=>state(a),s=>s.editor&&s.keyboard?.secure===true,'Native child password policy not observed');await compose('独立密码');await until(()=>reports.at(-1),r=>r.secureLength===4,'Native password commit failed');
 const exported=await a.evaluate(async()=>poc.tool.getTabContext(poc.context,{tab_id:poc.tab.tabId}));assert(!JSON.stringify(exported).includes('独立密码'));steps.push({action:'password-native-ime',length:4,exportRedacted:true});
 await mouse(440,180);await touch(280,180);
 await a.evaluate(()=>{const r=poc.surfaces.pages.get(poc.page).receiver;for(const text of ['跳转','新框']){r.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));r.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:text}))}});await settle();
 await until(()=>reports.at(-1),r=>r.value==='跨域中文按住连续甲连续乙跳转'&&r.secureLength===6,'Native terminal focus handoff failed');steps.push({action:'native-terminal-autoadvance',oldValue:'跨域中文按住连续甲连续乙跳转',secureLength:6});
 const wheel=await localPoint(500,350);await a.mouse.move(wheel.x,wheel.y);await a.mouse.wheel(0,160);await settle();await until(()=>reports.at(-1),r=>r.scrollY>0,'Actual client wheel did not scroll cross-site child');steps.push({action:'wheel-child',scrollY:reports.at(-1).scrollY});
 b=await open(true);await b.waitForFunction(()=>{const p=poc.surfaces.pages.get(poc.page);return p.media&&p.video?.readyState>=2&&p.video?.style.opacity==='1'},null,{timeout:30000});assert.equal((await state(a)).tab,(await state(b)).tab);assert.equal(service.pages.size,1);const document=(await state(a)).document;const msePixels=await b.evaluate(()=>{const p=poc.surfaces.pages.get(poc.page),v=p.video,c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.drawImage(v,200,200,1,1,0,0,1,1);return[...x.getImageData(0,0,1,1).data]});assert.equal(msePixels[3],255);steps.push({action:'mixed-decoders',msePixels});
 for(let i=0;i<4;i++){await a.evaluate(()=>poc.hide());await b.evaluate(()=>poc.hide());await sleep(100);await a.evaluate(()=>poc.show(720,540));await b.evaluate(()=>poc.show(720,540));await b.waitForFunction(()=>{const p=poc.surfaces.pages.get(poc.page);return p.media&&p.video?.readyState>=2&&p.video.style.opacity==='1'},null,{timeout:20000});await a.evaluate(async()=>{const p=poc.surfaces.pages.get(poc.page);await poc.surfaces.acquireControl(p,'human')});assert.equal((await state(a)).document,document)}
 assert(reports.every(r=>r.heap===heap));assert.equal(rendererGone.length,0);assert.deepEqual(clientErrors,[]);
 assert(nativeErrors.every(error=>error.code==='BROWSER_UNAVAILABLE'&&error.message==='Browser display is not ready'),'Valid input/website auto-advance must not report editing failures');
 const versions=await readFile(join(runtimeRoot,'runtime/browser/electron/opencraft-electron-artifact.json'),'utf8');assert.equal(JSON.parse(versions).source.patchCount>=19,true);
 await a.screenshot({path:out+'/webcodecs-and-oopif.png',fullPage:true});await b.screenshot({path:out+'/mse-and-oopif.png',fullPage:true});
 const before=frames;await sleep(5000);const idleFrames=frames-before;
 const closeAt=Date.now();await a.evaluate(async()=>poc.use({action:'close'}));await until(()=>service.pages.size,n=>n===0,'Explicit close did not retire native resource');await service.persistence;assert.equal(service.store.current.pages.length,0);
 success=true;await writeFile(out+'/report.json',JSON.stringify({success,steps,heap,document,frames,bytes,idleFrames,rendererGone,nativeErrors,clientErrors,closeMs:Date.now()-closeAt,durablePages:0,physicalOsIme:false,artifact,scope:'Typed source client + WS + isolated managed worker packaged with the selected verified native distribution; live product namespace not used; local CompositionEvents synthetic, physical IME unverified'},null,2));
}catch(error){await writeFile(out+'/failure.json',JSON.stringify({message:error.message,stack:error.stack,reports,steps,rendererGone,nativeErrors,clientErrors,client:a?await state(a).catch(()=>null):null},null,2));throw error}
finally{
 try{if(!success&&a)await a.evaluate(async()=>poc.use({action:'close'}))}catch{}
 await browser?.close();await gateway.close();await service.persistence;await new Promise(resolve=>fixture.close(resolve));
 const units=await unitsFor();await writeFile(out+'/cleanup-ownership.json',JSON.stringify({temporary,units,success},null,2));
 for(const unit of units){assert(!baseline.some(old=>old.unit===unit));const raw=execFileSync('systemctl',['show',unit,'--property=MainPID,BindReadOnlyPaths'],{encoding:'utf8'});const pid=Number(/MainPID=(\d+)/.exec(raw)?.[1]??0);if(pid){assert(raw.includes(temporary));execFileSync('systemctl',['stop',unit])}assert.equal(Number(execFileSync('systemctl',['show',unit,'--property=MainPID','--value'],{encoding:'utf8'}).trim()),0);const state=unit.replace('-owner-v1.service','');await rm('/var/lib/'+state,{recursive:true,force:true});await rm('/var/lib/private/'+state,{recursive:true,force:true})}
 await rm(temporary,{recursive:true,force:true});await writeFile(out+'/cleanup.json',JSON.stringify({done:true,temporary,units,success},null,2));
}
