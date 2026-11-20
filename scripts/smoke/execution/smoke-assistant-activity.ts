import {ImChannelService} from '../../im-channel-service.mjs';
import {AppHostServer} from '@opencraft/app-host-server';
import {ImChannelsAppServer} from '../../im-channels-appserver.mjs';
import {createWorkbenchWebServer} from '../../serve-workbench-web.mjs';
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
const evidence=process.env.OPENCRAFT_SMOKE_OUTPUT??'.local/assistant-activity';
const storage=await openServerDatabase(root),actors=new ActorStore(storage);
const principal=parsePrincipal({provider:'local',subject:'ui-human',displayName:'Human',expiresAt:Date.now()+3600000})!;
const human=actors.resolveHuman(principal)!,bot=actors.createSession('Review Bot',human.actorId);
const credential=actors.issueCredential(bot.id,Date.now()+3600000,human.actorId),botContext=actors.authenticateSession(credential.token)!;
actors.setGrant(human.actorId,bot.id,'message.send',true,'fixture');
const service=new Collaboration(storage,actors,{hostId:'fixture',serverId:'fixture',async validate(){},async receipt(){return null;},async add(){throw Error('fixture execution unavailable');},async steer(){throw Error('fixture execution unavailable');},async cancel(){return false;}});
const claimed=await service.personalAssistant(human,'opencraft/personal-assistant/claim');
const assistantChannel=(await service.personalAssistant(human,'opencraft/personal-assistant/open')).channel;
const provision=await service.provisionPersonalAssistant(human);
const assistantActor=actors.authenticateSession(provision.credential.token)!;
let runtime:any={phase:'running',reception:{running:1,queued:2}};
service.attachPersonalAssistantHost({state:()=>runtime,wake(){}});
await service.communicate(human,'opencraft/channels/messages/send',{channelId:assistantChannel.id,clientMessageId:'hello',parts:[{type:'text',text:'Please check my tasks.'}]});
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
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {createImExtension} from '/plugins/im/src/index.tsx';
import {ChannelsClient} from '/plugins/im/src/channel-client.ts';
import {connectWebSocketAppHost} from '/apps/workbench-web/src/runtime/websocket-app-host.ts';
import {createChannelsRpc} from '/apps/workbench-web/src/runtime/channels-rpc.ts';
import {CHANNELS_HOST_ID} from '/packages/appserver-protocol/src/channels.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
const wire=connectWebSocketAppHost();
await application.supervisor.extensions.activateOptional(createImExtension(fetch.bind(window),signal=>createChannelsRpc(wire.createTransport(CHANNELS_HOST_ID),signal)));
createIntlTestRoot(document.getElementById('app'),undefined,'en-US').render(<WorkbenchRoot application={application}/>);
let releaseStatus; let held=false;
const originalStatus=ChannelsClient.prototype.assistantStatus;
window.proof={theme:setThemePreference,holdStatus:()=>{ChannelsClient.prototype.assistantStatus=async function(signal){ const value=await originalStatus.call(this,signal); ChannelsClient.prototype.assistantStatus=originalStatus; held=true; await new Promise(resolve=>releaseStatus=resolve); return value; };},held:()=>held,releaseStatus:()=>{held=false;releaseStatus();},stallStatus:()=>{ChannelsClient.prototype.assistantStatus=()=>new Promise(()=>{});}};document.body.dataset.ready='true';`;
const applicationConfig=await loadConfigFromFile({command:'serve',mode:'development'},'apps/workbench-web/vite.config.ts');
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:join(evidence,'vite-cache'),logLevel:'error',
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
 for(const [width,theme]of [[1160,'light'],[390,'dark']]as const) {
  runtime={phase:'running',reception:{running:1,queued:2}};
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<600});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const activate=(locator:import('playwright').Locator)=>width<600?locator.tap():locator.click();
  await page.addInitScript('window.__name = target => target;');
  await page.goto(server.resolvedUrls!.local[0],{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForSelector('body[data-ready="true"]',{state:'attached',timeout:90000});
  await page.evaluate(theme=>(window as any).proof.theme(theme),theme);
  const sidebar=page.locator('[data-chrome-action-id="sidebar-toggle"]:visible').first();
  if(await sidebar.count()&&(await sidebar.getAttribute('aria-expanded'))!=='true')await activate(sidebar);
  await activate(page.getByRole('button',{name:'Inbox',exact:true}));
  const close=page.getByRole('button',{name:'Close sidebar',exact:true});
  if(width<600&&await close.count()){const box=await close.boundingBox();if(box)await close.tap({position:{x:box.width-8,y:box.height/2}});}
  if(width<600)await page.keyboard.press('Escape');
  await activate(page.getByRole('button',{name:'Open assistant',exact:true}));
  await page.getByText('Replying… 2 waiting',{exact:true}).waitFor({timeout:15000});
  await page.waitForFunction(()=>document.querySelector('.im-assistant-activity .ui-companion-avatar')?.getAttribute('data-motion')==='playing');
  assert.equal(await page.locator('.im-channel-chat__avatar [data-activity="working"]').count(),0,'history is static');
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(100);
  assert.equal(await page.locator('.im-assistant-activity [data-motion="playing"]').count(),0);
  await page.emulateMedia({reducedMotion:'no-preference'});
  const editor=page.locator('[contenteditable="true"]:visible').last();await editor.fill('Draft stays intact');
  const before=await editor.boundingBox();
  await page.getByText('Please check my tasks.',{exact:true}).waitFor({timeout:60000});
  await page.waitForTimeout(600);
  await page.screenshot({path:join(evidence,theme+'-'+width+'.png'),fullPage:true});
  runtime={phase:'running',reception:{running:1,queued:2},modelWait:{reason:'rate_limit',retryAt:Date.now()+90000}};
  await page.getByText('Model service busy; waiting to retry…',{exact:true}).waitFor({timeout:15000});
  assert.equal(await editor.innerText(),'Draft stays intact');
  assert.equal(await page.locator('.im-assistant-activity svg').getAttribute('data-activity'),'waiting');
  await page.screenshot({path:join(evidence,theme+'-'+width+'-rate-limit.png'),fullPage:true});
  runtime={phase:'running',reception:{running:1,queued:2},modelWait:{reason:'capacity'}};
  await page.getByText('Waiting for model capacity…',{exact:true}).waitFor({timeout:15000});
  runtime={phase:'running',reception:{running:1,queued:0}};
  await page.getByText('Replying…',{exact:true}).waitFor({timeout:15000});
  // Hold a stale busy read across the native final reply event. Its late
  // response must not resurrect the activity, including terminal error replies.
  await page.evaluate(()=>(window as any).proof.holdStatus());
  await page.waitForFunction(()=>(window as any).proof.held());
  runtime={phase:'running',reception:{running:0,queued:0}};
  await service.communicate(assistantActor,'personal-assistant/reply',{id:'final-'+theme,text:'Final reply '+theme});
  await page.getByText('Final reply '+theme,{exact:true}).waitFor();
  await page.evaluate(()=>(window as any).proof.releaseStatus());
  await page.waitForFunction(()=>document.querySelector('.im-assistant-activity')?.textContent==='',{},{timeout:2000});
  runtime={phase:'running',reception:{running:1,queued:1}};
  await service.communicate(assistantActor,'personal-assistant/reply',{id:'error-'+theme,text:'Model service busy final '+theme});
  await page.getByText('Model service busy final '+theme,{exact:true}).waitFor();
  await page.getByText('Replying… 1 waiting',{exact:true}).waitFor({timeout:2000});
  runtime={phase:'running',reception:{running:0,queued:0}};
  await page.waitForFunction(()=>document.querySelector('.im-assistant-activity')?.textContent==='');
  assert.equal(await editor.innerText(),'Draft stays intact');
  const after=await editor.boundingBox();assert.ok(Math.abs(after!.y-before!.y)<1,'status must not move composer');
  assert.equal(await page.getByText('收到，正在处理这条输入；这还不是处理结果。',{exact:true}).count(),0);
  // Task state lives outside the timeline; terminal entries from older Hosts are ignored.
  runtime={phase:'running',reception:{running:0,queued:0},works:[
    {id:'old',title:'Old reminder instruction',status:'completed',updatedAt:1},
    {id:'current',title:'Preparing dinner reminder',status:'awaiting_delivery',updatedAt:Date.now()}
  ]};
  const summary=page.locator('.im-channel-chat__work-summary');
  await summary.waitFor({timeout:15000});
  assert.equal(await page.locator('.im-channel-chat__timeline .im-channel-chat__current-work').count(),0);
  assert.equal(await page.getByText('Old reminder instruction',{exact:true}).count(),0);
  assert.ok((await summary.boundingBox())!.height<=56,'current tasks occupy only one compact control row');
  const bounds=await summary.boundingBox();
  assert.ok(bounds!.x>=0 && bounds!.x+bounds!.width<=width,'task summary fits the viewport');
  const switcherBounds=await page.getByRole('button',{name:'Switch chat',exact:true}).boundingBox();
  assert.ok(switcherBounds!.x+switcherBounds!.width<=width,'task text cannot push chat navigation offscreen');
  await page.screenshot({path:join(evidence,theme+'-'+width+'-current-work.png'),fullPage:true});
  await activate(summary);
  await page.getByRole('dialog').waitFor();
  await page.screenshot({path:join(evidence,theme+'-'+width+'-work-details.png'),fullPage:true});
  runtime={phase:'running',reception:{running:0,queued:0},works:[{id:'current',title:'Preparing dinner reminder',status:'completed',updatedAt:Date.now()}]};
  await page.getByText('No current tasks',{exact:true}).waitFor({timeout:15000});
  await page.keyboard.press('Escape');
  await summary.waitFor({state:'detached'});
  assert.equal(await editor.innerText(),'Draft stays intact');
  const settled=await editor.boundingBox();assert.ok(Math.abs(settled!.y-before!.y)<1,'finishing work restores the same composer position');
  await page.screenshot({path:join(evidence,theme+'-'+width+'-settled.png'),fullPage:true});
  runtime={phase:'config_required'};
  await page.getByText('Choose an assistant model in Agents',{exact:true}).waitFor({timeout:15000});
  runtime={phase:'running'};
  await page.getByText('Assistant status unavailable',{exact:true}).waitFor({timeout:15000});
  assert.equal(await editor.innerText(),'Draft stays intact');
  runtime={phase:'running',reception:{running:1,queued:0}};
  await page.getByText('Replying…',{exact:true}).waitFor({timeout:15000});
  await page.evaluate(()=>(window as any).proof.stallStatus());
  await page.getByText('Assistant status unavailable',{exact:true}).waitFor({timeout:10000});
  assert.equal(await editor.innerText(),'Draft stays intact');
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS: real Workbench assistant DM status transitions, no ack history, stable composer/draft, unknown state; light desktop and dark touch. Model/Host observations are synthetic.');
} catch(error) {
 const page=browser?.contexts().at(-1)?.pages().at(-1);if(page){console.error(await page.locator('body').innerText());await page.screenshot({path:join(evidence,'failure.png'),fullPage:true});}throw error;
} finally {await browser?.close();await server.close();await backend.close();await host.close();await im.close();await service.close();actors.close();await storage.close();await rm(root,{recursive:true,force:true});}
