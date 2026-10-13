import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??'playwright');
const source=`
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createComposerController} from '@opencraft/composer-core';
import {CodexComposer} from '@opencraft/codex-composer';
import '/apps/workbench-web/src/styles/app.scss';
const params=new URLSearchParams(location.search);
const target=params.has('existing')?{type:'existing-thread',key:{hostId:'fixture',threadId:'one'}}:
 {type:'new-thread',draftId:'new',execution:{hostId:'fixture',workspace:{cwd:null,runtimeWorkspaceRoots:[]}}};
const controller=createComposerController(target,{now:Date.now,createId:()=>crypto.randomUUID()});
if(params.has('explicit'))controller.dispatch({type:'set-selections',patch:{permissionProfile:params.get('explicit')==='inherit'?null:'readonly'}});
window.fixture={controller};
const profiles=[{id:'readonly',value:'readonly',label:'Read only',mode:'read-only',description:null,disabled:false},
{id:'full',value:'opencraft:permission-mode:full',label:'Full access',mode:'full',description:null,disabled:params.has('unavailable')}];
function App(){const[ready,setReady]=React.useState(!params.has('late'));window.fixture.load=()=>setReady(true);
 return <div data-selection='chrome' className={params.has('existing')?'thread-composer':'new-thread-draft-composer-zone'} style={{padding:16}}><CodexComposer controller={controller}
 selectionCatalog={{models:[],permissionProfiles:ready?profiles:[]}} effectiveSelections={{permissionProfile:'readonly'}}
 placeholder='Write a message' onSubmit={intent=>{window.fixture.intent=intent;return false;}} onCancel={()=>{}}/></div>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','react-intl'],force:true},resolve:{dedupe:['react','react-dom']},
 cacheDir:'node_modules/.vite-composer-mobile-input',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},
 plugins:[{name:'composer-mobile-input',resolveId:id=>id==='/composer-mobile-input.tsx'?id:null,
 load:id=>id==='/composer-mobile-input.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{
 if(new URL(req.url??'/','http://fixture').pathname!=='/')return next();res.setHeader('content-type','text/html');
 res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/composer-mobile-input.tsx"></script>');});}}]});
let browser:any;
try{
 await vite.listen();browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 const origin=`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin});
 const page=await context.newPage();const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
 const editor=page.locator('.codex-composer-editor');await page.goto(origin);await editor.waitFor();
 assert.equal(await page.evaluate(()=>(window as any).fixture.controller.getSnapshot().draft.selections.permissionProfile),'opencraft:permission-mode:full');
 assert.equal(await editor.locator('[contenteditable="false"]').count(),0,'empty input must not contain a noneditable placeholder widget');
 assert.equal(await editor.locator('.ProseMirror-separator').count(),0);
 const geometry=await editor.evaluate(el=>({height:el.getBoundingClientRect().height,select:getComputedStyle(el).userSelect,width:innerWidth,coarse:matchMedia('(any-pointer:coarse)').matches,
 placeholder:getComputedStyle(el.querySelector('p')!,'::before').content}));
 assert.ok(geometry.height>=48,JSON.stringify(geometry));assert.equal(geometry.select,'text');assert.equal(geometry.placeholder,'"Write a message"');
 assert.equal(await editor.evaluate(el=>{const e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});el.dispatchEvent(e);return e.defaultPrevented;}),false);
 await page.evaluate(()=>navigator.clipboard.writeText('已复制的内容 pasted text'));await editor.tap();await page.keyboard.press('Control+v');
 await page.waitForFunction(()=>document.querySelector('.codex-composer-editor')?.textContent?.includes('已复制的内容 pasted text'));
 await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>(window as any).fixture.intent),undefined,'mobile Return must not submit');
 assert.equal(await editor.locator('p').count(),2,'mobile Return must insert a paragraph');
 await page.keyboard.insertText('第二行');
 await page.getByRole('button',{name:'Send message',exact:true}).click();await page.waitForFunction(()=>(window as any).fixture.intent!==undefined);
 assert.equal(await page.evaluate(()=>(window as any).fixture.intent.selections.permissionProfile),'opencraft:permission-mode:full','submission must carry the actual selection');
 for(const [query,expected] of [['?existing',undefined],['?explicit=readonly','readonly'],['?explicit=inherit',null],['?unavailable',undefined]] as const){
  await page.goto(origin+query);await editor.waitFor();assert.equal(await page.evaluate(()=>(window as any).fixture.controller.getSnapshot().draft.selections.permissionProfile),expected,query);
 }
 await page.goto(origin+'?late');await editor.waitFor();assert.equal(await page.evaluate(()=>(window as any).fixture.controller.getSnapshot().draft.selections.permissionProfile),undefined);
 await page.evaluate(()=>(window as any).fixture.load());await page.waitForFunction(()=>(window as any).fixture.controller.getSnapshot().draft.selections.permissionProfile==='opencraft:permission-mode:full');
 const desktop=await browser.newPage({viewport:{width:1200,height:844}});await desktop.goto(origin);await desktop.locator('.codex-composer-editor').click();await desktop.keyboard.insertText('desktop submit');await desktop.keyboard.press('Enter');await desktop.waitForFunction(()=>(window as any).fixture.intent!==undefined);await desktop.close();
 const iosContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'});
 await iosContext.addInitScript(()=>Object.defineProperty(navigator,'vendor',{get:()=> 'Apple Computer, Inc.'}));
 const ios=await iosContext.newPage();await ios.goto(origin);const iosEditor=ios.locator('.codex-composer-editor');await iosEditor.tap();await ios.keyboard.insertText('iPhone Return');await ios.keyboard.press('Enter');await ios.waitForFunction(()=>document.querySelectorAll('.codex-composer-editor p').length===2);assert.equal(await ios.evaluate(()=>(window as any).fixture.intent),undefined,'iOS deferred Enter must not submit');await iosContext.close();
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,geometry,nativeClipboardPaste:true,newThreadFullAccess:true,existingAndExplicitChoicesPreserved:true,mobileReturnNewline:true,iosDeferredReturnNewline:true,desktopEnterSubmit:true,sendButtonSubmit:true}));
}finally{await browser?.close();await vite.close();}
