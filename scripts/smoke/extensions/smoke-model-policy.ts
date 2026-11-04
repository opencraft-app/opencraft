import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { build } from "esbuild";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
// Real application bootstrap, Settings, Router, Supervisor and Manager. Only
// product composition and the self-contained test plugin use local fixtures.
const withHost = false;
const evidenceDirectory = ".local/model-policy";
const source = `
import React from 'react';
import {SessionModelPicker} from '/packages/composer-editor/src/session-model-picker.tsx';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {useUiPreferencesRuntime} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density.ts';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {createHeadlessModelServicesExtension} from '/plugins/builtin-agents/src/index.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
const models=[{id:'codex-test',model:'codex-test',displayName:'Codex Test',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'ultra'}]}];
await application.supervisor.extensions.activateOptional(createHeadlessModelServicesExtension({hostId:'fixture',requestHost:async()=>({data:models,nextCursor:null})}));
application.supervisor.navigation.openSettings('appearance');
function DensityBoundary(){const preferences=useUiPreferencesRuntime();React.useEffect(()=>bindInteractionDensity(document,preferences),[preferences]);return <WorkbenchRoot application={application}/>;}
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN').render(<DensityBoundary/>);
window.proof={empty:()=>{const target=document.createElement('div');document.body.append(target);createIntlTestRoot(target,undefined,'zh-CN').render(<SessionModelPicker catalog={{models:[],permissionProfiles:[],policyRestricted:true}} label='模型' selected={null} disabled={false} open={true} onOpenChange={()=>{}} onSelect={()=>{}} focus={{triggerProps:{},contentProps:{}}}/>);},catalog:()=>application.supervisor.extensions.contributions.getSnapshot(),open:()=>application.supervisor.navigation.openSettings('opencraft.headless-model-services.policy'),theme:setThemePreference};
document.body.dataset.ready='true';
`;
let policy={canManage:true,revision:0,rules:[] as unknown[]};
const server = await createServer({ configFile: false, cacheDir: ".local/plugin-settings/vite-cache", root: process.cwd(), logLevel: "error",
  define: { "process.env.NEXT_PUBLIC_REGION": '"cn"', "process.env.NEXT_PUBLIC_PREVIEW_LOCALES": '""',
    "import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN": '"false"', "import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN": '"false"' },
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{
    name: "plugin-settings-proof", resolveId: id => id === "/proof.tsx" ? id : null,
    async load(id) {
      if (id === "/proof.tsx") return source;
      // Dev fixtures need the same CJS-to-ESM conversion as the production bundle.
      if (id.includes("/packages/remote-interaction/src/") && id.endsWith(".cjs")) {
        const names = Object.keys(require(id));
        const bundled = await build({ stdin: { resolveDir: process.cwd(), contents: `export {${names.join(",")}} from ${JSON.stringify(id)}` }, bundle: true, format: "esm", platform: "browser", write: false });
        return bundled.outputFiles[0].text;
      }
      return null;
    },
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url === "/__opencraft_model_policy") {
        void (async()=>{if(req.method==='POST'){let body="";for await(const chunk of req)body+=chunk;const input=JSON.parse(body);policy={canManage:true,revision:policy.revision+1,rules:input.rules};}res.setHeader("content-type","application/json");res.end(JSON.stringify(policy));})();
      } else if (req.url === "/") {
        res.setHeader("Content-Type", "text/html");
        res.end('<html><body><div id="app"></div><script type="module" src="/proof.tsx"></script></body></html>');
      } else next();
    }); },
  }],
});
let browser:any;
try {
 await server.listen();browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1280,height:900},hasTouch:true});
 await page.addInitScript('window.__name = target => target;');
 page.on('console',message=>{if(message.type()==='error')console.error(message.text());});
 const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
 await page.goto(server.resolvedUrls!.local[0]);await page.waitForSelector('body[data-ready="true"]');
 await page.getByText('模型使用限制',{exact:true}).first().waitFor();
 await page.evaluate(()=>(window as any).proof.open());
 await page.getByText('禁用模型',{exact:true}).waitFor();
 const switches=page.getByRole('switch');assert.equal(await switches.count(),3);
 await switches.first().click();await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForTimeout(100);assert.equal(policy.rules.length,1);
 await mkdir(evidenceDirectory,{recursive:true});
 for(const theme of ['light','dark'])for(const width of [1280,390]){
  await page.setViewportSize({width,height:900});await page.evaluate(value=>(window as any).proof.theme(value),theme);
  await page.waitForTimeout(300);
  if(width===390) {const navigation=page.getByRole('button',{name:'模型使用限制',exact:true});if(await navigation.isVisible())await navigation.tap();await page.waitForTimeout(300);}
  await page.screenshot({path:evidenceDirectory+'/'+theme+'-'+width+'.png',fullPage:true});
 }
 const member=await browser.newPage();await member.route('**/__opencraft_model_policy',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({canManage:false})}));await member.goto(server.resolvedUrls!.local[0]);await member.waitForSelector('body[data-ready="true"]');assert.equal(await member.getByText('模型使用限制',{exact:true}).count(),0);await member.close();
 await page.evaluate(()=>(window as any).proof.empty());
 await page.getByText('部分选项已被管理员禁用。',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',screenshots:evidenceDirectory,verified:['real Settings route','admin save','fully restricted catalog reason','light/dark','wide/narrow']}));
}finally{await browser?.close();await server.close();}
