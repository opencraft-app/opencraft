import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const output=await mkdtemp(join(tmpdir(),'opencraft-file-tree-toggle-'));
// A self-contained PDF fixture exercises the real PDF viewer, not a mock panel.
function pdfFixture() {
 const content='BT /F1 20 Tf 30 330 Td (PDF tree preview) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let pdf='%PDF-1.4\n';const offsets=[0];
 for(const [i,object] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;}
 const xref=Buffer.byteLength(pdf);
 pdf+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
 return Buffer.from(pdf).toString('base64');
}
const runtime=`
const reads=[];window.fixtureReads=reads;
const runtime={resources:{host:{canRequest:method=>method==='fuzzyFileSearch/sessionStart'},fileSystem:{
async getMetadata(){return {isFile:true,isDirectory:false,modifiedAtMs:0,size:100}},
async readFile(path){reads.push(path);return {dataBase64:path.endsWith('.pdf')?'${pdfFixture()}':btoa('<html><body><h1>Persistent preview</h1><p>'+path+'</p></body></html>')}},
async readDirectory(path){return {entries:path==='/fixture'? [{fileName:'report.pdf',isDirectory:false,isFile:true},{fileName:'nested',isDirectory:true,isFile:false},...Array.from({length:35},(_,i)=>({fileName:'report-'+i+'.html',isDirectory:false,isFile:true}))]:[{fileName:'child.html',isDirectory:false,isFile:true}]}},
async createFuzzyFileSearchSession(options){return {update:async()=>{options.onUpdated({files:[{root:'/fixture',path:'report-0.html',file_name:'report-0.html',match_type:'file'}]});options.onCompleted()},stop:async()=>{}}}
}}};
export const useAppServerRuntime=()=>runtime;
export const useBlobResources=()=>window.fixtureBlobs;
export const useAppServerSnapshot=()=>({hostId:'tree-fixture',conversation:{execution:{cwd:'/fixture',runtimeWorkspaceRoots:['/fixture']}}});`;
const source=`
import '/apps/workbench-web/src/runtime/web-crypto-compat.ts';
import React from 'react';import {Context} from '@deepseek-ai/cordis';import {BlobResourceService} from '@opencraft/blob-resources';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {WorkspaceResourcePanel} from '/apps/workbench-web/src/panels/workspace-resource-panel.tsx';
import '/apps/workbench-web/src/styles/app.scss';
const context=new Context();await context.plugin(BlobResourceService);window.fixtureBlobs=context.blobResources;
createIntlTestRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><div style={{height:'100vh'}}><WorkspaceResourcePanel tab={{id:'file',kind:'resource',title:'report',resource:location.search.includes('pdf')?'/fixture/report.pdf':'/fixture/report-0.html',region:'right',closable:true,preview:false}}/></div></QueryClientProvider>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[react(),{name:'file-tree-fixture',enforce:'pre',resolveId(id,importer){if(id.endsWith('/appserver-runtime-context')&&importer?.includes('/panels/'))return '/tree-runtime.ts';return ['/tree-runtime.ts','/tree-fixture.tsx'].includes(id)?id:null},load:id=>id==='/tree-runtime.ts'?runtime:id==='/tree-fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tree-fixture.tsx"></script>')})}}]});
let browser:any;
try{
await vite.listen();const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');browser=await chromium.launch({headless:true});
const evidence=[];
for(const width of [1000,390])for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height:800}});const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.addInitScript('window.__name=value=>value');
 await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port);await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 const hide=page.getByRole('button',{name:'Hide file tree',exact:true}),show=page.getByRole('button',{name:'Show file tree',exact:true});
 await page.frameLocator('iframe').getByRole('heading',{name:'Persistent preview'}).waitFor();
 assert.equal(await show.getAttribute('aria-expanded'),'false');
 assert.equal(await page.locator('.workspace-file-browser').isVisible(),false);
 assert.ok((await page.locator('.workspace-file-viewer').boundingBox())!.width>=width-1);
 await show.click();
 await page.getByRole('treeitem',{name:'nested',exact:true}).click();await page.getByRole('treeitem',{name:'child.html',exact:true}).waitFor();
 const tree=page.getByRole('tree',{name:'Workspace files'});await tree.evaluate((e:HTMLElement)=>e.scrollTop=100);
 const scroll=await tree.evaluate((e:HTMLElement)=>e.scrollTop);const initial=await page.locator('.workspace-file-viewer').boundingBox();
 await page.evaluate(()=>{(window as any).savedFrame=document.querySelector('iframe')});
 await hide.click();assert.equal(await show.getAttribute('aria-expanded'),'false');assert.equal(await page.locator('.workspace-file-browser').isVisible(),false);
 const closed=await page.locator('.workspace-file-viewer').boundingBox();assert.ok(closed!.width>initial!.width+100);assert.ok(closed!.width>=width-1,'no empty tree track');
 assert.equal(await page.evaluate(()=>document.querySelector('iframe')===(window as any).savedFrame),true,'preview stays mounted');
 await show.click();assert.equal(await hide.getAttribute('aria-expanded'),'true');assert.equal(await tree.evaluate((e:HTMLElement)=>e.scrollTop),scroll);await page.getByRole('treeitem',{name:'child.html',exact:true}).waitFor();
 const search=page.getByRole('textbox',{name:'Search workspace files'});await search.fill('report');await page.locator('.workspace-file-search-result').waitFor();await hide.click();await show.click();assert.equal(await search.inputValue(),'report');
 await page.screenshot({path:join(output,theme+'-'+width+'.png')});assert.deepEqual(errors,[]);evidence.push({width,theme});await page.close();
}
for(const width of [1000,390])for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height:800}});const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.addInitScript('window.__name=value=>value');
 await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port+'/?pdf');
 await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 const show=page.getByRole('button',{name:'Show file tree',exact:true}),hide=page.getByRole('button',{name:'Hide file tree',exact:true});
 await show.waitFor();assert.equal(await show.getAttribute('aria-expanded'),'false');
 assert.equal(await page.locator('.workspace-file-browser').isVisible(),false);
 await page.locator('[data-pdf-ready="true"]').waitFor({timeout:60000});
 assert.ok((await page.locator('.workspace-file-viewer').boundingBox())!.width>=width-1);
 await page.evaluate(()=>{(window as any).savedPdf=document.querySelector('.workspace-pdf-preview')});
 await show.click();await hide.waitFor();
 assert.equal(await page.evaluate(()=>document.querySelector('.workspace-pdf-preview')===(window as any).savedPdf),true,'opening tree retains PDF viewer');
 await page.getByRole('tree',{name:'Workspace files'}).focus();await page.getByRole('tree',{name:'Workspace files'}).press('Home');
 await page.getByRole('treeitem',{name:'report-0.html',exact:true}).click();
 await page.frameLocator('iframe').getByRole('heading',{name:'Persistent preview'}).waitFor();
 await page.getByRole('tree',{name:'Workspace files'}).focus();await page.getByRole('tree',{name:'Workspace files'}).press('End');
 await page.getByRole('treeitem',{name:'report.pdf',exact:true}).click();
 await page.locator('[data-pdf-ready="true"]').waitFor();
 assert.equal(await hide.getAttribute('aria-expanded'),'true','manual open choice survives browsing back to PDF');
 await hide.click();await show.waitFor();
 await page.waitForFunction(()=>document.querySelector('[data-pdf-ready="true"]')&&((document.querySelector('.workspace-pdf-preview__page canvas') as HTMLCanvasElement|null)?.clientWidth??0)>=window.innerWidth-40);
 await page.screenshot({path:join(output,'pdf-'+theme+'-'+width+'.png')});assert.deepEqual(errors,[]);
 evidence.push({width,theme,pdfDefault:'collapsed',manualChoice:'retained'});await page.close();
}
console.log(JSON.stringify({passed:true,evidence,output}));
}finally{await browser?.close();await vite.close();}
