import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { _electron } from 'playwright';

// Real Shell, overview, renderer and theme; only browser backing is controlled.
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/browser-panel-readiness');
await mkdir(output, { recursive: true });
const original = await readFile('scripts/smoke/shell/smoke-panel-toolbar-ownership.ts', 'utf8');
let source = original.split('const source=`')[1]!.split('`;')[0]!;
source = `
import BrowserPanel from '/apps/workbench-web/src/browser/browser-panel.tsx';
import {BrowserEnvironmentProvider} from '/apps/workbench-web/src/browser/browser-runtime-context.tsx';
import {PanelOverviewButton,usePanelOverviewPresentation} from '/apps/workbench-web/src/components/panel-overview-presentation.tsx';
import {useShellPresentation} from '/apps/workbench-web/src/components/shell-presentation.ts';
` + source;
source = source.replace("for(let i=0;i<12;i++)panels.open('scope','terminal',{id:String(i)});", `
const snapshots = new Map(['a','b'].map(id=>[id,{id,ownerId:'scope',title:'about:blank '+id,error:null,navigation:{currentUrl:null,isLoading:false,canGoBack:false,canGoForward:false}}]));
const tabs = new Map(['a','b'].map(id=>[id,{id,pageId:id,ownerId:'scope',viewportMode:{type:'responsive'}}]));
const attempts=[];
let reloads=0;
const pages={has:id=>snapshots.has(id),getSnapshot:id=>snapshots.get(id),subscribe:()=>()=>{},getZoom:()=>100,reload:()=>{reloads++}};
const workbench={getTabSnapshot:id=>tabs.get(id),subscribeTab:()=>()=>{}};
const presentations={present:({pageId})=>{
  if(window.throwPresentation)throw Error('unavailable');
  let resolve,reject;const ready=new Promise((a,b)=>{resolve=a;reject=b});
  const item={pageId,resolve,reject,disposed:false};attempts.push(item);
  return {ready,measure(){},updateViewportMode(){},dispose(){item.disposed=true}};
}};
panels.register({kind:'browser',createTab:({id})=>({id,resource:id,kind:'browser',region:'right',title:'about:blank '+id,icon:'browser',closable:true})});
panels.open('scope','browser',{id:'a'});panels.open('scope','browser',{id:'b'});
panels.dispatch('scope',{type:'select-foreground',foreground:'primary'});
const registrations=[{kind:'browser',Component:BrowserPanel,presentationReadiness:'renderer'}];
function Chat(){window.overview=usePanelOverviewPresentation();window.scene=useShellPresentation();return <div><input aria-label='Draft' defaultValue='Keep draft'/><PanelOverviewButton/></div>}
window.backing={attempts,reloads:()=>reloads};
`);
source = source.replace('renderers={[]}', 'renderers={registrations}');
source = source.replace("<input aria-label='Draft' defaultValue='Keep draft'/></AppShell>", '<Chat/></AppShell>');
source = source.replace('<App/></WorkbenchPanelRuntimeProvider>', '<BrowserEnvironmentProvider pages={pages} workbench={workbench} presentations={presentations} surfaces={{}}><App/></BrowserEnvironmentProvider></WorkbenchPanelRuntimeProvider>');
const vite = await createServer({ configFile:false, root:process.cwd(), logLevel:'error', resolve:{dedupe:['react','react-dom','react-intl']},
  optimizeDeps:{entries:[],include:['react','react-dom/client','react-intl']}, esbuild:{jsx:'automatic'}, server:{host:'127.0.0.1',port:0,hmr:false},
  plugins:[{name:'negative-control',enforce:'pre',transform(code,id){
    if(process.env.OPENCRAFT_READINESS_NEGATIVE_CONTROL && id.endsWith('/browser/browser-panel.tsx'))
      return code.replace('onPresentationReady?.();','void presentationRef.current?.ready.then(() => onPresentationReady?.());');
  }},{name:'fixture',resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?source:null,
    configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('Content-Type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>');});}}] });
let browser;
try {
  await vite.listen();
  await writeFile(output+'/app.cjs', "const{app,BrowserWindow}=require('electron');app.setPath('userData',__dirname+'/profile');app.whenReady().then(()=>new BrowserWindow({width:390,height:844}).loadURL('about:blank'));");
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.DISPLAY;delete env.WAYLAND_DISPLAY;
  browser=await _electron.launch({executablePath:'/opt/opencraft/runtime/browser/electron/electron',args:['--ozone-platform=headless','--ozone-override-screen-size=1600,1200','--disable-gpu','--disable-dev-shm-usage',output+'/app.cjs'],env});
  const page=await browser.firstWindow();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')console.log(m.text());});
  await page.addInitScript('window.__name=value=>value');
  await page.setViewportSize({width:390,height:844});
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await page.goto(vite.resolvedUrls!.local[0]!);
  // Initial Vite dependency discovery may invalidate the first fixture import.
  try { await page.waitForFunction(()=>!!(window as any).overview,{},{timeout:15000}); }
  catch { await page.reload(); }
  await page.waitForFunction(()=>!!(window as any).overview,{},{timeout:120000});
  await page.evaluate(()=>document.documentElement.dataset.uiDensity='touch');
  const tap = async (locator:any) => {
    const r=await locator.boundingBox();assert.ok(r);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:r.x+r.width/2,y:r.y+r.height/2}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  const open = async (id:string,touch=true) => {
    await page.evaluate(()=>{const w=window as any;w.overview.show({key:JSON.stringify(['primary','scope']),rect:null});});
    const card=page.locator('[data-tab-id="'+id+'"] .panel-overview-card__preview');
    await card.waitFor();
    if(touch)await tap(card);else await card.click();
    await page.waitForFunction(id=>{const s=(window as any).fixture.panels.getOwnerSnapshot('scope');return s.foreground==='tools'&&s.right.activeTabId===id;},id,{timeout:5000});
    await page.waitForFunction(()=>!document.querySelector('[role="dialog"]'),{},{timeout:5000});
  };
  await open('a');
  await page.getByText('Opening page…',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>{
    const surface=document.createElement('div');surface.className='web-browser-surface';
    surface.dataset.browserPainted='false';surface.style.transition='none';surface.style.opacity='1';surface.style.pointerEvents='auto';document.body.append(surface);
    const before=[getComputedStyle(surface).opacity,getComputedStyle(surface).pointerEvents];
    surface.dataset.browserPainted='true';const after=[getComputedStyle(surface).opacity,getComputedStyle(surface).pointerEvents];surface.remove();return {before,after};
  }),{before:['0','none'],after:['1','auto']},'empty external guest cannot hide or intercept panel status');
  assert.equal(await page.getByLabel('Web address',{exact:true}).isVisible(),true);
  assert.equal(await page.evaluate(()=>document.activeElement?.tagName==='INPUT'),false,'overview selection must not raise keyboard');
  await page.screenshot({path:output+'/touch-loading.png'});
  await page.evaluate(()=>(window as any).backing.attempts.at(-1).reject(Error('no frame')));
  await page.getByText('Unable to display this page',{exact:true}).waitFor();
  await tap(page.locator('.browser-panel__presentation-status button'));
  await page.getByText('Opening page…',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>(window as any).backing.reloads()),1);
  await page.evaluate(()=>(window as any).backing.attempts.at(-1).resolve());
  await page.waitForFunction(()=>!document.querySelector('.browser-panel__presentation-status'));
  await open('b');
  // Missing first frame reaches an actionable failure without owning navigation.
  await page.getByText('Unable to display this page',{exact:true}).waitFor({timeout:20000});
  await page.screenshot({path:output+'/touch-timeout.png'});
  await tap(page.locator('.browser-panel__presentation-status button'));
  await page.evaluate(()=>(window as any).backing.attempts.at(-2).resolve());
  await page.getByText('Opening page…',{exact:true}).waitFor();
  await page.evaluate(()=>(window as any).scene.selectPrimary());
  await page.evaluate(()=>(window as any).backing.attempts.at(-1).resolve());
  assert.equal(await page.evaluate(()=>(window as any).fixture.panels.getOwnerSnapshot('scope').foreground),'primary');
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
  await page.setViewportSize({width:1280,height:850});
  await page.evaluate(()=>{(window as any).fixture.setThemePreference('dark');(window as any).throwPresentation=true;});
  await open('a',false);
  await page.getByText('Unable to display this page',{exact:true}).waitFor();
  await page.screenshot({path:output+'/desktop-failed.png'});
  assert.deepEqual(errors,[]);
  await writeFile(output+'/result.json',JSON.stringify({passed:true,checks:['touch selection with pending media','retry','timeout','late result fencing','switch away','desktop synchronous failure','light/dark']},null,2));
  console.log('Browser panel readiness smoke passed');
} finally { await browser?.close();await vite.close(); }
