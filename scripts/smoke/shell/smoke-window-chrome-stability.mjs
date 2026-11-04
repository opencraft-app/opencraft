import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const output=await mkdtemp(join(tmpdir(),'window-chrome-stability-'));
const root=process.cwd();
const source=`import React,{useLayoutEffect} from 'react';import{createRoot}from'react-dom/client';
import{useWindowChrome}from'/apps/workbench-web/src/window-chrome.ts';
window.commits=0;const params=new URLSearchParams(location.search);document.documentElement.dataset.opencraftWindowType='browser';document.documentElement.dataset.opencraftOs='linux';
if(params.has('overlay')){const overlay=Object.assign(new EventTarget(),{visible:true,left:88,right:18,getTitlebarAreaRect(){return new DOMRect(this.left,0,window.innerWidth-this.left-this.right,28)}});Object.defineProperty(navigator,'windowControlsOverlay',{value:overlay});window.overlay=overlay;}
function Consumer(){const snapshot=useWindowChrome();useLayoutEffect(()=>{window.snapshot=snapshot;window.commits++});return <main style={{width:'100%',height:200}}><input aria-label='draft' defaultValue='unfinished input'/><output>{JSON.stringify(snapshot)}</output></main>};const root=createRoot(document.getElementById('root'));root.render(<Consumer/>);window.unmount=()=>root.unmount();`;
const vite=await createServer({configFile:false,root,logLevel:'error',cacheDir:'node_modules/.vite-window-chrome-stability',resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'probe',enforce:'pre',resolveId:id=>id==='/fixture.tsx'?id:null,load(id){if(id==='/fixture.tsx')return source;},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}input{width:80%}</style><div id="root"></div><script type="module" src="/fixture.tsx"></script>')})}}]});
let browser;const results=[];
try{await vite.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
for(const touch of [false,true])for(const overlay of [false,true]){
 const page=await browser.newPage({viewport:{width:touch?390:1280,height:720},hasTouch:touch,isMobile:touch});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript('window.__name=x=>x');
 await page.goto('http://127.0.0.1:'+vite.httpServer.address().port+'/?'+(overlay?'overlay=1':''));await page.waitForFunction(()=>window.snapshot);const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await frames();
 const input=page.getByRole('textbox',{name:'draft'});await input.focus();await input.evaluate(el=>el.setSelectionRange(2,8));
 const before=await page.evaluate(()=>({commits:window.commits,snapshot:window.snapshot,width:document.querySelector('main').getBoundingClientRect().width}));const widths=[];
 for(let n=0;n<20;n++){await page.setViewportSize({width:(touch?390:1280)+(n%2?2:12),height:720-(n%3)*20});await frames();widths.push(await page.locator('main').evaluate(el=>el.getBoundingClientRect().width));}
 const after=await page.evaluate(()=>({commits:window.commits,snapshot:window.snapshot,input:document.querySelector('input').value,focused:document.activeElement===document.querySelector('input'),selection:[document.querySelector('input').selectionStart,document.querySelector('input').selectionEnd]}));
 assert.deepEqual(after.snapshot,before.snapshot);assert.equal(after.input,'unfinished input');assert.equal(after.focused,true);assert.deepEqual(after.selection,[2,8]);assert.ok(new Set(widths).size>1,'layout still follows actual viewport width');
 const resizeCommits=after.commits-before.commits;assert.equal(resizeCommits,0,'unchanged chrome cannot republish on viewport resize');
 const cases=[];const change=async(update,expected)=>{await page.evaluate(update);await frames();const value=await page.evaluate(()=>window.snapshot);assert.deepEqual(value,expected);cases.push(value);};
 if(overlay){await change(()=>{window.overlay.left=120;window.overlay.dispatchEvent(new Event('geometrychange'))},{kind:'browser',platform:'linux',safeArea:{left:120,right:18}});await change(()=>{window.overlay.visible=false;window.overlay.dispatchEvent(new Event('geometrychange'))},{kind:'browser',platform:'linux',safeArea:{left:0,right:0}});}
 await change(()=>{document.documentElement.dataset.opencraftWindowType='electron';document.documentElement.dataset.opencraftOs='darwin'},{kind:'electron',platform:'darwin',safeArea:{left:78,right:0}});
 await change(()=>{document.documentElement.dataset.opencraftWindowFullscreen='true'},{kind:'electron',platform:'darwin',safeArea:{left:0,right:0}});
 await change(()=>{const d=document.documentElement.dataset;d.opencraftWindowFullscreen='false';d.opencraftSafeHeaderLeft='32';d.opencraftSafeHeaderRight='14'},{kind:'electron',platform:'darwin',safeArea:{left:32,right:14}});
 await change(()=>{document.documentElement.dataset.opencraftOs='win32'},{kind:'electron',platform:'win32',safeArea:{left:32,right:14}});
 const stableBefore=await page.evaluate(()=>window.commits);for(let i=0;i<10;i++){await page.evaluate(()=>window.dispatchEvent(new Event('resize')));await frames();}const stableCommits=await page.evaluate(()=>window.commits)-stableBefore;assert.equal(stableCommits,0);
 await page.evaluate(()=>window.unmount());await page.setViewportSize({width:500,height:500});await frames();assert.deepEqual(errors,[]);
 results.push({touch,overlay,resizeCommits,stableCommits,layoutWidths:[...new Set(widths)],focusAndSelectionPreserved:true,hostTransitions:cases,unmount:true,errors});console.log(JSON.stringify(results.at(-1)));await page.close();
}
await writeFile(output+'/report.json',JSON.stringify(results,null,2));
}finally{await browser?.close();await vite.close();}
