import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer,loadConfigFromFile} from 'vite';
import react from '@vitejs/plugin-react';
import {optionalWebAssets} from "../../../apps/workbench-web/optional-web-assets";
import {writeFile} from 'node:fs/promises';
const output=await mkdtemp(join(tmpdir(),'opencraft-files-entry-'));
const fixtures=Object.fromEntries(await Promise.all(['doc','docx','csv','tsv','xls','xlsm','drawio','dio','excalidraw','mmd','mermaid'].map(async ext=>[ext,(await readFile('tests/fixtures/'+(['doc','docx'].includes(ext)?'office':'structured')+'/sample.'+ext)).toString('base64')])));
const runtime=`
const reads=[];window.fixtureReads=reads;const fixtures=${JSON.stringify(fixtures)};
const runtime={resources:{host:{canRequest:method=>method==='fuzzyFileSearch/sessionStart'},fileSystem:{
async getMetadata(path){return {isFile:path!=='/fixture',isDirectory:path==='/fixture',modifiedAtMs:0,size:100}},
async readFile(path){reads.push(path);if(path.includes('encrypted.doc')){const bytes=Uint8Array.from(atob(fixtures.doc),c=>c.charCodeAt(0));bytes[523]|=1;return {dataBase64:btoa(String.fromCharCode(...bytes))}}return {dataBase64:path.includes('broken')?btoa('invalid document'):path.includes('ragged')?btoa('target,b,c,d,e,f\\nshort\\n'):fixtures[path.split('.').at(-1)]??btoa('invalid document')}},
async readDirectory(path){return {entries:path==='/fixture'? [{fileName:'nested',isDirectory:true,isFile:false},...['doc','docx','csv','tsv','xls','xlsm','drawio','dio','excalidraw','mmd','mermaid'].map(ext=>({fileName:'sample.'+ext,isDirectory:false,isFile:true}))]:[{fileName:'child.html',isDirectory:false,isFile:true}]}},
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
const vite=await createServer({configFile:false,root:process.cwd(),cacheDir:join(output,'vite-cache'),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic'},optimizeDeps:{...workbenchConfig.config.optimizeDeps,entries:['/tree-fixture.tsx'],include:[...workbenchConfig.config.optimizeDeps?.include??[],'@extend-ai/react-xlsx','@extend-ai/react-docx','docx-preview','@aiden0z/pptx-renderer/browser','@excalidraw/excalidraw','dompurify','@tanstack/react-virtual']},server:{host:'127.0.0.1',port:0,hmr:false,cors:false},plugins:[react(),optionalWebAssets(),{name:'file-tree-fixture',enforce:'pre',resolveId(id,importer){if(id.endsWith('/appserver-runtime-context')&&importer?.includes('/panels/'))return '/tree-runtime.ts';return ['/tree-runtime.ts','/tree-fixture.tsx'].includes(id)?id:null},load:id=>id==='/tree-runtime.ts'?runtime:id==='/tree-fixture.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tree-fixture.tsx"></script>')})}}]});
let browser:any;
try{
await vite.listen();const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const evidence=[];
for(const width of (process.env.OPENCRAFT_PREVIEW_WIDTHS?.split(',').map(Number)??[390,1280]))for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<700});const errors:string[]=[];const externalRequests:string[]=[];const sandboxAssetRequests:string[]=[];page.on('request',request=>{const url=new URL(request.url());if(url.protocol.startsWith('http')&&url.hostname!=='127.0.0.1')externalRequests.push(url.origin);if(url.pathname.includes('viewer-static')&&request.frame()!==page.mainFrame())sandboxAssetRequests.push(request.url())});page.on('pageerror',(e:Error)=>{errors.push(e.message);console.log('PAGE ERROR',e.message)});page.on('console',m=>{if(m.type()==='error')console.log('browser:',m.text())});await page.addInitScript('window.__name=value=>value');
 await page.goto('http://127.0.0.1:'+(vite.httpServer!.address() as any).port);await page.waitForFunction(()=>Boolean((window as any).fixture));await page.evaluate(theme=>(window as any).fixture.setThemePreference(theme),theme);
 const open=async(path:string)=>page.evaluate(path=>(window as any).fixture.panels.open('scope','resource',{resource:path,preview:false}),path);
 const waitReady=async()=>{
   await page.locator('[data-file-preview-phase]:not([data-file-preview-phase="opening"])').waitFor({state:'attached',timeout:90000});
   if(await page.locator('[data-file-preview-phase]').getAttribute('data-file-preview-phase')!=='ready') console.log('ENGINE_FAILURE',await page.evaluate(()=>[...(window as any).fixture.previews.pool.entries.values()].map((entry:any)=>({phase:entry.snapshot.phase,error:entry.snapshot.error?.stack}))));
   assert.equal(await page.locator('[data-file-preview-phase]').getAttribute('data-file-preview-phase'),'ready',await page.locator('body').innerText());
 };
 const formats=[];
 for(const ext of (process.env.OPENCRAFT_PREVIEW_FORMATS?.split(',')??['doc','docx','csv','tsv','xls','xlsm','drawio','dio','excalidraw','mmd','mermaid'])){
  await open('/fixture/sample.'+ext);await waitReady();
  if(ext==='doc'||ext==='docx'){
   await page.getByText(ext==='doc'?'Legacy Word preview':'Office preview document',{exact:true}).waitFor({timeout:60000});
   if(ext==='doc')await page.getByText('中文旧版 Word 文档',{exact:true}).waitFor();
   assert.equal(await page.locator('.office-preview [contenteditable="true"]').count(),0);
   const zoomBefore=await page.locator('.office-preview__paper-content').getAttribute('style');
   await page.getByRole('button',{name:'Zoom in',exact:true}).click();
   assert.notEqual(await page.locator('.office-preview__paper-content').getAttribute('style'),zoomBefore);
   await page.getByRole('button',{name:'Fit width',exact:true}).click();
   await page.evaluate(()=>{window.fixtureOpenedLinks=[];window.open=(url)=>{window.fixtureOpenedLinks.push(url);return null};const root=document.querySelector('.office-preview');for(const [label,url]of [['safe','https://example.com/guide'],['unsafe','javascript:alert(1)']]){const link=document.createElement('a');link.textContent=label;link.href=url;root.append(link)}});
   await page.getByRole('link',{name:'safe',exact:true}).click();await page.getByRole('link',{name:'unsafe',exact:true}).click();
   assert.deepEqual(await page.evaluate(()=>(window as any).fixtureOpenedLinks),['https://example.com/guide']);
   await page.getByRole('link',{name:'safe',exact:true}).evaluate(node=>node.remove());await page.getByRole('link',{name:'unsafe',exact:true}).evaluate(node=>node.remove());
  }else if(ext==='csv'||ext==='tsv'){
   await page.getByRole('table',{name:'sample.'+ext,exact:true}).waitFor();
   await page.getByRole('cell',{name:ext==='csv'?'中文,数据':'中文',exact:true}).waitFor();
   if(ext==='csv'){
    await page.getByRole('cell',{name:'00125',exact:true}).waitFor();
    const multiline=page.getByRole('cell',{name:'Line one Line two',exact:true});
    if(width<700)await multiline.tap();else await multiline.click();
    assert.equal(await page.getByRole('textbox',{name:'Cell contents',exact:true}).inputValue(),'Line one\nLine two');
    if(width<700){
      const resize=page.getByRole('separator',{name:'Column width A',exact:true});
      await page.locator('.structured-preview__table-scroll').evaluate(node=>node.scrollTo({left:0,top:0,behavior:'instant'}));
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const box=await resize.boundingBox();assert.ok(box);
      const initial=Number(await resize.getAttribute('aria-valuenow'));
      const cdp=await page.context().newCDPSession(page),x=box.x+box.width/2,y=box.y+box.height/2;
      assert.equal(await resize.evaluate((node,{x,y})=>document.elementFromPoint(x,y)===node,{x,y}),true,'touch sequence hits the actual resize handle');
      const touch=(id:number,x:number,y:number)=>({id,x,y});
      await resize.evaluate(node=>{const events: {type:string;pointerId:number;trusted:boolean}[]=[];(window as any).tableResizeEvents=events;for(const type of ['pointerdown','pointerup','pointercancel'])node.addEventListener(type,event=>{const pointer=event as PointerEvent;events.push({type:pointer.type,pointerId:pointer.pointerId,trusted:pointer.isTrusted})},true)});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch(101,x,y)]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(101,x+20,y)]});
      await page.waitForFunction(size=>Number(document.querySelector('[role="separator"][aria-label="Column width A"]')?.getAttribute('aria-valuenow'))===size,initial+20);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch(101,x+20,y),touch(102,x+20,y+6)]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(101,x+20,y),touch(102,x+50,y+6)]});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(Number(await resize.getAttribute('aria-valuenow')),initial+20,'a second contact cannot take over a held column resize');
      const contacts=await page.evaluate(()=>(window as any).tableResizeEvents.filter((event:any)=>event.type==='pointerdown'));
      assert.equal(contacts.length,2);assert(contacts.every((event:any)=>event.trusted));
      // Chromium's WebTouch backend releases the supplied point; assert its native event below.
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[touch(102,x+50,y+6)]});
      const releases=await page.evaluate(()=>(window as any).tableResizeEvents.filter((event:any)=>event.type==='pointerup'));
      assert.deepEqual(releases.map((event:any)=>event.pointerId),[contacts[1].pointerId],'only the second native contact is released');
      assert.equal(await resize.evaluate((node,id)=>node.hasPointerCapture(id),contacts[0].pointerId),true,'first contact retains native capture');
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(101,x+40,y)]});
      await page.waitForFunction(size=>Number(document.querySelector('[role="separator"][aria-label="Column width A"]')?.getAttribute('aria-valuenow'))===size,initial+40);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      assert.equal(Number(await resize.getAttribute('aria-valuenow')),initial+40,'only the owner commits the final width');
      const next=await resize.boundingBox();assert.ok(next);const nextX=next.x+next.width/2,nextY=next.y+next.height/2;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch(103,nextX,nextY)]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(103,nextX-25,nextY)]});
      await page.waitForFunction(size=>Number(document.querySelector('[role="separator"][aria-label="Column width A"]')?.getAttribute('aria-valuenow'))===size,initial+15);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
      await page.waitForFunction(size=>Number(document.querySelector('[role="separator"][aria-label="Column width A"]')?.getAttribute('aria-valuenow'))===size,initial+40);
      await cdp.detach();
      assert.equal(await page.getByRole('textbox',{name:'Cell contents',exact:true}).inputValue(),'Line one\nLine two','resize preserves selected cell content');
    }
    const handle=page.getByRole('separator',{name:'Column width C',exact:true});
    await handle.evaluate(node=>node.scrollIntoView({block:'nearest',inline:'center'}));
    if(width<700){
     const box=await handle.boundingBox();assert.ok(box);const cdp=await page.context().newCDPSession(page),x=box.x+box.width/2,y=box.y+box.height/2;
     const before=await handle.getAttribute('aria-valuenow');
     await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
     await handle.dispatchEvent('pointermove',{pointerId:9999,pointerType:'touch',clientX:x+100});
     await handle.dispatchEvent('pointercancel',{pointerId:9999,pointerType:'touch'});
     assert.equal(await handle.getAttribute('aria-valuenow'),before,'another pointer must neither resize nor cancel the active gesture');
     await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+24,y,id:1}]});
     await page.waitForFunction(before=>Number(document.querySelector('[role="separator"][aria-label="Column width C"]')?.getAttribute('aria-valuenow'))>Number(before),before);
     await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await cdp.detach();
     await page.waitForFunction(before=>document.querySelector('[role="separator"][aria-label="Column width C"]')?.getAttribute('aria-valuenow')===before,before);
    }
    const originalWidth=Number(await handle.getAttribute('aria-valuenow'));await handle.focus();await handle.press('ArrowRight');
    await page.waitForFunction(size=>Number(document.querySelector('[role="separator"][aria-label="Column width C"]')?.getAttribute('aria-valuenow'))===size,originalWidth+20);
    await page.getByRole('searchbox',{name:'Find in table'}).fill('00125');await page.getByRole('button',{name:'Next match',exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'Cell contents',exact:true}).inputValue(),'00125');

    await page.getByRole('button',{name:'Source',exact:true}).click();
    assert.match(await page.locator('.structured-preview__source').innerText(),/Line one\nLine two/);
    await page.getByRole('button',{name:'Table',exact:true}).click();
    await page.evaluate(()=>{(window as any).localizedTable=document.querySelector('.structured-preview--table')});
    await page.getByRole('button',{name:'Source',exact:true}).click();
    await page.evaluate(()=>(window as any).fixture.setLocale('zh-CN'));
    await page.getByRole('button',{name:'源码',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'源码',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await page.evaluate(()=>document.querySelector('.structured-preview--table')===(window as any).localizedTable),true,'locale must preserve table DOM and source selection');
    await page.getByRole('button',{name:'表格',exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'单元格内容',exact:true}).inputValue(),'00125');
    assert.equal(await page.getByRole('separator',{name:'列宽 C',exact:true}).getAttribute('aria-valuenow'),String(originalWidth+20));
    await page.evaluate(()=>(window as any).fixture.setLocale('en-US'));
    await page.getByRole('button',{name:'Table',exact:true}).waitFor();
   }
  }else if(ext==='xls'||ext==='xlsm'){
   await page.getByRole('tab',{name:'Summary',exact:true}).waitFor();
   await page.getByRole('tab',{name:'Details',exact:true}).click();
   assert.equal(await page.getByRole('tab',{name:'Details',exact:true}).getAttribute('aria-selected'),'true');
   assert.equal(await page.locator('.office-preview--xlsx [contenteditable="true"]').count(),0);
  }else if(ext==='drawio'||ext==='dio'){
   await page.locator('[data-diagram-ready="true"]').waitFor({timeout:60000});
   const iframe=page.frameLocator('.structured-preview__drawio');
   await iframe.getByText('Draw.io first page',{exact:true}).waitFor();
   await iframe.getByTitle('Next page',{exact:true}).click();await iframe.getByText('第二页 / Second page',{exact:true}).waitFor();
   await iframe.getByTitle('Previous page',{exact:true}).click();await iframe.getByText('Draw.io first page',{exact:true}).waitFor();
   assert.ok(await iframe.locator('svg').count()>0);
   await page.evaluate(()=>(window as any).fixture.setLocale('zh-CN'));
   await iframe.getByTitle('下一页',{exact:true}).waitFor();
   await iframe.getByTitle('下一页',{exact:true}).click();await iframe.getByText('第二页 / Second page',{exact:true}).waitFor();
   await page.evaluate(()=>(window as any).fixture.setLocale('en-US'));await iframe.getByTitle('Previous page',{exact:true}).waitFor();
   await page.screenshot({path:join(output,ext+'-'+theme+'-'+width+'.png')});
  }else{
   await page.locator('[data-diagram-ready="true"] svg').waitFor();
   assert.ok(await page.locator('[data-diagram-ready] svg').evaluate(svg=>(svg as SVGSVGElement).viewBox.baseVal.width>0));
   await page.evaluate(()=>(window as any).fixture.setLocale('zh-CN'));await page.getByRole('button',{name:'适合窗口',exact:true}).waitFor();
   await page.evaluate(()=>(window as any).fixture.setLocale('en-US'));await page.getByRole('button',{name:'Fit diagram',exact:true}).waitFor();
   const transform=await page.locator('.structured-preview__diagram-content').getAttribute('style');
   await page.getByRole('button',{name:'Zoom in',exact:true}).click();
   assert.notEqual(await page.locator('.structured-preview__diagram-content').getAttribute('style'),transform);
   if(width<700){
    const box=await page.locator('.structured-preview__diagram').boundingBox();assert.ok(box);
    const cdp=await page.context().newCDPSession(page),x=box.x+box.width/2,y=box.y+box.height/2;
    const before=await page.locator('.structured-preview__diagram-content').getAttribute('style');
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-25,y,id:1},{x:x+25,y,id:2}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-55,y:y+10,id:1},{x:x+55,y:y+10,id:2}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.notEqual(await page.locator('.structured-preview__diagram-content').getAttribute('style'),before,'native touch pinch pans and zooms');
    await cdp.detach();await page.getByRole('button',{name:'Fit diagram',exact:true}).tap();
   }else await page.getByRole('button',{name:'Fit diagram',exact:true}).click();
  }
  assert.equal(await page.getByRole('button',{name:'Show file tree',exact:true}).getAttribute('aria-expanded'),'false');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'preview must not widen page');
  await page.screenshot({path:join(output,ext+'-'+theme+'-'+width+'.png')});formats.push(ext);
  if(ext==='csv')await page.evaluate(()=>{(window as any).retainedTable=document.querySelector('.structured-preview--table')});
  if(ext==='tsv'){
   await open('/fixture/sample.csv');await waitReady();
   assert.equal(await page.evaluate(()=>document.querySelector('.structured-preview--table')===(window as any).retainedTable),true);
  }
 }
 await open('/fixture/ragged.csv');await waitReady();
 await page.getByRole('cell',{name:'short',exact:true}).click();
 for(let col=0;col<5;col++)await page.locator('[role="cell"][tabindex="0"]').press('ArrowRight');
 await page.getByRole('searchbox',{name:'Find in table',exact:true}).fill('target');
 await page.getByRole('button',{name:'Previous match',exact:true}).click();
 assert.equal(await page.getByRole('textbox',{name:'Cell contents',exact:true}).inputValue(),'target','backward search from a ragged-row padding cell must wrap to every real cell');
 await open('/fixture/encrypted.doc');await page.locator('[data-file-preview-phase="failed"]').waitFor({timeout:60000});
 await page.getByText('Password-protected files cannot be previewed. Download it to open with its password.',{exact:true}).waitFor();
 await page.evaluate(()=>(window as any).fixture.setLocale('zh-CN'));await page.getByText('暂不支持预览加密文件，请下载后使用密码打开。',{exact:true}).waitFor();
 await page.evaluate(()=>(window as any).fixture.setLocale('en-US'));
 await open('/fixture/broken.doc');await page.locator('[data-file-preview-phase="failed"]').waitFor();
 await page.getByText('This file is damaged or its contents do not match the format. Download the original to check it.',{exact:true}).waitFor();
 await open('/fixture/broken.mmd');await page.locator('[data-file-preview-phase="failed"]').waitFor({timeout:60000});
 await page.getByRole('button',{name:'Try again',exact:true}).waitFor();
 await page.evaluate(()=>{const f=(window as any).fixture;for(const t of f.state.right.tabs)f.panels.close('scope','right',t.id)});
 assert.equal(await page.evaluate(()=>(window as any).fixture.previews.pool.size),0,'closed tabs must release retained engines');
 assert.deepEqual(sandboxAssetRequests,[],'opaque sandbox must not fetch local assets');assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[],'previews must not request external resources');evidence.push({width,theme,formats});await page.close();
}
await writeFile(join(output,'result.json'),JSON.stringify({passed:true,evidence,output},null,2));console.log(JSON.stringify({passed:true,evidence,output}));
}finally{await browser?.close();await vite.close();}
