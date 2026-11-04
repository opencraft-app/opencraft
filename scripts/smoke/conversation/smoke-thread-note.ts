import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {ThreadNoteStore} from '../../../plugins/thread-summary/src/note-store';
import {conversationSummarySource} from '../../../tests/fixtures/conversation-summary-source';
const output=process.env.OPENCRAFT_NOTE_EVIDENCE??'/tmp/opencraft-thread-note';await mkdir(output,{recursive:true});
const dir=await mkdtemp(join(tmpdir(),'note-smoke-')),store=new ThreadNoteStore(join(dir,'notes.sqlite'));
const source=conversationSummarySource.replace("useState} from 'react'","useState,useMemo} from 'react'")
 .replace('return <WorkbenchPanelRuntimeProvider',`const note=useMemo(()=>({exchange:async(update,vector)=>{const response=await fetch('/fixture-note',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope,update,vector})});if(!response.ok)throw Error('offline');return response.json();}}),[scope]);return <WorkbenchPanelRuntimeProvider`)
 .replace("context={{scopeKey:scope,","context={{note,scopeKey:scope,")
 .replace("createIntlTestRoot(document.getElementById('root'))","createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN')")
 .replace('length:16','length:3');
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[react(),{name:'note-fixture',resolveId:id=>id==='/note-fixture.tsx'?id:null,load:id=>id==='/note-fixture.tsx'?source:null,configureServer(server){server.middlewares.use(async(req,res,next)=>{
 if(req.url==='/fixture-note'){try{let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);const result=store.exchange('fixture',input.scope,input.update,input.vector);res.setHeader('content-type','application/json');res.end(JSON.stringify(result));}catch{res.statusCode=400;res.end('{}');}return;}
 if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/note-fixture.tsx"></script>');
});}}]});
let browser:any;
try{
 await vite.listen();const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');browser=await chromium.launch({headless:true,...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE?{executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE}:{})});
 const errors:string[]=[];
 const open=async(options:any={})=>{const context=await browser.newContext({viewport:{width:1680,height:900},...options});const page=await context.newPage();page.on('pageerror',(error:Error)=>{errors.push(error.message);console.error(error.message);});await page.addInitScript(()=>{(window as any).__name=(value:unknown)=>value;});await page.goto(vite.resolvedUrls!.local[0]);await page.waitForSelector('.conversation-summary-trigger');await page.waitForSelector('.conversation-summary-layout[data-summary-mode]');if(await page.locator('.conversation-summary-layout').getAttribute('data-summary-mode')==='overlay')await page.locator('.conversation-summary-trigger').click();await page.waitForSelector('.thread-summary__note-status[data-note-status=saved]');return page;};
 const a=await open(),b=await open();const editor=(page:any)=>page.locator('.thread-summary__note-editor');
 await editor(a).fill('## 处理进展\n- [x] 已定位\n- [ ] 继续排查');await b.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('.thread-summary__note-editor')?.value.includes('已定位'));
 assert.equal(await a.locator('.thread-summary__scroll').evaluate(node=>node.firstElementChild?.className),'thread-summary__note');assert.equal(await a.locator('.thread-summary__file').count(),11);
 await a.context().setOffline(true);await editor(a).fill((await editor(a).inputValue())+'\nAlice');await editor(b).fill((await editor(b).inputValue())+'\nBob');await a.waitForSelector('[data-note-status=offline]');await a.context().setOffline(false);
 await a.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('.thread-summary__note-editor')?.value.includes('Bob'));await b.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('.thread-summary__note-editor')?.value.includes('Alice'));assert.equal(await editor(a).inputValue(),await editor(b).inputValue());
 await editor(a).focus();await editor(a).evaluate((element:HTMLTextAreaElement)=>element.setSelectionRange(2,6));const before=await editor(a).evaluate((element:HTMLTextAreaElement)=>[element.selectionStart,element.selectionEnd]);
 await editor(b).press('Control+Home');await editor(b).pressSequentially('前缀');await a.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('.thread-summary__note-editor')?.value.startsWith('前缀'));assert.deepEqual(await editor(a).evaluate((element:HTMLTextAreaElement)=>[element.selectionStart,element.selectionEnd]),before.map((x:number)=>x+2));
 await editor(b).press('Control+Home');await editor(b).press('Delete');await editor(b).press('Delete');console.log('prefix-delete',JSON.stringify(await editor(a).inputValue()),JSON.stringify(await editor(b).inputValue()));await a.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('.thread-summary__note-editor')?.value.startsWith('##'));
 await a.locator('.thread-summary__note-heading button').click();await a.waitForFunction(()=>document.querySelector('.thread-summary__note-preview')?.textContent?.includes('处理进展'));assert.match(await a.locator('.thread-summary__note-preview').innerText(),/处理进展/);await a.screenshot({path:join(output,'desktop-preview.png')});await a.locator('.thread-summary__note-heading button').click();
 await a.evaluate(()=> (window as any).fixture.setThemePreference('dark'));await a.screenshot({path:join(output,'desktop-dark.png')});
 const saved=await editor(a).inputValue();await a.reload();await a.waitForSelector('.thread-summary__note-status[data-note-status=saved]');assert.equal(await editor(a).inputValue(),saved);
 const touch=await open({viewport:{width:390,height:844},hasTouch:true,isMobile:true});await touch.locator('.thread-summary__note-heading button').tap();await touch.waitForSelector('.thread-summary__note-preview');await touch.screenshot({path:join(output,'touch-preview.png')});
 await touch.locator('.thread-summary__note-heading button').tap();await editor(touch).tap();await editor(touch).pressSequentially('触控');await touch.screenshot({path:join(output,'touch-edit.png')});
 assert.equal(await touch.locator('.conversation-summary').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);assert.deepEqual(errors,[]);await writeFile(join(output,'result.json'),JSON.stringify({convergence:true,restart:true,relativeSelection:true,markdown:true,touch:true,errors},null,2));console.log(output);
}finally{await browser?.close();await vite.close();store.close();await rm(dir,{recursive:true,force:true});}
