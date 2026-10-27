import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const imported = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = imported.default ?? imported;
const output = ".local/contributed-navigation-copy";
const source = `
import React,{useState} from 'react';
import {IntlProvider,createIntl} from 'react-intl';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {embeddedLocaleCatalogs} from '/apps/workbench-web/src/i18n/catalogs.ts';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const messages=Object.fromEntries(await Promise.all(['en-US','zh-CN','ms-MY','th-TH'].map(async id=>[id,await embeddedLocaleCatalogs.find(c=>c.locale===id).load()])));
const config=document.createElement('script');config.id='opencraft-deployment-config';config.type='application/json';config.textContent=JSON.stringify({hosts:[{hostId:'fixture-host',label:'Fixture Host',kind:'remote-ssh',url:location.origin.replace('http','ws')+'/fixture-rpc'}],builtinAgents:false,hypernode:false});document.head.append(config);
const app=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
const supervisor=app.supervisor,nav=supervisor.navigation;let clicks=0;
await supervisor.extensions.activate({manifest:{manifestVersion:1,id:'example.copy',name:'Navigation copy',version:'1.0.0',apiVersion:1,trust:'trusted',platforms:['web','electron'],activationEvents:['onStartupFinished']},activate(api){
 const viewId='example.copy.view';
 api.views.register({id:viewId,title:'Example view',viewType:'example.copy.surface'});
 api.commands.register({id:'example.copy.click',title:'Count'},()=>{clicks++});
 api.navigation.register({id:'example.copy.nav',title:'Fallback navigation',titleMessage:{id:'sidebar.rail.collaboration',defaultMessage:'Collaboration'},shortTitleMessage:{id:'sidebar.rail.collaboration.short',defaultMessage:'Collab'},badgeMessage:{id:'navigation.tryIt',defaultMessage:'Try it'},surface:'sidebar-primary',target:{kind:'command',commandId:'example.copy.click'}});
 api.navigation.register({id:'example.copy.plain',title:'Plain extension',surface:'sidebar-primary',target:{kind:'command',commandId:'example.copy.click'}});
 api.settings.registerPage({id:'example.copy.library',title:'Fallback library',titleMessage:{id:'sidebar.rail.storage',defaultMessage:'Cloud storage'},shortTitleMessage:{id:'sidebar.rail.storage.short',defaultMessage:'Files'},viewId,management:{familyId:'example.copy.manage',scope:'host',entryPoint:'workbench'}});
 api.internal.register('platformViewRenderer',{viewType:'example.copy.surface',Component:()=>React.createElement('input',{'aria-label':'Retained draft',defaultValue:'Keep my work'})});
}});
nav.openSettings('example.copy.library');
window.proof={theme:setThemePreference,retire:()=>supervisor.extensions.deactivate('example.copy'),clicks:()=>clicks,copy:locale=>{const intl=createIntl({locale,messages:messages[locale]});return ['sidebar.rail.collaboration','sidebar.rail.collaboration.short','navigation.tryIt','sidebar.rail.storage','sidebar.rail.storage.short'].map((id,i)=>intl.formatMessage({id,defaultMessage:['Collaboration','Collab','Try it','Cloud storage','Files'][i]}))}};
function Fixture(){const[locale,setLocale]=useState('en-US');window.proof.locale=setLocale;return <IntlProvider locale={locale} messages={messages[locale]}><WorkbenchRoot application={app}/></IntlProvider>}
createIntlTestRoot(document.getElementById('root')).render(<Fixture/>);
document.body.dataset.ready='true';
`;
const vite=await createServer({configFile:false,cacheDir:output+'/vite-cache',root:process.cwd(),publicDir:'apps/workbench-web/public',logLevel:'error',
 define:{'process.env.NEXT_PUBLIC_REGION':'"cn"','process.env.NEXT_PUBLIC_PREVIEW_LOCALES':'""','import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN':'"false"','import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN':'"false"'},
 esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'navigation-copy-fixture',resolveId:id=>id==='/proof.tsx'?id:null,load:id=>id==='/proof.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/proof.tsx"></script>');});}}]});
let browser:any;const errors:string[]=[],external:string[]=[];
try {
 await vite.listen();const url=vite.resolvedUrls!.local[0],origin=new URL(url).origin;
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000},hasTouch:true,isMobile:true});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():(external.push(r.request().url()),r.abort()));
 await page.goto(url);await page.locator('body[data-ready="true"]').waitFor({timeout:60000});
 const draft=page.getByRole('textbox',{name:'Retained draft'});await draft.fill('Retained through locale and geometry');
 const showSidebar=async()=>{const toggle=page.locator('.app-shell-root [data-chrome-action-id="sidebar-toggle"]:visible').last();if(await toggle.count()&&(await toggle.getAttribute('aria-expanded'))!=='true')await toggle.click();};
 const locales=['en-US','zh-CN','ms-MY','th-TH'];
 await mkdir(output,{recursive:true});
 const observed=[];
 for(const locale of locales){
  await page.evaluate(locale=>(window as any).proof.locale(locale),locale);await showSidebar();
  const item=page.locator('[data-action-id="example.copy.nav"]');await item.waitFor();
  const tool=page.locator('[data-action-id="example.copy.library"]');await tool.waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-action-id="example.copy.nav"]')?.getAttribute('aria-label')!=='Fallback navigation');
  const actual=await item.evaluate(el=>({full:el.getAttribute('aria-label'),short:el.querySelector('.shell-navigation__item-label--short')?.textContent,badge:el.querySelector('small')?.textContent}));
  const toolCopy=await tool.evaluate(el=>({full:el.getAttribute('aria-label'),short:el.querySelector('.shell-navigation__item-label--short')?.textContent}));
  observed.push({locale,actual,toolCopy});
  // Locale catalogs are the authority; record their actual full and compact
  // labels rather than asserting guessed translations for every locale.
  const catalogCopy=await page.evaluate(locale=>(window as any).proof.copy(locale),locale);
  assert.deepEqual([actual.full,actual.short,actual.badge,toolCopy.full,toolCopy.short],catalogCopy);
  assert.equal(await page.locator('[data-action-id="example.copy.plain"] small').count(),0);
  assert.equal(await draft.inputValue(),'Retained through locale and geometry');
  for(const theme of ['light','dark'])for(const width of [1440,390]){
   await page.evaluate(theme=>(window as any).proof.theme(theme),theme);await page.setViewportSize({width,height:1000});
   await page.waitForFunction(width=>Math.abs(document.querySelector('.app-shell-root').getBoundingClientRect().width-width)<1,width);
   await page.waitForFunction(width=>{const w=document.querySelector('.app-shell-sidecar')?.getBoundingClientRect().width??0;return width===390?w<1:w>1;},width);
   await showSidebar();
   if(width===390){await item.locator('.shell-navigation__item-label--full').waitFor({state:'visible'});await item.locator('small').waitFor({state:'visible'});await page.waitForFunction(()=>{const badge=document.querySelector('[data-action-id="example.copy.nav"] small');const r=badge.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&badge.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));});}
   await page.screenshot({path:output+'/'+locale+'-'+theme+'-'+width+'.png',fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
 }
 await page.locator('[data-action-id="example.copy.nav"]').click();await page.waitForFunction(()=>(window as any).proof.clicks()===1);
 await page.evaluate(()=>(window as any).proof.retire());await page.locator('[data-action-id="example.copy.nav"]').waitFor({state:'hidden'});await page.locator('[data-action-id="example.copy.library"]').waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 await writeFile(output+'/browser.json',JSON.stringify({observed,errors,external},null,2));
 console.log('PASS real Workbench navigation: contributed full/compact/badge copy, live locale changes, preserved draft, light/dark desktop/mobile, command action and retirement');
}finally{await browser?.close();await vite.close();}
