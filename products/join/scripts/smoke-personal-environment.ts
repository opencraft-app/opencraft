import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import('playwright');
const output = '.local/personal-env-proof';
const source = `
import React from 'react';
import {IntlProvider} from 'react-intl';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {identityWorkbenchExtension} from '/products/join/identity-web.ts';
import {embeddedLocaleCatalogs} from '/apps/workbench-web/src/i18n/catalogs.ts';
import productMessages from '/products/join/plugins/tencentoa/src/locales/zh-CN.json';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const messages={...await embeddedLocaleCatalogs.find(c=>c.locale==='zh-CN').load(),...productMessages};
let doc={projectId:null,revision:0,variables:[],inherited:[],projects:[]};
const fetcher=async(url,options={})=>{
if(url==='/__opencraft_enterprise_identity/session')return Response.json({available:true,identity:{staffId:'101',loginName:'fixture',expiresAt:new Date(Date.now()+3600000).toISOString()}});
if(!String(url).startsWith('/__opencraft_enterprise_identity/environment-variables'))return new Response(null,{status:404});
if(options.method==='POST'){const input=JSON.parse(options.body);doc={...doc,revision:doc.revision+1,variables:input.variables.map(row=>({...row,value:row.secret?null:row.value}))};}return Response.json(doc);};
const app=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
await app.supervisor.extensions.activate(await identityWorkbenchExtension.load({fetcher,getClient:()=>undefined}));
app.supervisor.navigation.openSettings('tencentoa.identity.environment');
window.proof={theme:setThemePreference};
createIntlTestRoot(document.getElementById('root')).render(<IntlProvider locale="zh-CN" messages={messages}><WorkbenchRoot application={app}/></IntlProvider>);
`;
const vite=await createServer({configFile:false,cacheDir:output+'/vite-cache',root:process.cwd(),publicDir:'apps/workbench-web/public',logLevel:'error',
 define:{'process.env.NEXT_PUBLIC_REGION':'"cn"','process.env.NEXT_PUBLIC_PREVIEW_LOCALES':'""','import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN':'"false"','import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN':'"false"'},
 esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'fixture-cjs',transform(code,id){if(id.endsWith('.cjs')&&id.includes('/packages/'))return code.replace('module.exports =','export').replace(/const (\{[^}]+\}) = require\(([^)]+)\);/g,'import $1 from $2;');}},{name:'personal-env-fixture',resolveId:id=>id==='/proof.tsx'?id:null,load:id=>id==='/proof.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/proof.tsx"></script>');});}}]});
let browser:any;
try {
 await vite.listen();await mkdir(output,{recursive:true});
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const touch of [false,true]) {
  const page=await browser.newPage({viewport:{width:touch?390:1280,height:900},hasTouch:touch,isMobile:touch});
  const errors:string[]=[];page.on('pageerror',error=>{errors.push(error.message);console.error(error.message)});
  await page.goto(vite.resolvedUrls!.local[0]);
  const add=page.getByRole('button',{name:'添加变量',exact:true});await add.waitFor({timeout:30000}).catch(async e=>{console.error((await page.locator('body').innerText()).slice(0,4000));throw e});
  if(touch)await add.tap();else await add.click();
  await page.getByLabel('名称',{exact:true}).fill('SERVICE_KEY');
  const password=page.getByLabel('值',{exact:true});await password.fill('synthetic-secret');
  assert.equal(await password.getAttribute('type'),'password');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('button',{name:'修改 SERVICE_KEY'}).waitFor();
  assert.equal((await page.locator('body').innerText()).includes('synthetic-secret'),false);
  for(const theme of ['light','dark']) {await page.evaluate(theme=>(window as any).proof.theme(theme),theme);await page.screenshot({path:output+'/'+(touch?'touch':'desktop')+'-'+theme+'.png',fullPage:true});}
  await page.getByRole('button',{name:'修改 SERVICE_KEY'}).click();
  assert.equal(await page.getByLabel('值',{exact:true}).inputValue(),'');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'删除 SERVICE_KEY'}).click();
  await page.getByRole('button',{name:'修改 SERVICE_KEY'}).waitFor({state:'detached'});
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Personal ENV: actual settings route, desktop/touch, light/dark, add/masked save/edit/cancel/delete passed');
} finally {await browser?.close();await vite.close();}
