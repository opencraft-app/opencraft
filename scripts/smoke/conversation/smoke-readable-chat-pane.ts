import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {createServer} from "vite";
const output=process.env.OPENCRAFT_PANE_ARTIFACT_DIR??"/tmp/opencraft-readable-pane";
const source=`
import React,{useState,useSyncExternalStore} from 'react';
import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {Context} from '@deepseek-ai/cordis';
import {WorkbenchPanelService} from '@opencraft/workbench-panels';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {AppShellHeader} from '/apps/workbench-web/src/components/app-shell-header.tsx';
import {RightPanel} from '/apps/workbench-web/src/components/right-panel.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();const ctx=new Context();await ctx.plugin(WorkbenchPanelService);const panels=ctx.workbenchPanels;
panels.register({kind:'terminal',createTab:({id})=>({id,resource:id,kind:'terminal',region:'right',title:'Terminal '+id,icon:'terminal',closable:true,preview:false})});
for(let i=0;i<12;i++)panels.open('scope','terminal',{id:String(i)});
const subscribe=f=>panels.subscribeOwner('scope',f),get=()=>panels.getOwnerSnapshot('scope');
const navigation={layout:'unified',actions:[{id:'chat',title:'Chat',icon:'chat',onInvoke:()=>{}}],settingsActive:false,onOpenSettings:()=>{},account:{snapshot:{phase:'anonymous',name:null,avatarUrl:null},onOpen:()=>{},onRefresh:async()=>{},onSignOut:async()=>{}}};
panels.dispatch('scope',{type:'set-region-open',region:'right',open:false});
function App(){const state=useSyncExternalStore(subscribe,get);const [sidebar,setSidebar]=useState(false);window.fixture={panels,setThemePreference};
const action={id:'terminal',region:'right',icon:'terminal',label:'New terminal',creationLabel:'Terminal',run:()=>panels.open('scope','terminal',{id:crypto.randomUUID()})};
return <AppShell layoutScope='toolbar-ownership' mainContentLayout='default' navigation={navigation} sidebarOpen={sidebar} sidebarWidth={275} onSidebarCollapse={()=>setSidebar(false)} onSidebarExpand={()=>setSidebar(true)} onSidebarResizeEnd={()=>{}} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}}
header={<AppShellHeader title='Conversation' project={null} sidebarOpen={sidebar} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onToggleSidebar={()=>setSidebar(!sidebar)} onToggleRightPanel={()=>panels.dispatch('scope',{type:'set-region-open',region:'right',open:!state.right.open})} onHome={()=>{}} canGoBack={false} canGoForward={false} onBack={()=>{}} onForward={()=>{}} navigationActions={['sidebar-toggle']}/>}
floatingSidebarHeader={()=>null} leftPanel={<p>Navigation</p>}
rightPanel={<RightPanel state={state} presentationId='view' renderers={[]} toolbarActions={[action]} toolbarActionContext={{ownerId:'scope',resourceOwnerId:'scope',hostId:'fixture',cwd:null}} onAction={a=>panels.dispatch('scope',a)} onCloseTab={t=>panels.close('scope',t.region,t.id)}/>}
rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onRightPanelOpenChange={open=>panels.dispatch('scope',{type:'set-region-open',region:'right',open})}><div data-chat-scroll style={{overflowY:'auto',height:'100%'}}><input aria-label='Draft' defaultValue='Keep draft'/><p data-chat-paragraph>Keep chat text readable while tools open. 保持聊天内容的可读宽度，不把正常段落挤成每行两个字。</p>{Array.from({length:45},(_,i)=><p key={i} data-chat-anchor={i===10?true:undefined}>Message {i}: persistent scroll and draft.</p>)}</div></AppShell>}
createRoot(document.getElementById('root')).render(<App/>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},cacheDir:'node_modules/.vite-readable-pane',optimizeDeps:{entries:[],include:['react','react-dom/client','react-intl','@radix-ui/react-dialog','@radix-ui/react-dropdown-menu','@radix-ui/react-tooltip','sonner','motion/react']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'readable-pane-fixture',resolveId:id=>id==='/pane-fixture.tsx'?id:null,load:id=>id==='/pane-fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/pane-fixture.tsx"></script>');});}}]});
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');
let browser:any;const evidence:any[]=[];const resizeEvidence:any[]=[];
try {
 await mkdir(output,{recursive:true});await vite.listen();
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const reducedMotion of ['no-preference','reduce'] as const)for(const theme of ['light','dark']) {
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,reducedMotion});
  const page=await context.newPage();page.setDefaultTimeout(30000);
  const errors:string[]=[];page.on('pageerror',(e:Error)=>{errors.push(e.message);console.error(e.stack)});page.on('console',m=>{if(m.type()==='error')console.error(m.text())});
  await page.addInitScript('window.__name=value=>value');
  await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port,{timeout:60000});
  await page.getByLabel('Draft').waitFor();
  await page.evaluate(theme=>(window as any).fixture.setThemePreference(theme),theme);
  for(const width of [320,390,430,640,800,1280,1600]) {
   await page.setViewportSize({width,height:844});
   await page.evaluate(()=>{const p=(window as any).fixture.panels;if(p.getOwnerSnapshot('scope').rightPanelFullWidth)p.dispatch('scope',{type:'toggle-right-full-width'});p.dispatch('scope',{type:'set-region-open',region:'right',open:false});});
   await page.waitForTimeout(600);
   await page.getByLabel('Draft').fill('Preserved draft '+width);
   await page.locator('[data-chat-scroll]').evaluate((e:HTMLElement)=>e.scrollTop=180);
   const baseline=await page.evaluate(()=>{const viewport=document.querySelector('.main-content-viewport')!,frame=document.querySelector('.main-content-frame')!;(window as any).originalEditor=document.querySelector('input[aria-label="Draft"]');(window as any).originalFrame=frame;return {width:frame.getBoundingClientRect().width,scroll:document.querySelector('[data-chat-scroll]')!.scrollTop,viewport:viewport.getBoundingClientRect().width,anchor:document.querySelector('[data-chat-anchor]')!.getBoundingClientRect().top-document.querySelector('[data-chat-scroll]')!.getBoundingClientRect().top};});
   const sample=async(label:string,operation:()=>Promise<unknown>)=>{
    await page.evaluate(()=>{const host=window as any;host.samples=[];host.recording=true;const read=()=>{const v=document.querySelector('.main-content-viewport')!.getBoundingClientRect(),f=document.querySelector('.main-content-frame')!.getBoundingClientRect();host.samples.push({viewport:v.width,frame:f.width,x:f.x-v.x,right:f.right-v.right});if(host.recording)requestAnimationFrame(read);};read();});
    await operation();await page.waitForTimeout(650);
    const samples=await page.evaluate(()=>{(window as any).recording=false;return (window as any).samples;});
    for(const entry of samples){assert.ok(entry.frame>=Math.min(baseline.width,480)-1,JSON.stringify({label,width,entry,baseline}));assert.ok(Math.abs(entry.right)<2,JSON.stringify({label,width,entry}));if(width<=480)assert.ok(Math.abs(entry.frame-baseline.width)<1,'mobile text layout never narrows');}
    assert.equal(await page.evaluate(()=>document.querySelector('input[aria-label="Draft"]')===(window as any).originalEditor&&document.querySelector('.main-content-frame')===(window as any).originalFrame),true,'same editor and frame DOM');
    assert.equal(await page.getByLabel('Draft').inputValue(),'Preserved draft '+width);
    assert.ok(Math.abs(await page.locator('[data-chat-anchor]').evaluate(e=>e.getBoundingClientRect().top-document.querySelector('[data-chat-scroll]')!.getBoundingClientRect().top)-baseline.anchor)<2,JSON.stringify({width,label,baseline}));
    if(width<=480)assert.equal(await page.locator('[data-chat-scroll]').evaluate((e:HTMLElement)=>e.scrollTop),baseline.scroll,JSON.stringify({width,label,baseline}));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no document overflow');
    evidence.push({theme,reducedMotion,width,label,baseline,samples});
   };
   const toggle=page.locator('button.app-shell-header__right-panel-toggle');
   await sample('open',()=>toggle.click());
   await page.screenshot({path:output+'/'+theme+'-'+reducedMotion+'-'+width+'-open.png'});
   const maximize=page.getByRole('button',{name:'Maximize panel',exact:true});
   if(await maximize.count()){
    await sample('maximize',()=>maximize.click());
    await sample('restore',()=>page.getByRole('button',{name:'Restore panel',exact:true}).click());
    await sample('reverse',async()=>{await maximize.click();await page.waitForTimeout(70);await page.getByRole('button',{name:'Restore panel',exact:true}).click();});
    const separator=page.getByRole('separator',{name:'Resize preview panel',exact:true});
    if(width>=1280){
     assert.equal(await separator.count(),1,'desktop resize handle is present');
     // Viewport changes can leave the preference at minimum. Start inside the
     // ordinary range so narrowing and widening are both observable while held.
     const settleGeometry=()=>page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
     await separator.press('End');await settleGeometry();
     for(let step=0;step<10;step++){await separator.press('ArrowRight');await settleGeometry();}
     await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
     const box=await separator.boundingBox();assert.ok(box);
     const before=await page.locator('.main-content-frame').evaluate(e=>e.getBoundingClientRect().width);
     const startingWidth=await page.locator('.app-shell-right-panel').evaluate(e=>e.getBoundingClientRect().width);
     assert.ok(startingWidth>420&&startingWidth<width-500,'held gesture starts inside ordinary bounds');
     await page.mouse.move(box!.x+1,box!.y+140);await page.mouse.down();await page.mouse.move(box!.x+65,box!.y+140,{steps:6});await settleGeometry();
     const held=await page.locator('.main-content-frame').evaluate(e=>e.getBoundingClientRect().width);
     assert.ok(held>before+30,'ordinary resize reflows before release');
     await page.mouse.move(box!.x-39,box!.y+140,{steps:8});await settleGeometry();
     const reversed=await page.locator('.main-content-frame').evaluate(e=>e.getBoundingClientRect().width);
     assert.ok(reversed<before-20,'reversing the held gesture reflows before release');
     await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true})));await page.mouse.up();await settleGeometry();
     const cancelled=await page.locator('.main-content-frame').evaluate(e=>e.getBoundingClientRect().width);
     assert.ok(Math.abs(cancelled-before)<2,'cancel restores starting geometry');
     resizeEvidence.push({theme,reducedMotion,width,before,held,reversed,cancelled});
    }
   }
   await sample('close',()=>toggle.click());
   await sample('fast-open-close',async()=>{await toggle.click();await page.waitForTimeout(70);await toggle.click();});
   const restored=await page.locator('.main-content-frame').boundingBox();assert.ok(restored&&Math.abs(restored.width-baseline.width)<1);
  }
  assert.deepEqual(errors,[]);await context.close();
 }
 await writeFile(output+'/result.json',JSON.stringify(evidence));
 await writeFile(output+'/held-resize.json',JSON.stringify(resizeEvidence));
 console.log(JSON.stringify({passed:true,cases:evidence.length,heldGestures:resizeEvidence.length,frames:evidence.reduce((n,e)=>n+e.samples.length,0),output}));
}finally{await browser?.close();await vite.close();}
