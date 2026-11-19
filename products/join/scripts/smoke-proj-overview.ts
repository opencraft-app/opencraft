/** Real Shell and actual app declarations, with synthetic service boundaries. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createServer, build as buildWeb, type UserConfig } from 'vite';
import { productPluginPacks } from '../../../apps/workbench-web/product-plugin-packs.vite';
import { joinProductPluginBuilds } from '../plugin-packs/builds.mjs';
import { splitProductPluginPacks, prepareProductPluginPacks, openProductPluginAssets } from '../../../scripts/web-deployment/product-plugin-packs.mjs';
import { createWorkbenchWebServer } from '../../../scripts/workbench-web-server.mjs';
import { ioaSmokeAliases, ioaSmokeRoots } from './ioa-smoke-workspace';
const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.OPENCRAFT_SIDEBAR_APPS_OUTPUT ?? '/tmp/join-proj-overview';
await mkdir(output, { recursive: true });
const externalPack = process.env.OPENCRAFT_SMOKE_PRODUCT_PLUGIN_PACK === '1';
const buildProduct = externalPack
  ? (await import(createRequire(new URL('../../../package.json', import.meta.url)).resolve('vite'))).build : buildWeb;
let source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {localeCatalogs} from '/apps/workbench-web/src/i18n/catalogs.ts';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {createProjectOverviewExtension} from '/@fs/${process.cwd()}/products/join/plugins/proj-overview/src/index.ts';
import {messages} from '/@fs/${process.cwd()}/products/join/plugins/proj-overview/src/messages.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const now=Date.now(), titles=['会话断线后自动重连','任务中断后从断点恢复','接入自选股行情数据','App 首次使用引导'];
const ids=['c0c31409-2ac9-4b9d-bc27-9c3599a3929b','b4623242-d024-4e61-8a0c-bdb490749dae','new-finance','7c790706-fb0b-445e-8055-b8b2523038a4'];
const tasks=titles.map((title,k)=>({id:ids[k],title,description:'已有上下文完整保留',acceptanceCriteria:'在原会话核对验收结果',status:k===3?'todo':'in_review',kind:'feature',createdAt:now-86400000,updatedAt:now,deletedAt:null,revision:1,assigneeId:k%2?'mason':'walker',projectServerId:null,projectId:null,conversations:k===3?[]:[{serverId:'opencraft-server',threadId:'t'+k,createdAt:now-86400000}]}));
let fail=false;const client={connectionGeneration:1,initializeResult:{capabilities:{extensions:{}}},subscribeNotification:()=>()=>{},request:async(method,params)=>{
 if(fail&&method==='opencraft/tasks/list')throw Error('network');
 if(method==='opencraft/tasks/list')return {tasks,members:[{id:'walker',name:'Walker',revision:1},{id:'mason',name:'Mason',revision:1}]};
 if(method==='opencraft/tasks/events/list')return {events:[{eventId:params.taskId+'-created',seq:1,type:'created',createdAt:now-86400000,payload:{status:'in_review'}},{eventId:params.taskId+'-progress',seq:2,type:'progress',createdAt:now-36000000,payload:{text:'AI_RESEARCH_HANDOFF_V1\\n'+JSON.stringify({output:'完成调研',decision:'是否采用当前方案？',nextStep:'确认后继续开发'})}}],nextBeforeSeq:null};
 if(method==='thread/read')return {thread:{id:params.threadId,name:'事项共享会话 '+params.threadId,updatedAt:now/1000,status:params.threadId==='t1'?{type:'active',activeFlags:[]}:{type:'idle'}}};
 if(method==='thread/turns/list')return {data:[{id:'turn',items:[]}],nextCursor:null};
 if(method==='thread/items/list')return {data:[{turnId:'turn',item:{type:'plan',id:'plan',text:'- [x] 形成方案\\n- [ ] 完成验收'}}],nextCursor:null};
 if(method==='opencraft/token-usage/query')return {scope:'team',canQueryTeam:true,snapshotRevision:1,coverage:{enabled:true,partial:false},rows:[{key:'t0',tokens:'120000'},{key:'t1',tokens:'48000'},{key:'t2',tokens:'180000'}],nextCursor:null};
 throw Error(method)
}};
document.getElementById('opencraft-deployment-config')?.remove();const config=document.createElement('script');config.id='opencraft-deployment-config';config.type='application/json';config.textContent=JSON.stringify({hosts:[{hostId:'fixture-host',label:'Fixture Host',kind:'remote-ssh',url:location.origin.replace('http','ws')+'/fixture-rpc'}],builtinAgents:false,hypernode:false});document.head.append(config);
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct([],false)});
const extension=createProjectOverviewExtension(()=>client),original=extension.activate;
await application.supervisor.extensions.activate({...extension,activate:api=>original({...api,internal:{...api.internal,register:(channel,value)=>{if(channel==='platformViewRenderer'){const Actual=value.Component;return api.internal.register(channel,{...value,Component:props=><Actual {...props} host={{...props.host,currentUser:{providerId:'fixture',id:'walker',handle:'walker'},openConversation:(serverId,threadId)=>{window.opened=[serverId,threadId]}}}/>})}return api.internal.register(channel,value)}}})});
const catalogs=localeCatalogs.map(c=>({...c,load:async()=>({...await c.load(),...Object.fromEntries(Object.entries(messages).map(([key,pair])=>['join.projOverview.'+key,pair[c.locale==='zh-CN'?0:1]]))})}));
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN',catalogs).render(<WorkbenchRoot application={application}/>);
window.proof={theme:setThemePreference,fail:()=>fail=true,deactivate:()=>application.supervisor.extensions.deactivate('join.proj-overview')};document.body.dataset.ready='true';`;
if (externalPack) source = source
  .replace("import {createProjectOverviewExtension} from", "import projectOverview from")
  .replace('/plugins/proj-overview/src/index.ts', '/plugin-packs/proj-overview-registration.ts')
  .replace(/import \{messages\} from [^;]+;/, '')
  .replace('const extension=createProjectOverviewExtension(()=>client)', 'const extension=await projectOverview.load({fetcher:fetch,getClient:()=>client})')
  .replace("Object.fromEntries(Object.entries(messages).map(([key,pair])=>['join.projOverview.'+key,pair[c.locale==='zh-CN'?0:1]]))", "await projectOverview.localeCatalogs.find(catalog=>catalog.locale===c.locale).load()");
const config = {configFile:false as const,root:process.cwd(),publicDir:'apps/workbench-web/public',cacheDir:output+'/vite-cache',logLevel:'error' as const,
  define:{'import.meta.env.VITE_OPENCRAFT_PRESENTATION':JSON.stringify(JSON.stringify({iconStyle:'classic'})),'process.env.NEXT_PUBLIC_REGION':'"cn"','process.env.NEXT_PUBLIC_PREVIEW_LOCALES':'""','import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN':'"false"','import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN':'"false"'},
  esbuild:{jsx:'automatic'},resolve:{alias:ioaSmokeAliases,dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false,fs:{allow:ioaSmokeRoots}},
  plugins:[{name:'sidebar-apps-proof',resolveId:id=>id==='/proof.tsx'?id:null,async load(id){
    if(id==='/proof.tsx')return source;
    if(!externalPack&&/\/packages\/(browser-core|remote-interaction)\/src\/.*\.cjs$/.test(id)){
      const names=Object.keys(require(id));const bundled=await build({stdin:{resolveDir:process.cwd(),contents:`export {${names.join(',')}} from ${JSON.stringify(id)}`},bundle:true,format:'esm',platform:'browser',write:false});return bundled.outputFiles[0].text;
    }return null;
  },configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/proof.tsx"></script>');});}}]} satisfies UserConfig;
let vite: Awaited<ReturnType<typeof createServer>> | undefined, packed: Awaited<ReturnType<typeof createWorkbenchWebServer>> | undefined, base: string;
if (externalPack) {
  await rm(output+'/payload',{recursive:true,force:true});
  const proofRoot=process.cwd()+'/.runtime/product-plugin-proof';await mkdir(proofRoot,{recursive:true});
  await writeFile(proofRoot+'/index.html', '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/proof.tsx"></script></body></html>');
  try { await buildProduct({...config,worker:{format:'es'},plugins:[...config.plugins,productPluginPacks(joinProductPluginBuilds)],build:{outDir:output+'/web',emptyOutDir:true,rollupOptions:{input:proofRoot+'/index.html'}}}); }
  finally { await rm(proofRoot,{recursive:true,force:true}); }
  await rename(output+'/web/.runtime/product-plugin-proof/index.html',output+'/web/index.html');
  await splitProductPluginPacks(output+'/web',output+'/payload');
  await prepareProductPluginPacks({sourceDirectory:output+'/payload',cacheDirectory:output+'/persistent',webRoot:output+'/web'});
  packed=await createWorkbenchWebServer({root:output+'/web',appServerTarget:null,productPluginAssets:await openProductPluginAssets(output+'/persistent')});
  const address=await packed.listen({host:'127.0.0.1',port:0});base='http://127.0.0.1:'+address.port;
} else { vite=await createServer(config);await vite.listen();base=vite.resolvedUrls!.local[0]!; }

let browser:any;const report=[];try{browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
for(const width of [1440,390])for(const theme of ['light','dark']){
const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390,isMobile:width===390}),page=await context.newPage();const errors:string[]=[];page.on('pageerror',(e:Error)=>{errors.push(e.message);console.error(e.message)});await page.addInitScript(() => { (window as any).__name=(value:any)=>value; localStorage.setItem('opencraft.onboarding.completedAt','2026-11-11T00:00:00.000Z'); });await page.goto(base,{timeout:90000});await page.locator('body[data-ready=true]').waitFor({timeout:90000});await page.evaluate(t=>(window as any).proof.theme(t),theme);
const toggle=page.locator('[data-app-shell-sidebar-trigger=true]:visible').first();if(await toggle.count()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();await page.waitForTimeout(500);await page.screenshot({path:output+'/entry.png'});await writeFile(output+'/entry.txt',await page.locator('body').innerText());await page.locator('[data-action-id="shell.applications"]:visible,[data-action-id="shell.applications.header"]:visible').first().click();await page.locator('[data-sidebar-miniapp-id="join.proj-overview.navigation"]:visible').click();await page.getByRole('heading',{name:'项目视图',exact:true}).waitFor();await page.waitForTimeout(1500);
await page.screenshot({path:output+'/'+width+'-'+theme+'.png'});assert.equal(await page.locator('.proj-overview__row.is-heading span').nth(1).textContent(),'进度状态');
await page.getByRole('button',{name:'通用任务稳定性与运行底座',exact:true}).first().click();
await page.getByRole('button',{name:'会话断线后自动重连',exact:true}).first().click();await page.getByRole('dialog',{name:'会话断线后自动重连'}).waitFor();assert.equal(await page.locator('.proj-overview__drawer h3').filter({hasText:'经过'}).count(),0);assert.equal(await page.locator('.proj-overview__todo').count(),2);await page.getByRole('button',{name:'进入会话',exact:true}).last().click();assert.deepEqual(await page.evaluate(()=>(window as any).opened),['opencraft-server','t0']);await page.screenshot({path:output+'/'+width+'-'+theme+'-drawer.png'});await page.getByRole('button',{name:'关闭',exact:true}).last().click();
await page.getByRole('combobox',{name:'进度状态',exact:true}).selectOption('unfollowed');assert.ok((await page.locator('.proj-overview__read-status').textContent())?.includes('1'));await page.getByRole('combobox',{name:'进度状态',exact:true}).selectOption('');await page.getByRole('button',{name:'我的',exact:true}).click();assert.ok((await page.locator('.proj-overview__read-status').textContent())?.includes('2'));
assert.ok(await page.locator('.proj-overview').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
if(externalPack){assert.ok(await page.locator('link[data-opencraft-product-plugin-style=true]').count());const coreStyles=await page.locator('link[rel="stylesheet"]:not([data-opencraft-product-plugin-style])').count();await page.evaluate(()=>(window as any).proof.deactivate());assert.equal(await page.locator('.proj-overview').count(),0);assert.equal(await page.locator('link[data-opencraft-product-plugin-style=true]').count(),0);assert.equal(await page.locator('link[rel="stylesheet"]:not([data-opencraft-product-plugin-style])').count(),coreStyles);}
assert.deepEqual(errors,[]);report.push({width,theme,navigation:true,drawer:true,todos:2,filters:true,externalPack,errors});await context.close()}
await writeFile(output+'/report.json',JSON.stringify(report,null,2));}finally{await browser?.close();await vite?.close();await packed?.close()}
