import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const output=await mkdtemp(join(tmpdir(),'deferred-search-'));
const source=`import React,{useState} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {ConversationSearch} from '/apps/workbench-web/src/components/conversation-search.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();setThemePreference(new URLSearchParams(location.search).get('theme')||'light');
const threads=[{id:'same',title:'Alpha conversation',connectionHostId:'a',serverOrigin:{serverId:'a',label:'Alpha server'}},{id:'same',title:'Beta conversation',connectionHostId:'b',serverOrigin:{serverId:'b',label:'Beta server'}},{id:'disabled',title:'Unavailable',connectionHostId:'a',interactionAvailable:false,serverOrigin:{serverId:'a',label:'Alpha server'}}].map(t=>({...t,updatedAt:1,project:'fixture',status:'ready'}));
window.selected=[];
function App(){const[open,setOpen]=useState(false);return <main><textarea aria-label='Composer draft' defaultValue='Keep this draft'/><button onClick={()=>setOpen(true)}>Open search</button><ConversationSearch enabled open={open} onOpenChange={setOpen} threads={threads} loading={false} onSelectThread={(host,id)=>window.selected.push([host,id])}/></main>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const server=await createServer({configFile:false,root,cacheDir:output+'/vite',logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic'},optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','react-intl','@radix-ui/react-dialog']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'deferred-search',resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?source:null,configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>')})}}]});
let browser;const results=[];
try{
 await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 for(const touch of[false,true]){
  const page=await browser.newPage({viewport:{width:touch?390:1280,height:844},hasTouch:touch,isMobile:touch,reducedMotion:'reduce'});
  await page.addInitScript('window.__name=x=>x');const errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/conversation-search-dialog.tsx'))requests.push(r.url())});
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/?theme='+(touch?'dark':'light'),{timeout:90000});
  const draft=page.getByRole('textbox',{name:'Composer draft'});await draft.waitFor({timeout:90000});assert.equal(requests.length,0);
  await draft.focus();await draft.evaluate(el=>{window.originalDraft=el;el.setSelectionRange(2,7)});
  let release;const held=new Promise(resolve=>release=resolve);const requested=page.waitForRequest('**/conversation-search-dialog.tsx*');
  await page.route('**/conversation-search-dialog.tsx*',async route=>{await held;await route.continue()});
  await page.keyboard.press('Control+k');await requested;
  const dialog=page.getByRole('dialog',{name:'Search conversations',exact:true});await dialog.waitFor();
  assert.equal(await dialog.locator('.modal-surface__close').isVisible(),true,'cold search retains an immediately usable close control');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert.equal(await draft.evaluate(el=>el===document.activeElement&&el===window.originalDraft&&el.selectionStart===2&&el.selectionEnd===7),true);
  const downloaded=page.waitForResponse(r=>r.url().includes('/conversation-search-dialog.tsx'));release();await downloaded;await page.unroute('**/conversation-search-dialog.tsx*');
  assert.equal(await dialog.count(),0,'late module must not reopen closed search');
  const trigger=page.getByRole('button',{name:'Open search',exact:true});
  if(touch)await trigger.tap();else await trigger.click();
  const input=dialog.getByRole('combobox');await input.waitFor({timeout:90000});assert.equal(await input.evaluate(el=>el===document.activeElement),true);
  const requestCount=requests.length;await input.fill('Beta');assert.equal(await dialog.getByRole('option').count(),1);
  await input.evaluate(el=>window.originalSearch=el);await page.setViewportSize({width:touch?844:390,height:touch?390:844});
  assert.equal(await input.evaluate(el=>el===window.originalSearch&&el.value==='Beta'),true);
  await dialog.getByRole('option',{name:'Beta conversation Beta server',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.deepEqual(await page.evaluate(()=>window.selected),[['b','same']]);
  await draft.focus();await page.keyboard.press('Control+k');await input.waitFor();assert.equal(await input.inputValue(),'');
  assert.equal(await dialog.getByRole('option',{name:'Unavailable Alpha server',exact:true}).isDisabled(),true);
  await page.screenshot({path:join(output,'search-'+touch+'.png')});await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert.equal(await draft.evaluate(el=>el===window.originalDraft&&el.value==='Keep this draft'&&el===document.activeElement),true);
  assert.equal(requests.length,requestCount);assert.deepEqual(errors,[]);
  results.push({touch,initialDialogRequests:0,coldEscape:true,lateImportIgnored:true,autofocus:true,resizeRetainedInput:true,hostSelection:true,disabledRow:true,reentryReusesModule:true,draftAndFocusPreserved:true,errors});await page.close();
 }
 await writeFile(join(output,'report.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({output,results}));
}finally{await browser?.close();await server.close()}
