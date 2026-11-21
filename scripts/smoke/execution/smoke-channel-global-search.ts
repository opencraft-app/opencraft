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
// Only identity admission is synthetic; no model or external IM service is used.
const root=await mkdtemp(join(tmpdir(),'native-channel-ui-'));
const evidence=process.env.OPENCRAFT_SMOKE_OUTPUT??'.local/channel-search';
const storage=await openServerDatabase(root),actors=new ActorStore(storage);
const principal=parsePrincipal({provider:'local',subject:'ui-human',displayName:'Human',expiresAt:Date.now()+3600000})!;
const human=actors.resolveHuman(principal)!,bot=actors.createSession('Review Bot',human.actorId);
const credential=actors.issueCredential(bot.id,Date.now()+3600000,human.actorId),botContext=actors.authenticateSession(credential.token)!;
actors.setGrant(human.actorId,bot.id,'message.send',true,'fixture');
const service=new Collaboration(storage,actors,{hostId:'fixture',serverId:'fixture',async validate(){},async receipt(){return null;},async add(){throw Error('fixture execution unavailable');},async steer(){throw Error('fixture execution unavailable');},async cancel(){return false;}});
actors.setGrant(human.actorId,bot.id,'execution.queue',true,'fixture');
await service.bind(bot.id,'fixture-review',0,()=>{});
const claimed=await service.personalAssistant(human,'opencraft/personal-assistant/claim');
const assistantChannel=(await service.personalAssistant(human,'opencraft/personal-assistant/open')).channel;
let runtime:any={phase:'running',reception:{running:1,queued:0},works:[{id:'week',title:'本周进展摘要',status:'running',updatedAt:Date.now()}]};
service.attachPersonalAssistantHost({state:()=>runtime,wake(){}});
await service.communicate(human,'opencraft/channels/messages/send',{channelId:assistantChannel.id,clientMessageId:'hello',parts:[{type:'text',text:'帮我看看今天还有什么没完成'}]});
const assistantCredential=await service.provisionPersonalAssistant(human);
const assistantActor=actors.authenticateSession(assistantCredential.credential.token)!;
await service.communicate(assistantActor,'opencraft/channels/messages/send',{channelId:assistantChannel.id,clientMessageId:'response',parts:[{type:'text',text:'还有两件事需要你关注。\n\n1. **确认官网方案**\n\n   设计稿已更新，等你确认\n\n2. **整理本周进展**\n\n   我正在汇总相关会话\n\n整理好后，我会把摘要发在这里。'}]});
await service.communicate(human,'opencraft/channels/messages/send',{channelId:assistantChannel.id,clientMessageId:'followup',parts:[{type:'text',text:'好，把需要我决定的单独列出来'}]});
const colleague=actors.resolveHuman(parsePrincipal({provider:'local',subject:'colleague',displayName:'小林',expiresAt:Date.now()+3600000})!)!;
let discussion=await service.communicate(human,'opencraft/channels/group/create',{title:'产品方案讨论',memberActorIds:[colleague.actorId,bot.id],clientRequestId:'group-one'});
await service.communicate(colleague,'opencraft/channels/messages/send',{channelId:discussion.id,clientMessageId:'discussion-human',parts:[{type:'text',text:'设计稿更新好了，大家看看这个方案。'}]});
await service.communicate(botContext,'opencraft/channels/messages/send',{channelId:discussion.id,clientMessageId:'discussion-bot',parts:[{type:'text',text:'已整理好待确认项：\n\n- **导航**：统一入口\n- **排版**：保持阅读轴线'}]});
await service.communicate(human,'opencraft/channels/messages/send',{channelId:discussion.id,clientMessageId:'discussion-self',parts:[{type:'text',text:'收到，下午一起确认。'}]});
await service.communicate(human,'opencraft/channels/group/create',{title:'下周工作计划',memberActorIds:[],clientRequestId:'group-two'});
const archive=await service.communicate(human,'opencraft/channels/group/create',{title:'历史归档',memberActorIds:[colleague.actorId],clientRequestId:'group-history'});
for(let i=0;i<240;i++) await service.communicate(colleague,'opencraft/channels/messages/send',{channelId:archive.id,clientMessageId:'archive-'+i,parts:[{type:'text',text:'历史消息 '+i+'：'+('验证长内容的测量与阅读锚点。'.repeat(i%5+1))}]});
const {ChannelSync}=await import('../../../plugins/im/src/channel-sync');
let incoming:any;
const sync=await ChannelSync.open({bindings:[{source:'fixture-wecom',channelId:archive.id}],subscribe(fn){incoming=fn;return()=>{}},async send(){return 'delivered'}},service);
await incoming({source:'fixture-wecom',id:'search-wecom',author:'企微同事',sender:{id:'wecom-user',displayName:'企微同事'},text:'企微 IOA 搜索验证',at:Date.now()});
for(let i=0;i<70;i++)await service.communicate(colleague,'opencraft/channels/messages/send',{channelId:archive.id,clientMessageId:'tail-'+i,parts:[{type:'text',text:'后续消息 '+i}]});
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
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {createImExtension} from '/plugins/im/src/index.tsx';
import {ChannelsClient} from '/plugins/im/src/channel-client.ts';
import {connectWebSocketAppHost} from '/apps/workbench-web/src/runtime/websocket-app-host.ts';
import {createChannelsRpc} from '/apps/workbench-web/src/runtime/channels-rpc.ts';
import {CHANNELS_HOST_ID} from '/packages/appserver-protocol/src/channels.ts';
import '/apps/workbench-web/src/styles/app.scss';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density.ts';
import {openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
bindInteractionDensity(document, await openWorkbenchUiPreferences());
initializeAppearanceTheme();setAppearanceThemeId('opencraft.core.lavender');
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
const wire=connectWebSocketAppHost();
await application.supervisor.extensions.activateOptional(createImExtension(fetch.bind(window),signal=>createChannelsRpc(wire.createTransport(CHANNELS_HOST_ID),signal)));
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN').render(<WorkbenchRoot application={application}/>);
window.proof={theme:setThemePreference,stallStatus:()=>{ChannelsClient.prototype.assistantStatus=()=>new Promise(()=>{});}};document.body.dataset.ready='true';`;
const applicationConfig=await loadConfigFromFile({command:'serve',mode:'development'},'apps/workbench-web/vite.config.ts');
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'.local/assistant-chat-design-vite',logLevel:'error',
 define:{'process.env.NEXT_PUBLIC_REGION':'"cn"','process.env.NEXT_PUBLIC_PREVIEW_LOCALES':'""','import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN':'"false"','import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN':'"false"'},
 optimizeDeps:{...applicationConfig!.config.optimizeDeps,include:[...applicationConfig!.config.optimizeDeps!.include!,'@opencraft/browser-core/presentation']},esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/apphost':{target:'http://127.0.0.1:'+backendPort,ws:true}}},plugins:[{
 name:'native-channel-proof',resolveId:id=>id==='/native-channel-proof.tsx'?id:null,load:id=>id==='/native-channel-proof.tsx'?source:null,
 configureServer(vite){vite.middlewares.use((req,res,next)=>{
  if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/native-channel-proof.tsx"></script></body></html>');}
  else if(req.url?.startsWith('/__opencraft_im')){void im.handle(req,res,()=>true).catch(next);}
  else if(req.url?.startsWith('/__opencraft_actors/collaboration/'))void api.handle(req,res);
  else next();
 });}
 }]});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try {
 await server.listen();await mkdir(evidence,{recursive:true});
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const [width,theme]of [[1160,'light'],[390,'dark']]as const){
 const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<1000});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript('window.__name = target => target;');
 await page.goto(server.resolvedUrls!.local[0],{waitUntil:'domcontentloaded',timeout:90000});
 await page.waitForSelector('body[data-ready="true"]',{state:'attached',timeout:90000});
 await page.evaluate(theme=>(window as any).proof.theme(theme),theme);
 await page.keyboard.press('Control+k');
 const input=page.getByRole('combobox');await input.fill('IOA');
 const option=page.getByRole('option').filter({hasText:'企微 IOA 搜索验证'});
 await option.waitFor({timeout:15000});
 await page.screenshot({path:join(evidence,'results-'+width+'.png')});
 if(width<1000)await option.tap();else await page.keyboard.press('Enter');
 const match=page.locator('.im-channel-chat__conversation').getByText('企微 IOA 搜索验证',{exact:true});
 await match.waitFor({timeout:15000});
 await page.waitForTimeout(500);
 const bounds=await match.boundingBox();assert.ok(bounds&&bounds.y>=0&&bounds.y+bounds.height<900,JSON.stringify(bounds));
 assert.ok(await page.getByRole('button',{name:'最新消息',exact:true}).isVisible());
 await page.screenshot({path:join(evidence,'context-'+width+'.png')});
 const editor=page.locator('[contenteditable="true"]:visible').last();
 await editor.fill('搜索上下文中的草稿');
 await page.getByRole('button',{name:'最新消息',exact:true}).click();
 assert.equal(await editor.innerText(),'搜索上下文中的草稿');
 await page.getByText('后续消息 69',{exact:true}).waitFor();
 await page.keyboard.press('Control+k');await input.fill('无匹配字串');
 await page.waitForTimeout(600);assert.equal(await page.getByRole('option').count(),0);
 await input.fill('IOA');await option.waitFor();await input.fill('后续消息 69');
 await page.getByRole('option').filter({hasText:'后续消息 69'}).waitFor();
 assert.equal(await option.count(),0);
 assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS: native+WeCom global search, keyboard/touch selection, older-message context and latest navigation, query replacement; real Workbench/SQLite/AppServer, synthetic identity/provider transport.');
}catch(error){const page=browser?.contexts().at(-1)?.pages().at(-1);if(page){console.error(await page.locator('body').innerText());await page.screenshot({path:join(evidence,'failure.png')});}throw error;}
finally{await browser?.close();await server.close();await backend.close();await host.close();await im.close();await sync.close();await service.close();actors.close();await storage.close();await rm(root,{recursive:true,force:true});}
