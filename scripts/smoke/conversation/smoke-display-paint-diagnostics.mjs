import assert from "node:assert/strict";
import {createServer} from "vite";
import {mkdtemp,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??"playwright");
const root=fileURLToPath(new URL("../../../",import.meta.url));
const output=await mkdtemp(join(tmpdir(),"display-paint-diagnostics-"));
const fixture=`
import {measureDisplayPaint,reportDisplayPaint} from '/apps/workbench-web/src/runtime/display-paint-diagnostics.ts';
import {canReportDisplayEvent,reportDisplayEvent} from '/apps/workbench-web/src/runtime/recovery-diagnostics.ts';
let host=document.getElementById('timestamps');
for(let i=0;i<20;i++){const child=document.createElement('div');host.append(child);host=child;}
for(let group=0;group<10;group++){
 const section=document.createElement('section');section.id='group-'+group;
 if(group===7)section.style.display='none';if(group===8)section.style.visibility='hidden';if(group===9)section.style.opacity='0';
 for(let i=0;i<10;i++){const row=document.createElement('div');row.className='thread-user-message';const time=document.createElement('time');time.textContent='12:00';row.append(time);section.append(row);}
 host.append(section);
}
window.counts={query:0,rect:0,style:0};
const style=window.getComputedStyle;window.getComputedStyle=function(...args){window.counts.style++;return style.apply(this,args)};
const rect=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(...args){window.counts.rect++;return rect.apply(this,args)};
const query=document.querySelectorAll;document.querySelectorAll=function(...args){window.counts.query++;return query.apply(this,args)};
// Original visibility semantics, deliberately without sharing ancestor reads.
function uncached(){const times=[...document.querySelectorAll('.thread-user-message time, [data-assistant-message-sent-time]')];const visibleTimes=times.filter(element=>{const rect=element.getBoundingClientRect();if(!rect.width||!rect.height)return false;for(let node=element;node;node=node.parentElement){const s=getComputedStyle(node);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;}return true}).length;return{renderedTimes:times.length,visibleTimes}}
function capture(fn){window.counts={query:0,rect:0,style:0};const result=fn();return{result,reads:{...window.counts}}}
window.probe={
 baseline:()=>capture(uncached),candidate:()=>capture(measureDisplayPaint),
 mutate:()=>{document.getElementById('group-9').style.opacity='1'},
 zero:()=>{document.getElementById('group-0').style.fontSize='0';for(const time of document.getElementById('group-0').querySelectorAll('time')){time.style.display='inline-block';time.style.width='0';time.style.height='0'}},
 exhaust:()=>{for(let n=0;n<64;n++)reportDisplayEvent('display-save',{messages:n,timestamps:n});return canReportDisplayEvent()},
 budgetProbe:()=>capture(()=>reportDisplayPaint({messages:100,timestamps:100,workClocks:0,authoritative:1})),
};`;
const server=await createServer({configFile:false,root,cacheDir:output+'/vite',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{
 name:'display-measurement',resolveId:id=>id==='/fixture.ts'?id:null,load:id=>id==='/fixture.ts'?fixture:null,
 configureServer(vite){vite.middlewares.use((req,res,next)=>{
  if(req.url?.split('?')[0]==='/'){res.setHeader('content-type','text/html');return res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="timestamps"></div><script type="module" src="/fixture.ts"></script>')}
  if(req.url?.startsWith('/__opencraft_apphost_diagnostic')){res.setHeader('content-type','application/json');return res.end('{}')}
  next();
 })}
}]});
let browser;const results=[];
try{
 await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 for(const touch of[false,true]){
  const page=await browser.newPage({viewport:{width:touch?390:1280,height:850},hasTouch:touch,isMobile:touch});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port,{timeout:90000});
  await page.waitForFunction(()=>window.probe!==undefined,undefined,{timeout:90000});
  const data=await page.evaluate(()=>{
   const before=window.probe.baseline(),after=window.probe.candidate();
   window.probe.mutate();const changedBefore=window.probe.baseline(),changedAfter=window.probe.candidate();
   window.probe.zero();const zeroBefore=window.probe.baseline(),zeroAfter=window.probe.candidate();
   const exhausted=window.probe.exhaust(),budget=window.probe.budgetProbe();
   return{before,after,changedBefore,changedAfter,zeroBefore,zeroAfter,exhausted,budget};
  });
  assert.deepEqual(data.after.result,{renderedTimes:100,visibleTimes:70});
  assert.deepEqual(data.before.result,data.after.result);
  assert.ok(data.after.reads.style<data.before.reads.style/4,'shared ancestor reads are eliminated');
  assert.equal(data.after.reads.rect,100);
  assert.deepEqual(data.changedBefore.result,data.changedAfter.result);
  assert.equal(data.changedAfter.result.visibleTimes,80,'a new batch rereads changed opacity');
  assert.deepEqual(data.zeroBefore.result,data.zeroAfter.result);
  assert.equal(data.zeroAfter.result.visibleTimes,70,'zero-size timestamps remain invisible');
  assert.equal(data.exhausted,false);
  assert.deepEqual(data.budget.reads,{query:0,rect:0,style:0},'exhausted diagnostic budget reads no DOM');
  assert.deepEqual(errors,[]);results.push({touch,...data,errors});await page.close();
 }
 await writeFile(join(output,'report.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({output,results}));
}finally{await browser?.close();await server.close()}
