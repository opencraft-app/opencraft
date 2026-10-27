import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const output=await mkdtemp(join(tmpdir(),'opencraft-files-entry-'));
const runtime=`
const reads=[];window.fixtureReads=reads;
const runtime={resources:{host:{canRequest:method=>method==='fuzzyFileSearch/sessionStart'},fileSystem:{
async getMetadata(path){return {isFile:path!=='/fixture',isDirectory:path==='/fixture',modifiedAtMs:0,size:100}},
async readFile(path){reads.push(path);return {dataBase64:btoa('<html><body><h1>Persistent preview</h1><p>'+path+'</p></body></html>')}},
async readDirectory(path){return {entries:path==='/fixture'? [{fileName:'nested',isDirectory:true,isFile:false},...Array.from({length:35},(_,i)=>({fileName:'report-'+i+'.html',isDirectory:false,isFile:true}))]:[{fileName:'child.html',isDirectory:false,isFile:true}]}},
async createFuzzyFileSearchSession(options){return {update:async()=>{options.onUpdated({files:[{root:'/fixture',path:'report-0.html',file_name:'report-0.html',match_type:'file'}]});options.onCompleted()},stop:async()=>{}}}
}}};
export const useAppServerRuntime=()=>runtime;
export const useBlobResources=()=>window.fixtureBlobs;
export const useAppServerSnapshot=()=>({hostId:'tree-fixture',conversation:{execution:{cwd:'/fixture',runtimeWorkspaceRoots:['/fixture']}}});`;
const source=`
import '/apps/workbench-web/src/runtime/web-crypto-compat.ts';
import React,{useSyncExternalStore,useState} from 'react';import {Context} from '@deepseek-ai/cordis';import {BlobResourceService} from '@opencraft/blob-resources';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWorkbenchPanelReactRuntime} from '@opencraft/workbench-panels-react';
import {BuiltinWorkbenchPanelPlugin} from '/apps/workbench-web/src/panels/builtin-panel-plugin.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {RightPanel} from '/apps/workbench-web/src/components/right-panel.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const context=new Context();await context.plugin(BlobResourceService);window.fixtureBlobs=context.blobResources;
const runtime=await createWorkbenchPanelReactRuntime({defaultRightPanelOpen:true});await runtime.install(BuiltinWorkbenchPanelPlugin);
const panels=runtime.panels;panels.ensureOwner('scope');panels.dispatch('scope',{type:'set-region-open',region:'right',open:true,allowEmpty:true});if(innerWidth<700)panels.dispatch('scope',{type:'toggle-right-full-width'});const get=()=>panels.getOwnerSnapshot('scope'),subscribe=f=>panels.subscribeOwner('scope',f);
function App(){const state=useSyncExternalStore(subscribe,get);const[cwd,setCwd]=useState('/fixture');
window.fixture={panels,state,setCwd,setThemePreference};
const panel=<RightPanel state={state} presentationId='view' renderers={runtime.renderers.getSnapshot()} toolbarActions={panels.getToolbarActionSnapshot()} toolbarActionContext={{ownerId:'scope',resourceOwnerId:'scope',hostId:'tree-fixture',cwd}} onAction={a=>panels.dispatch('scope',a)} onCloseTab={t=>panels.close('scope',t.region,t.id)}/>;
return <AppShell layoutScope='scope' header={<span>Workspace</span>} floatingSidebarHeader={()=>null} leftPanel={null} sidebarOpen={false} sidebarWidth={260} onSidebarCollapse={()=>{}} onSidebarExpand={()=>{}} onSidebarResizeEnd={()=>{}} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanel={panel} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onRightPanelOpenChange={open=>panels.dispatch('scope',{type:'set-region-open',region:'right',open,allowEmpty:true})}><p>Conversation</p></AppShell>
}
createIntlTestRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><App/></QueryClientProvider>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[react(),{name:'file-tree-fixture',enforce:'pre',resolveId(id,importer){if(id.endsWith('/appserver-runtime-context')&&importer?.includes('/panels/'))return '/tree-runtime.ts';return ['/tree-runtime.ts','/tree-fixture.tsx'].includes(id)?id:null},load:id=>id==='/tree-runtime.ts'?runtime:id==='/tree-fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tree-fixture.tsx"></script>')})}}]});
let browser:any;
try{
await vite.listen();const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');browser=await chromium.launch({headless:true});
const evidence=[];
for(const width of [1000,1400])for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height:800}});const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.addInitScript('window.__name=value=>value');
 await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port);await page.evaluate(theme=>(window as any).fixture.setThemePreference(theme),theme);
 const files=page.locator('.right-panel-launcher').getByRole('button',{name:'Open files',exact:true});
 await files.waitFor();assert.equal(await files.locator('[data-workbench-icon="folder"]').count(),1);
 await page.screenshot({path:join(output,'launcher-'+theme+'-'+width+'.png')});
 await files.click();await page.getByRole('treeitem',{name:'report-0.html',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>(window as any).fixture.state.right.tabs[0].resource),'/fixture');
 assert.equal(await page.evaluate(()=>(window as any).fixture.state.right.tabs[0].preview),false);
 await page.getByRole('treeitem',{name:'report-0.html',exact:true}).click();
 await page.frameLocator('iframe').getByRole('heading',{name:'Persistent preview'}).waitFor();
 await page.screenshot({path:join(output,'preview-'+theme+'-'+width+'.png')});
 const hide=page.getByRole('button',{name:'Hide file tree',exact:true}),show=page.getByRole('button',{name:'Show file tree',exact:true});
 await hide.click();assert.equal(await page.locator('.workspace-file-browser').isVisible(),false);await show.click();
 await page.getByRole('button',{name:'New tab',exact:true}).click();
 await page.getByRole('menuitem',{name:'Files',exact:true}).click();
 assert.equal(await page.evaluate(()=>(window as any).fixture.state.right.tabs.length),1,'repeated launch reuses the directory tab');
 await page.evaluate(()=>(window as any).fixture.panels.open('scope','resource',{resource:'/fixture/report-1.html'}));
 assert.deepEqual(await page.evaluate(()=>(window as any).fixture.state.right.tabs.map(t=>t.preview)),[false,true],'file-link preview does not replace the retained directory tab');
 await page.evaluate(()=>{const f=(window as any).fixture;for(const t of f.state.right.tabs)f.panels.close('scope','right',t.id);f.setCwd(null)});
 await page.waitForFunction(()=>document.querySelector('.right-panel-launcher'));
 assert.equal(await files.count(),0,'no directory means no launcher');
 await page.screenshot({path:join(output,theme+'-'+width+'.png')});assert.deepEqual(errors,[]);evidence.push({width,theme});await page.close();
}
console.log(JSON.stringify({passed:true,evidence,output}));
}finally{await browser?.close();await vite.close();}
