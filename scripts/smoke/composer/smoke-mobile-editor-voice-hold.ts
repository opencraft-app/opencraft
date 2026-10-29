import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const source=`import React from 'react';import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';import {createComposerController} from '@opencraft/composer-core';import {OpenCraftComposer} from '@opencraft/composer-editor';import {createVoiceInputAction} from '/plugins/voice-input/src/voice-input-action.tsx';import '/apps/workbench-web/src/styles/app.scss';import {openWorkbenchUiPreferences,UiPreferencesProvider} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density.ts';import {SettingsSelect,SettingsSegmented} from '@opencraft/extension-react';import {TouchDensitySetting} from '/apps/workbench-web/src/components/touch-density-setting.tsx';const preferences=await openWorkbenchUiPreferences();bindInteractionDensity(document,preferences);
const controller=createComposerController({type:'existing-thread',key:{hostId:'fixture',threadId:'one'}},{now:Date.now,createId:()=>crypto.randomUUID()});
const fixture={controller,starts:0,stops:0,cancels:0,sent:0,delayed:false,available:true,ready:()=>{}};window.fixture=fixture;
const Voice=createVoiceInputAction({id:'fake',isAvailable:()=>fixture.available,start(observer){fixture.starts++;let dead=false;const listen=()=>{if(!dead)observer.status('listening')};fixture.ready=listen;if(!fixture.delayed)queueMicrotask(listen);return {phase:'starting',stop(){fixture.stops++;queueMicrotask(()=>{if(!dead){observer.commit('Voice transcript');observer.end()}})},cancel(){dead=true;fixture.cancels++}}}});
const mutations={insertText:text=>controller.insertText(text),beginTransientTextInput:observer=>controller.beginTransientTextInput(observer),focus:()=>controller.focus()};
function App(){return <UiPreferencesProvider runtime={preferences}><div style={{padding:16}}><OpenCraftComposer controller={controller} endActions={<Voice mutations={mutations} disabled={false} platform='web'/>} placeholder='Write' onSubmit={()=>{fixture.sent++;return false}} onCancel={()=>{}}/><TouchDensitySetting/><SettingsSelect aria-label='Density select'><option>One</option></SettingsSelect><SettingsSegmented label='Density segmented' value='one' options={[{value:'one',label:'One'},{value:'two',label:'Two'}]} onValueChange={()=>{}}/><button className='settings-control-button'>Shared action</button></div></UiPreferencesProvider>};createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom']},cacheDir:'node_modules/.vite-editor-voice-hold',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},plugins:[{name:'fixture',resolveId:id=>id==='/voice.tsx'?id:null,load:id=>id==='/voice.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/voice.tsx"></script>')})}}]});await mkdir('.local/editor-voice-hold',{recursive:true});await vite.listen();const browser=await chromium.launch({executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});const evidence=[];
const contactOnly=process.argv.includes('--contact-only');
try{for(const [width,touchCapable] of (contactOnly?[[390,true]]:[[390,true],[768,true],[820,true],[1024,true],[1280,true],[1280,false]]) as readonly (readonly [number,boolean])[]){const context=await browser.newContext({viewport:{width,height:844},hasTouch:touchCapable,isMobile:width===390});const page=await context.newPage();await page.addInitScript(()=>{const state={blockPointerRelease:false,blockTouchRelease:false,blockClick:false,pointerUps:0,touchEnds:0};(window as any).releaseProbe=state;window.addEventListener('pointerup',event=>{if(state.blockPointerRelease){state.pointerUps++;event.stopImmediatePropagation();}},true);window.addEventListener('touchend',event=>{state.touchEnds++;if(state.blockTouchRelease)event.stopImmediatePropagation();},true);window.addEventListener('click',event=>{if(state.blockClick){event.preventDefault();event.stopImmediatePropagation();}},true);});await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);const editor=page.locator('.opencraft-composer-editor');await editor.waitFor();const count=()=>page.evaluate(()=>(window as any).fixture.starts);if(touchCapable){await editor.tap();await page.waitForTimeout(550);assert.equal(await count(),0,'first empty-editor tap only establishes focus');}await editor.fill('Keep draft');const initial=await editor.innerText();await editor.evaluate(e=>(window as any).keptEditor=e);const box=(await editor.boundingBox())!;const x=box.x+100,y=box.y+20;const cdp=await context.newCDPSession(page);
const touch=(type:string,tx=x,ty=y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{id:1,x:tx,y:ty}]});
if(!touchCapable){const toggle=page.getByRole('radiogroup',{name:'Touch experience'});assert.equal(await toggle.getByRole('radio',{name:'Automatic',exact:true}).getAttribute('aria-checked'),'true','Mouse-only defaults automatic');await toggle.getByRole('radio',{name:'On',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.uiDensity==='touch');assert.ok((await page.locator('.opencraft-voice-input-action').boundingBox())!.height>=44,'Manual on works without touch hardware');await page.mouse.move(x,y);await page.mouse.down();await page.waitForTimeout(550);await page.mouse.up();assert.equal(await count(),0,'Friendly density does not reinterpret mouse');await toggle.getByRole('radio',{name:'Automatic',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.uiDensity==='compact');evidence.push({width,touchCapable,autoCompact:true,manualOn:true,mouseExcluded:true});await context.close();continue;}

await touch('touchStart');await page.waitForTimeout(100);await touch('touchEnd');await page.waitForTimeout(500);assert.equal(await count(),0,'Tap stays text input');
if(width===390){
 // A focused editor must also retire from pointerup if touchend is withheld.
 await page.evaluate(()=>(window as any).releaseProbe.blockTouchRelease=true);
 await touch('touchStart');await page.waitForTimeout(75);await touch('touchEnd');await page.waitForTimeout(550);
 assert.equal(await count(),0,'focused editor tap cannot become voice when touchend is withheld');
 assert.equal(await editor.evaluate(e=>e===document.activeElement),true,'retap retains text focus');
 assert.equal(await editor.innerText(),initial,'retap retains draft');
 await page.evaluate(()=>(window as any).releaseProbe.blockTouchRelease=false);
 // Native contact end is authoritative even if its derived PointerEvent is lost.
 await page.evaluate(()=>(window as any).releaseProbe.blockPointerRelease=true);
 await touch('touchStart');await page.waitForTimeout(100);await touch('touchEnd');await page.waitForTimeout(550);
 const releases=await page.evaluate(()=>(window as any).releaseProbe);
 assert(releases.pointerUps>0&&releases.touchEnds>0,'adversarial release keeps real native touchend');
 assert.equal(await count(),0,'a completed short native contact cannot leave a voice hold armed');
 // Isolate the mic hold from its legitimate click-to-record action. A real
 // short touchend must disarm it even when pointerup delivery is withheld.
 await page.evaluate(()=>(window as any).releaseProbe.blockClick=true);
 const micContact=(await page.locator('.opencraft-voice-input-action').boundingBox())!;
 await touch('touchStart',micContact.x+micContact.width/2,micContact.y+micContact.height/2);
 await page.waitForTimeout(75);await touch('touchEnd');await page.waitForTimeout(550);
 assert.equal(await count(),0,'short mic contact cannot leave a delayed hold after native lift-off');
 await page.evaluate(()=>{(window as any).releaseProbe.blockPointerRelease=false;(window as any).releaseProbe.blockClick=false;});
 await touch('touchStart');
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x,y},{id:2,x:width-4,y:4}]});
 await page.waitForTimeout(550);await touch('touchEnd');
 assert.equal(await count(),0,'a second native contact outside the editor cancels the pending hold');
}
// Editing gestures must never compete with voice, even past the former threshold.
await editor.fill(initial);await editor.focus();await page.evaluate(()=>getSelection()?.collapseToEnd());
await touch('touchStart');await page.waitForTimeout(900);
assert.equal(await count(),0,'focused editor long press never starts voice');
await touch('touchEnd');await page.waitForTimeout(150);
assert.equal(await editor.innerText(),initial,'editor long press preserves draft');
assert.equal(await editor.evaluate(e=>e===(window as any).keptEditor),true,'editor identity is stable');
assert.equal(await page.locator('.opencraft-composer-voice-footer').count(),0,'editing does not show recording controls');
await page.keyboard.press('Escape');await page.evaluate(()=>getSelection()?.removeAllRanges());
// The explicit microphone remains usable by touch and keyboard.
const micButton=page.locator('.opencraft-voice-input-action');
await micButton.tap();await page.locator('.opencraft-composer-voice-footer[data-voice-phase=listening]').waitFor();
assert.equal(await count(),1,'microphone tap starts voice');
await page.keyboard.press('Escape');await page.locator('.opencraft-composer-voice-footer').waitFor({state:'hidden'});
assert.equal(await editor.innerText(),initial,'cancel keeps the original draft');
await micButton.focus();await page.keyboard.press('Enter');
await page.locator('.opencraft-composer-voice-footer[data-voice-phase=listening]').waitFor();
assert.equal(await count(),2,'keyboard activation starts voice');
await page.getByRole('button',{name:'Stop and insert text',exact:true}).click();
await page.locator('.opencraft-composer-voice-footer').waitFor({state:'hidden'});
assert.ok((await editor.innerText()).includes(initial),'completion preserves existing draft');
assert.ok((await editor.innerText()).includes('Voice transcript'),'explicit stop inserts transcript');
assert.equal(await page.evaluate(()=>(window as any).fixture.sent),0,'completion does not implicitly send');
await page.screenshot({path:'.local/editor-voice-hold/'+width+'.png'});
if(!process.argv.includes('--editor-only')){
 const beforeHold=await count();const mic=(await micButton.boundingBox())!;
 await touch('touchStart',mic.x+mic.width/2,mic.y+mic.height/2);await page.waitForTimeout(250);
 await page.locator('.opencraft-composer-voice-footer[data-voice-phase=listening]').waitFor();
 assert.equal(await count(),beforeHold+1,'microphone hold starts voice');
 await touch('touchEnd');await page.locator('.opencraft-composer-voice-footer').waitFor({state:'hidden'});
 assert.equal(await count(),beforeHold+1,'microphone hold release cannot restart voice');
}
evidence.push({width,editorTapAndHoldExcluded:true,microphoneTap:true,keyboard:true,explicitStop:true,draftPreserved:true});await context.close();}
console.log('Editor touch gestures stay text-only; explicit microphone and draft continuity passed');}finally{await writeFile('.local/editor-voice-hold/result.json',JSON.stringify(evidence,null,2));await browser.close();await vite.close()}
