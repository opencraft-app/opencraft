import {ImChannelService} from '../../../apps/headless-server/src/im-channel-service.mjs';
import {AppHostServer} from '@opencraft/app-host-server';
import {ImChannelsAppServer} from '../../../apps/headless-server/src/im-channels-appserver.mjs';
import {createWorkbenchWebServer} from '../../../apps/headless-server/src/serve-workbench-web.mjs';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {writeFile} from 'node:fs/promises';
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
const evidence=process.env.OPENCRAFT_SMOKE_OUTPUT??'.local/channel-image-layout';
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
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
const wire=connectWebSocketAppHost();
await application.supervisor.extensions.activateOptional(createImExtension(fetch.bind(window),signal=>createChannelsRpc(wire.createTransport(CHANNELS_HOST_ID),signal)));
createIntlTestRoot(document.getElementById('app'),undefined,'en-US').render(<WorkbenchRoot application={application}/>);
window.proof={theme:setThemePreference,openGroup:id=>application.supervisor.navigation.openExtensionView('opencraft.im.channel-chat','opencraft-channel:'+id)};document.body.dataset.ready='true';`;
const applicationConfig=await loadConfigFromFile({command:'serve',mode:'development'},'apps/workbench-web/vite.config.ts');
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'.local/channel-image-layout-vite',logLevel:'error',
 define:{'process.env.NEXT_PUBLIC_REGION':'"cn"','process.env.NEXT_PUBLIC_PREVIEW_LOCALES':'""','import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN':'"false"','import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN':'"false"'},
 optimizeDeps:{...applicationConfig!.config.optimizeDeps,include:[...applicationConfig!.config.optimizeDeps!.include!,'@opencraft/browser-core/presentation']},esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/apphost':{target:'http://127.0.0.1:'+backendPort,ws:true}}},plugins:[{
 name:'native-channel-proof',resolveId:id=>id==='/native-channel-proof.tsx'?id:null,load:id=>id==='/native-channel-proof.tsx'?source:null,
 configureServer(vite){vite.middlewares.use((req,res,next)=>{
  if(req.url==='/fixture-avatar.svg'){res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#257c62"/><circle cx="16" cy="12" r="6" fill="white"/><path d="M6 30a10 10 0 0 1 20 0" fill="white"/></svg>');}
  else if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/native-channel-proof.tsx"></script></body></html>');}
  else if(req.url?.startsWith('/__opencraft_im')){void im.handle(req,res,()=>true).catch(next);}
  else if(req.url?.startsWith('/__opencraft_actors/collaboration/'))void api.handle(req,res);
  else next();
 });}
 }]});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const results:any[]=[];
try {
 await server.listen();await mkdir(evidence,{recursive:true});
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox','--disable-dev-shm-usage']});
 for(const [width,theme,touch] of [[390,'light',true],[1160,'dark',false]] as const){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:touch});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const activate=(locator:import('playwright').Locator)=>touch?locator.tap():locator.click();
  await page.addInitScript('window.__name = target => target;');
  await page.goto(server.resolvedUrls!.local[0],{waitUntil:'domcontentloaded',timeout:90000});await page.waitForSelector('body[data-ready="true"]',{state:'attached',timeout:90000});
  await page.evaluate(theme=>(window as any).proof.theme(theme),theme);
  const group=await service.communicate(human,'opencraft/channels/group/create',{title:'图片讨论 '+width,memberActorIds:[bot.id],clientRequestId:'image-group-'+width}) as {id:string};
  const source='fixture/images/'+width,incarnation='image-smoke-'+width;
  await service.synchronizeChannels({method:'configure',params:{incarnation,bindings:[{source,channelId:group.id}],images:true}});
  await page.evaluate(id=>(window as any).proof.openGroup(id),group.id);
  const close=page.getByRole('button',{name:'Close sidebar',exact:true});if(touch&&await close.count()){const box=await close.boundingBox();if(box)await close.tap({position:{x:box.width-8,y:box.height/2}});}
  const editor=page.locator('[contenteditable="true"]:visible').last();await editor.click();await editor.pressSequentially('Keep this draft');
  let negativeControl=false;
  for(const [kind,w,h]of [['portrait',600,1200],['landscape',1600,900],['screenshot',450,2400],['tiny',16,16]] as const){
   const bytes=await sharp({create:{width:w,height:h,channels:3,background:kind==='portrait'?'#277969':'#664593'}}).composite([{input:Buffer.from(`<svg width="${w}" height="${h}"><rect x="1" y="1" width="${w-2}" height="${h-2}" fill="none" stroke="white" stroke-width="4"/><text x="12" y="50" font-size="32" fill="white">${kind} ${w} × ${h}</text></svg>`)}]).png().toBuffer();
   for(const self of [false,true]){
    if(self)await service.communicate(human,'channel/image/send',{channelId:group.id,clientMessageId:width+'-'+kind+'-self',type:'image/png',bytes});
    else {
     const arrival={source,id:kind,author:'Wei',sender:{id:'external-user',displayName:'Wei'},text:'',at:Date.now(),mediaId:'media-'+kind};
     const admitted=await service.synchronizeChannels({method:'ingest',params:{incarnation,source,arrival}});
     await page.getByText('Loading image…',{exact:true}).waitFor({timeout:20000});
     await service.synchronizeChannels({method:'imageReady',params:{incarnation,source,messageId:admitted.messageId,bytes}});
    }
    const row=page.locator(`.im-channel-chat__timeline [role="listitem"][data-self="${self}"]`).filter({has:page.locator('.im-channel-chat__picture')}).last();
    const trigger=row.getByRole('button',{name:'Preview image',exact:true});await trigger.waitFor({timeout:20000});await trigger.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>{const imgs=[...document.querySelectorAll('.im-channel-chat__picture img')] as HTMLImageElement[];return imgs.every(i=>i.complete&&i.naturalWidth>0);});
    const measure=()=>trigger.evaluate(el=>{const i=el.querySelector('img')!,r=i.getBoundingClientRect(),b=el.getBoundingClientRect(),m=el.closest('.im-channel-chat__message')!,box=m.getBoundingClientRect(),style=getComputedStyle(m);return {w:r.width,h:r.height,ratio:i.naturalWidth/i.naturalHeight,buttonW:b.width,buttonH:b.height,bubbleW:box.width,bubbleH:box.height,padding:style.padding,background:style.backgroundColor,imageOnly:m.getAttribute('data-image-only'),overflow:document.documentElement.scrollWidth>innerWidth};});
    let m=await measure();assert.ok(Math.abs(m.w/m.h-w/h)<0.01,JSON.stringify(m));assert.ok(m.h<=384.1&&m.w<=320.1,JSON.stringify(m));assert.equal(m.overflow,false);assert.equal(m.imageOnly,'true');
    if(kind!=='tiny'){assert.ok(Math.abs(m.buttonW-m.w)<1&&Math.abs(m.buttonH-m.h)<1,'image must fill its clickable frame: '+JSON.stringify(m));if(self){assert.equal(m.padding,'0px');assert.equal(m.background,'rgba(0, 0, 0, 0)');assert.ok(Math.abs(m.bubbleW-m.w)<1,'no oversized text bubble');}}
    if(kind==='portrait'&&!self){
     const old=await page.addStyleTag({content:'.im-channel-chat__picture-frame{block-size:8rem}.im-channel-chat__picture.ui-button img{inline-size:12rem;block-size:8rem;object-fit:contain}'});const bad=await measure();assert.ok(Math.abs(bad.w/bad.h-w/h)>0.1,'old style must violate ratio assertion');negativeControl=true;await old.evaluate(e=>e.remove());
    }
    if(touch)await trigger.tap();else {await trigger.focus();await page.keyboard.press('Enter');}
    const dialog=page.getByRole('dialog');await dialog.getByRole('img',{name:'Preview image',exact:true}).waitFor({timeout:20000});
    if(touch)await activate(page.getByRole('button',{name:'Close image preview',exact:true}));else await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});assert.equal(await trigger.evaluate(el=>el===document.activeElement),true,'preview returns keyboard focus');
    assert.equal((await editor.innerText()).trim(),'Keep this draft');
    const timeline=page.locator('.im-channel-chat__timeline');await timeline.evaluate(el=>el.scrollTop=el.scrollHeight);await page.waitForTimeout(100);
    results.push({width,theme,touch,kind,self,...m});
    if(kind==='portrait'||kind==='landscape')await page.screenshot({path:join(evidence,`${width}-${kind}-${self?'self':'incoming'}.png`)});
   }
  }
  const arrival={source,id:'failed',author:'Wei',sender:{id:'external-user',displayName:'Wei'},text:'',at:Date.now(),mediaId:'missing-media'};
  const pending=await service.synchronizeChannels({method:'ingest',params:{incarnation,source,arrival}});
  await page.getByText('Loading image…',{exact:true}).waitFor();await service.synchronizeChannels({method:'imageReady',params:{incarnation,source,messageId:pending.messageId,bytes:Buffer.from('invalid')}});
  await page.getByText('Image unavailable.',{exact:true}).waitFor();assert.equal((await editor.innerText()).trim(),'Keep this draft');assert.equal(negativeControl,true);assert.deepEqual(errors,[]);await page.close();
 }
 await writeFile(join(evidence,'results.json'),JSON.stringify({cases:results,negativeControl:true,realWorkbench:true,nativeTransport:true,syntheticIdentityAndProvider:true,physicalPhone:false},null,2));console.log('PASS: intrinsic image ratios, fitted self bubbles, portrait/landscape/screenshot/tiny, native self/external incoming, touch and desktop, loading/error, full preview/focus/draft, old-style negative control.');
}catch(error){const page=browser?.contexts().at(-1)?.pages().at(-1);if(page){console.error(await page.locator('body').innerText());await page.screenshot({path:join(evidence,'failure.png'),fullPage:true});}throw error;}finally{await browser?.close();await server.close();await backend.close();await host.close();await im.close();await service.close();actors.close();await storage.close();await rm(root,{recursive:true,force:true});}
