import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createServer, loadConfigFromFile } from 'vite';
import react from '@vitejs/plugin-react';
import { HostFileDownloads } from '../../../apps/opencraft-daemon/src/host-file-downloads.js';
import { createWorkbenchWebServer } from '../../serve-workbench-web.mjs';

const output=process.env.OPENCRAFT_HTML_PREVIEW_OUTPUT??await mkdtemp(join(tmpdir(),'html-preview-ui-'));
const report=process.env.OPENCRAFT_HTML_PREVIEW_REPORT;
if(!report)throw Error('Set OPENCRAFT_HTML_PREVIEW_REPORT to an HTML report');
const root=await mkdtemp(join(tmpdir(),'html-preview-host-'));await writeFile(join(root,'index.html'),'<!doctype html><title>Host</title>');
const files=new HostFileDownloads(host=>{if(host!=='local-codex')throw Error('Unknown Host');return 'local';});
const gateway=await createWorkbenchWebServer({root,appServerTarget:null,fileDownloads:files});
const address=await gateway.listen({host:'127.0.0.1',port:0});
const prefix='/servers/fixture', requests:string[]=[];
const runtime=`const runtime={resources:{host:{canRequest:()=>false},fileSystem:{getMetadata:async()=>({isFile:true,isDirectory:false,modifiedAtMs:0}),readDirectory:async()=>({entries:[]})}}};export const useAppServerRuntime=()=>runtime;export const useBlobResources=()=>window.blobs;export const useAppServerSnapshot=()=>({hostId:'local-codex',conversation:{execution:{cwd:'/',runtimeWorkspaceRoots:['/']}}});`;
const source=`import '/apps/workbench-web/src/runtime/web-crypto-compat.ts';import React from 'react';import {Context} from '@deepseek-ai/cordis';import {BlobResourceService} from '@opencraft/blob-resources';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';import {WorkspaceResourcePanel} from '/apps/workbench-web/src/panels/workspace-resource-panel.tsx';import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';import '/apps/workbench-web/src/styles/app.scss';initializeAppearanceTheme();setThemePreference(location.search.includes('dark')?'dark':'light');const c=new Context();await c.plugin(BlobResourceService);window.blobs=c.blobResources;createIntlTestRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><div style={{height:'100vh'}}><WorkspaceResourcePanel ownerId='preview-test' active previewOnly tab={{id:'report',kind:'resource',title:'Report',resource:${JSON.stringify(report)},region:'right',closable:true,preview:false}}/></div></QueryClientProvider>);`;
const config=await loadConfigFromFile({command:'serve',mode:'development'},resolve('apps/workbench-web/vite.config.ts'));if(!config)throw Error('No Vite config');
const vite=await createServer({configFile:false,root:process.cwd(),cacheDir:join(output,'vite-cache'),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic'},optimizeDeps:{...config.config.optimizeDeps,entries:[]},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[react(),{name:'html-preview-fixture',enforce:'pre',resolveId(id,importer){if(id.endsWith('/appserver-runtime-context')&&importer?.includes('/panels/'))return '/preview-runtime.ts';return ['/preview-runtime.ts','/preview-fixture.tsx'].includes(id)?id:null;},load:id=>id==='/preview-runtime.ts'?runtime:id==='/preview-fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{
 if(req.url?.startsWith(prefix+'/__opencraft_')){requests.push(req.url.split('#')[0]!);const upstream=httpRequest({host:'127.0.0.1',port:address.port,path:req.url.slice(prefix.length),method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode!,r.headers);r.pipe(res);});upstream.on('error',()=>{res.statusCode=502;res.end();});req.pipe(upstream);return;}
 if(req.url?.split('?')[0]!=='/')return next();
 res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script id="opencraft-deployment-config" type="application/json">'+JSON.stringify({hosts:[],builtinAgents:false,hypernode:false,fileDownloads:true,htmlPreviews:!req.url?.includes('disabled')})+'</script><script id="opencraft-server-context" type="application/json">'+JSON.stringify({id:'fixture',name:'Fixture',basePath:prefix,selectorPath:'/servers'})+'</script><div id="root"></div><script type="module" src="/preview-fixture.tsx"></script>');
 });}}]});
let browser:any;
try{
 await vite.listen();const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const origin='http://127.0.0.1:'+(vite.httpServer!.address() as any).port,evidence=[];
 for(const [width,theme] of [[1280,'light'],[390,'dark']] as const){
  console.log('checking',width,theme);
  const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<700});const page=await context.newPage(),errors:string[]=[];
  page.on('pageerror',(e:Error)=>errors.push(e.message));await page.addInitScript('window.__name=value=>value');await page.goto(origin+'/?'+theme);
  const button=page.locator('header').getByRole('button',{name:'Open in browser',exact:true});await button.waitFor({timeout:60000});
  await page.getByRole('link',{name:'Download file',exact:true}).waitFor();
  await page.screenshot({path:join(output,`header-${width}-${theme}.png`)});
  const opened=page.waitForEvent('popup');if(width<700)await button.tap();else await button.click();const popup=await opened;
  await popup.waitForURL('**/s/*/',{timeout:60000});assert.ok(new URL(popup.url()).pathname.startsWith(prefix+'/__opencraft_preview/s/'));
  const frame=popup.frameLocator('iframe');await frame.locator('summary').first().waitFor();
  const count=await frame.locator('details').count();assert.ok(count>0);
  const expand=frame.getByRole('button',{name:'全部展开',exact:true});await expand.click();assert.equal(await frame.locator('details[open]').count(),count);
  await frame.getByRole('button',{name:'全部收起',exact:true}).click();assert.equal(await frame.locator('details[open]').count(),0);
  await frame.locator('summary').first().click();await frame.locator('img').first().scrollIntoViewIfNeeded();assert.equal(await frame.locator('img').first().evaluate(async(e:HTMLImageElement)=>{await e.decode();return e.naturalWidth>0;}),true);
  assert.equal(await frame.locator('body').evaluate(()=>{try{return Boolean(parent.document)}catch{return false}}),false);
  await popup.reload();await frame.locator('summary').first().waitFor();
  await popup.screenshot({path:join(output,`report-${width}-${theme}.png`)});
  assert.equal(await popup.evaluate(()=>window.opener===null),true);
  assert.deepEqual(errors,[]);evidence.push({width,theme,details:count,prefix:true,refresh:true,openerRevoked:true,errors});await context.close();
 }
 const page=await browser.newPage();await page.addInitScript('window.__name=value=>value');await page.goto(origin+'/?disabled');await page.getByRole('link',{name:'Download file',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Open in browser',exact:true}).count(),0);await page.close();
 assert.ok(requests.some(p=>p===prefix+'/__opencraft_preview/tickets'));assert.ok(requests.some(p=>p===prefix+'/__opencraft_preview/redeem'));
 assert.ok(requests.every(p=>!p.includes('#ticket=')));
 await writeFile(join(output,'ui-proof.json'),JSON.stringify({passed:true,evidence,capabilityAbsentHidesAction:true,pathsContainNoTickets:true,scope:'real resource panel + real file/gateway authority; only Host metadata is synthetic'},null,2));console.log(JSON.stringify({passed:true,evidence,output}));
}finally{await browser?.close();await vite.close();files.close();await gateway.close();await rm(root,{recursive:true,force:true});}
