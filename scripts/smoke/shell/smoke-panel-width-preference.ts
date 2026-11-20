import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const output=process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/panel-width-preference';
const source=`
import React,{useState} from 'react';
import {AppShell} from '/apps/workbench-web/src/components/app-shell';
import {AppShellHeader} from '/apps/workbench-web/src/components/app-shell-header';
import {createComposerController} from '@opencraft/composer-core';
import {createConversationKey} from '@opencraft/chat-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {createIntlTestRoot} from '/tests/fixtures/intl-root';
import {openWorkbenchUiPreferences,UiPreferencesProvider} from '/apps/workbench-web/src/runtime/ui-preferences-runtime';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const preferences=await openWorkbenchUiPreferences();
const noop=()=>{};
const controller=createComposerController({type:'existing-thread',key:createConversationKey('width-proof-host','draft')},{now:Date.now,createId:()=>crypto.randomUUID()});
function App(){const[open,setOpen]=useState(false);const[full,setFull]=useState(false);
 window.fixture={preferences,setOpen,setFull,setThemePreference,controller};
 return <AppShell layoutScope='width-proof' mainContentLayout='default' sidebarOpen={false} sidebarWidth={275} onSidebarCollapse={noop} onSidebarExpand={noop} onSidebarResizeEnd={noop}
 header={<AppShellHeader conversationHeader title='Conversation with a draft' project={null} sidebarOpen={false} rightPanelOpen={open} rightPanelFullWidth={full} onToggleSidebar={noop} onToggleRightPanel={()=>setOpen(!open)} onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={[]}/>} floatingSidebarHeader={()=>null} leftPanel={null}
 rightPanelOpen={open} rightPanelFullWidth={full} onRightPanelOpenChange={setOpen} rightPanelKeepMounted
 rightPanel={<article style={{padding:24}}><h2>REPORT.md</h2><p>Resource preview</p><button onClick={()=>setOpen(false)}>Close tools</button></article>}
 windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}}><div style={{height:'100%',minWidth:0,display:'flex',flexDirection:'column'}}><div style={{flex:1,padding:16}}>Keep composing while resizing the report.</div><div className='thread-composer-region'><OpenCraftComposer controller={controller} isStreaming={false} onSubmit={noop} onCancel={noop}/></div></div></AppShell>;
}
createIntlTestRoot(document.getElementById('root')).render(<UiPreferencesProvider runtime={preferences}><App/></UiPreferencesProvider>);
`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},cacheDir:'node_modules/.vite-panel-width',esbuild:{jsx:'automatic'},optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','motion/react','react-intl']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'width-proof',resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>')})}}]});
let browser;const evidence=[];
try{
 await mkdir(output,{recursive:true});await vite.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 for(const touch of [false,true]){
  const context=await browser.newContext({viewport:{width:1920,height:1200},hasTouch:touch});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript('window.__name=v=>v');page.setDefaultTimeout(15000);
  const start=async()=>{await page.goto(vite.resolvedUrls!.local[0]!,{waitUntil:'commit'});await page.locator('.opencraft-composer-editor').waitFor({timeout:90000});await page.locator('.opencraft-composer-editor').fill('Keep this draft');await page.evaluate(async touch=>{const f=(window as any).fixture;await f.preferences.set('interface.touchFriendly',touch?'on':'off');f.setThemePreference(touch?'dark':'light');},touch);};
  const click=async(l:any)=>touch?l.tap():l.click();
  const width=()=>page.locator('.app-shell-right-panel').evaluate(e=>e.getBoundingClientRect().width);
  const stored=()=>page.evaluate(()=>(window as any).fixture.preferences.get('shell.rightPanelWidth').ratio);
  const settled=async()=>{await page.waitForTimeout(550)};
  await start();await click(page.getByRole('button',{name:'Open preview panel'}));await settled();assert.ok(Math.abs(await width()-640)<2,'wide default remains 640px');assert.equal(await stored(),null);
  const handle=page.getByRole('separator',{name:'Resize preview panel'});
  // Mouse and touch share the real divider; held resize must change live layout.
  const drag=async(cancel=false)=>{const b=await handle.boundingBox();const x=b!.x+b!.width/2,y=200;const before=await width();
   if(touch){const c=await context.newCDPSession(page);await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});await c.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-200,y,id:1}]});await page.waitForTimeout(100);assert.ok(await width()>before+150);assert.equal(await stored(),null);await c.send('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});await c.detach();}
   else {await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x-200,y,{steps:5});await page.waitForTimeout(100);assert.ok(await width()>before+150);assert.equal(await stored(),null);if(cancel)await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel')));await page.mouse.up();}await settled();};
  await drag(true);assert.equal(await stored(),null);assert.ok(Math.abs(await width()-640)<2,'wide default remains 640px');
  await drag();const explicitWidth=await width();const ratio=await stored();assert.equal(typeof ratio,'number');assert.ok(explicitWidth>800);
  await click(page.getByRole('button',{name:'Close tools'}));await click(page.getByRole('button',{name:'Open preview panel'}));await settled();assert.ok(Math.abs(await width()-explicitWidth)<2);
  await start();await click(page.getByRole('button',{name:'Open preview panel'}));await settled();assert.equal(await stored(),ratio);assert.ok(Math.abs(await width()-explicitWidth)<2);
  await page.setViewportSize({width:390,height:844});await settled();assert.equal(await stored(),ratio);await page.setViewportSize({width:1920,height:1200});await settled();assert.ok(Math.abs(await width()-explicitWidth)<2);
  // A magnetic close is visibility intent, not a new preferred split.
  const closeBox=await handle.boundingBox();const closeX=closeBox!.x+closeBox!.width/2;
  await page.mouse.move(closeX,200);await page.mouse.down();await page.mouse.move(closeX+explicitWidth-100,200,{steps:10});await page.mouse.up();await settled();assert.equal(await stored(),ratio);
  await click(page.getByRole('button',{name:'Open preview panel'}));await settled();assert.ok(Math.abs(await width()-explicitWidth)<2);
  await page.evaluate(()=>(window as any).fixture.setFull(true));await settled();assert.equal(await stored(),ratio);await page.evaluate(()=>(window as any).fixture.setFull(false));await settled();
  await handle.dblclick();await settled();assert.equal(await stored(),null);assert.ok(Math.abs(await width()-640)<2,'wide default remains 640px');await handle.focus();await page.keyboard.press('ArrowLeft');await settled();assert.equal(typeof await stored(),'number');await handle.dblclick();await settled();
  assert.equal(await page.locator('.opencraft-composer-editor').textContent(),'Keep this draft');
  // Use an ordinary desktop window: a larger right pane must leave exactly the
  // requested 352px chat reserve, rather than silently stopping at 480px.
  await page.setViewportSize({width:1280,height:900});await settled();
  const main=page.locator('.main-content-viewport');
  const mainWidth=()=>main.evaluate(e=>e.getBoundingClientRect().width);
  const assertMinimum=async()=>{
   assert.ok(Math.abs(await mainWidth()-352)<2,'main chat reaches 352px');
   assert.ok(await width()>=320,'right tool retains its 320px minimum');
   const frameWidth=await page.locator('.main-content-frame').evaluate(e=>e.getBoundingClientRect().width);
   assert.ok(Math.abs(frameWidth-352)<2,'actual chat frame follows the 352px viewport');
   const outside=await main.evaluate(e=>{
    const pane=e.getBoundingClientRect();
    return [...e.querySelectorAll<HTMLElement>('.opencraft-composer-editor,.thread-composer-region button')]
     .filter(control=>{const b=control.getBoundingClientRect();return b.width>0&&b.height>0&&getComputedStyle(control).visibility!=='hidden'&&(b.left<pane.left-1||b.right>pane.right+1);})
     .map(control=>control.getAttribute('aria-label')||control.className);
   });
   assert.deepEqual(outside,[],'real composer input and actions fit the 352px chat');
  };
  const editor=page.locator('.opencraft-composer-editor');
  const rememberDraft=async()=>{
   await editor.focus();
   await editor.evaluate(e=>{
    const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);const text=walker.nextNode();
    if(!text)throw new Error('Expected real composer draft text');
    const selection=getSelection()!;selection.setBaseAndExtent(text,2,text,9);
    (window as any).draftProof={editor:e,anchor:text,focus:text,anchorOffset:2,focusOffset:9};
   });
  };
  const assertDraft=async(focused=true)=>{
   assert.deepEqual(await editor.evaluate((e,focused)=>{
    const proof=(window as any).draftProof,selection=getSelection();
    return {sameNode:e===proof.editor,text:e.textContent,focused:!focused||e.contains(document.activeElement),
     selection:selection?.anchorNode===proof.anchor&&selection?.focusNode===proof.focus&&selection?.anchorOffset===proof.anchorOffset&&selection?.focusOffset===proof.focusOffset};
   },focused),{sameNode:true,text:'Keep this draft',focused:true,selection:true});
  };
  await handle.focus();await page.keyboard.press('End');await settled();await assertMinimum();
  const keyboardMaximum=await width();
  assert.ok(Math.abs(Number(await handle.getAttribute('aria-valuemax'))-keyboardMaximum)<2,'separator exposes the same maximum');
  await page.screenshot({path:output+'/'+(touch?'touch-dark':'pointer-light')+'-352-split-keyboard.png'});
  await handle.press('Home');await settled();assert.ok(Math.abs(await width()-320)<2,'Home preserves the right minimum');
  // Real pointer/touch input, with live samples in both directions and at the
  // limit. The editor must keep its DOM, focus and noncollapsed selection.
  await rememberDraft();const beforeLimitRatio=await stored();
  const box=(await handle.boundingBox())!;const x=box.x+box.width/2,y=200;
  const session=touch?await context.newCDPSession(page):null;
  const move=async(targetX:number)=>{
   if(session)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:targetX,y,id:1}]});
   else await page.mouse.move(targetX,y,{steps:5});
   await page.waitForTimeout(100);
   assert.equal(await stored(),beforeLimitRatio,'held resize does not commit preferences');
   await assertDraft();
  };
  if(session)await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
  else {await page.mouse.move(x,y);await page.mouse.down();}
  await page.waitForTimeout(50);
  await move(x-150);assert.ok(await width()>450,'held divider changes live layout');
  await move(x-60);assert.ok(await width()<400,'held reverse drag follows the pointer');
  await move(0);await assertMinimum();
  await page.screenshot({path:output+'/'+(touch?'touch-dark':'pointer-light')+'-352-split-held.png'});
  if(session){await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await session.detach();}
  else await page.mouse.up();
  await settled();await assertMinimum();await assertDraft();
  const minimumRatio=await stored();assert.equal(typeof minimumRatio,'number');
  // Resize without touching the editor. This tests continuity across the
  // compact boundary; a later explicit keyboard focus on the divider is user intent.
  await page.evaluate(()=>(window as any).fixture.setOpen(false));await settled();
  await rememberDraft();
  await page.setViewportSize({width:352,height:844});await settled();
  assert.equal(await stored(),minimumRatio);await assertDraft();
  const narrowBounds=await editor.evaluate(e=>{
   const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,documentWidth:document.documentElement.scrollWidth,viewport:innerWidth};
  });
  await page.screenshot({path:output+'/'+(touch?'touch-dark':'pointer-light')+'-352-standalone.png'});
  assert.ok(narrowBounds.width>0&&narrowBounds.left>=-1&&narrowBounds.right<=353,'real composer fits the 352px standalone window');
  assert.ok(narrowBounds.documentWidth<=353,'352px standalone window has no document overflow');
  await page.setViewportSize({width:1280,height:900});await settled();await assertDraft();
  await page.evaluate(()=>(window as any).fixture.setOpen(true));await settled();await assertMinimum();await assertDraft();
  await start();await click(page.getByRole('button',{name:'Open preview panel'}));await settled();
  assert.equal(await stored(),minimumRatio);await assertMinimum();
  await page.setViewportSize({width:1920,height:1200});await settled();
  await handle.dblclick();await settled();assert.equal(await stored(),null);assert.ok(Math.abs(await width()-640)<2,'reset still uses wide 640px default');
  assert.deepEqual(errors,[]);await page.screenshot({path:output+'/'+(touch?'touch-dark':'pointer-light')+'.png'});evidence.push({touch,explicitWidth,defaultWidth:await width(),persistedRatio:ratio,keyboardMaximum,minimumRatio,narrowBounds,errors});await context.close();
 }
 await writeFile(output+'/evidence.json',JSON.stringify(evidence,null,2));console.log('PASS 352px split and standalone, real header/composer continuity, pointer/touch/keyboard limits, 640px default and resize persistence',evidence);
}finally{await browser?.close();await vite.close()}
