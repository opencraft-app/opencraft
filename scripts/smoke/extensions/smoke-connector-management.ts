import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const imported = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = imported.default ?? imported;
const output = ".local/connector-management";
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const config=document.createElement('script');config.id='opencraft-deployment-config';config.type='application/json';config.textContent=JSON.stringify({hosts:[{hostId:'fixture-host',label:'Fixture Host',kind:'remote-ssh',url:location.origin.replace('http','ws')+'/fixture-rpc'}],builtinAgents:false,hypernode:false});document.head.append(config);
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
const supervisor=application.supervisor, nav=supervisor.navigation;
const definition={manifest:{manifestVersion:1,id:'example.connectors',name:'Connector manager',version:'1.0.0',apiVersion:1,trust:'trusted',platforms:['web','electron'],activationEvents:['onStartupFinished']},activate(api){
 api.views.register({id:'example.connectors.view',title:'Connector library',viewType:'example.connectors.surface',role:'connector-management'});
 api.settings.registerPage({id:'example.connectors.library',title:'Connector library',viewId:'example.connectors.view'});
 api.internal.register('platformViewRenderer',{viewType:'example.connectors.surface',Component:()=>React.createElement('div',{'data-connector-library':true},'Connector library content')});
}};
createIntlTestRoot(document.getElementById('app')).render(<WorkbenchRoot application={application}/>);
window.proof={activate:()=>supervisor.extensions.activate(definition),retire:()=>supervisor.extensions.deactivate('example.connectors'),route:()=>nav.getSnapshot().applicationRoute,chat:()=>nav.openChat()};
document.body.dataset.ready='true';
`;
const vite=await createServer({configFile:false,cacheDir:output+'/vite-cache',root:process.cwd(),logLevel:'error',
 define:{'process.env.NEXT_PUBLIC_REGION':'"cn"','process.env.NEXT_PUBLIC_PREVIEW_LOCALES':'""','import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN':'"false"','import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN':'"false"'},
 esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'connector-management-fixture',resolveId:id=>id==='/proof.tsx'?id:null,load:id=>id==='/proof.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<div id="app"></div><script type="module" src="/proof.tsx"></script>');});}}]});
let browser:any; const errors:string[]=[],external:string[]=[];
try {
 await vite.listen();const url=vite.resolvedUrls!.local[0],origin=new URL(url).origin;
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(external.push(route.request().url()),route.abort()));
 await page.goto(url);await page.locator('body[data-ready="true"]').waitFor({timeout:60000});
 const openPicker=async()=>{await page.getByRole('button',{name:'Add',exact:true}).click();await page.getByRole('menuitem',{name:'Connectors',exact:true}).hover();await page.locator('.connector-quick-menu:visible').waitFor();};
 await openPicker();assert.equal(await page.getByRole('menuitem',{name:'Manage connectors',exact:true}).count(),0);
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');
 await page.evaluate(()=>(window as any).proof.activate());
 await openPicker();await page.getByRole('menuitem',{name:'Manage connectors',exact:true}).click();
 await page.locator('[data-connector-library]').waitFor();
 assert.equal(await page.evaluate(()=>(window as any).proof.route().slug),'example.connectors.library');
 await mkdir(output,{recursive:true});await page.screenshot({path:output+'/managed.png',fullPage:true});
 await page.evaluate(()=>(window as any).proof.chat());
 await openPicker();await page.evaluate(()=>(window as any).proof.retire());
 await page.getByRole('menuitem',{name:'Manage connectors',exact:true}).waitFor({state:'hidden'});
 assert.equal(await page.evaluate(()=>(window as any).proof.route().kind),'conversation');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 await writeFile(output+'/browser.json',JSON.stringify({errors,external,checks:['unavailable-hidden','contributed-page-opened','retirement-while-menu-open']},null,2));
 console.log('PASS actual Workbench App + Composer connector menu: absent owner hidden, contributed page navigation, open-menu retirement');
} finally {await browser?.close();await vite.close();}
