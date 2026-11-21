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
const evidence=process.env.OPENCRAFT_SMOKE_OUTPUT??'.local/native-channel-ui';
const storage=await openServerDatabase(root),actors=new ActorStore(storage);
const principal=parsePrincipal({provider:'local',subject:'ui-human',displayName:'Human',expiresAt:Date.now()+3600000})!;
const human=actors.resolveHuman(principal)!,bot=actors.createSession('Review Bot',human.actorId);
const credential=actors.issueCredential(bot.id,Date.now()+3600000,human.actorId),botContext=actors.authenticateSession(credential.token)!;
actors.setGrant(human.actorId,bot.id,'message.send',true,'fixture');
const service=new Collaboration(storage,actors,{hostId:'fixture',serverId:'fixture',async validate(){},async receipt(){return null;},async add(){throw Error('fixture execution unavailable');},async steer(){throw Error('fixture execution unavailable');},async cancel(){return false;}});
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
import {connectWebSocketAppHost} from '/apps/workbench-web/src/runtime/websocket-app-host.ts';
import {createChannelsRpc} from '/apps/workbench-web/src/runtime/channels-rpc.ts';
import {CHANNELS_HOST_ID} from '/packages/appserver-protocol/src/channels.ts';
import '/apps/workbench-web/src/styles/app.scss';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density.ts';
import {openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
bindInteractionDensity(document, await openWorkbenchUiPreferences());
initializeAppearanceTheme();
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
const wire=connectWebSocketAppHost();
await application.supervisor.extensions.activateOptional(createImExtension(fetch.bind(window),signal=>createChannelsRpc(wire.createTransport(CHANNELS_HOST_ID),signal)));
createIntlTestRoot(document.getElementById('app'),undefined,'en-US').render(<WorkbenchRoot application={application}/>);
window.proof={theme:setThemePreference,openGroup:id=>application.supervisor.navigation.openExtensionView('opencraft.im.channel-chat','opencraft-channel:'+id)};document.body.dataset.ready='true';`;
const applicationConfig=await loadConfigFromFile({command:'serve',mode:'development'},'apps/workbench-web/vite.config.ts');
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'.local/native-channel-ui-vite',logLevel:'error',
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
try{
 await server.listen();await mkdir(evidence,{recursive:true});
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 for(const [width,theme] of [[1160,'light'],[390,'dark']] as const){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:width<600});const errors:string[]=[];
  const activate=(locator:import('playwright').Locator)=>width<600?locator.tap({timeout:60000}):locator.click({timeout:60000});
  page.on('console',message=>{if(message.type()==='error')console.error('console:',message.text());});
  page.on('requestfailed',request=>console.error('request:',request.url(),request.failure()?.errorText));
  page.on('crash',()=>console.error('browser crashed at width',width));
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
  await page.addInitScript('window.__name = target => target;');
  await page.goto(server.resolvedUrls!.local[0],{waitUntil:'domcontentloaded',timeout:90000});await page.waitForSelector('body[data-ready="true"]',{state:'attached',timeout:90000}).catch(async error=>{console.error(await page.locator('body').innerText());await page.screenshot({path:join(evidence,'failure.png')});throw error;});
  await page.evaluate(theme=>(window as any).proof.theme(theme),theme);
  const sidebar=page.locator('[data-chrome-action-id="sidebar-toggle"]:visible').first();
  if(await sidebar.count()&&(await sidebar.getAttribute('aria-expanded'))!=='true')await activate(sidebar);
  const group=await service.communicate(human,'opencraft/channels/group/create',{title:'Native group '+width,memberActorIds:[bot.id],clientRequestId:'fixture-group-'+width}) as {id:string};
  console.info('native-group-created',width,group.id);
  await page.evaluate(id=>(window as any).proof.openGroup(id),group.id);
  console.info('native-group-opened',width);
  const closeSidebar=page.getByRole('button',{name:'Close sidebar',exact:true});if(width<600&&await closeSidebar.count()){const box=await closeSidebar.boundingBox();if(box)await closeSidebar.tap({position:{x:box.width-8,y:box.height/2}});}
  await service.communicate(botContext,'opencraft/channels/messages/send',{channelId:group.id,clientMessageId:'incoming-'+width,parts:[{type:'text',text:'Review Bot received the group message.'}]});
  await page.getByText('Review Bot received the group message.',{exact:true}).waitFor({timeout:20000});
  const editor=page.locator('[contenteditable="true"]:visible').last();await editor.fill('Human reply from '+width);await activate(page.getByRole('button',{name:'Send message',exact:true}));
  await page.getByText('Human reply from '+width,{exact:true}).waitFor({timeout:15000});
  let unread=0;for(let attempt=0;attempt<100;attempt++){unread=(await service.syncInbox(botContext)).changes.find(c=>c.channelId===group.id)?.item?.unreadCount??0;if(unread===1)break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(unread,1);
  const source='fixture/wecom/'+width,incarnation='smoke-'+width;
  await service.synchronizeChannels({method:'configure',params:{incarnation,bindings:[{source,channelId:group.id}],images:true}});
  const arrival={source,id:'external',author:'Wei',sender:{id:'external-user',displayName:'Wei'},text:'External message in the same native group',at:Date.now()};
  await service.synchronizeChannels({method:'ingest',params:{incarnation,source,arrival}});
  await page.getByText(arrival.text,{exact:true}).waitFor({timeout:15000});
  assert.equal((await service.communicate(human,'opencraft/channels/list',{})).groups.filter(g=>g.id===group.id).length,1);
  const imageArrival={...arrival,id:'image',text:'',mediaId:'fixture-image'};
  const admitted=await service.synchronizeChannels({method:'ingest',params:{incarnation,source,arrival:imageArrival}});
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=','base64');
  await service.synchronizeChannels({method:'imageReady',params:{incarnation,source,messageId:admitted.messageId,bytes}});
  const preview=page.getByRole('button',{name:'Preview image',exact:true});
  await preview.waitFor({timeout:15000});
  await page.waitForFunction(()=>{const img=document.querySelector('.im-channel-chat__picture img') as HTMLImageElement;return img?.complete&&img.naturalWidth>0;});
  await activate(preview);await page.getByRole('dialog').getByRole('img',{name:'Preview image'}).waitFor();
  await activate(page.getByRole('button',{name:'Close image preview',exact:true}));
  // Owner renames the group from the chat header; the header and directory follow.
  console.info('native-group-rename-start',width);
  await activate(page.getByRole('button',{name:'Group settings',exact:true}));
  const settings=page.getByRole('dialog');const nameField=settings.getByLabel('Group name',{exact:true});
  assert.equal(await nameField.inputValue(),'Native group '+width);
  await nameField.fill('Renamed group '+width);await activate(settings.getByRole('button',{name:'Save',exact:true}));
  await settings.getByText('Group name saved.',{exact:true}).waitFor({timeout:15000});
  await page.screenshot({path:join(evidence,theme+'-'+width+'-rename.png'),fullPage:true});
  await activate(settings.getByRole('button',{name:'Done',exact:true}));await settings.waitFor({state:'hidden'});
  await page.getByRole('heading',{name:'Renamed group '+width,exact:true}).waitFor({timeout:15000});
  assert.equal((await service.communicate(human,'opencraft/channels/list',{})).groups.find((g:any)=>g.id===group.id).title,'Renamed group '+width);
  // Non-owners get the read-only members dialog.
  assert.equal((await service.communicate(botContext,'opencraft/channels/list',{})).groups.find((g:any)=>g.id===group.id).canRename,false);
  await page.screenshot({path:join(evidence,theme+'-'+width+'.png'),fullPage:true});
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS: real Workbench native group, owner rename, Bot receive, Human reply, external native timeline, authenticated image load and preview; light desktop and dark touch layout.');
}catch(error){const page=browser?.contexts().at(-1)?.pages().at(-1);if(page){console.error(await page.locator('body').innerText());await page.screenshot({path:join(evidence,'failure.png'),fullPage:true});}throw error;}finally{await browser?.close();await server.close();await backend.close();await host.close();await im.close();await service.close();actors.close();await storage.close();await rm(root,{recursive:true,force:true});}
