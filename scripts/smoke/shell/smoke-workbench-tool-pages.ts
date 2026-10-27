import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const withHost = process.argv.includes("--with-host");
const output = `.local/workbench-tool-pages/${withHost ? "active" : "hostless"}`;
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {setInternalDeveloperMode} from '/apps/workbench-web/src/internal-developer-mode.ts';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
if (${withHost}) {const config=document.createElement('script'); config.id='opencraft-deployment-config';config.type='application/json';config.textContent=JSON.stringify({hosts:[{hostId:'fixture-host',label:'Fixture Host',kind:'remote-ssh',url:location.origin.replace('http','ws')+'/fixture-rpc'}],builtinAgents:false,hypernode:false});document.head.append(config);}
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
const supervisor=application.supervisor;
const definition={manifest:{manifestVersion:1,id:'example.tools',name:'Tools fixture',version:'1.0.0',apiVersion:1,trust:'trusted',platforms:['web','electron'],activationEvents:['onStartupFinished']},activate(api){
 for (const [key,title,extra] of [
  ['first','Library tool',{order:20,management:{entryPoint:'workbench'}}],
  ['second','Storage tool',{order:10,audience:'internal',management:{entryPoint:'workbench'}}],
  ['contextual','Contextual tool',{order:5}],
  ['desktop','Desktop-only tool',{platforms:['electron'],management:{entryPoint:'workbench'}}],
 ]) {
  const viewId='example.tools.'+key+'-view';
  api.views.register({id:viewId,title,viewType:viewId});
  api.settings.registerPage({id:'example.tools.'+key,title,viewId,icon:'sparkles',...extra,
    ...(key==='first'?{titleMessage:{id:'fixture.tools.library',defaultMessage:'Library tool'}}:{}),
    management:{familyId:'example.tools.manage',scope:'host',...extra.management}});
  api.internal.register('platformViewRenderer',{viewType:viewId,Component:()=>React.createElement('div',{'data-fixture-page':key},title+' content')});
 }
}};
await supervisor.extensions.activate(definition);
const nav=supervisor.navigation; nav.openSettings('appearance');
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN',[{locale:'zh-CN',label:'简体中文',load:async()=>({'fixture.tools.library':'示例工具'})}]).render(<WorkbenchRoot application={application}/>);
window.proof={route:()=>nav.getSnapshot().applicationRoute,open:slug=>nav.openSettings(slug),back:()=>nav.back(),developer:setInternalDeveloperMode,theme:setThemePreference,retire:()=>supervisor.extensions.deactivate('example.tools'),mode:supervisor.mode};
document.body.dataset.ready='true';
`;
const vite=await createServer({configFile:false,cacheDir:`${output}/vite-cache`,root:process.cwd(),logLevel:'error',
 define:{'process.env.NEXT_PUBLIC_REGION':'"cn"','process.env.NEXT_PUBLIC_PREVIEW_LOCALES':'""','import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN':'"false"','import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN':'"false"'},
 esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'workbench-tool-fixture',resolveId:id=>id==='/proof.tsx'?id:null,load:id=>id==='/proof.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<div id="app"></div><script type="module" src="/proof.tsx"></script>');});}}]});
let browser:any;
const errors:string[]=[],external:string[]=[];
try {
 await vite.listen();const url=vite.resolvedUrls!.local[0],origin=new URL(url).origin;
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});page.setDefaultTimeout(15000);
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(external.push(route.request().url()),route.abort()));
 await page.goto(url);await page.locator('body[data-ready="true"]').waitFor({timeout:60000});
 await page.evaluate(()=>(window as any).proof.open('example.tools.first'));
 const tool=page.locator('.workbench-tool-route');await tool.locator('[data-fixture-page="first"]').waitFor();
 assert.equal(await page.getByRole('dialog').count(),0,'application tool owns a route, not a contextual modal');
 assert.equal(await page.locator('[data-fixture-page="desktop"]').count(),0);
 await page.evaluate(()=>(window as any).proof.open('example.tools.contextual'));
 await page.getByRole('dialog').locator('[data-fixture-page="contextual"]').waitFor();
 assert.equal(await page.locator('.workbench-tool-route').count(),0);
 await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.evaluate(()=>(window as any).proof.open('example.tools.first'));
 await tool.locator('[data-fixture-page="first"]').waitFor();
 const showSidebar=async()=>{const toggle=page.locator('[data-chrome-action-id="sidebar-toggle"]:visible').first();if(await toggle.count()&&(await toggle.getAttribute('aria-expanded'))!=='true')await toggle.click();};
 await showSidebar();
 assert.equal(await page.getByRole('button',{name:'Storage tool',exact:true}).count(),0,'internal entry hidden');
 assert.equal(await page.getByRole('button',{name:'Desktop-only tool',exact:true}).count(),0,'other platform hidden');
 await page.getByRole('button',{name:'示例工具',exact:true}).first().waitFor();
 await page.evaluate(()=>(window as any).proof.developer(true));
 await page.getByRole('button',{name:'Storage tool',exact:true}).first().waitFor();
 await page.getByRole('button',{name:'Storage tool',exact:true}).first().click();
 await tool.locator('[data-fixture-page="second"]').waitFor();
 await page.evaluate(()=>(window as any).proof.developer(false));
 await page.waitForFunction(()=>(window as any).proof.route().slug==='appearance');
 await page.evaluate(()=>(window as any).proof.open('example.tools.first'));
 await tool.locator('[data-fixture-page="first"]').waitFor();
 await mkdir(output,{recursive:true});
 for(const theme of ['light','dark'])for(const width of [1440,390]){
  await page.evaluate(theme=>(window as any).proof.theme(theme),theme);await page.setViewportSize({width,height:1000});
  const toggle=page.locator('[data-chrome-action-id="sidebar-toggle"]:visible').first();if(await toggle.count()&&await toggle.getAttribute('aria-expanded')==='true'&&width===390)await toggle.click();
  await page.mouse.move(width-5,100);await page.keyboard.press('Escape');
  await page.waitForFunction(()=>{const box=document.querySelector('.workbench-tool-route')!.getBoundingClientRect();return box.x>=0&&box.right<=innerWidth+1&&box.width>250;});
  const box=await tool.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width+1&&box.width>250,JSON.stringify({theme,width,box}));
  await page.screenshot({path:`${output}/${theme}-${width}.png`,fullPage:true});
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.evaluate(()=>(window as any).proof.retire());
 await page.locator('.workbench-tool-route').waitFor({state:'hidden'});
 await showSidebar();assert.equal(await page.getByRole('button',{name:'示例工具',exact:true}).count(),0);
 assert.equal(await page.locator('[data-fixture-page]').count(),0);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 assert.equal(await page.evaluate(()=>(window as any).proof.mode),withHost?'active':'hostless');
 console.log('PASS actual Workbench root: explicit tool route, contextual modal, localized navigation, developer/platform filtering, light/dark narrow geometry and contribution retirement');
 await writeFile(`${output}/browser.json`,JSON.stringify({mode:withHost?'active':'hostless',errors,external},null,2));
} finally {await browser?.close();await vite.close();}
