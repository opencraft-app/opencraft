import fs from 'node:fs';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {groupDetailsShellSource as source} from './group-details-shell.fixture.mjs';
const task=process.env.OPENCRAFT_SYNC_UI_OUTPUT??process.cwd()+'/.local/group-lifecycle-browser/',root=process.cwd();fs.mkdirSync(task,{recursive:true});
const {createServer}=await import(pathToFileURL(root+'/node_modules/vite/dist/node/index.js'));
const {chromium}=await import(pathToFileURL(root+'/node_modules/playwright/index.mjs'));
const server=await createServer({root,configFile:false,cacheDir:task+'vite',publicDir:root+'/apps/workbench-web/public',logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['prosemirror-state','prosemirror-view','prosemirror-model','prosemirror-transform','prosemirror-commands','prosemirror-history','prosemirror-keymap','prosemirror-inputrules','prosemirror-schema-list','@dnd-kit/core','@dnd-kit/sortable','@dnd-kit/utilities','react','react-dom','react-dom/client','react/jsx-runtime','motion/react','@tanstack/react-query','react-intl','@radix-ui/react-dialog','@radix-ui/react-dropdown-menu','@radix-ui/react-popover','@radix-ui/react-alert-dialog','tslib']},plugins:[{name:'navigation-probe',resolveId:id=>id==='/lifecycle-probe.tsx'?id:null,load:id=>id==='/lifecycle-probe.tsx'?source:null,configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/@')||req.url?.startsWith('/node_modules')||req.url?.startsWith('/apps/')||req.url?.startsWith('/packages/')||req.url?.startsWith('/plugins/')||req.url?.startsWith('/lifecycle-probe.tsx')||req.url?.startsWith('/products/'))return next();if(req.headers.accept?.includes('text/html')){res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/lifecycle-probe.tsx"></script>')}else next()})}}]});

let browser,page;
try {
 await server.listen();browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const scenarios=[...([390,1200].flatMap(width=>['light','dark'].flatMap(theme=>[true,false].map(owner=>({width,theme,owner,remote:false}))))),{width:1200,theme:'light',owner:true,remote:true}];
 for(const {width,theme,owner,remote} of scenarios) {
  const touch=width<600,context=await browser.newContext({viewport:{width,height:844},hasTouch:touch,isMobile:touch,reducedMotion:'reduce'});
  page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(90000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({owner})=>{
   const id='group:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',listeners=new Set(),subscriptions=new Map(),disconnects=new Set(),receipts=new Map();
   let group={id,title:'产品设计讨论组',kind:'group',latestMessage:{text:'群内的历史记录',at:1700000000000},canSend:true,canManageMembers:owner,canRename:owner,listState:{hidden:false},lifecycle:{state:'active',revision:1,dissolvedAt:null,canLeave:!owner,canDissolve:owner}};
   const control={remoteDissolve(){group={...group,canSend:false,canManageMembers:false,canRename:false,lifecycle:{...group.lifecycle,state:'dissolved',revision:group.lifecycle.revision+1,dissolvedAt:Date.now(),canLeave:false,canDissolve:false}};control.changed()},calls:[],left:false,conflict:false,hold:false,release:null,keys:[],changed(){for(const key of subscriptions.keys())for(const fn of listeners)fn(key)}};window.lifecycle=control;
   const members=[{actorId:'owner',displayName:'林晓',actorKind:'human',role:'owner'},{actorId:'colleague',displayName:'陈雨',actorKind:'human',role:'member'},{actorId:'bot',displayName:'我的助手',actorKind:'session',role:'member'}];
   window.channelRpcFixture={draftScope:'group-lifecycle-test',supportsRead:true,async connect(){},async close(){},onChanged(fn){listeners.add(fn);return()=>listeners.delete(fn)},onDisconnect(fn){disconnects.add(fn);return()=>disconnects.delete(fn)},async request(method,p){
    if(method.endsWith('/subscribe')){subscriptions.set(p.subscriptionId,p.channelId);return {}};
    if(method.endsWith('/unsubscribe')){subscriptions.delete(p.subscriptionId);return {}};
    if(method==='opencraft/personal-assistant/get')return {assistant:null,runtime:{phase:'stopped'}};
    if(method==='opencraft/channels/list')return {groups:control.left||group.listState.hidden?[]:[structuredClone(group)]};
    if(method==='opencraft/channels/people/list')return {people:[],next:null};
    if(method==='opencraft/channels/group/leave'&&receipts.has(p.clientRequestId))return null;
    if(control.left)throw Error('channel_denied');
    if(method==='opencraft/channels/group/get')return structuredClone(group);
    if(method==='opencraft/channels/group/members/list')return {members};
    if(method==='opencraft/channels/group/sync/status')return null;
    if(method==='opencraft/channels/group/list-state/set'){group.listState.hidden=p.hidden;control.calls.push('hide');control.changed();return structuredClone(group)};
    if(method==='opencraft/channels/group/dissolve'){
     control.calls.push('dissolve');control.keys.push(p.clientRequestId);
     if(control.conflict){control.conflict=false;group.lifecycle.revision++;control.changed();throw Error('channel_revision_conflict')}
     if(p.expectedRevision!==group.lifecycle.revision)throw Error('channel_revision_conflict');
     if(control.hold){control.hold=false;await new Promise(resolve=>control.release=resolve);throw Error('lost reply')}
     group={...group,canSend:false,canManageMembers:false,canRename:false,lifecycle:{...group.lifecycle,state:'dissolved',revision:group.lifecycle.revision+1,dissolvedAt:Date.now(),canLeave:false,canDissolve:false}};control.changed();return structuredClone(group);
    }
    if(method==='opencraft/channels/group/leave'){control.calls.push('leave');receipts.set(p.clientRequestId,null);control.left=true;control.changed();return null};
    if(method==='opencraft/channels/sync')return {kind:'snapshot',cursor:'one',messages:[{sequence:1,messageId:'m1',author:'Alex',sender:{id:'alex',displayName:'Alex',actorKind:'human'},text:'群内的历史记录',at:1700000000000,status:'received'}],hasEarlier:false};
    if(method==='opencraft/channels/read')return null;
    throw Error('Unexpected fixture RPC '+method);
   }};
  },{owner});
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/?theme='+theme);
  await page.getByRole('button',{name:'Open Inbox',exact:true}).click();await page.locator('.page-stack__live').getByRole('button',{name:'产品设计讨论组',exact:true}).click();
  const settings=page.getByRole('button',{name:'群设置',exact:true});await settings.waitFor();if(touch)await settings.tap();else await settings.click();
  await page.getByRole('heading',{name:'聊天信息 (3)',exact:true}).waitFor();
  const hide=page.getByRole('button',{name:'从收件箱隐藏',exact:true});await hide.waitFor();
  await page.screenshot({path:task+'info-'+width+'-'+theme+'-'+owner+'.png'});
  if(remote){
   await page.getByRole('button',{name:'解散群聊',exact:true}).click();await page.getByRole('region',{name:'解散群聊',exact:true}).waitFor();
   await page.evaluate(()=>window.lifecycle.remoteDissolve());await page.getByText('此群已解散。现有成员可查看历史，但不能发送消息或邀请成员。',{exact:true}).waitFor();
   assert.equal(await page.getByRole('region',{name:'解散群聊',exact:true}).count(),0);assert.deepEqual(await page.evaluate(()=>window.lifecycle.calls),[]);
   await page.screenshot({path:task+'remote-dissolve-'+width+'-'+theme+'.png'});
  }else if(owner){
   assert.equal(await page.getByRole('button',{name:'退出群聊',exact:true}).count(),0);await page.getByText(/群主不能直接退出/).waitFor();
   const dissolve=page.getByRole('button',{name:'解散群聊',exact:true});await dissolve.click();
   const region=page.getByRole('region',{name:'解散群聊',exact:true});await region.waitFor();
   assert.match(await region.textContent(),/不会退出或解散企业微信群/);assert.equal(await page.getByRole('button',{name:'取消',exact:true}).evaluate(el=>el===document.activeElement),true);
   await page.screenshot({path:task+'confirm-'+width+'-'+theme+'.png'});
   await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await dissolve.evaluate(el=>el===document.activeElement),true);
   assert.deepEqual(await page.evaluate(()=>window.lifecycle.calls),[]);
   // A stale confirmation must refresh and require a new explicit confirmation.
   await dissolve.click();await page.evaluate(()=>window.lifecycle.conflict=true);await page.getByRole('region',{name:'解散群聊',exact:true}).getByRole('button',{name:'解散群聊',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'群信息已有变化'}).waitFor();assert.equal(await page.getByRole('region',{name:'解散群聊',exact:true}).count(),0);
   await dissolve.click();await page.evaluate(()=>window.lifecycle.hold=true);const confirm=page.getByRole('region',{name:'解散群聊',exact:true}).getByRole('button',{name:'解散群聊',exact:true});await confirm.click();
   assert.equal(await confirm.isDisabled(),true);await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),1);
   await page.evaluate(()=>window.lifecycle.release());await page.getByRole('alert').filter({hasText:'暂时无法确认'}).waitFor();await confirm.click();
   await page.getByText('此群已解散。现有成员可查看历史，但不能发送消息或邀请成员。',{exact:true}).waitFor();
   const keys=await page.evaluate(()=>window.lifecycle.keys);assert.equal(keys.at(-1),keys.at(-2),'unknown outcome retry reuses its request ID');assert.notEqual(keys[0],keys[1],'revision conflict requires a new confirmation');
   await page.getByRole('button',{name:'关闭',exact:true}).click();await page.getByText('群聊已解散 · 历史只读',{exact:true}).waitFor();assert.equal(await page.locator('.im-channel-chat__dock .composer').count(),0);
   await page.screenshot({path:task+'readonly-'+width+'-'+theme+'.png'});
  } else {
   assert.equal(await page.getByRole('button',{name:'解散群聊',exact:true}).count(),0);
   // Personal hide removes the directory item but the authorized open view survives.
   if(touch)await hide.tap();else await hide.click();
   const restore=page.getByRole('button',{name:'在收件箱显示',exact:true});await restore.waitFor();await restore.click();await hide.waitFor();
   await page.getByRole('button',{name:'退出群聊',exact:true}).click();await page.getByRole('region',{name:'退出群聊',exact:true}).waitFor();
   await page.screenshot({path:task+'leave-'+width+'-'+theme+'.png'});
   await page.getByRole('region',{name:'退出群聊',exact:true}).getByRole('button',{name:'退出群聊',exact:true}).click();
   await page.waitForFunction(()=>window.lifecycle.left);await page.waitForFunction(()=>document.querySelectorAll('[role=dialog]').length===0);
   assert.equal(await page.getByText('群内的历史记录',{exact:true}).count(),0);
  }
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({width,theme,owner,touch,actualShell:true,remoteDissolution:remote,externalProvider:'simulated',conflictAndRetry:owner,personalHideAndLeave:!owner}));await context.close();
 }
} catch(error){await page?.screenshot({path:task+'failure.png'}).catch(()=>{});fs.writeFileSync(task+'failure.txt',await page?.locator('body').innerText().catch(()=>'')??'');throw error;}finally{await browser?.close();await server.close();}
