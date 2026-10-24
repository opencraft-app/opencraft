import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium, type Page } from "@playwright/test";

// Real message renderers and editor; captures a submission without calling a model.
const source = `
import React,{useState,useCallback} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createComposerController} from '@opencraft/composer-core';
import {compileSubmitIntent} from '@opencraft/composer-appserver';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {WebChatDocument,WebUserMessageDocument} from '@opencraft/chat-render-web';
import {ConversationSelectionMenu} from '/apps/workbench-web/src/components/conversation/selection-menu.tsx';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
document.documentElement.dataset.uiDensity=matchMedia("(any-pointer: coarse)").matches?"touch":"compact";
const controller=createComposerController({type:'existing-thread',key:{hostId:'fixture',threadId:'one'}},{now:Date.now,createId:()=>crypto.randomUUID()});
window.fixture={controller,setThemePreference,setAppearanceThemeId};
function App(){
 const [root,setRoot]=useState(null);const [thread,setThread]=useState('one');const [revision,setRevision]=useState(0);
 window.fixture.switchThread=()=>{controller.dispatch({type:'switch-target',target:{type:'existing-thread',key:{hostId:'fixture',threadId:'two'}}});setThread('two')};
 window.fixture.stream=()=>setRevision(r=>r+1);
 const add=useCallback(text=>controller.appendQuote(text),[thread,revision]);
 return <main style={{maxWidth:720,padding:20}}>
 <div key={thread+'scroll'} ref={setRoot} style={{height:360,overflow:'auto'}}>
  <label id='sender'>Sender metadata</label>
  <section id='assistant'><WebChatDocument documentId={thread+'answer'} source={'Hello 世界 — selected answer.\\n\\nSecond paragraph /literal @nobody.\\n\\n'+(revision?'Streaming update.\\n\\n':'')+'\u0060\u0060\u0060ts\\nconst first = 1;\\nconst second = 2;\\n\u0060\u0060\u0060\\n\\nMiddle prose.\\n\\n\u0060\u0060\u0060ts\\nconst third = 3;\\n\u0060\u0060\u0060'} /></section>
  <section id='user'><WebUserMessageDocument documentId={thread+'user'} source='Original user question 中文。' /></section>
  <div style={{height:500}} />
 </div>
 <ConversationSelectionMenu key={thread+'menu'} root={root} onAddToChat={add}/>
 <OpenCraftComposer controller={controller} placeholder='Write a message' onSubmit={intent=>{window.fixture.intent=intent;window.fixture.compiled=compileSubmitIntent(intent);return false}} onCancel={()=>{}}/>
 </main>;
}
createIntlTestRoot(document.getElementById('root'),undefined,new URLSearchParams(location.search).get('locale')||'en-US').render(<App/>);
`;
const vite = await createServer({ configFile:false, root:process.cwd(), logLevel:'error',
  resolve:{dedupe:['react','react-dom']}, esbuild:{jsx:'automatic'}, server:{host:'127.0.0.1',port:0},
  plugins:[{name:'selection-fixture',resolveId:id=>id==='/selection-fixture.tsx'?id:null,
    load:id=>id==='/selection-fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{
      if(new URL(req.url??'/','http://fixture').pathname!=='/')return next();res.setHeader('content-type','text/html');
      res.end('<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/selection-fixture.tsx"></script>');
    });}}]});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const select = async (page:Page, selector:string, start=0, end?:number) => {
  await page.locator(selector).first().evaluate((element, offsets) => {
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);const nodes:Node[]=[];
    while(walker.nextNode())nodes.push(walker.currentNode);
    const range=document.createRange();let start=offsets.start;let end=offsets.end??element.textContent!.length;
    for(const node of nodes){if(start<=node.textContent!.length){range.setStart(node,start);break;}start-=node.textContent!.length;}
    for(const node of nodes){if(end<=node.textContent!.length){range.setEnd(node,end);break;}end-=node.textContent!.length;}
    const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
  },{start,end});
};
try {
  await vite.listen();
  browser=process.env.OPENCRAFT_CDP_URL ? await chromium.connectOverCDP(process.env.OPENCRAFT_CDP_URL)
    : await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=process.env.OPENCRAFT_CDP_URL ? browser.contexts()[0].pages()[0] : await browser.newPage();
  await page.setViewportSize({width:900,height:900});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const origin=`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`;
  await page.goto(origin);const editor=page.locator('.opencraft-composer-editor');await editor.waitFor();
  const action=page.getByRole('button',{name:'Add to chat',exact:true});
  await page.locator('#assistant p').first().waitFor();
  await editor.click();await page.keyboard.insertText('Existing draft');
  await page.evaluate(()=>{const c=(window as any).fixture.controller;c.dispatch({type:'add-context',reference:{id:'context',kind:'file',title:'keep.ts',uri:'file:///keep.ts'}})});
  // Real mouse drag opens the toolbar only after pointer release.
  const p=page.locator('#assistant p').first();const box=(await p.boundingBox())!;
  await page.mouse.move(box.x+1,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+100,box.y+box.height/2,{steps:8});assert.equal(await action.count(),0);
  await page.mouse.up();await action.waitFor();
  await select(page,'#assistant p',6,8);await action.waitFor();
  await page.evaluate(()=>(window as any).fixture.stream());await action.waitFor();
  await action.click();await editor.locator('blockquote').waitFor();
  assert.equal(await editor.locator('blockquote').innerText(),'世界');
  assert.ok((await editor.innerText()).startsWith('Existing draft'));
  assert.equal(await editor.evaluate(el=>el.contains(document.activeElement)),true);
  assert.equal(await page.evaluate(()=>(window as any).fixture.intent),undefined,'must not auto-submit');
  assert.equal(await page.evaluate(()=>(window as any).fixture.controller.getSnapshot().draft.context[0].id),'context');
  await page.keyboard.insertText('Reply after quote');
  assert.equal(await editor.locator('p').last().innerText(),'Reply after quote','caret must be outside the quote');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.waitForFunction(()=>(window as any).fixture.compiled!==undefined);
  const input=await page.evaluate(()=>(window as any).fixture.compiled.input);
  assert.ok(input.some((item:any)=>item.type==='text'&&item.text.includes('> 世界')),'native input must retain quote markers');
  assert.ok(input.some((item:any)=>item.type==='text'&&item.text.includes('Reply after quote')));
  // Undo an appended quote without losing the preexisting draft.
  await select(page,'#assistant p',0,5);await action.click();
  assert.equal(await editor.locator('blockquote').count(),2);
  await page.keyboard.press('Control+z');assert.equal(await editor.locator('blockquote').count(),1);
  // Exclude sender labels, composer and selections crossing different messages.
  await select(page,'#sender');await action.waitFor({state:'hidden'});
  await select(page,'.opencraft-composer-editor p');assert.equal(await action.count(),0);
  await page.evaluate(()=>{const a=document.querySelector('#assistant p')!.firstChild!;const b=document.querySelector('#user p')!.firstChild!;const r=document.createRange();r.setStart(a,0);r.setEnd(b,0);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(r)});
  await action.waitFor({state:'hidden'});
  // Partial code stays partial, with no code-header actions or full-block expansion.
  await select(page,'#assistant pre code',0,5);await action.waitFor();await action.click();
  assert.equal(await editor.locator('blockquote').last().innerText(),'const');
  // A range crossing code surfaces includes the second caption in cloneContents;
  // only its selected source belongs in the quote.
  await page.evaluate(() => {
    const codes = document.querySelectorAll('#assistant pre code');
    const first = document.createTreeWalker(codes[0]!, NodeFilter.SHOW_TEXT).nextNode()!;
    const last = document.createTreeWalker(codes[1]!, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange(); range.setStart(first, 1); range.setEnd(last, 5);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  });
  await action.waitFor(); await action.click();
  assert.equal((await editor.locator('blockquote').last().innerText()).replace(/\n+/g, '\n'),
    'onst first = 1;\nconst second = 2;\nMiddle prose.\nconst');
  // A long selection beginning above the scroll viewport must expose a reachable action.
  await page.evaluate(()=>{document.querySelector('#assistant')!.parentElement!.scrollTop=90});
  await page.waitForTimeout(50);
  await select(page,'#assistant p',0,5);await page.waitForTimeout(50);assert.equal(await action.count(),0,'wholly offscreen selections must not expose an unreachable action');
  await page.evaluate(()=>{const r=document.createRange();r.selectNodeContents(document.querySelector('#assistant .opencraft-chat-document')!);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(r)});
  await action.waitFor();await page.waitForTimeout(160);
  const longBounds=(await action.boundingBox())!;assert.ok(longBounds.y>=0&&longBounds.y+longBounds.height<=900,JSON.stringify(longBounds));
  await action.click({timeout:2000});
  assert.ok((await editor.locator('blockquote').last().innerText()).includes('const second = 2;'));
  await page.evaluate(()=>{document.querySelector('#assistant')!.parentElement!.scrollTop=0});
  await page.waitForTimeout(50);
  // User messages are also quotable; Escape, scroll and navigation dismiss.
  await select(page,'#user p');await action.waitFor();await page.keyboard.press('Escape');await action.waitFor({state:'hidden'});
  await select(page,'#user p',1);await action.waitFor();await page.evaluate(()=>document.querySelector('#user')!.parentElement!.dispatchEvent(new Event('scroll')));await action.waitFor({state:'hidden'});
  await select(page,'#user p',2);await action.waitFor();await page.evaluate(()=>(window as any).fixture.switchThread());await action.waitFor({state:'hidden'});
  assert.equal(await editor.locator('blockquote').count(),0,'must not leak a quote into another thread');
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>(window as any).fixture.setThemePreference(theme),theme);
    await select(page,'#assistant p',0,5);await action.waitFor();
    const colors=await action.evaluate(el=>({color:getComputedStyle(el).color,bg:getComputedStyle(el.parentElement!).backgroundColor}));
    assert.notEqual(colors.color,colors.bg);await page.keyboard.press('Escape');
  }
  await page.evaluate(()=>(window as any).fixture.setAppearanceThemeId('opencraft.core.lavender'));
  await mkdir('.local/selection-quote',{recursive:true});
  await select(page,'#assistant p',0,5);await action.waitFor();await page.waitForTimeout(160);await page.screenshot({path:'.local/selection-quote/desktop.png'});
  if(!process.env.OPENCRAFT_CDP_URL){
  const touch=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const mobile=await touch.newPage();await mobile.goto(origin+'?locale=zh-CN');await mobile.locator('#user p').waitFor();
  await select(mobile,'#user p');
  await mobile.waitForTimeout(100);
  assert.equal(await mobile.getByRole('button',{name:'添加到对话',exact:true}).count(),0);
  assert.equal(await mobile.evaluate(()=>window.getSelection()?.toString()),'Original user question 中文。','native selection remains available');
  assert.equal(await mobile.locator('.opencraft-composer-editor blockquote').count(),0);
  // Layout preference changes revoke an already open menu, without clearing selection.
  await page.evaluate(()=>document.documentElement.dataset.uiDensity='compact');
  await select(page,'#assistant p',0,5);await action.waitFor();
  await page.evaluate(()=>document.documentElement.dataset.uiDensity='touch');
  await action.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>window.getSelection()?.toString()),'Hello');
  await page.evaluate(()=>document.documentElement.dataset.uiDensity='compact');
  await select(page,'#assistant p',0,6);await action.waitFor();
  await mobile.screenshot({path:'.local/selection-quote/mobile.png'});await touch.close();
  }
  assert.deepEqual(errors,[]);await writeFile('.local/selection-quote/result.json',JSON.stringify({passed:true,nativeInput:input,mouseDrag:true,partialCode:true,crossCodeQuote:true,undo:true,draftPreserved:true,caretAfterQuote:true,navigationDismiss:true,touch:!process.env.OPENCRAFT_CDP_URL,themes:true,client:process.env.OPENCRAFT_CDP_URL?"electron":"web"},null,2));
  console.log('Selection → quote → edit → native submission passed; draft/context retention, undo, exact partial code, stale selection dismissal, themes verified (touch covered on Web).');
  if(!process.env.OPENCRAFT_CDP_URL)await page.close();
} finally {await browser?.close();await vite.close();}
