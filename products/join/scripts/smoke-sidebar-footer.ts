import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import {createServer} from 'vite';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=await import('playwright');
const output='.local/sidebar-footer';
const source=`
import React from 'react';
import {bindWorkbenchPreview,isMobileWorkbenchPreview} from '/apps/workbench-web/src/runtime/workbench-preview.ts';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density.ts';
import {MemoryUiPreferenceStore,UiPreferencesRuntime} from '@opencraft/ui-preferences';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {registerMobileGuide} from '/products/join/plugins/tencentoa/src/mobile-guide-browser.ts';
import {createMobileGuideQr} from '/products/join/plugins/tencentoa/src/mobile-guide-qr.ts';
import {localeCatalogs} from '/apps/workbench-web/src/i18n/catalogs.ts';
import mobileMessages from '/products/join/plugins/tencentoa/src/locales/zh-CN.json';
import '/apps/workbench-web/src/styles/app.scss';
// Exercise an established workspace; first-use onboarding owns its own input layer.
localStorage.setItem("opencraft.onboarding.completedAt","2026-11-12T00:00:00Z");
initializeAppearanceTheme();
bindWorkbenchPreview();
const preferences=await UiPreferencesRuntime.open({installation:new MemoryUiPreferenceStore()});
bindInteractionDensity(document,preferences,isMobileWorkbenchPreview()?{touchFriendly:"on"}:undefined);
const config=document.createElement("script");config.id="opencraft-deployment-config";config.type="application/json";config.textContent=JSON.stringify({hosts:[{hostId:"fixture-host",label:"Fixture Host",kind:"remote-ssh",url:location.origin.replace("http","ws")+"/fixture-rpc"}],builtinAgents:false,hypernode:false});document.head.append(config);
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct([],false)});
const supervisor=application.supervisor;
await supervisor.extensions.activate({manifest:{manifestVersion:1,id:'tencentoa.identity',name:'Phone guide fixture',version:'1.0.0',apiVersion:1,trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']},activate(api){
const snapshot={revision:1,identity:{id:'fixture',handle:'Lin'},phase:'authenticated',name:'Lin',avatarUrl:null,planLabel:null,usageRemainingPercent:null,error:null};
api.views.register({id:'tencentoa.identity.fixture-account',title:'Account',viewType:'tencentoa.identity.fixture-account'});
api.internal.register('platformViewRenderer',{viewType:'tencentoa.identity.fixture-account',Component:()=> <p>Fixture account</p>});
api.internal.register('platformAccount',{id:'tencentoa.identity.fixture-account',viewId:'tencentoa.identity.fixture-account',entrancePriority:100,getSnapshot:()=>snapshot,subscribe:()=>()=>{},refresh:async()=>{}} as any);
registerMobileGuide(api,{getSnapshot:()=>({identity:{staffId:'fixture'}}),subscribe:()=>()=>{}} as any);}});
const catalogs=localeCatalogs.map(c=>c.locale==='zh-CN'?{...c,load:async()=>({...await c.load(),...mobileMessages})}:c);
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN',catalogs).render(<WorkbenchRoot application={application}/>);
window.proof={qr:createMobileGuideQr,theme:setThemePreference,themeId:setAppearanceThemeId,retire:()=>supervisor.extensions.deactivate('tencentoa.identity'),open:()=>supervisor.extensions.contributions.executeCommand('tencentoa.identity.mobile-guide.open')};
document.body.dataset.ready='true';
`;
const vite = await createServer({ configFile: false, root: process.cwd(), cacheDir: output + "/vite-cache", publicDir: "apps/workbench-web/public", logLevel: "error",
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "@opencraft/remote-interaction", "@opencraft/remote-interaction/touch", "@opencraft/remote-interaction/websocket"] },
  define: { "import.meta.env.VITE_OPENCRAFT_PRESENTATION": JSON.stringify(JSON.stringify({ iconStyle: "classic" })), "process.env.NEXT_PUBLIC_REGION": '"cn"', "process.env.NEXT_PUBLIC_PREVIEW_LOCALES": '""',
    "import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN": '"false"', "import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN": '"false"' },
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0, hmr: false, allowedHosts: ["join.localhost"] },
  plugins: [{ name: "overhome-smoke", resolveId: id => id === "/proof.tsx" ? id : null, async load(id) {
    if (id === "/proof.tsx") return source;
    if (/\/packages\/(browser-core|remote-interaction)\/src\/.*\.cjs$/.test(id)) {
      const names = Object.keys(require(id));
      const bundled = await build({ stdin: { resolveDir: process.cwd(), contents: `export {${names.join(",")}} from ${JSON.stringify(id)}` }, bundle: true, format: "esm", platform: "browser", write: false });
      return bundled.outputFiles[0].text;
    }
    return null;
  },
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next(); response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="app"></div><script type="module" src="/proof.tsx"></script>');
    }); } }],
});

let browser:any;
try {
 await mkdir(output,{recursive:true});await vite.listen();
 const local=new URL(vite.resolvedUrls!.local[0]!);local.hostname='join.localhost';const url=local.href;
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--no-proxy-server','--host-resolver-rules=MAP join.localhost 127.0.0.1']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];
 page.on('pageerror',(e:any)=>{errors.push(e.message);console.error(e.message)});
 page.setDefaultTimeout(60000);
 await page.addInitScript("window.__name=value=>value");
 await page.addInitScript(() => {
  (window as any).collapsedPreviewFrames=[];
  const sample=()=>{const el=document.querySelector<HTMLElement>('.announcement-experience-surface');
   if(el&&el.offsetHeight<100)(window as any).collapsedPreviewFrames.push(el.offsetHeight);
   requestAnimationFrame(sample);};requestAnimationFrame(sample);
 });
 let releaseFrame!:()=>void;
 const frameGate=new Promise<void>(resolve=>{releaseFrame=resolve;});
 await page.route('**/*',async route=>{
  const request=route.request();
  if(request.isNavigationRequest()&&request.frame().parentFrame())await frameGate;
  await route.continue();
 });
 await page.goto(url,{waitUntil:"domcontentloaded",timeout:120000});await page.locator('body[data-ready=true]').waitFor({timeout:120000});

 await page.getByRole('dialog').waitFor();
 await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 const column=page.locator('.shell-sidebar__column:visible').first();
 const strip=column.locator('.shell-navigation-strip');
 await strip.waitFor();
 // Change the real sidebar container's available capacity, without changing input modality.
 const width=async(n:number)=>{
 const handle=page.locator('.app-shell-left-panel__resize:visible').first();
 const rect=await handle.boundingBox();
 const current=await page.locator('.app-shell-left-panel:visible').first().evaluate(el=>el.getBoundingClientRect().width);
 await page.mouse.move(rect!.x+1,200);await page.mouse.down();
 await page.mouse.move(rect!.x+1+n-current,200,{steps:8});await page.mouse.up();await page.waitForTimeout(250);
 };
 const measure=()=>strip.evaluate(el=>{
   const port=el.querySelector('.shell-navigation-strip__viewport')!, track=el.querySelector('.shell-navigation-strip__content')!;
   return {frame:el.getBoundingClientRect().width,port:port.clientWidth,content:track.getBoundingClientRect().width,overflow:el.hasAttribute('data-overflow'),left:port.hasAttribute('data-left'),right:port.hasAttribute('data-right'),scroll:port.scrollLeft};
 });
 const footer=column.locator('.shell-sidebar__rail-footer');
 await page.evaluate(()=>window.proof.themeId('opencraft.core.frost'));
 await width(400);
 console.log('wide',await measure());assert.equal((await measure()).overflow,false);
 await page.screenshot({path:output+'/wide-light.png'});
 await width(240);
 console.log('narrow',await measure());assert.equal((await measure()).overflow,true);
 assert.equal(await footer.locator('[data-surface=account]').count(),1);
 const fixed=await footer.boundingBox();
 const next=strip.locator('.shell-navigation-strip__next');
 for(let i=0;i<12&&await next.isEnabled();i++){await next.click();await page.waitForTimeout(80);}
 assert.equal((await measure()).right,false);assert.equal((await measure()).left,true);
 assert.deepEqual(await footer.boundingBox(),fixed,'fixed region does not move during horizontal navigation');
 await page.screenshot({path:output+'/narrow-end.png'});
 const first=strip.locator('[data-action-id]').first();await first.focus();await page.waitForTimeout(100);
 assert.equal((await measure()).left,false,'keyboard focus exposes first destination');
 const last=strip.locator('[data-action-id]').last();await last.focus();await page.waitForTimeout(100);
 assert.equal((await measure()).right,false,'keyboard focus exposes last destination');
 await width(400);assert.equal((await measure()).overflow,false,'arrows retire when capacity returns');
 // Material is inherited, not a new glass base.
 assert.equal(await strip.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
 await page.evaluate(()=>window.proof.theme('dark'));await width(260);await page.waitForTimeout(200);
 await page.screenshot({path:output+'/narrow-dark.png'});
 // Real touch input, wide touch-capable layout, horizontal scroll must not invoke destinations.
 await page.evaluate(()=>window.proof.theme('light'));
 const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await page.waitForTimeout(200);
 await first.focus();await page.waitForTimeout(100);
 const bounds=await strip.locator('.shell-navigation-strip__viewport').boundingBox();
 const x=bounds!.x+bounds!.width-8,y=bounds!.y+bounds!.height/2;
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
 for(const dx of [10,25,40,60,80])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-dx,y,id:1}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(300);
 assert.ok((await measure()).scroll>0,'native touch scroll reaches hidden entries');
 await cdp.detach();
 const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await mobile.addInitScript('window.__name=value=>value');await mobile.goto(url,{timeout:120000});await mobile.locator('body[data-ready=true]').waitFor();await mobile.waitForTimeout(500);
 const toggle=mobile.locator('[data-chrome-action-id=sidebar-toggle]:visible').first();await toggle.tap();await mobile.locator('[data-mobile-sidebar]:visible').first().waitFor();await mobile.waitForTimeout(250);
 await mobile.screenshot({path:output+'/mobile.png'});
 assert.equal(await mobile.locator('.shell-sidebar__column[data-navigation-layout=mobile] .shell-navigation-strip__viewport').first().evaluate(el=>getComputedStyle(el).display),'contents');
 assert.equal(await mobile.locator('.shell-navigation-strip__next:visible').count(),0,'mobile drawer does not get a horizontal footer');
 await writeFile(output+'/evidence.json',JSON.stringify({checks:['real WorkbenchRoot','wide and constrained container','left/right paging','stable fixed footer','keyboard reveal','resize overflow retirement','continuous material','dark theme','native touch horizontal scrolling','mobile presentation'],errors},null,2));
 assert.deepEqual(errors,[]);console.log('PASS sidebar footer in real WorkbenchRoot');
}finally{await browser?.close();await vite.close();}
