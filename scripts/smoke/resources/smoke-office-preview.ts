import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer,loadConfigFromFile} from 'vite';
import react from '@vitejs/plugin-react';
import {writeFile} from 'node:fs/promises';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
const output=await mkdtemp(join(tmpdir(),'opencraft-files-entry-'));
const fixtures=Object.fromEntries(await Promise.all(['docx','pptx','xlsx'].map(async ext=>[ext,(await readFile('tests/fixtures/office/sample.'+ext)).toString('base64')])));
// Extend our synthetic deck to exercise bounded lazy thumbnails and distant jumps.
const deck=unzipSync(Buffer.from(fixtures.pptx!,'base64'));
let slideIds='',relationships='',contentTypes='';
for(let i=3;i<=20;i++){
 deck[`ppt/slides/slide${i}.xml`]=strToU8(strFromU8(deck['ppt/slides/slide2.xml']!).replace(/Preview/gu,`Slide ${i}`));
 if(deck['ppt/slides/_rels/slide2.xml.rels'])deck[`ppt/slides/_rels/slide${i}.xml.rels`]=deck['ppt/slides/_rels/slide2.xml.rels']!;
 slideIds+=`<p:sldId id="${500+i}" r:id="rIdPreview${i}"/>`;
 relationships+=`<Relationship Id="rIdPreview${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>`;
 contentTypes+=`<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
}
for(const [path,end,extra] of [['ppt/presentation.xml','</p:sldIdLst>',slideIds],['ppt/_rels/presentation.xml.rels','</Relationships>',relationships],['[Content_Types].xml','</Types>',contentTypes]]){
 const text=strFromU8(deck[path!]!);assert.ok(text.includes(end!));deck[path!]=strToU8(text.replace(end!,extra!+end!));
}
fixtures.pptx=Buffer.from(zipSync(deck)).toString('base64');
const runtime=`
const reads=[];window.fixtureReads=reads;const fixtures=${JSON.stringify(fixtures)};
const runtime={resources:{host:{canRequest:method=>method==='fuzzyFileSearch/sessionStart'},fileSystem:{
async getMetadata(path){return {isFile:path!=='/fixture',isDirectory:path==='/fixture',modifiedAtMs:0,size:100}},
async readFile(path){reads.push(path);return {dataBase64:path.includes('broken')?btoa('invalid document'):fixtures[path.split('.').at(-1)]??btoa('invalid document')}},
async readDirectory(path){return {entries:path==='/fixture'? [{fileName:'nested',isDirectory:true,isFile:false},...['docx','pptx','xlsx'].map(ext=>({fileName:'sample.'+ext,isDirectory:false,isFile:true}))]:[{fileName:'child.html',isDirectory:false,isFile:true}]}},
async createFuzzyFileSearchSession(options){return {update:async()=>{options.onUpdated({files:[{root:'/fixture',path:'report-0.html',file_name:'report-0.html',match_type:'file'}]});options.onCompleted()},stop:async()=>{}}}
}}};
export const useAppServerRuntime=()=>runtime;
export const useBlobResources=()=>window.fixtureBlobs;
export const useAppServerSnapshot=()=>({hostId:'tree-fixture',conversation:{execution:{cwd:'/fixture',runtimeWorkspaceRoots:['/fixture']}}});`;
const source=`
import '/apps/workbench-web/src/runtime/web-crypto-compat.ts';
import {FilePreviewProvider} from '@opencraft/file-preview-web';
import React,{useSyncExternalStore,useState} from 'react';import {Context} from '@deepseek-ai/cordis';import {BlobResourceService} from '@opencraft/blob-resources';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWorkbenchPanelReactRuntime} from '@opencraft/workbench-panels-react';
import {BuiltinWorkbenchPanelPlugin} from '/apps/workbench-web/src/panels/builtin-panel-plugin.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {RightPanel} from '/apps/workbench-web/src/components/right-panel.tsx';
import {useUiPreferencesRuntime} from '/apps/workbench-web/src/runtime/ui-preferences-runtime';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const context=new Context();await context.plugin(BlobResourceService);window.fixtureBlobs=context.blobResources;
const runtime=await createWorkbenchPanelReactRuntime({defaultRightPanelOpen:true});await runtime.install(BuiltinWorkbenchPanelPlugin);
const panels=runtime.panels;panels.ensureOwner('scope');panels.dispatch('scope',{type:'set-region-open',region:'right',open:true,allowEmpty:true});if(innerWidth<700)panels.dispatch('scope',{type:'toggle-right-full-width'});const get=()=>panels.getOwnerSnapshot('scope'),subscribe=f=>panels.subscribeOwner('scope',f);
function App(){const preferences=useUiPreferencesRuntime();const state=useSyncExternalStore(subscribe,get);const[cwd,setCwd]=useState('/fixture');
window.fixture={panels,state,setLocale:locale=>preferences.set('locale.override',locale),setCwd,setThemePreference,previews:runtime.context.filePreviews};
const panel=<RightPanel hostPresentationActive={innerWidth<700?true:undefined} state={state} presentationId='view' renderers={runtime.renderers.getSnapshot()} toolbarActions={panels.getToolbarActionSnapshot()} toolbarActionContext={{ownerId:'scope',resourceOwnerId:'scope',hostId:'tree-fixture',cwd}} onAction={a=>panels.dispatch('scope',a)} onCloseTab={t=>panels.close('scope',t.region,t.id)}/>;
return <AppShell layoutScope='scope' header={<span>Workspace</span>} floatingSidebarHeader={()=>null} leftPanel={null} sidebarOpen={false} sidebarWidth={260} onSidebarCollapse={()=>{}} onSidebarExpand={()=>{}} onSidebarResizeEnd={()=>{}} windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}} rightPanel={innerWidth<700?null:panel} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onRightPanelOpenChange={open=>panels.dispatch('scope',{type:'set-region-open',region:'right',open,allowEmpty:true})}>{innerWidth<700?panel:<p>Conversation</p>}</AppShell>
}
createIntlTestRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><FilePreviewProvider service={runtime.context.filePreviews}><App/></FilePreviewProvider></QueryClientProvider>);`;
// Reuse production dependency ownership, without crawling generated Expo HTML.
const workbenchConfig=await loadConfigFromFile({command:'serve',mode:'development'},resolve('apps/workbench-web/vite.config.ts'));
if(!workbenchConfig)throw new Error('Workbench Vite configuration unavailable');
const vite=await createServer({configFile:false,root:process.cwd(),cacheDir:join(output,'vite-cache'),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic'},optimizeDeps:{...workbenchConfig.config.optimizeDeps,entries:[],include:[...workbenchConfig.config.optimizeDeps?.include??[],'@extend-ai/react-xlsx','docx-preview','@aiden0z/pptx-renderer/browser']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[react(),{name:'file-tree-fixture',enforce:'pre',resolveId(id,importer){if(id.endsWith('/appserver-runtime-context')&&importer?.includes('/panels/'))return '/tree-runtime.ts';return ['/tree-runtime.ts','/tree-fixture.tsx'].includes(id)?id:null},load:id=>id==='/tree-runtime.ts'?runtime:id==='/tree-fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tree-fixture.tsx"></script>')})}}]});
let browser:any;
try{
await vite.listen();const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const evidence=[];
for(const width of [320,390,1280])for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<700});const errors:string[]=[];page.on('pageerror',(e:Error)=>{errors.push(e.message);console.log('PAGE ERROR',e.message)});page.on('console',m=>{if(m.type()==='error')console.log('browser:',m.text())});await page.addInitScript('window.__name=value=>value');
 await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port);await page.waitForFunction(()=>Boolean((window as any).fixture));await page.evaluate(theme=>(window as any).fixture.setThemePreference(theme),theme);
 const open=async(path:string)=>page.evaluate(path=>(window as any).fixture.panels.open('scope','resource',{resource:path,preview:false}),path);
 await open('/fixture/sample.docx');

 await page.locator('[data-file-preview-phase]:not([data-file-preview-phase="opening"])').waitFor({state:'attached',timeout:60000}).catch(async error=>{console.log('BODY',await page.locator('body').innerText());console.log('READS',await page.evaluate(()=>(window as any).fixtureReads));await page.screenshot({path:join(output,'failure.png')});throw error}); assert.equal(await page.locator('[data-file-preview-phase]').getAttribute('data-file-preview-phase'),'ready');
 await page.getByText('Office preview document',{exact:true}).waitFor();
 assert.equal(await page.locator('.office-preview--docx').count(),1);
 assert.equal(await page.getByRole('button',{name:'Show file tree',exact:true}).getAttribute('aria-expanded'),'false');
 assert.equal(await page.locator('.workspace-file-browser').isVisible(),false);
 assert.ok(await page.getByText('Revenue',{exact:true}).evaluate(e=>getComputedStyle(e).color.match(/\d+/g)?.slice(0,3).map(Number).every(c=>c<80)),'document paper must remain readable in dark Workbench');
 await page.screenshot({path:join(output,'docx-'+theme+'-'+width+'.png')});
 await page.evaluate(()=>{(window as any).retainedDocument=document.querySelector('.office-preview--docx')});
 await open('/fixture/sample.pptx');await page.locator('[data-file-preview-phase]:not([data-file-preview-phase="opening"])').waitFor({state:'attached',timeout:60000}).catch(async error=>{console.log('BODY',await page.locator('body').innerText());console.log('READS',await page.evaluate(()=>(window as any).fixtureReads));await page.screenshot({path:join(output,'failure.png')});throw error}); assert.equal(await page.locator('[data-file-preview-phase]').getAttribute('data-file-preview-phase'),'ready');
 const ppt=page.locator('.office-preview--pptx'),slide=ppt.locator('.office-preview__slide-frame');
 await slide.getByText('Office preview slides',{exact:true}).waitFor();
 const input=ppt.getByRole('spinbutton',{name:'Slide number',exact:true}),rail=ppt.getByRole('navigation',{name:'Slide thumbnails',exact:true});
 assert.equal(await input.inputValue(),'1');assert.equal(await ppt.getByRole('button',{name:'Previous page',exact:true}).isDisabled(),true);
 const narrow=await ppt.evaluate(e=>e.clientWidth<520);
 assert.equal(await ppt.getByRole('button',{name:'Slide thumbnails',exact:true}).getAttribute('aria-expanded'),String(!narrow));
 if(narrow)await ppt.getByRole('button',{name:'Slide thumbnails',exact:true}).tap();
 await rail.getByRole('button',{name:'Slide 2',exact:true}).waitFor();
 if(width<700)await rail.getByRole('button',{name:'Slide 2',exact:true}).tap();else await rail.getByRole('button',{name:'Slide 2',exact:true}).click();
 assert.equal(await input.inputValue(),'2');assert.equal(await rail.getByRole('button',{name:'Slide 2',exact:true}).getAttribute('aria-current'),'page');
 await rail.getByRole('button',{name:'Slide 2',exact:true}).press('End');assert.equal(await input.inputValue(),'20');
 assert.equal(await ppt.getByRole('button',{name:'Next page',exact:true}).isDisabled(),true);
 await rail.getByRole('button',{name:'Slide 20',exact:true}).press('ArrowUp');assert.equal(await input.inputValue(),'19');
 await input.fill('999');await input.press('Enter');assert.equal(await input.inputValue(),'20');
 await input.fill('');await input.press('Enter');assert.equal(await input.inputValue(),'20');
 await input.fill('2');await input.press('Escape');assert.equal(await input.inputValue(),'20');
 await input.press('ArrowLeft');assert.equal(await input.inputValue(),'20','editing keys must not navigate');
 await input.fill('3');await input.press('Enter');assert.equal(await input.inputValue(),'3');
 const scroll=ppt.locator('.office-preview__slide-scroll');await scroll.focus();await scroll.press('ArrowRight');assert.equal(await input.inputValue(),'4');
 await scroll.press('Control+ArrowLeft');assert.equal(await input.inputValue(),'4');await scroll.press('PageUp');assert.equal(await input.inputValue(),'3');
 if(narrow)await ppt.getByRole('button',{name:'Slide thumbnails',exact:true}).tap();
 await page.waitForFunction(()=>document.querySelector('.office-preview__slide-frame')!.getBoundingClientRect().width>1);
 const fit=await slide.boundingBox(),viewport=await scroll.boundingBox();assert.ok(fit&&viewport&&fit.width<=viewport.width&&fit.height<=viewport.height,'fit must include width and height');
 await ppt.getByRole('button',{name:'Zoom in',exact:true}).click();await ppt.getByText('125%',{exact:true}).waitFor();
 await page.evaluate(()=>{(window as any).retainedPresentation=document.querySelector('.office-preview--pptx')});
 await page.evaluate(()=>(window as any).fixture.setLocale('zh-CN'));await ppt.getByRole('button',{name:'适合页面',exact:true}).waitFor();
 assert.equal(await ppt.getByRole('spinbutton',{name:'幻灯片页码',exact:true}).inputValue(),'3');await ppt.getByText('125%',{exact:true}).waitFor();
 await page.evaluate(()=>(window as any).fixture.setLocale('en-US'));await ppt.getByRole('button',{name:'Fit slide',exact:true}).waitFor();
 assert.ok(await ppt.locator('.office-preview__thumbnail-surface > div').count()<=8,'thumbnail handles must be bounded');
 await page.screenshot({path:join(output,'pptx-'+theme+'-'+width+'.png')});
 await open('/fixture/sample.docx');await page.locator('.office-preview--docx').waitFor();
 assert.equal(await page.evaluate(()=>document.querySelector('.office-preview--docx')===(window as any).retainedDocument),true,'switch restores retained engine');
 await open('/fixture/sample.pptx');await ppt.waitFor();assert.equal(await page.evaluate(()=>document.querySelector('.office-preview--pptx')===(window as any).retainedPresentation),true);
 assert.equal(await input.inputValue(),'3');await ppt.getByText('125%',{exact:true}).waitFor();
 // An off-screen current slide must be revealed when reopening the rail or tab.
 await input.fill('19');await input.press('Enter');
 if(narrow)await ppt.getByRole('button',{name:'Slide thumbnails',exact:true}).tap();
 const currentThumbnailVisible=()=>page.waitForFunction(()=>{const rail=document.querySelector('.office-preview__thumbnails')!,current=rail.querySelector('[aria-current=page]')!;const r=rail.getBoundingClientRect(),c=current.getBoundingClientRect();return r.height>0&&c.top>=r.top&&c.bottom<=r.bottom});
 await currentThumbnailVisible();
 await open('/fixture/sample.docx');await page.locator('.office-preview--docx').waitFor();
 await open('/fixture/sample.pptx');await ppt.waitFor();assert.equal(await input.inputValue(),'19');await currentThumbnailVisible();
 if(narrow)await ppt.getByRole('button',{name:'Slide thumbnails',exact:true}).tap();
 await ppt.getByRole('button',{name:'Fit slide',exact:true}).click();await ppt.getByText('100%',{exact:true}).waitFor();
 await open('/fixture/sample.xlsx');await page.locator('[data-file-preview-phase]:not([data-file-preview-phase="opening"])').waitFor({state:'attached',timeout:60000}).catch(async error=>{console.log('BODY',await page.locator('body').innerText());console.log('READS',await page.evaluate(()=>(window as any).fixtureReads));await page.screenshot({path:join(output,'failure.png')});throw error}); assert.equal(await page.locator('[data-file-preview-phase]').getAttribute('data-file-preview-phase'),'ready');
 await page.getByRole('tab',{name:'Summary',exact:true}).waitFor();await page.getByRole('tab',{name:'Details',exact:true}).click();
 assert.equal(await page.getByRole('tab',{name:'Details',exact:true}).getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('.office-preview--xlsx [contenteditable="true"]').count(),0);
 await page.screenshot({path:join(output,'xlsx-'+theme+'-'+width+'.png')});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'preview must not widen page');
 await open('/fixture/broken.docx');await page.locator('[data-file-preview-phase="failed"]').waitFor({timeout:60000});
 await page.getByRole('button',{name:'Try again',exact:true}).waitFor();
 await page.evaluate(()=>{const f=(window as any).fixture;for(const t of f.state.right.tabs)f.panels.close('scope','right',t.id)});
 assert.equal(await page.evaluate(()=>(window as any).fixture.previews.pool.size),0,'closed tabs must release retained engines');
 assert.deepEqual(errors,[]);evidence.push({width,theme});await page.close();
}
await writeFile(join(output,'result.json'),JSON.stringify({passed:true,evidence,output},null,2));console.log(JSON.stringify({passed:true,evidence,output}));
}finally{await browser?.close();await vite.close();}
