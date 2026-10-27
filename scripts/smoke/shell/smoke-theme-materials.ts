import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { createServer } from "vite";

const executablePath = process.env.OPENCRAFT_THEME_ELECTRON_EXECUTABLE;
if (!executablePath) throw new Error("Set OPENCRAFT_THEME_ELECTRON_EXECUTABLE to an explicit Electron binary");
const { _electron } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = await mkdtemp(join(tmpdir(), "opencraft-theme-materials-"));
const source = `
import React,{useState} from 'react';import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {SettingsContent} from '/apps/workbench-web/src/components/settings-page.tsx';
import {ExtensionSupervisor} from '@opencraft/extension-runtime';
import {SettingsGroup,SettingsRow,SettingsTextInput,SettingsSelect} from '@opencraft/extension-react';
import {initializeAppearanceTheme,connectAppearanceThemeContributions,setThemePreference,setAppearanceThemeId,getAppearanceThemeSnapshot,useAppearanceTheme,coreThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
const supervisor=new ExtensionSupervisor({platform:'electron'});initializeAppearanceTheme();connectAppearanceThemeContributions(supervisor.contributions);
const palette=(dark)=>({accent:'#5599dd',contrast:45,ink:dark?'#eeeeee':'#171717',surface:dark?'#161616':'#f8f8f8',surfaces:{window:dark?'#181818':'#ededed',sidebar:dark?'#161616':'#f0f0f0',panel:dark?'#202020':'#ffffff',input:dark?'#2b2b2b':'#fafafa',popover:dark?'#363636':'#ffffff'},material:{window:'opaque',elevation:'flat'},semanticColors:{diffAdded:'#118844',diffRemoved:'#dd3344',skill:'#775599'}});
const definition={manifest:{manifestVersion:1,id:'opencraft.material-test',name:'Material test',version:'1.0.0',apiVersion:1,trust:'trusted',platforms:['electron'],activationEvents:['onStartupFinished']},activate(api){api.themes.register({id:'opencraft.material-test.studio',label:'Studio test',palettes:{light:palette(false),dark:palette(true)}})}};
window.themeHarness={install:()=>supervisor.activate(definition),remove:()=>supervisor.deactivate('opencraft.material-test'),select:()=>setAppearanceThemeId('opencraft.material-test.studio'),core:()=>setAppearanceThemeId(coreThemeId),mode:setThemePreference,snapshot:getAppearanceThemeSnapshot};
const managerSnapshot={extensions:[],installationLoadErrors:[]};const empty=[];
const manager={subscribe:()=>()=>{},getSnapshot:()=>managerSnapshot};const renderers={subscribe:()=>()=>{},getSnapshot:()=>empty};
function App(){const [settings,setSettings]=useState(false);const appearance=useAppearanceTheme();window.themeHarness.showSettings=()=>setSettings(true);
if(settings)return <div style={{height:'100vh',display:'flex',background:'var(--color-background-surface)'}}><SettingsContent section='appearance' onSectionChange={()=>{}} profiles={[]} machines={[]} activeHostId='' themes={appearance.availableThemes} themeId={appearance.themeId} themePreference={appearance.preference} onThemeChange={setAppearanceThemeId} onThemePreferenceChange={setThemePreference} extensionContributions={supervisor.contributions} extensionManager={manager} extensionRuntime={supervisor} platformViewRenderers={renderers}/></div>;
return <main style={{display:'grid',gridTemplateColumns:'220px 1fr',height:'100vh',background:'var(--opencraft-window-material)'}}>
<aside id='sidebar' style={{padding:20,background:'var(--opencraft-sidebar-material-background)',backdropFilter:'var(--opencraft-sidebar-material-filter)'}}>主题材质<br/>Theme materials</aside>
<section style={{padding:24}}><h2>配置 Settings</h2><SettingsGroup><SettingsRow label='名称 Name' htmlFor='name'><SettingsTextInput id='name' defaultValue='中英文名称'/></SettingsRow><SettingsRow label='模型 Model' htmlFor='model'><SettingsSelect id='model'><option>默认 Default</option></SettingsSelect></SettingsRow></SettingsGroup>
<div id='popover' style={{marginTop:24,padding:20,background:'var(--color-background-elevated-primary-opaque)',boxShadow:'var(--opencraft-main-surface-elevation)'}}>浮层 Popover</div></section></main>}
createRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({configFile:false,root:process.cwd(),logLevel:"error",resolve:{dedupe:["react","react-dom"]},cacheDir:"node_modules/.vite-theme-materials",esbuild:{jsx:"automatic"},server:{host:"127.0.0.1",port:0,hmr:false},plugins:[{
  name:"theme-material-fixture",resolveId:id=>id==="/theme-probe.tsx"?id:null,load:id=>id==="/theme-probe.tsx"?source:null,
  configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=="/")return next();res.setHeader("content-type","text/html");res.end('<title>OpenCraft theme verification</title><div id="root"></div><script type="module" src="/theme-probe.tsx"></script>')})},
}]});
let desktop: any;
const evidence: unknown[]=[];const errors:string[]=[];
try {
  await vite.listen();
  await build({entryPoints:["apps/workbench-electron/src/preload.ts"],bundle:true,platform:"node",format:"cjs",external:["electron"],outfile:join(output,"preload.cjs")});
  await build({entryPoints:["apps/workbench-electron/src/window-appearance.ts"],bundle:true,platform:"node",format:"cjs",outfile:join(output,"appearance.cjs")});
  const url=`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  const entry=join(output,"main.cjs");
  await writeFile(entry,`const {app,BrowserWindow,ipcMain,nativeTheme}=require('electron');const {isWindowAppearanceMessage,applyNativeWindowAppearance}=require('./appearance.cjs');app.setPath('userData',${JSON.stringify(join(output,"profile"))});let current={themeSource:'light',resolvedTheme:'light'};globalThis.probe={rejected:0,calls:[]};app.whenReady().then(()=>{const w=new BrowserWindow({width:1000,height:720,show:false,webPreferences:{preload:${JSON.stringify(join(output,"preload.cjs"))},contextIsolation:true,nodeIntegration:false}});globalThis.probe.window=w;const vibrancy=w.setVibrancy.bind(w);w.setVibrancy=value=>{globalThis.probe.calls.push(value);vibrancy(value)};const refresh=()=>{nativeTheme.themeSource=current.themeSource;applyNativeWindowAppearance(w,current,process.platform);globalThis.probe.appearance=current};ipcMain.on('opencraft:set-window-appearance',(event,payload)=>{if(event.sender!==w.webContents||!isWindowAppearanceMessage(payload)){globalThis.probe.rejected++;return;}current=payload;refresh()});w.on('focus',refresh);w.on('blur',refresh);w.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`);
  desktop=await _electron.launch({executablePath:resolve(executablePath),args:[entry],env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=="ELECTRON_RUN_AS_NODE"))});
  const page=await desktop.firstWindow();page.on("pageerror",(e:Error)=>errors.push(e.message));
  await page.addInitScript("window.__name=value=>value");await page.goto(url);await page.locator('#name').waitFor();
  await page.evaluate(()=>(window as any).themeHarness.install());await page.evaluate(()=>(window as any).themeHarness.select());
  for(const mode of ['light','dark']){
    await page.evaluate(mode=>(window as any).themeHarness.mode(mode),mode);
    await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
    const expected=mode==='dark'?['rgb(22, 22, 22)','rgb(32, 32, 32)','rgb(43, 43, 43)','rgb(54, 54, 54)']:['rgb(240, 240, 240)','rgb(255, 255, 255)','rgb(250, 250, 250)','rgb(255, 255, 255)'];
    // Inputs animate their theme colors; assert the settled endpoint, not a
    // frame half-way between the previous and next palette.
    await page.waitForFunction(expected=>['#sidebar','.settings-control-group','#name','#popover'].every((s,i)=>getComputedStyle(document.querySelector(s)!).backgroundColor===expected[i]),expected);
    const surfaces=await page.evaluate(()=>['#sidebar','.settings-control-group','#name','#popover'].map(s=>getComputedStyle(document.querySelector(s)!).backgroundColor));
    assert.deepEqual(surfaces,expected);
    const native=await desktop.evaluate(()=>{const p=(globalThis as any).probe;return {background:p.window.getBackgroundColor(),appearance:p.appearance,vibrancy:p.calls.at(-1)}});
    assert.equal(native.appearance.opaqueWindows,true);assert.equal(native.background.toLowerCase(),mode==='dark'?'#181818':'#ededed');assert.equal(native.vibrancy,null);
    await page.screenshot({path:join(output,`${mode}.png`)});evidence.push({mode,surfaces,native});
  }
  // Exercise actual native focus transitions without touching an existing app window.
  await desktop.evaluate(()=>{const w=(globalThis as any).probe.window;w.show();w.focus()});
  await page.waitForTimeout(150);
  let state=await desktop.evaluate(()=>{const p=(globalThis as any).probe;return{focused:p.window.isFocused(),vibrancy:p.calls.at(-1)}});
  assert.equal(state.focused,true);assert.equal(state.vibrancy,null);
  await page.evaluate(()=>(window as any).themeHarness.core());
  await page.waitForTimeout(100);
  state=await desktop.evaluate(()=>{const p=(globalThis as any).probe;return{focused:p.window.isFocused(),vibrancy:p.calls.at(-1)}});assert.equal(state.vibrancy,'menu');
  await desktop.evaluate(async ()=>{
    const p=(globalThis as any).probe;p.window.blur();
    await new Promise<void>((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{
      if(!p.window.isFocused()&&p.calls.at(-1)===null){clearInterval(timer);resolve()}
      else if(Date.now()-started>3000){clearInterval(timer);reject(new Error('Native blur did not settle'))}
    },20)});
  });
  state=await desktop.evaluate(()=>{const p=(globalThis as any).probe;return{focused:p.window.isFocused(),vibrancy:p.calls.at(-1)}});assert.equal(state.focused,false);assert.equal(state.vibrancy,null);
  await page.evaluate(()=>(window as any).themeHarness.select());await page.evaluate(()=>(window as any).themeHarness.remove());
  const fallback=await page.evaluate(()=>(window as any).themeHarness.snapshot());assert.equal(fallback.requestedThemeId,'opencraft.material-test.studio');assert.equal(fallback.themeId,'opencraft.core.neutral');
  await page.evaluate(()=>(window as any).themeHarness.install());assert.equal((await page.evaluate(()=>(window as any).themeHarness.snapshot())).themeId,'opencraft.material-test.studio');
  await page.emulateMedia({colorScheme:'dark'});await page.evaluate(()=>(window as any).themeHarness.mode('system'));
  assert.equal((await page.evaluate(()=>(window as any).themeHarness.snapshot())).resolvedTheme,'dark');
  await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>(window as any).themeHarness.snapshot().resolvedTheme==='light');
  await page.evaluate(()=>(window as any).opencraftDesktop.setWindowAppearance({themeSource:'dark',resolvedTheme:'dark',backgroundColor:'url(x)'}));
  await page.waitForTimeout(100);assert.equal(await desktop.evaluate(()=>(globalThis as any).probe.rejected),1);
  if(process.env.OPENCRAFT_VERIFY_GRAPHITE==='1'){
    await page.evaluate(()=>(window as any).themeHarness.remove());
    await page.evaluate(()=>(window as any).themeHarness.showSettings());
    const graphite=page.getByRole('radio',{name:/Graphite/});
    await graphite.click();await page.waitForFunction(()=>document.documentElement.dataset.themeId==='opencraft.core.graphite');
    for(const mode of ['Light','Dark']){
      await page.getByRole('radiogroup',{name:'Appearance mode'}).getByText(mode,{exact:true}).click();
      await page.waitForFunction(mode=>(window as any).themeHarness.snapshot().resolvedTheme===mode,mode.toLowerCase());
      await page.waitForTimeout(200);
      assert.equal(await graphite.getAttribute('aria-checked'),'true');
      const swatch=await page.locator('[data-theme-preview="opencraft.core.graphite"] span:first-child').evaluate(e=>getComputedStyle(e).backgroundColor);
      assert.equal(swatch,mode==='Dark'?'rgb(22, 22, 22)':'rgb(240, 240, 240)');
      const native=await desktop.evaluate(()=>{const p=(globalThis as any).probe;return{background:p.window.getBackgroundColor(),vibrancy:p.calls.at(-1)}});
      assert.equal(native.vibrancy,null);assert.equal(native.background.toLowerCase(),mode==='Dark'?'#161616':'#f8f8f8');
      await page.screenshot({path:join(output,`graphite-${mode.toLowerCase()}.png`)});
      evidence.push({preset:'Graphite',mode,swatch,native});
    }
    await page.reload();await page.locator('#name').waitFor();
    assert.equal((await page.evaluate(()=>(window as any).themeHarness.snapshot())).themeId,'opencraft.core.graphite');
    await page.evaluate(()=>(window as any).themeHarness.showSettings());
    await page.getByRole('radiogroup',{name:'Appearance mode'}).getByText('System',{exact:true}).click();
    await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>(window as any).themeHarness.snapshot().resolvedTheme==='light');
    await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>(window as any).themeHarness.snapshot().resolvedTheme==='dark');
    evidence.push({preset:'Graphite',reloadRestores:true,systemChange:true});
  }
  assert.deepEqual(errors,[]);evidence.push({focusTransitions:true,unloadFallback:true,reinstallRestoresIntent:true,systemChange:true,invalidIPCRejected:true});
  console.log(JSON.stringify({output,evidence,errors}));
}finally{await writeFile(join(output,'report.json'),JSON.stringify({evidence,errors},null,2));await desktop?.close();await vite.close();}
