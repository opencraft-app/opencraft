import assert from "node:assert/strict";
import { createServer } from "vite";
async function assertComposingMenuEscape(page:any, editor:any, trigger:any, menu:any) {
 await editor.fill('菜单组词草稿');await trigger.tap();await menu.waitFor();
 assert(await editor.evaluate(el=>el===document.activeElement));
 await editor.evaluate(el=>{window.compositionEditor=el;window.menuImeKeys=[];window.menuImeEvents=[];el.addEventListener('keydown',event=>{if(event.key==='Escape')window.menuImeKeys.push({composing:event.isComposing,keyCode:event.keyCode});});for(const type of ['compositionstart','compositionend'])el.addEventListener(type,()=>window.menuImeEvents.push(type));});
 const cdp=await page.context().newCDPSession(page);
 try {
  await cdp.send('Input.imeSetComposition',{text:'候选',selectionStart:2,selectionEnd:2});
  const composing=await editor.innerText();assert.equal(composing,'菜单组词草稿候选');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await menu.getAttribute('data-state'),'open','composing Escape retains the auxiliary menu');
  assert.equal(await editor.innerText(),composing);assert(await editor.evaluate(el=>el===window.compositionEditor&&el===document.activeElement));
  assert(await page.evaluate(()=>window.menuImeKeys.some(e=>e.composing)));
  await cdp.send('Input.insertText',{text:'已确认'});assert.equal(await editor.innerText(),'菜单组词草稿已确认');
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:229,nativeVirtualKeyCode:229});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:229,nativeVirtualKeyCode:229});
  assert.equal(await menu.getAttribute('data-state'),'open','compatibility IME keyCode229 retains the menu');
  assert(await page.evaluate(()=>window.menuImeKeys.some(e=>!e.composing&&e.keyCode===229)));
  await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelectorAll('[role="menu"]').length===0);
  assert(await page.evaluate(()=>window.menuImeEvents.includes('compositionstart')&&window.menuImeEvents.includes('compositionend')&&window.menuImeKeys.some(e=>!e.composing&&e.keyCode===27)));
  assert.equal(await editor.innerText(),'菜单组词草稿已确认');assert(await editor.evaluate(el=>el===window.compositionEditor&&el===document.activeElement));
 } finally {await cdp.detach();}
}
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:"error",cacheDir:"node_modules/.vite-composer-picker-focus",esbuild:{jsx:"automatic"},resolve:{dedupe:["react","react-dom"]},server:{host:"127.0.0.1",port:0},plugins:[{name:"entry-defaults",configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith("/?"))return next();res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/touch-newera.tsx"></script>')})}}]});
const playwright=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??"playwright");
const {chromium}=playwright.default??playwright;
await vite.listen();const browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:["--no-sandbox"]});
try {
 for(const newera of [true,false]) for(const mode of ["light","dark"]){
  console.log("case",newera,mode);
  const context=await browser.newContext({viewport:{width:390,height:700},hasTouch:true,isMobile:true});
  const page=await context.newPage();const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript("window.__name=value=>value");
  await page.goto(`${vite.resolvedUrls!.local[0]}?pickerFocus=1&addMenu=1&mode=${mode}`);
  await page.waitForFunction(()=>typeof(window as any).setTouch==="function");
  await page.evaluate(async newera=>{await(window as any).setTouch(true);await(window as any).setNewera(newera)},newera);
  const editor=page.locator('.opencraft-composer-editor'),model=page.locator('.opencraft-composer-mode--intelligence'),permissions=page.locator('.opencraft-composer-mode--permissions');
  const menu=page.locator('[role="menu"]');
  await editor.fill('正在编辑的草稿');
  await editor.evaluate(el=>{const sel=getSelection()!;const range=document.createRange();range.setStart(el.firstChild!.firstChild!,2);range.collapse(true);sel.removeAllRanges();sel.addRange(range);(window as any).originalEditor=el;(window as any).blurs=0;el.addEventListener('blur',()=>{(window as any).blurs++})});
  const assertEditing=async()=>{
   assert(await editor.evaluate(el=>el===document.activeElement&&el===(window as any).originalEditor));
   assert.equal(await page.evaluate(()=>(window as any).blurs),0,'no editor blur during auxiliary touch selection');
   assert.equal(await page.evaluate(()=>getSelection()?.anchorOffset),2,'native selection retained');
  };
  const touchSession=await context.newCDPSession(page);
  const add=page.locator('.opencraft-composer-footer__attachment .opencraft-composer-icon-button[aria-haspopup="menu"]');
  for(const trigger of [model,permissions,add]){
   const b=(await trigger.boundingBox())!;const p={x:b.x+b.width/2,y:b.y+b.height/2,id:1};
   await touchSession.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});await page.waitForTimeout(120);
   assert.equal(await menu.count(),0,'touch down alone cannot open a picker');await assertEditing();
   await touchSession.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});assert.equal(await menu.count(),0);
   await trigger.tap();await menu.waitFor();await assertEditing();
   await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});await assertEditing();
  }
  await model.tap();await menu.waitFor();await assertEditing();
  if(await page.locator('.opencraft-composer-model-quick__title').count())await page.locator('.opencraft-composer-model-quick__title').tap();
  await page.getByRole('menuitem',{name:'Beta',exact:false}).tap();await assertEditing();
  assert.equal(await page.evaluate(()=>(window as any).composerController.getSnapshot().draft.selections.model),'Beta');
  await page.waitForTimeout(220);
  const list=page.locator('.opencraft-composer-intelligence-models');
  const box=await list.evaluate(el=>{let node:HTMLElement|null=el as HTMLElement;while(node&&!(node.scrollHeight>node.clientHeight&&/(auto|scroll)/.test(getComputedStyle(node).overflowY)))node=node.parentElement;if(!node)throw new Error('model menu must expose its native scroll owner');(window as any).modelScrollport=node;const b=node.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height}});assert(box);
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height-20}]});
  for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height-20-i*12}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(()=>((window as any).modelScrollport?.scrollTop ?? 0)>0);
  // A tap that stops native momentum is not a completed menu activation.
  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{const node=(window as any).modelScrollport;let previous=-1,stable=0;const end=performance.now()+5000;const sample=()=>{const current=node.scrollTop;stable=current===previous?stable+1:0;previous=current;if(stable>=6)resolve();else if(performance.now()>end)reject(new Error('model menu scroll did not settle'));else requestAnimationFrame(sample)};sample()}));
  console.log("scroll passed");await assertEditing();
  await permissions.tap();await page.locator('.opencraft-composer-selection-menu--permissions').waitFor();await assertEditing();
  await page.getByRole('menuitem',{name:'只读',exact:false}).tap();await page.waitForFunction(()=>document.querySelectorAll('[role="menu"]').length===0);await assertEditing();
  // Escape and continued typing keep editing; opening does not change shell geometry.
  const shell=page.locator('.opencraft-composer-shell'),before=await shell.boundingBox();
  await model.tap();await menu.waitFor();await assertEditing();
  assert.deepEqual(await shell.boundingBox(),before);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelectorAll('[role="menu"]').length===0);await assertEditing();
  await model.tap();await menu.waitFor();await page.keyboard.type('x');await page.waitForFunction(()=>document.querySelectorAll('[role="menu"]').length===0);
  assert.equal(await editor.innerText(),'正在x编辑的草稿');
  // Explicit keyboard navigation releases the editor lease and uses native Radix items.
  await model.tap();await menu.waitFor();await page.keyboard.press('ArrowDown');
  assert(await menu.evaluate(el=>el.contains(document.activeElement)));
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelectorAll('[role="menu"]').length===0);
  await page.waitForFunction(()=>document.activeElement===document.querySelector('.opencraft-composer-mode--intelligence'));
  assert(await model.evaluate(el=>el===document.activeElement),'keyboard escape returns to trigger');
  // Keyboard/AT opens without an editor lease; no focus interception.
  await permissions.focus();await page.keyboard.press('Enter');await menu.waitFor();
  assert(await menu.evaluate(el=>el.contains(document.activeElement)));
  await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelectorAll('[role="menu"]').length===0);
  await page.waitForFunction(()=>document.activeElement===document.querySelector('.opencraft-composer-mode--permissions'));
  assert(await permissions.evaluate(el=>el===document.activeElement));
  // A touch opening from a non-editing state remains an ordinary menu.
  await model.tap();await menu.waitFor();assert(await menu.evaluate(el=>el.contains(document.activeElement)));
  await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelectorAll('[role="menu"]').length===0);
  console.log('core passed');
  for(const trigger of [model,permissions])await assertComposingMenuEscape(page,editor,trigger,menu);
  // Outside text entry may take focus and must not be stolen by delayed cleanup.
  await editor.click();await model.tap();await menu.waitFor();
  await page.getByLabel('Outside input').tap();await page.waitForFunction(()=>document.querySelectorAll('[role="menu"]').length===0);
  await page.waitForTimeout(80);assert(await page.getByLabel('Outside input').evaluate(el=>el===document.activeElement));
  // Unmount revokes pending return-to-editor behavior.
  await editor.click();await model.tap();await menu.waitFor();
  await page.evaluate(()=>(window as any).setComposerVisible(false));await page.waitForFunction(()=>document.querySelectorAll('[role="menu"]').length===0);
  await page.getByLabel('Outside input').tap();await page.waitForTimeout(80);
  assert(await page.getByLabel('Outside input').evaluate(el=>el===document.activeElement));
  assert.deepEqual(errors,[]);await context.close();
 }
 const context=await browser.newContext({viewport:{width:1280,height:800}});
 const page=await context.newPage();await page.addInitScript("window.__name=value=>value");
 await page.goto(`${vite.resolvedUrls!.local[0]}?pickerFocus=1`);
 const editor=page.locator('.opencraft-composer-editor'),menu=page.locator('[role="menu"]');
 await editor.fill('桌面草稿');
 for(const selector of ['.opencraft-composer-mode--intelligence','.opencraft-composer-mode--permissions']){
  await editor.click();await page.locator(selector).click();await menu.waitFor();
  assert(await menu.evaluate(el=>el.contains(document.activeElement)),'mouse uses normal Radix focus');
  await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelectorAll('[role="menu"]').length===0);
  await page.waitForFunction(selector=>document.activeElement===document.querySelector(selector),selector);
  assert(await page.locator(selector).evaluate(el=>el===document.activeElement));
 }
 assert.equal(await editor.innerText(),'桌面草稿');await context.close();
 console.log('PASS: touch Newera on/off × light/dark; model/permissions selection, switching, no blur, native selection/draft, stable layout, typing, keyboard/AT entry, native composing/compatibility Escape ownership and ordinary Escape');
}finally{await browser.close();await vite.close()}
