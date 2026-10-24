import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');
const out=process.env.OPENCRAFT_TOOLBAR_HOVER_OUTPUT??'/tmp/opencraft-toolbar-hover';
const source=`
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {AsyncNoticesProvider} from '/apps/workbench-web/src/components/async-notices.tsx';
import {ToolbarDock} from '/apps/workbench-web/src/components/toolbar-dock.tsx';
import {ToolbarDockCapacityContext} from '/apps/workbench-web/src/components/toolbar-dock-state.tsx';
import {bindTouchInteractionMode} from '/apps/workbench-web/src/runtime/pointer-modality.ts';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();bindTouchInteractionMode(document);window.setTheme=setThemePreference;
const actions=['Alpha','Beta','Gamma'].map(id=>({id,label:id,icon:<span aria-hidden='true'>•</span>,invoke(){throw Error('Unexpected invocation')}}));
createIntlTestRoot(document.getElementById('root')).render(<AsyncNoticesProvider><ToolbarDockCapacityContext.Provider value={3}><ToolbarDock scope='isolated-hover-fixture' dockId='test' actions={actions} defaultActions={['Alpha','Beta']} label='Test actions' onActionTrigger={()=>{}} returnFocus={()=>null}/></ToolbarDockCapacityContext.Provider></AsyncNoticesProvider>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},cacheDir:'node_modules/.vite-toolbar-hover',esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0},plugins:[{name:'toolbar-hover-fixture',resolveId:id=>id==='/probe.tsx'?id:null,load:id=>id==='/probe.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/probe.tsx"></script>')})}}]});
let browser:any;const results:any[]=[];
try{
 await mkdir(out,{recursive:true});await vite.listen();browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:process.env.OPENCRAFT_CHROMIUM_NO_SANDBOX==='1'?['--no-sandbox']:[]});
 for(const touch of [false,true])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width:touch?390:1100,height:844},hasTouch:touch,isMobile:touch});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));page.setDefaultTimeout(60000);page.on('console',m=>{if(m.type()==='error')console.error(m.text())});
  try{
   await page.goto(vite.resolvedUrls!.local[0]!);const trigger=page.getByRole('button',{name:'Test actions',exact:true});await trigger.waitFor();await page.evaluate(theme=>(window as any).setTheme(theme),theme);
   const press=async(el:any)=>touch?el.tap():el.click();const open=async()=>{await press(trigger);await press(page.getByRole('menuitem',{name:'Customize toolbar',exact:true}));await page.getByRole('dialog',{name:'Customize toolbar',exact:true}).waitFor()};await open();
   const dialog=page.getByRole('dialog',{name:'Customize toolbar',exact:true});const grip=dialog.getByRole('button',{name:'Drag Alpha',exact:true});const toggle=dialog.getByRole('button',{name:'Remove from toolbar: Alpha',exact:true});
   const color=async(el:any)=>el.evaluate((e:Element)=>({background:getComputedStyle(e).backgroundColor,hover:e.matches(':hover'),touch:document.documentElement.hasAttribute('data-touch-interaction'),token:getComputedStyle(e).getPropertyValue('--color-background-button-tertiary-hover'),box:e.getBoundingClientRect().toJSON(),hit:(()=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML})(),fine:matchMedia('(any-hover: hover) and (any-pointer: fine)').matches}));
   if(touch){await grip.tap();const after=await color(grip);results.push({touch,theme,after});await page.screenshot({path:out+'/touch-'+theme+'.png'});await writeFile(out+'/results.json',JSON.stringify(results,null,2));assert.equal(after.background,'rgba(0, 0, 0, 0)','Touch tap must not retain hover background');assert.equal(after.touch,true)}
   else for(const control of [grip,toggle]){
    await control.hover();await page.waitForFunction(()=>!document.getAnimations().some(a=>a.playState==='running'));await control.hover();const box=await control.boundingBox();await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await control.evaluate((e:Element)=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const mouse=await color(control);results.push({phase:'mouse',mouse});await writeFile(out+'/results.json',JSON.stringify(results,null,2));await page.screenshot({path:out+'/mouse-'+theme+'.png'});assert.notEqual(mouse.background,'rgba(0, 0, 0, 0)');assert.equal(mouse.fine,true);
    // Exercise the real document input boundary with fine-pointer media still active.
    // This is synthetic hybrid/pen input, not a claim about physical hardware.
    for(const pointerType of ['touch','pen']){await control.dispatchEvent('pointerdown',{pointerType,bubbles:true,composed:true,pointerId:7,isPrimary:true,button:0});await control.dispatchEvent('pointerup',{pointerType,bubbles:true,composed:true,pointerId:7,isPrimary:true,button:0});const after=await color(control);results.push({touch,theme,pointerType,mouse,after});await writeFile(out+'/results.json',JSON.stringify(results,null,2));assert.equal(after.background,'rgba(0, 0, 0, 0)','Touch/pen signal must suppress fine-media hover');await page.mouse.move(1,1);await control.hover();await control.evaluate((e:Element)=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.notEqual((await color(control)).background,'rgba(0, 0, 0, 0)','Mouse movement restores hover')}
   }
   assert.deepEqual(errors,[]);await page.screenshot({path:out+'/final-'+touch+'-'+theme+'.png'});
  }catch(error){await writeFile(out+'/failure.json',JSON.stringify({errors,html:await page.locator('body').innerText(),error:String(error)},null,2));throw error}finally{await context.close()}
 }
 await writeFile(out+'/passed.json',JSON.stringify({passed:true,scenes:4,results},null,2));
}finally{await browser?.close();await vite.close()}
