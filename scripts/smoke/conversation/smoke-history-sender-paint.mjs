import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {IntlProvider} from 'react-intl';
import {createWebChatRenderRuntime,WebChatRenderRuntimeProvider,WebChatDocument} from '@opencraft/chat-render-web';
import {UserMessageBlock} from '/apps/workbench-web/src/components/conversation/user-message';
import '/apps/workbench-web/src/styles/app.scss';
const runtime=await createWebChatRenderRuntime();
const root=createRoot(document.getElementById('root'));
window.renderDocument=(identity,text,streaming,context={})=>flushSync(()=>root.render(<IntlProvider locale="zh-CN" messages={{}} onError={()=>{}}><WebChatRenderRuntimeProvider runtime={runtime}><div id="document-scroll" style={{height:320,overflow:'auto',width:'min(760px, 100%)'}}><WebChatDocument documentId={identity} source={text} streaming={streaming} {...context}/></div></WebChatRenderRuntimeProvider></IntlProvider>));
window.paint=[];
window.compiles=[];
const original=runtime.documents.session.bind(runtime.documents);
const seen=new WeakSet();
runtime.documents.session=(id)=>{
 const session=original(id);
 if(!seen.has(session)){
  seen.add(session);
  const compile=session.compile.bind(session);
  session.compile=(...args)=>{const start=performance.now();const prior=session.getSnapshot();const result=compile(...args);window.compiles.push({id,start,end:performance.now(),reused:prior===result.snapshot});return result;};
 }
 return session;
};
const markdown=('## Historical answer\\n\\nParagraph **emphasis** and [resource](https://example.com). 中文内容。\\n\\n- List item\\n- Another item\\n\\n').repeat(40);
window.openHistory=(identity)=>{
 window.started=performance.now();window.paint=[];window.compiles=[];
 const track=()=>{
  const sender=document.querySelector('.thread-user-message__sender');
  window.paint.push({ms:performance.now()-window.started,sender:sender?.textContent??null,visible:!!sender&&sender.getBoundingClientRect().height>0&&getComputedStyle(sender).visibility==='visible',compiled:window.compiles.length,pending:document.querySelectorAll('.opencraft-chat-document-fallback').length,documents:document.querySelectorAll('.opencraft-chat-document').length,headings:document.querySelectorAll('.opencraft-chat-document h2').length,strong:document.querySelectorAll('.opencraft-chat-document strong').length});
  if(window.paint.length<120)requestAnimationFrame(track);
 };
 requestAnimationFrame(track);
 root.render(<IntlProvider locale="zh-CN" messages={{}} onError={()=>{}}><WebChatRenderRuntimeProvider runtime={runtime}>
 <div style={{width:'min(760px, 100%)'}}>{Array.from({length:5},(_,index)=><React.Fragment key={identity+index}>
 <UserMessageBlock block={{id:identity+':user:'+index,type:'user-message',message:'Historical message '+index,messageKind:'user',content:[],steeringStatus:null,deliveryStatus:'sent',sender:{kind:'employee',loginName:identity+'-employee'},sentAtMs:null,attachments:[],sourceItemIds:[],clientId:null,referencesPriorConversation:false,reviewMode:false,pullRequestFixMode:false,autoResolveSync:false,goal:false,hookFeedback:false,commentCount:0,hasExternalAttachments:false}}/>
 <WebChatDocument documentId={identity+':answer:'+index} source={markdown}/>
 </React.Fragment>)}</div>
 </WebChatRenderRuntimeProvider></IntlProvider>);
};
`;
const server=await createServer({root:process.cwd(),configFile:false,logLevel:'error',resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic'},cacheDir:'node_modules/.vite-history-sender-paint',server:{host:'127.0.0.1',port:0},plugins:[{name:'history-sender-fixture',resolveId:id=>id==='/probe.tsx'?id:null,load:id=>id==='/probe.tsx'?source:null,configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<!doctype html><meta charset="UTF-8"><div id="root"></div><script type="module" src="/probe.tsx"></script>');});}}]});
let browser;
try{
 await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1000,height:900}});const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});page.setDefaultTimeout(20000);
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port);await page.waitForFunction(()=>typeof window.openHistory==='function');
 const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 const results=[];
 for(const id of ['first','second','first','mobile']){
  if(id==='mobile')await page.setViewportSize({width:390,height:844});
  await page.evaluate(id=>window.openHistory(id),id);
  await page.waitForFunction(id=>document.querySelector('.thread-user-message__sender')?.textContent===id+'-employee'&&document.querySelectorAll('.opencraft-chat-document-fallback').length===0,id);
  await page.waitForTimeout(80);
  const result=await page.evaluate(()=>({frames:window.paint,compiles:window.compiles.map(c=>({...c,start:c.start-window.started,end:c.end-window.started}))}));
  const first=result.frames.find(f=>f.sender===id+'-employee'&&f.visible);
  assert.ok(first,'historical sender must render');assert.equal(await page.locator('.thread-user-message__sender').count(),5);
  assert.equal(first.pending,0,'the first sender frame must not contain raw Markdown');
  assert.equal(first.documents,10,'sender and formatted documents must share the first visible frame');
  assert.equal(first.headings,200);assert.equal(first.strong,200);
  if(id==='first'&&results.length>0)assert.ok(result.compiles.every(c=>c.reused),'returning history must reuse completed snapshots');
  assert.equal(await page.locator('.opencraft-chat-document').count(),10);
  assert.equal(await page.locator('.opencraft-chat-document h2').count(),200);
  if(process.env.OPENCRAFT_SMOKE_ARTIFACT_DIR&&(id==='mobile'||results.length===0))await page.screenshot({path:process.env.OPENCRAFT_SMOKE_ARTIFACT_DIR+'/'+id+'.png'});
  results.push({id,firstSenderFrame:first,compileMs:result.compiles.reduce((sum,c)=>sum+c.end-c.start,0),lastCompileEndMs:result.compiles.at(-1)?.end});
 }

 // Streaming, completion and source edits stay formatted in the same commit. Rapid replacement must not revive old names.
 const immediateCompletion=await page.evaluate(()=>{
  window.renderDocument('immediate','**live**',true);
  const streamingPending=document.querySelectorAll('.opencraft-chat-document-fallback').length;
  window.renderDocument('immediate','**completed**',false);
  return {streamingPending,completionPending:document.querySelectorAll('.opencraft-chat-document-fallback').length,text:document.querySelector('.opencraft-chat-document strong')?.textContent};
 });
 assert.deepEqual(immediateCompletion,{streamingPending:0,completionPending:0,text:'completed'});
 await page.evaluate(()=>window.renderDocument('live','**live**',true));
 await page.waitForFunction(()=>document.querySelector('.opencraft-chat-document strong')?.textContent==='live');
 assert.equal(await page.locator('.opencraft-chat-document-fallback').count(),0);
 await page.evaluate(()=>window.renderDocument('live','**completed**',false));
 await page.waitForFunction(()=>document.querySelector('.opencraft-chat-document strong')?.textContent==='completed');
 assert.equal(await page.locator('.opencraft-chat-document-fallback').count(),0);
 await page.evaluate(()=>window.renderDocument('live','**edited**',false));
 await page.waitForFunction(()=>document.querySelector('.opencraft-chat-document strong')?.textContent==='edited');
 assert.equal(await page.locator('.opencraft-chat-document-fallback').count(),0);

 await page.evaluate(()=>window.renderDocument('identity-a','**first identity**',false));
 await page.waitForFunction(()=>document.querySelector('.opencraft-chat-document strong')?.textContent==='first identity');
 const replaced=await page.evaluate(()=>{
  window.renderDocument('identity-b','**second identity**',false);
  const second=document.querySelector('.opencraft-chat-document strong')?.textContent;
  window.renderDocument('identity-a','**updated first identity**',false);
  return {second,returned:document.querySelector('.opencraft-chat-document strong')?.textContent,pending:document.querySelectorAll('.opencraft-chat-document-fallback').length};
 });
 assert.equal(replaced.second,'second identity');
 assert.equal(replaced.returned,'updated first identity');assert.equal(replaced.pending,0);
 await page.waitForFunction(()=>document.querySelector('.opencraft-chat-document strong')?.textContent==='updated first identity');
 // Reusing a syntax/snapshot must still consume fresh resource context.
 const contextResult=await page.evaluate(()=>{
  const source='Read [source](src/a.ts) now. [external](https://example.com)';
  window.renderDocument('context',source,false,{cwd:'/workspace-a',hostId:'host-a'});
  const first=document.querySelector('[data-chat-resource-kind="workspace-file"]')?.getAttribute('href');
  window.renderDocument('context',source,false,{cwd:'/workspace-b',hostId:'host-b',externalResourcePolicy:'restricted'});
  return {first,second:document.querySelector('[data-chat-resource-kind="workspace-file"]')?.getAttribute('href'),externalDisabled:document.querySelector('a[data-markdown-raw-link-label="external"]')?.getAttribute('aria-disabled')};
 });
 assert.equal(contextResult.first,'file:///workspace-a/src/a.ts');
 assert.equal(contextResult.second,'file:///workspace-b/src/a.ts');
 assert.equal(contextResult.externalDisabled,'true');

 const geometry=await page.evaluate(()=>{
  const source=('## Readable history\n\n**Formatted paragraph**\n\n').repeat(60);
  window.renderDocument('scroll',source,false);
  const scroll=document.getElementById('document-scroll');scroll.scrollTop=500;
  const before={top:scroll.scrollTop,height:scroll.scrollHeight};
  window.renderDocument('scroll',source,false,{theme:'dark'});
  return {before,after:{top:scroll.scrollTop,height:scroll.scrollHeight},fades:document.querySelectorAll('.chat-stream-fade-in').length};
 });
 assert.ok(geometry.before.height>geometry.before.top+320);
 assert.deepEqual(geometry.after,geometry.before,'a reused completed document must not disturb reader geometry');
 assert.equal(geometry.fades,0,'history must not replay streaming animation');
 await page.evaluate(()=>{window.openHistory('discarded');window.openHistory('replacement');});
 await page.waitForFunction(()=>document.querySelector('.thread-user-message__sender')?.textContent==='replacement-employee'&&document.querySelectorAll('.opencraft-chat-document-fallback').length===0);
 assert.ok((await page.locator('.thread-user-message__sender').allTextContents()).every(name=>name==='replacement-employee'));
 assert.deepEqual(errors,[]);console.log(JSON.stringify({history:results,streamingAndCompletion:'passed',rapidReplacement:'passed',freshResourceContext:'passed',completedGeometry:geometry}));
}finally{await browser?.close();await server.close();}
