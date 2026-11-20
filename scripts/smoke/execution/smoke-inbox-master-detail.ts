import {ImChannelService} from '../../im-channel-service.mjs';
import {AppHostServer} from '@opencraft/app-host-server';
import {ImChannelsAppServer} from '../../im-channels-appserver.mjs';
import {createWorkbenchWebServer} from '../../serve-workbench-web.mjs';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
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
const evidence=process.env.OPENCRAFT_SMOKE_OUTPUT??'.local/inbox-master-detail';
const storage=await openServerDatabase(root),actors=new ActorStore(storage);
const principal=parsePrincipal({provider:'local',subject:'image-smoke-human',displayName:'Human',expiresAt:Date.now()+3600000})!;
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
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'browser',clientProduct:createSmokeClientProduct()});
const wire=connectWebSocketAppHost();
await application.supervisor.extensions.activateOptional(createImExtension(fetch.bind(window),signal=>createChannelsRpc(wire.createTransport(CHANNELS_HOST_ID),signal)));
createIntlTestRoot(document.getElementById('app'),undefined,'en-US').render(<WorkbenchRoot application={application}/>);
window.proof={navigation:application.supervisor.navigation,theme:setThemePreference,openGroup:id=>application.supervisor.navigation.openExtensionView('opencraft.im.channel-chat','opencraft-channel:'+id)};document.body.dataset.ready='true';`;
const applicationConfig=await loadConfigFromFile({command:'serve',mode:'development'},'apps/workbench-web/vite.config.ts');
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'.local/inbox-master-detail-vite',logLevel:'error',
 define:{'process.env.NEXT_PUBLIC_REGION':'"cn"','process.env.NEXT_PUBLIC_PREVIEW_LOCALES':'""','import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN':'"false"','import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN':'"false"'},
 optimizeDeps:{...applicationConfig!.config.optimizeDeps,include:[...applicationConfig!.config.optimizeDeps!.include!,'@opencraft/browser-core/presentation']},esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/apphost':{target:'http://127.0.0.1:'+backendPort,ws:true}}},plugins:[{
 name:'native-channel-proof',resolveId:id=>id==='/native-channel-proof.tsx'?id:null,async load(id){
  if(id==='/native-channel-proof.tsx')return source;
  if(process.env.OPENCRAFT_INBOX_NEGATIVE_CONTROL==='retention'&&/\/(?:app|hostless-workbench)\.tsx$/.test(id))return(await readFile(id,'utf8')).replace(' routeFamilies={extensionProjection.routeFamilies}','');
  return null;
 },
 configureServer(vite){vite.middlewares.use((req,res,next)=>{
  if(req.url==='/fixture-avatar.svg'){res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#257c62"/><circle cx="16" cy="12" r="6" fill="white"/><path d="M6 30a10 10 0 0 1 20 0" fill="white"/></svg>');}
  else if(req.headers.accept?.includes('text/html')){res.setHeader('content-type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/native-channel-proof.tsx"></script></body></html>');}
  else if(req.url?.startsWith('/__opencraft_im')){void im.handle(req,res,()=>true).catch(next);}
  else if(req.url?.startsWith('/__opencraft_actors/collaboration/'))void api.handle(req,res);
  else next();
 });}
 }]});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const results:any[]=[];
try {
 await server.listen();await mkdir(evidence,{recursive:true});
 const groups:{id:string;title:string}[]=[];
 for(let i=0;i<26;i++){
  const group=await service.communicate(human,'opencraft/channels/group/create',{title:i===0?'Product design':i===1?'Release coordination':'Team discussion '+i,memberActorIds:[bot.id],clientRequestId:'split-group-'+i}) as {id:string;title:string};
  await service.communicate(human,'opencraft/channels/messages/send',{channelId:group.id,clientMessageId:'split-message-'+i,parts:[{type:'text',text:'A real group message for '+group.title}]});groups.push(group);
 }
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
 for(const scenario of [
  {name:'desktop-light',width:1440,touch:false,theme:'light'},
  {name:'desktop-touch-dark',width:1440,touch:true,theme:'dark'},
  {name:'narrow-pointer',width:390,touch:false,theme:'dark'},
  {name:'mobile-touch',width:390,touch:true,theme:'light'},
 ].filter(x=>!process.env.OPENCRAFT_INBOX_CASE||x.name===process.env.OPENCRAFT_INBOX_CASE)){
  const {width,touch,theme,name}=scenario;const context=await browser.newContext({viewport:{width,height:900},hasTouch:touch}),page=await context.newPage();
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.addInitScript('window.__name=target=>target;');
  await page.goto(server.resolvedUrls!.local[0],{waitUntil:'domcontentloaded',timeout:90000});await page.waitForSelector('body[data-ready="true"]',{state:'attached',timeout:90000});
  await page.evaluate(theme=>(window as any).proof.theme(theme),theme);
  await page.evaluate(()=>(window as any).proof.navigation.openExtensionView('opencraft.im.people'));
  const root=page.locator('.app-shell-master-detail:visible'),list=page.locator('.people-page--inbox:visible');await root.waitFor();await list.getByRole('button',{name:groups[0].title,exact:true}).waitFor();
  // Capture the actual DOM, not a duplicate lookalike from a retained ancestor.
  await list.evaluate(el=>(window as any).originalInbox=el);
  const selectedBefore=await page.locator('.im-channel-chat__conversation').count();assert.equal(selectedBefore,0,'empty Inbox must not auto-open/read a chat');
  const activate=(locator:import('playwright').Locator)=>touch?locator.tap():locator.click();
  await activate(list.getByRole('button',{name:groups[0].title,exact:true}));
  const editor=page.locator('.im-channel-chat__conversation [contenteditable="true"]:visible').last();await editor.waitFor();
  assert.equal(await page.locator('.people-page--inbox').count(),1,'one list owner across root/detail routes');
  const selectedRow=page.locator('.people-group[aria-current="page"]');
  assert.equal(await selectedRow.getAttribute('aria-current'),'page');
  if(width>1000){
   await page.mouse.move(1435,5);await page.waitForTimeout(200);
   const normal=await selectedRow.evaluate(el=>getComputedStyle(el).backgroundColor);
   assert.notEqual(normal,'rgba(0, 0, 0, 0)');
   // Append the real shared reset after Inbox CSS: lazy pack order cannot whiten selection.
   await page.addStyleTag({content:'.ui-button.ui-object-row-button:hover:not(:disabled):not(:active){background:transparent;}'});
   await selectedRow.hover();await page.waitForTimeout(200);
   assert.equal(await selectedRow.evaluate(el=>getComputedStyle(el).backgroundColor),normal,'selected row keeps background under quiet hover');
   assert.equal(await page.locator('.app-shell-header [data-navigation-scope="page"]').count(),0,'split must not show page return');
  }
  assert.equal(await page.locator('.people-page--inbox').evaluate(el=>el===(window as any).originalInbox),true,'same retained list DOM');
  if(width===390)await page.locator('.app-shell-header').getByRole('button',{name:'Back',exact:true}).waitFor();
  const expected=width===390?'detail':'split';await page.waitForFunction(mode=>document.querySelector('.app-shell-master-detail')?.getAttribute('data-presentation')===mode,expected);
  await editor.fill('Draft A: keep my input');await editor.focus();
  await editor.evaluate(el=>{(window as any).originalEditor=el;const sel=getSelection()!;sel.selectAllChildren(el);sel.collapseToEnd();});
  // Actual host capacity, while the browser remains wide: cannot use window
  // breakpoints. Both directions keep this exact editor and the focused caret.
  if(width>1000){
   await root.evaluate(el=>{el.style.width='500px';});await page.waitForFunction(()=>document.querySelector('.app-shell-master-detail')?.getAttribute('data-presentation')==='detail');
   assert.equal(await editor.evaluate(el=>el===(window as any).originalEditor&&document.activeElement===el&&!!getSelection()?.anchorNode&&el.contains(getSelection()!.anchorNode)),true);
   assert.equal(await page.locator('.app-shell-master-detail__master').evaluate(el=>el.inert&&el.getAttribute('aria-hidden')==='true'),true);
   await root.evaluate(el=>{el.style.removeProperty('width');});await page.waitForFunction(()=>document.querySelector('.app-shell-master-detail')?.getAttribute('data-presentation')==='split');
   assert.equal(await editor.evaluate(el=>el===(window as any).originalEditor&&document.activeElement===el),true);
   assert.equal((await editor.innerText()).trim(),'Draft A: keep my input');
   const stream=page.locator('.people-page--inbox .people-stream');await stream.evaluate(el=>{el.scrollTop=120;});const beforeScroll=await stream.evaluate(el=>el.scrollTop);assert.ok(beforeScroll>0);
   await page.evaluate(id=>(window as any).proof.openGroup(id),groups[1].id);await editor.waitFor();assert.equal(await stream.evaluate(el=>el.scrollTop),beforeScroll,'switching group keeps list scroll position');
   await page.evaluate(id=>(window as any).proof.openGroup(id),groups[0].id);await editor.waitFor();
   const search=page.getByRole('textbox',{name:'Search groups, people and assistants',exact:true});await search.fill('Product');
   await page.evaluate(()=>{const el=document.querySelector('.people-page--inbox')!;el.scrollTop=0;});
   const mark=await list.evaluate(el=>({top:el.querySelector('.people-stream')!.scrollTop,query:el.querySelector('input')!.value}));
   await page.evaluate(id=>(window as any).proof.openGroup(id),groups[1].id);await page.locator('.im-channel-chat__conversation').filter({has:page.getByText('Release coordination',{exact:true})}).waitFor();
   assert.equal(await page.locator('.people-page--inbox').evaluate(el=>el===(window as any).originalInbox),true);
   assert.deepEqual(await list.evaluate(el=>({top:el.querySelector('.people-stream')!.scrollTop,query:el.querySelector('input')!.value})),mark);
   await editor.fill('Draft B: separate channel');
   await page.evaluate(id=>(window as any).proof.openGroup(id),groups[0].id);await page.waitForFunction(()=>document.querySelector('.im-channel-chat__conversation [contenteditable]')?.textContent?.includes('Draft A: keep my input'));
   await search.fill('');
  }
  // Return is still the existing Router operation; no local selected-channel copy.
  await page.evaluate(()=>(window as any).proof.navigation.returnToParent());
  await page.waitForFunction(()=>document.querySelector('.app-shell-master-detail')?.getAttribute('data-presentation')!=='detail');
  assert.equal(await page.locator('.people-page--inbox').evaluate(el=>el===(window as any).originalInbox),true);
  assert.equal(await page.locator('.im-channel-chat__conversation').count(),0,'no hidden conversation effects after returning to root');
  await page.evaluate(id=>(window as any).proof.openGroup(id),groups[0].id);await editor.waitFor();
  await page.waitForFunction(()=>document.querySelector('.im-channel-chat__conversation [contenteditable]')?.textContent?.includes('Draft A: keep my input'));
  if(width>1000){const row=page.locator('.people-group[aria-current="page"]');assert.equal(await row.count(),1);await row.scrollIntoViewIfNeeded();}
  const measure=await root.evaluate(el=>{const r=el.getBoundingClientRect(),master=el.querySelector('.app-shell-master-detail__master')!,detail=el.querySelector('.app-shell-master-detail__detail')!,m=master.getBoundingClientRect(),d=detail.getBoundingClientRect();return{mode:el.getAttribute('data-presentation'),width:r.width,master:{x:m.x,width:m.width,right:m.right},detail:{x:d.x,width:d.width,right:d.right},overflow:document.documentElement.scrollWidth>innerWidth};});
  assert.equal(measure.overflow,false);if(measure.mode==='split'){assert.ok(measure.detail.width>=352);assert.ok(Math.abs(measure.master.right-measure.detail.x)<1);}
  if(width>1000)assert.equal(await page.locator('.app-shell-header__title').filter({hasText:'Chats'}).count(),0,'split does not duplicate generic page title');
  await page.screenshot({path:join(evidence,name+'.png')});
  if(name==='desktop-light'){
   const url=page.url();const linked=await context.newPage();await linked.addInitScript('window.__name=target=>target;');await linked.goto(url,{waitUntil:'domcontentloaded'});await linked.locator('.im-channel-chat__conversation [contenteditable="true"]:visible').waitFor();assert.equal(await linked.locator('.people-page--inbox').count(),1,'direct-link does not mount unseen parent separately');assert.equal(await linked.locator('.people-group[aria-current="page"]').getAttribute('aria-label'),groups[0].title);await linked.close();
  }
assert.deepEqual(errors,[]);results.push({name,...measure,oneDirectoryOwner:true,routeSelection:true,draftsRetained:true,contextWidthAdaptation:width>1000,syntheticIdentity:true,nativeChannelTransport:true});await context.close();
 }
 await writeFile(join(evidence,'report.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({passed:results.length,output:evidence}));
}catch(error){const page=browser?.contexts().at(-1)?.pages().at(-1);if(page){console.error(await page.locator('body').innerText());await page.screenshot({path:join(evidence,'failure.png'),fullPage:true});}throw error;}finally{await browser?.close();await server.close();await backend.close();await host.close();await im.close();await service.close();actors.close();await storage.close();await rm(root,{recursive:true,force:true});}
