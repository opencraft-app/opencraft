import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const output=process.env.OPENCRAFT_UI_FEEDBACK_REPORT??'/tmp/opencraft-ui-feedback';await mkdir(output,{recursive:true});
const source=`
import React,{useState} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {ThreadRowMenu,ThreadActionModals,useThreadActionOwner} from '/apps/workbench-web/src/components/thread-management.tsx';
import {copyConversationReference} from '/apps/workbench-web/src/runtime/conversation-reference-actions.ts';
import {createComposerController} from '@opencraft/composer-core';
import {createConversationKey} from '@opencraft/chat-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';initializeAppearanceTheme();
const target={hostId:'fixture',threadId:'audit-target',title:'Audit conversation'};
const calls={};const pending={};let lastCopy=null;
const hold=action=>{calls[action]=(calls[action]??0)+1;return new Promise((resolve,reject)=>{pending[action]={resolve,reject}})};
const controller=createComposerController({type:'existing-thread',key:createConversationKey('fixture','audit-target')},{now:Date.now,createId:()=>crypto.randomUUID()});
function Demo(){
const [open,setOpen]=useState(null);const [stopping,setStopping]=useState(false);
const callbacks={onRename:async(t,title)=>{await hold('rename')},onDelete:()=>hold('delete'),onFork:()=>hold('fork'),onArchive:()=>hold('archive'),onCopyReference:()=>copyConversationReference(async()=>{await hold('reference');return {ref:{serverId:'fixture',threadId:target.threadId}}},location.href,target)};
const owner=useThreadActionOwner(callbacks);
window.audit={calls,pending,activity:owner.activity(target),resolve:a=>pending[a].resolve(),reject:a=>pending[a].reject(new Error('Synthetic rejection'))};
return <main style={{padding:24}}><div className="sidebar-activity-list" style={{width:300}}><ThreadRowMenu target={target} capabilities={{rename:true,delete:true,fork:true,archive:true,reference:true}} owner={owner} openMenuKind={open} onOpenMenuChange={(kind,value)=>setOpen(value?kind:null)}><button className="sidebar-activity-item">Audit conversation</button></ThreadRowMenu></div><ThreadActionModals owner={owner}/>
<div style={{marginTop:180,maxWidth:760}}><OpenCraftComposer controller={controller} isStreaming isStopping={stopping} catalog={{search:async()=>[]}} onSubmit={()=>false} onCancel={()=>{setStopping(true);void hold('stop').catch(()=>{}).finally(()=>setStopping(false));}}/></div></main>;
}
createIntlTestRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><Demo/></QueryClientProvider>);
`;
const vite=await createServer({root:process.cwd(),configFile:false,logLevel:'error',resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'audit',resolveId:id=>id==='/audit.tsx'?id:null,load:id=>id==='/audit.tsx'?source:null,configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('Content-Type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/audit.tsx"></script>')})}}]});
let browser;const results=[];
try{await vite.listen();browser=await chromium.launch({headless:true,args:['--no-sandbox']});
for(const width of [1280,390])for(const theme of ['light','dark']){
const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390,isMobile:width===390,permissions:['clipboard-read','clipboard-write']});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(t=>{window.__name=v=>v;localStorage.setItem('opencraft.appearance-theme',t)},theme);
await page.goto('http://127.0.0.1:'+(vite.httpServer.address() as any).port);try{await page.waitForFunction(()=>!!window.audit,{},{timeout:10000})}catch(e){console.error(JSON.stringify({errors,body:await page.locator('body').innerText()}));throw e;}
const activate=async locator=>width===390?locator.tap():locator.click();
const menu=async name=>{const row=page.locator('.sidebar-activity-row');if(width!==390)await row.hover();await activate(row.getByRole('button',{name:'Actions for Audit conversation',exact:true}));await activate(page.getByRole('menuitem',{name,exact:true}));};
const toast=()=>page.locator('[data-sonner-toast]:not([data-removed=true])');
await menu('Copy conversation reference');await page.waitForFunction(()=>window.audit.calls.reference===1);await page.waitForTimeout(200);
const copyPending={busy:await page.locator('.sidebar-activity-item__menu-trigger').isDisabled(),noticeCount:await toast().count()};
assert.equal(copyPending.busy,true);assert.ok(copyPending.noticeCount>0);await page.getByText('Preparing conversation reference…',{exact:true}).waitFor();await page.screenshot({path:output+'/'+width+'-'+theme+'-copy-pending.png'});
await page.evaluate(()=>window.audit.resolve('reference'));
await page.waitForFunction(()=>!window.audit.activity.busy);const clipboard=await page.evaluate(()=>navigator.clipboard.readText());assert.ok(clipboard.includes('opencraft%3A%2F%2Fconversation'));
await page.getByText('Copied',{exact:true}).waitFor();
await page.screenshot({path:output+'/'+width+'-'+theme+'-copy-success.png'});
await menu('Copy conversation reference');await page.waitForFunction(()=>window.audit.calls.reference===2);await page.getByText('Preparing conversation reference…',{exact:true}).waitFor();
await page.evaluate(()=>window.audit.reject('reference'));await page.waitForFunction(()=>!window.audit.activity.busy);await page.locator('[data-sonner-toast][data-type=error]').waitFor();
assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),clipboard,'Failed reference preparation cannot change the clipboard');
assert.equal(await page.getByText('Copied',{exact:true}).count(),0,'Failed copy cannot report success');
await menu('Delete');await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('alertdialog').waitFor({state:'detached'});await menu('Delete');const confirmation=page.getByRole('alertdialog');await confirmation.waitFor();await activate(confirmation.getByRole('button',{name:'Delete',exact:true}));
await page.waitForFunction(()=>window.audit.calls.delete===1);await page.waitForTimeout(200);
const deletionPending={dialogCount:await confirmation.count(),noticeCount:await toast().count(),rowStillVisible:await page.getByRole('button',{name:'Audit conversation',exact:true}).isVisible(),busy:await page.locator('.sidebar-activity-item__menu-trigger').isDisabled()};
assert.equal(deletionPending.dialogCount,0);await page.getByText('Deleting conversation…',{exact:true}).waitFor();assert.equal(deletionPending.rowStillVisible,true);assert.equal(deletionPending.busy,true);
await page.screenshot({path:output+'/'+width+'-'+theme+'-delete-pending.png'});await page.evaluate(()=>window.audit.resolve('delete'));await page.waitForFunction(()=>!window.audit.activity.busy);
await page.waitForTimeout(200);const afterDelete=await page.evaluate(()=>({bodyPointerEvents:document.body.style.pointerEvents,bodyComputed:getComputedStyle(document.body).pointerEvents,dialogs:document.querySelectorAll('[role=dialog],[role=alertdialog]').length}));assert.notEqual(afterDelete.bodyComputed,'none');await menu('Rename');const input=page.getByRole('textbox',{name:'Conversation name'});await input.fill('Updated name');await activate(page.getByRole('button',{name:'Save',exact:true}));await page.waitForFunction(()=>window.audit.calls.rename===1);
await page.keyboard.press('Escape');const save=page.getByRole('button',{name:'Saving…',exact:true});const renamePending={dialogCount:await page.getByRole('dialog').count(),inputDisabled:await input.isDisabled(),saveLabel:await save.innerText(),saveBusy:await save.getAttribute('aria-busy'),spinnerCount:await save.locator('.settings-control-button__spinner').count()};
assert.equal(renamePending.dialogCount,1);assert.equal(renamePending.inputDisabled,true);assert.equal(renamePending.saveLabel,'Saving…');assert.equal(renamePending.saveBusy,'true');assert.equal(renamePending.spinnerCount,1);
await page.screenshot({path:output+'/'+width+'-'+theme+'-rename-pending.png'});await page.evaluate(()=>window.audit.resolve('rename'));await page.getByRole('dialog').waitFor({state:'detached'});
const stop=page.getByRole('button',{name:'Stop response',exact:true});await activate(stop);const pendingStop=page.getByRole('button',{name:'Stopping response…',exact:true});await pendingStop.waitFor();
const stopPending={disabled:await pendingStop.isDisabled(),busy:await pendingStop.getAttribute('aria-busy'),calls:await page.evaluate(()=>window.audit.calls.stop)};
assert.equal(stopPending.disabled,true);assert.equal(stopPending.busy,'true');assert.equal(stopPending.calls,1);await page.evaluate(()=>window.audit.reject('stop'));await stop.waitFor();assert.equal(await stop.isEnabled(),true);
await page.screenshot({path:output+'/'+width+'-'+theme+'-stop-recovered.png'});
assert.deepEqual(errors,[]);results.push({width,theme,copyPending,copySuccessNotice:true,copyFailureNotice:true,deletionPending,afterDelete,renamePending,stopPending,errors});await context.close();
}
await writeFile(output+'/results.json',JSON.stringify({scope:'Real components with controlled native callbacks; confirm/cancel, held success and rejection',results},null,2));console.log(JSON.stringify({output,scenarios:results.length,results}));
}finally{await browser?.close();await vite.close();}
