import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import {createServer} from 'vite';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=await import('playwright');
const output='.local/onboarding-default-off';
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
// A fresh browser must not open any first-use guidance.
localStorage.removeItem("opencraft.onboarding.completedAt");
localStorage.removeItem("tencentoa.identity.mobile-guide.seen.v1");
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
 for (const touch of [false,true]) {
  const context=await browser.newContext({viewport:touch?{width:390,height:844}:{width:1440,height:1000},isMobile:touch,hasTouch:touch});
  const page=await context.newPage();await page.addInitScript('window.__name=value=>value');
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:120000});
  await page.locator('body[data-ready=true]').waitFor({timeout:120000});
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.agent-onboard').count(),0,'No automatic Agent onboarding');
  assert.equal(await page.locator('.announcement-experience').count(),0,'No automatic phone guide');
  assert.equal(await page.evaluate(()=>localStorage.getItem('opencraft.onboarding.completedAt')),null,'Do not forge onboarding completion');
  assert.equal(await page.evaluate(()=>localStorage.getItem('tencentoa.identity.mobile-guide.seen.v1')),null,'Do not forge phone guide dismissal');
  await page.screenshot({path:output+(touch?'/touch-default.png':'/desktop-default.png')});
  if(!touch) {
   await page.evaluate(()=>{void (window as any).proof.open();});
   await page.locator('.announcement-experience').waitFor({timeout:60000});
   await page.screenshot({path:output+'/manual-phone-guide.png'});
  }
  await context.close();
 }
 console.log('Fresh desktop and touch contexts show no automatic guidance; manual phone guide opens.');
} finally {await browser?.close();await vite.close();}
