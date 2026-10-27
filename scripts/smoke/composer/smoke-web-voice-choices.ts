import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
const output=process.env.OPENCRAFT_VOICE_CHOICE_EVIDENCE??'.local/voice-choice-evidence';
await mkdir(output,{recursive:true});
// Production settings, preferences and menu. Only the speech service is synthetic.
const source=`
import React,{useEffect} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebVoiceSettings} from '/plugins/voice-input/src/web-voice-settings.tsx';
import {useVoiceInputPreference} from '/apps/workbench-web/src/runtime/use-voice-input-preference.ts';
import {useUiPreferencesRuntime} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density.ts';
import {bindTouchInteractionMode} from '/apps/workbench-web/src/runtime/pointer-modality.ts';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId,coreThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();let snapshot={phase:'ready',binding:'synthetic',revision:1,selection:null,models:[{providerId:'speech',modelId:'enabled',name:'Speech fixture',enabled:true},{providerId:'speech',modelId:'disabled',name:'Unavailable fixture',enabled:false}]};
const listeners=new Set();let release;const selections=[];
const service={subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},getSnapshot:()=>snapshot,refresh:async()=>{},selectModel:async selection=>{selections.push(selection);await new Promise(resolve=>release=resolve);snapshot={...snapshot,selection,revision:snapshot.revision+1};for(const listener of listeners)listener()}};
const Settings=createWebVoiceSettings(service,useVoiceInputPreference);
function App(){const preferences=useUiPreferencesRuntime();useEffect(()=>{const density=bindInteractionDensity(document,preferences),touch=bindTouchInteractionMode(document);return()=>{density();touch()}},[preferences]);window.fixture={setThemePreference,setAppearanceThemeId,coreThemeId,preferences,release:()=>release?.(),selections};return <main style={{maxWidth:900,padding:24,margin:'auto'}}><Settings/><textarea aria-label='Draft' defaultValue='Keep this draft'/></main>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},plugins:[{name:'voice-choice-ui',resolveId:id=>id==='/voice-choice.tsx'?id:null,load:id=>id==='/voice-choice.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/voice-choice.tsx"></script>')})}}]});
let browser:any;const evidence=[];
try{
 await vite.listen();const{chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');browser=await chromium.launch({headless:true});
 for(const width of [1280,390])for(const theme of width===390?['longing']:['neutral','longing','lavender'])for(const mode of ['light','dark']){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:width===390,isMobile:width===390,reducedMotion:mode==='dark'?'reduce':'no-preference'});const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.addInitScript('window.__name=value=>value');
  await page.goto(vite.resolvedUrls!.local[0]!);const method=page.getByRole('button',{name:'Recognition method',exact:true});await method.waitFor();
  await page.evaluate(([theme,mode])=>{const f=(window as any).fixture;f.setThemePreference(mode);f.setAppearanceThemeId(theme==='neutral'?f.coreThemeId:'opencraft.core.'+theme)},[theme,mode]);
  const draft=await page.getByRole('textbox',{name:'Draft'}).elementHandle();
  const open=async()=>{if(width===390)await method.tap();else await method.press('ArrowDown');await page.getByRole('menu',{name:'Recognition method',exact:true}).waitFor();await page.getByRole('menu',{name:'Recognition method',exact:true}).evaluate(async el=>{getComputedStyle(el).opacity;await Promise.all(el.getAnimations().map(a=>a.finished))})};
  await open();const menu=page.getByRole('menu',{name:'Recognition method',exact:true});assert.equal(await menu.getByRole('menuitemradio').count(),3);
  const bounds=await menu.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width);
  if(width===390)assert.ok((await menu.getByRole('menuitemradio').evaluateAll(items=>items.map(item=>item.getBoundingClientRect().height))).every(height=>height>=44));
  assert.equal(await menu.getByRole('menuitemradio',{name:'Automatic',exact:true}).getAttribute('aria-checked'),'true');
  await page.screenshot({path:output+`/choices-${width}-${theme}-${mode}.png`});
  await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement===document.querySelector('#web-speech-provider'));assert.ok(await method.evaluate(el=>el===document.activeElement));
  await open();
  if(width===390)await menu.getByRole('menuitemradio',{name:'Hunyuan Speech',exact:true}).tap();
  else{await menu.getByRole('menuitemradio',{name:'Automatic',exact:true}).focus();await page.keyboard.press('ArrowDown');await page.waitForFunction(()=>document.activeElement?.textContent==='Hunyuan Speech');await page.keyboard.press('Enter')}
  await menu.waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('#web-speech-provider')!.textContent!.includes('Hunyuan Speech'));
  const model=page.getByRole('button',{name:'Transcription model',exact:true});if(width===390)await model.tap();else await model.click();const models=page.getByRole('menu',{name:'Transcription model',exact:true});
  assert.equal(await models.getByRole('menuitemradio',{name:'Unavailable fixture (not enabled)',exact:true}).getAttribute('data-disabled'),'');
  const before=await page.getByRole('main').boundingBox();if(width===390)await models.getByRole('menuitemradio',{name:'Speech fixture',exact:true}).tap();else await models.getByRole('menuitemradio',{name:'Speech fixture',exact:true}).click();
  await models.waitFor({state:'hidden'});assert.ok(await method.isDisabled());assert.ok(await model.isDisabled());assert.deepEqual(await page.getByRole('main').boundingBox(),before,'pending selection preserves layout');
  await page.evaluate(()=>(window as any).fixture.release());await page.waitForFunction(()=>!document.querySelector('#web-speech-model')!.hasAttribute('disabled'));assert.equal(await model.innerText(),'Speech fixture');assert.equal(await page.getByRole('menu').count(),0,'completed save must not reopen the menu');
  await open();await menu.getByRole('menuitemradio',{name:'Hunyuan Speech',exact:true}).focus();const option=await menu.getByRole('menuitemradio',{name:'Hunyuan Speech',exact:true}).elementHandle();
  await page.evaluate(()=>(window as any).fixture.preferences.set('locale.override','zh-CN'));await page.getByRole('menu',{name:'识别方式',exact:true}).waitFor();assert.ok(await option!.evaluate(el=>el===document.activeElement),'locale change retains the focused option');
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('textbox',{name:'Draft'}).inputValue(),'Keep this draft');assert.ok(await draft!.evaluate(el=>el===document.querySelector('textarea')));assert.deepEqual(errors,[]);
  evidence.push({width,theme,mode,touch:width===390,keyboard:true,selection:true,disabled:true,pendingStable:true,localeFocus:true,draftPreserved:true});await page.close();
 }
 console.log(JSON.stringify({output,evidence}));await writeFile(output+'/choices-report.json',JSON.stringify(evidence,null,2));
}finally{await browser?.close();await vite.close();}
