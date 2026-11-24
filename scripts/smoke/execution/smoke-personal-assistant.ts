import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import {AssistantThreadCommands} from '../../../packages/access-control/src/assistant-thread-commands';
import {ThreadAccessStore} from '../../../packages/access-control/src/thread-access';
import {createAssistantModelSource} from '../../../apps/local-agent-host/src/model-config/assistant';
import {ModelConfigurationRepository} from '../../../apps/local-agent-host/src/model-config/repository';
import {createPersonalAssistantHost} from '../../../apps/personal-assistant/src/runtime/host-supervisor.mjs';
import {ImChannelService} from '../../../apps/headless-server/src/im-channel-service.mjs';
import {AppHostServer} from '@opencraft/app-host-server';
import {ImChannelsAppServer} from '../../../apps/headless-server/src/im-channels-appserver.mjs';
import {createWorkbenchWebServer} from '../../../apps/headless-server/src/serve-workbench-web.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,loadConfigFromFile} from 'vite';
import {chromium} from 'playwright';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ActorStore} from '../../../packages/access-control/src/actors';
import {ActorAccess} from '../../../packages/access-control/src/actor-access';
import {Collaboration,CollaborationHttpApi} from '../../../packages/access-control/src/collaboration';
import {parsePrincipal} from '@opencraft/identity-core';

// Actual Workbench extension, native transport, communication authority and DB.
// Identity admission and worker execution are explicit fixtures. Model selection uses the real repository and RPC.
const root=await mkdtemp(join(tmpdir(),'personal-assistant-ui-'));
const evidence=process.env.OPENCRAFT_SMOKE_OUTPUT??'.local/personal-assistant-ui';
const storage=await openServerDatabase(root),actors=new ActorStore(storage);
const principal=parsePrincipal({provider:'local',subject:'ui-human',displayName:'Human',expiresAt:Date.now()+3600000})!;
const human=actors.resolveHuman(principal)!,bot=actors.createSession('Review Bot',human.actorId);
const credential=actors.issueCredential(bot.id,Date.now()+3600000,human.actorId),botContext=actors.authenticateSession(credential.token)!;
actors.setGrant(human.actorId,bot.id,'message.send',true,'fixture');
const service=new Collaboration(storage,actors,{hostId:'local-codex',serverId:'fixture',hostForServer:()=> 'local-codex',async discover(){return {conversations:[{ref:{serverId:'fixture',threadId:'task-source'},title:'Project task settings'}],nextCursor:null};},async validate(){},async receipt(){return null;},async add(){throw Error('fixture execution unavailable');},async steer(){throw Error('fixture execution unavailable');},async cancel(){return false;}});
const threadAccess=new ThreadAccessStore(storage,actors);threadAccess.created('fixture','task-source',human,'private');
const threadCommands=new AssistantThreadCommands(service,{async prepare(){return {cwd:'/project',model:'granted',sandbox:'read-only'};},async create(){throw Error('not used');},async createRoot(){throw Error('not used');},async snapshot(threadId){return {threadId,rootTurnId:null,turnId:null,state:'completed'};}},threadAccess);await threadCommands.initialize();
const models=new ModelConfigurationRepository(fileStateDocumentStore(join(root,'models')));await models.initialize();
await models.update(0,d=>{d.providers=[{id:'smoke',name:'Local test',enabled:true,protocol:'openai-responses',baseUrl:'http://127.0.0.1:1/v1',authentication:'none',credentialRef:null,models:[{id:'model-a',name:'Assistant A',enabled:true},{id:'model-b',name:'Assistant B',enabled:true}]}];});
const assistantHost=await createPersonalAssistantHost({directory:root,service,codexBinary:process.execPath,modelSource:createAssistantModelSource(join(root,'models')),intervalMs:50,spawn:()=>({ready:Promise.resolve(),failed:()=>false,async close(){}})});
const seeded=[];
for(let i=0;i<5;i++){
 const group=await service.communicate(human,'opencraft/channels/group/create',{title:'项目讨论 '+i,memberActorIds:[bot.id],clientRequestId:'directory-'+i});seeded.push(group);
 if(i<4)await service.communicate(botContext,'opencraft/channels/messages/send',{channelId:group.id,clientMessageId:'preview-'+i,parts:[{type:'text',text:'进展更新 '+i}]});
}
const access=new ActorAccess(actors,{authenticateHuman:()=>principal,admitted:()=>true,administrator:()=>false});
const api=new CollaborationHttpApi(service,access);
const im=await ImChannelService.open([],{dataDirectory:root,actors,actorAccess:access,collaboration:service,getAppHost:()=>null});
const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport:()=>new ImChannelsAppServer(()=>service)});
const backend=await createWorkbenchWebServer({root,appServerTarget:null,appHostServer:host,actorService:access,allowSessionChannels:true,actorCollaborationService:api,loopbackOnly:true,onAppHostDiagnostic(){}});
const {port:backendPort}=await backend.listen({host:'127.0.0.1',port:0});
const source=`
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId,frostThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {createImExtension} from '/plugins/im/src/index.tsx';
import {connectWebSocketAppHost} from '/apps/workbench-web/src/runtime/websocket-app-host.ts';
import {createChannelsRpc} from '/apps/workbench-web/src/runtime/channels-rpc.ts';
import {CHANNELS_HOST_ID} from '/packages/appserver-protocol/src/channels.ts';
import '/apps/workbench-web/src/styles/app.scss';
import {serveNodeHttpExchange} from '@opencraft/http-exchange/node';
initializeAppearanceTheme();
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
const wire=connectWebSocketAppHost();
await application.supervisor.extensions.activateOptional(createImExtension(fetch.bind(window),signal=>createChannelsRpc(wire.createTransport(CHANNELS_HOST_ID),signal)));
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN').render(<WorkbenchRoot application={application}/>);
window.proof={theme:(name)=>{setThemePreference(name==='frost'?'light':name);if(name==='frost')setAppearanceThemeId(frostThemeId);}};document.body.dataset.ready='true';`;
const applicationConfig=await loadConfigFromFile({command:'serve',mode:'development'},'apps/workbench-web/vite.config.ts');
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'.local/personal-assistant-ui-vite',logLevel:'error',
 define:{'process.env.NEXT_PUBLIC_REGION':'"cn"','process.env.NEXT_PUBLIC_PREVIEW_LOCALES':'""','import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN':'"false"','import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN':'"false"'},
 optimizeDeps:{...applicationConfig!.config.optimizeDeps,include:[...applicationConfig!.config.optimizeDeps!.include!,'@opencraft/browser-core/presentation']},esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/apphost':{target:'http://127.0.0.1:'+backendPort,ws:true}}},plugins:[{
 name:'native-channel-proof',resolveId:id=>id==='/native-channel-proof.tsx'?id:null,load:id=>id==='/native-channel-proof.tsx'?source:null,
 configureServer(vite){vite.middlewares.use((req,res,next)=>{
  if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/native-channel-proof.tsx"></script></body></html>');}
  else if(req.url?.startsWith('/__opencraft_im')){void im.handle(req,res,()=>true).catch(next);}
  else if(req.url?.startsWith('/__opencraft_actors/collaboration/'))void serveNodeHttpExchange(req,res,exchange=>api.handle(exchange));
  else next();
 });}
 }]});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 await server.listen();await mkdir(evidence,{recursive:true});
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const [width,theme] of [[1160,'light'],[1160,'dark'],[390,'light'],[390,'dark'],[1160,'frost']] as const){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<600});const errors:string[]=[];
  const activate=(locator:any)=>width<600?locator.tap():locator.click();
  page.on('pageerror',e=>errors.push(e.message));await page.addInitScript('window.__name = target => target;');
  await page.goto(server.resolvedUrls!.local[0],{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForSelector('body[data-ready="true"]',{state:'attached',timeout:90000});await page.evaluate(theme=>(window as any).proof.theme(theme),theme);
  const sidebar=page.locator('[data-chrome-action-id="sidebar-toggle"]:visible').first();
  if(await sidebar.count()&&(await sidebar.getAttribute('aria-expanded'))!=='true')await activate(sidebar);
  await activate(page.getByRole('button',{name:'Inbox',exact:true}));
  const closeSidebar=page.getByRole('button',{name:'关闭侧边栏',exact:true});
  if(width<600&&await closeSidebar.count()){const box=await closeSidebar.boundingBox();if(box)await closeSidebar.tap({position:{x:box.width-8,y:box.height/2}});}
  assert.equal(await page.getByRole('button',{name:'新建群聊',exact:true}).count(),0);
  await page.locator('.people-stream').waitFor();
  assert.equal(await page.locator('input:focus').count(),0);
  await page.waitForFunction(()=>document.querySelectorAll('.people-group').length===4);
  assert.equal(await page.locator('.people-group').count(),4);
  const segmented=page.locator('.people-toolbar .segmented-control');
  assert.equal(await segmented.getAttribute('data-width'),'content');
  assert.equal(await segmented.getAttribute('class'),'segmented-control');
  const geometry=await segmented.evaluate(e=>({width:e.getBoundingClientRect().width,parent:e.parentElement!.getBoundingClientRect().width,face:getComputedStyle(e).getPropertyValue('--height-segmented-face').trim(),heights:[...e.querySelectorAll('button')].map(b=>b.getBoundingClientRect().height)}));
  assert(geometry.width<geometry.parent);
  if(width<600)assert(geometry.heights.every(h=>h>=44));
  const groups=page.getByRole('radio',{name:'群聊',exact:true}),members=page.getByRole('radio',{name:'成员',exact:true});
  await groups.focus();await groups.press('ArrowRight');assert.equal(await members.getAttribute('aria-checked'),'true');
  await members.press('Home');assert.equal(await groups.getAttribute('aria-checked'),'true');
  await activate(members);await activate(groups);
  if(width<600){assert.equal(await groups.evaluate(e=>getComputedStyle(e,'::before').boxShadow.includes('0px 0px 0px 2px')),false);}

  assert.equal(await page.locator('.people-group').filter({hasText:'项目讨论 4'}).count(),0);
  await activate(page.getByRole('radio',{name:'成员',exact:true}));
  await page.locator('.people-member').first().waitFor();
  assert.equal(await page.getByRole('button',{name:'发消息',exact:true}).count(),0);
  await activate(page.getByRole('radio',{name:'群聊',exact:true}));
  await page.screenshot({path:join(evidence,theme+'-'+width+'-unclaimed.png'),fullPage:true});
  assert.equal(await page.getByRole('button',{name:'雇佣',exact:true}).count(),0);
  const reopenSidebar=page.locator('[data-chrome-action-id="sidebar-toggle"]:visible').first();
  if(await reopenSidebar.count()&&(await reopenSidebar.getAttribute('aria-expanded'))!=='true')await activate(reopenSidebar);
  await activate(page.getByRole('button',{name:'助理',exact:true}));
  if(width<600&&await closeSidebar.count()){const box=await closeSidebar.boundingBox();if(box)await closeSidebar.tap({position:{x:box.width-8,y:box.height/2}});}
  await page.getByRole('heading',{name:'助理',exact:true}).waitFor();
  const beforeHire=(await service.personalAssistant(human,'opencraft/personal-assistant/get')).assistant;
  assert.equal(beforeHire?.state==='claimed',false);
  await page.getByRole('button',{name:theme==='light'&&width===1160?'雇佣':'恢复助理',exact:true}).waitFor();
  await page.screenshot({path:join(evidence,theme+'-'+width+'-agents-directory.png'),fullPage:true});
  await activate(page.getByRole('button',{name:theme==='light'&&width===1160?'雇佣':'恢复助理',exact:true}));
  await page.getByRole('heading',{name:'我的助理',exact:true}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'可雇佣',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'雇佣',exact:true}).count(),0);
  const choose=page.getByRole('button',{name:'模型',exact:true});
  await choose.waitFor({timeout:15000});
  await page.waitForFunction(()=>{const e=document.querySelector('button[aria-label="模型"]');return e&&!e.hasAttribute('disabled');});
  if(width>=600){await choose.focus();await choose.press('Enter');}else await activate(choose);
  const chosen=theme==='light'?'Assistant A':'Assistant B';
  const option=page.getByRole('menuitemradio',{name:'Local test · '+chosen,exact:true});
  if(width>=600){await option.focus();await option.press('Enter');}else await activate(option);
  await page.getByText('已就绪，关闭页面后也会继续工作。',{exact:true}).waitFor({timeout:15000});
  assert.equal((await service.personalAssistant(human,'opencraft/personal-assistant/get')).assistant.model.modelId,theme==='light'?'model-a':'model-b');
  assert.equal(await page.locator('.people-page .ui-companion-avatar').count()>=1,true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await activate(page.getByRole('button',{name:'参照会话',exact:true}));
  await activate(page.getByRole('menuitemradio',{name:'Project task settings',exact:true}));
  await activate(page.locator('#people-assistant-details').getByRole('button',{name:'允许',exact:true}));
  await page.locator('#people-assistant-details').getByRole('button',{name:'关闭',exact:true}).waitFor();
  const granted=await service.personalAssistant(human,'opencraft/personal-assistant/threads/profiles',{});assert.equal(granted.profiles[0].enabled,true);
  await page.screenshot({path:join(evidence,theme+'-'+width+'-claimed.png'),fullPage:true});
  await activate(page.locator('#people-assistant-details').getByRole('button',{name:'关闭',exact:true}));
  await page.locator('#people-assistant-details').getByRole('button',{name:'允许',exact:true}).waitFor();
  assert.equal((await service.personalAssistant(human,'opencraft/personal-assistant/threads/profiles',{})).profiles[0].enabled,false);
  await activate(page.getByRole('button',{name:'收起助理设置',exact:true}));
  await page.screenshot({path:join(evidence,theme+'-'+width+'-claimed.png'),fullPage:true});
  await activate(page.getByRole('button',{name:'助理设置',exact:true}));
  if(width>=600){await choose.focus();await choose.press('Enter');await page.keyboard.press('Escape');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='模型');assert.equal(await choose.evaluate(e=>e===document.activeElement),true);}
  if(width===390&&theme==='dark'){
    await models.update(1,d=>{d.providers[0]!.enabled=false;});
    await activate(page.getByRole('button',{name:'收起助理设置',exact:true}));await activate(page.getByRole('button',{name:'助理设置',exact:true}));
    await page.getByText('所选模型不可用',{exact:true}).waitFor();
    assert.equal(await choose.isDisabled(),true);
    await page.getByText('选择一个模型，助理就能开始工作。',{exact:true}).waitFor({timeout:15000});
    await page.screenshot({path:join(evidence,'dark-390-unavailable.png'),fullPage:true});
    await models.update(2,d=>{d.providers[0]!.enabled=true;});
    await activate(page.getByRole('button',{name:'收起助理设置',exact:true}));await activate(page.getByRole('button',{name:'助理设置',exact:true}));
    await page.getByText('Local test · Assistant B',{exact:true}).waitFor();
    await page.getByText('已就绪，关闭页面后也会继续工作。',{exact:true}).waitFor({timeout:15000});
  }
  const assistant=(await service.personalAssistant(human,'opencraft/personal-assistant/get')).assistant;
  await activate(page.getByRole('button',{name:'打开对话',exact:true}));
  await page.locator('[contenteditable="true"]:visible').waitFor({timeout:15000});
  const directory=await service.communicate(human,'opencraft/channels/list',{});assert.equal(directory.groups.length,6);
  const cred=await service.provisionPersonalAssistant(human),botCtx=actors.authenticateSession(cred.credential.token)!;
  await service.communicate(botCtx,'personal-assistant/reply',{id:'smoke-'+width+'-'+theme,text:'你好，我是你的个人助理。'});
  await page.getByText('你好，我是你的个人助理。',{exact:true}).last().waitFor({timeout:15000});
  await page.screenshot({path:join(evidence,theme+'-'+width+'-chat.png'),fullPage:true});
  await service.personalAssistant(human,'opencraft/personal-assistant/revoke');
  assert.equal((await service.personalAssistant(human,'opencraft/personal-assistant/get')).assistant.binding.botId,assistant.binding.botId);
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS: actual Workbench, explicit claim, shared model selector and persisted selection, native DM; desktop/touch light/dark; no autofocus/overflow/errors. Execution is a fixture.');
}catch(error){const page=browser?.contexts().at(-1)?.pages().at(-1);if(page){console.error(await page.locator('body').innerText());await page.screenshot({path:join(evidence,'failure.png'),fullPage:true});}throw error;}finally{await browser?.close();await server.close();await backend.close();await host.close();await im.close();await assistantHost.close();await threadCommands.close();threadAccess.close();await service.close();actors.close();await storage.close();await rm(root,{recursive:true,force:true});}
