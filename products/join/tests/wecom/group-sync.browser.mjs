/** Run from the assembled source. Real group settings UI, simulated authenticated RPC; no provider I/O. */
import fs from'node:fs';import path from'node:path';import assert from'node:assert/strict';import{pathToFileURL}from'node:url';import{tmpdir}from'node:os';
const root=process.cwd(),out=process.env.OPENCRAFT_SYNC_UI_OUTPUT??fs.mkdtempSync(path.join(tmpdir(),'group-sync-ui-'));fs.mkdirSync(out,{recursive:true});
const{createServer}=await import(pathToFileURL(root+'/node_modules/vite/dist/node/index.js'));
const{chromium}=await import(pathToFileURL(root+'/node_modules/playwright/index.mjs'));
const source=`
import React from'react';import{ChannelsClient}from'/plugins/im/src/channel-client';import{GroupMembersButton}from'/plugins/im/src/channel-group-controls';import{createIntlTestRoot}from'/tests/fixtures/intl-root';import'/apps/workbench-web/src/styles/app.scss';import'/plugins/im/src/channel-chat.scss';
import {buildOpenCraftThemeCssProperties} from '@opencraft/design-system/theme-engine';
for(const [key,value] of Object.entries(buildOpenCraftThemeCssProperties('light')))document.documentElement.style.setProperty(key,value);
document.body.style.font='var(--typography-body-font)';
const params=new URLSearchParams(location.search),native=params.has('native'),readonly=params.has('readonly');
const changes=new Set(),subs=new Map();let resolve,resolveRename,failRead=false,fail=false,renameFail=true;let members=[{actorId:'owner',displayName:'林晓',actorKind:'human',role:'owner'},{actorId:'colleague',displayName:'陈雨',actorKind:'human',role:'member'},{actorId:'bot',displayName:'我的助手',actorKind:'session',role:'member'}];
let state={provider:'wecom',configured:true,canRefresh:!readonly,state:'idle',lastSyncedAt:1700000000000,lastAttemptAt:1700000000000,name:'inbound',members:'observe',pendingOperations:0};
if(params.has("many"))members.push(...Array.from({length:30},(_,i)=>({actorId:"more"+i,displayName:"群成员 "+i,actorKind:"human",role:"member"})));
const control={finishRename(){resolveRename?.()},failStatus(){failRead=true;control.changed()},recoverStatus(){failRead=false},calls:[],reads:0,renames:[],candidates:0,notices:[],complete(){state={...state,state:'idle',lastSyncedAt:1800000000000};control.changed()},changed(){for(const id of subs.keys())for(const fn of changes)fn(id)},failNext(){fail=true},finish(){resolve?.()},readonly,native};window.control=control;
const rpc={connect:async()=>{},close:async()=>{},onChanged:fn=>{changes.add(fn);return()=>changes.delete(fn)},onDisconnect:()=>()=>{},request:async(method,p,signal)=>{
 if(method==='opencraft/channels/subscribe'){subs.set(p.subscriptionId,p.channelId);return null;}
 if(method==='opencraft/channels/unsubscribe'){subs.delete(p.subscriptionId);return null;}
 if(method==='opencraft/channels/group/members/list')return{members};
 if(method==='opencraft/channels/group/candidates/search'){control.candidates++;return{candidates:[{actorId:'new',displayName:'周宁',actorKind:'human'}]};}
 if(method==='opencraft/channels/group/rename'){control.renames.push(p);if(renameFail){renameFail=false;throw Error('DISCONNECTED')}await new Promise(r=>resolveRename=r);return{...group,title:p.title};}
 if(method==='opencraft/channels/group/sync/status'){control.reads++;if(failRead)throw Error('DISCONNECTED');return native?null:state;}
 if(method==='opencraft/channels/group/sync/refresh'){control.calls.push(p.clientRequestId);if(fail){fail=false;throw Error('DISCONNECTED');}await new Promise(r=>resolve=r);state={...state,state:'pending'};return state;}
 throw Error('method_not_found');
}};
const client=new ChannelsClient(fetch,rpc),group={id:'group:fixture',title:params.has('long')?'产品设计与研发协作讨论组 · 一起把细节做好 · 长群名换行验证':'产品设计讨论组',kind:'group',canSend:true,canRename:!readonly,canManageMembers:!readonly};
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<GroupMembersButton client={client} group={group} reportError={notice=>control.notices.push(notice)}/>);
`;
const server=await createServer({root,configFile:false,cacheDir:path.join(out,'vite'),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-runtime','react-intl','@radix-ui/react-dialog']},plugins:[{name:'group-sync-fixture',resolveId:id=>id==='/group-sync-fixture.tsx'?id:null,load:id=>id==='/group-sync-fixture.tsx'?source:null,configureServer(s){s.middlewares.use((req,res,next)=>{if(req.headers.accept?.includes('text/html')){res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/group-sync-fixture.tsx"></script>');}else next();});}}]});
let browser;const evidence=[];
try {
 await server.listen();browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.OPENCRAFT_CHROMIUM?{executablePath:process.env.OPENCRAFT_CHROMIUM}:{})});
 const origin='http://127.0.0.1:'+server.httpServer.address().port;
 for(const width of[320,390,430,1200]){const touch=width<600;
  const context=await browser.newContext({viewport:{width,height:844},isMobile:touch,hasTouch:touch}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.getByRole('button',{name:'群设置',exact:true}).click();const section=page.getByRole('region',{name:'企业微信连接',exact:true});await section.waitFor();assert.match(await section.textContent(),/更新于/);assert.equal(await page.getByRole('textbox').count(),0);assert.equal(await page.evaluate(()=>window.control.candidates),0);await page.screenshot({path:path.join(out,'overview-'+width+'.png'),fullPage:true});
  const button=section.getByRole('button');assert.equal(await button.isEnabled(),true);
  await page.evaluate(()=>window.control.failNext());if(touch)await button.tap();else{await button.focus();await page.keyboard.press('Enter');}
  await section.getByText('检查失败，请重试',{exact:true}).waitFor();assert.equal(await button.isEnabled(),true);
  if(touch)await button.tap();else await button.click();await page.waitForFunction(()=>window.control.calls.length===2);assert.equal(await button.isDisabled(),true);
  const keys=await page.evaluate(()=>window.control.calls);assert.equal(keys[0],keys[1]);await page.evaluate(()=>window.control.finish());await section.getByText('等待同步',{exact:true}).waitFor();assert.equal(await button.isDisabled(),true);
  await page.evaluate(()=>window.control.complete());await section.getByText('同步正常',{exact:true}).waitFor();assert.equal(await button.isEnabled(),true);assert.match(await section.textContent(),/2027/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));await page.screenshot({path:path.join(out,'synced-'+width+'.png'),fullPage:true});
  await page.getByRole('button',{name:'修改群名',exact:true}).click();
  const input=page.getByRole('textbox',{name:'群名称',exact:true});assert.equal(await input.evaluate(el=>el.selectionStart===0&&el.selectionEnd===el.value.length),true);await input.fill('   ');assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isDisabled(),true);
  await input.fill('新的讨论组');await input.press('Enter');await page.waitForFunction(()=>window.control.notices.length===1);assert.equal(await input.inputValue(),'新的讨论组');
  await input.press('Enter');await page.waitForFunction(()=>window.control.renames.length===2);assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'取消',exact:true}).isDisabled(),true);await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.control.renames.length),2);await page.evaluate(()=>window.control.finishRename());await page.getByRole('button',{name:'修改群名',exact:true}).filter({hasText:'新的讨论组'}).waitFor();assert.equal(await page.getByRole('textbox').count(),0);
  const renames=await page.evaluate(()=>window.control.renames);assert.equal(renames[0].clientRequestId,renames[1].clientRequestId);
  await page.getByRole('button',{name:'修改群名',exact:true}).click();await input.fill('保留焦点');assert.equal(await page.getByRole('dialog').count(),1);await page.setViewportSize({width,height:380});await input.focus();assert.equal(await input.inputValue(),'保留焦点');
  await page.screenshot({path:path.join(out,'keyboard-'+width+'.png'),fullPage:true});await page.getByRole('button',{name:'取消',exact:true}).click();await page.setViewportSize({width,height:844});
  await page.getByRole('button',{name:'添加成员',exact:true}).click();await page.getByRole('button',{name:'添加 周宁',exact:true}).waitFor();assert.ok(await page.evaluate(()=>window.control.candidates)>0);
  await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.getByRole('searchbox').count(),0);
  await page.getByRole('button',{name:'完成',exact:true}).click();assert.equal(await page.getByRole('region',{name:'企业微信连接'}).count(),0);
  await page.goto(origin+'/?native');await page.getByRole('button',{name:'群设置',exact:true}).click();await page.waitForFunction(()=>window.control.reads>0);assert.equal(await page.getByRole('region',{name:'企业微信连接'}).count(),0);
  await page.goto(origin+'/?readonly');await page.getByRole('button',{name:'群设置',exact:true}).click();await page.getByRole('region',{name:'企业微信连接'}).waitFor();assert.equal(await page.getByRole('button',{name:'检查更新',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'修改群名',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'添加成员',exact:true}).count(),0);
  await page.evaluate(()=>window.control.failStatus());const retryRead=page.getByRole('region',{name:'企业微信连接'}).getByRole('button',{name:'重试',exact:true});await retryRead.waitFor();assert.equal(await retryRead.isEnabled(),true);await page.evaluate(()=>window.control.recoverStatus());await retryRead.click();await page.getByRole('button',{name:'检查更新',exact:true}).waitFor();
  await page.goto(origin+'/?many');await page.getByRole('button',{name:'群设置',exact:true}).click();await page.getByText('群成员 29',{exact:true}).waitFor();const body=page.locator('.settings-panel__body');assert.equal(await body.evaluate(el=>el.scrollHeight>el.clientHeight),true);await body.evaluate(el=>el.scrollTop=el.scrollHeight);await page.getByRole('region',{name:'企业微信连接'}).waitFor();assert.ok((await page.getByRole('button',{name:'完成',exact:true}).boundingBox()).y<100);
  await page.screenshot({path:path.join(out,'scroll-'+width+'.png'),fullPage:true});
  await page.goto(origin+'/?long');await page.getByRole('button',{name:'群设置',exact:true}).click();await page.getByRole('button',{name:'修改群名',exact:true}).filter({hasText:'产品设计与研发'}).waitFor();await page.screenshot({path:path.join(out,'long-'+width+'.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));assert.deepEqual(errors,[]);evidence.push({mode:touch?'touch-emulation':'desktop',realGroupSettings:true,rpc:'simulated',providerCalls:0,keyboard:!touch,tap:touch,sameKeyRetry:true,progressAndCompletion:true,nativeHidden:true,nonownerDisabled:true,noHorizontalOverflow:true});await context.close();
 }
 fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
} finally {await browser?.close();await server.close();}
