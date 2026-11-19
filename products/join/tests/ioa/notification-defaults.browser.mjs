import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {PushStore,TurnPushService} from '@opencraft/web-push-node';
import {createIoaNotificationDefaultTarget} from '../../plugins/tencentoa/src/notification-defaults.mjs';
import {createWeComTurnNotifications} from '../../plugins/wecom/turn-notifications.mjs';

// Actual Settings, locale/client, HTTP API, product policy and SQLite. Only signed
// identity verification and the external WeCom boundary are synthetic. No sends.
const directory=await mkdtemp(join(tmpdir(),'ioa-notification-defaults-'));
const artifacts=process.env.OPENCRAFT_NOTIFICATION_ARTIFACTS??join(directory,'screenshots');await mkdir(artifacts,{recursive:true});
let actorId='fixture',ready=false,sends=0;
const actors={get:()=>({kind:'human',enabled:true}),isCurrent:()=>true,bindings:()=>[{provider:'tencentoa',subject:actorId},{provider:'wecom.corp',subject:'self'}]};
const port=createWeComTurnNotifications({actors,corpId:'corp',ready:()=>ready,deliver:()=>{sends++;throw Error('Real delivery forbidden');}});
const store=new PushStore(join(directory,'push.sqlite'));
const service=new TurnPushService(store,{authenticate:()=>({context:{actorId,credentialId:null,generation:1,expiresAt:Date.now()+60000}}),current:()=>true,trustedOrigin:()=>null,hosts:[],read:async()=>({}),
 imTargets:async binding=>port.targets(binding.context.actorId),defaultTarget:createIoaNotificationDefaultTarget({actors,resolveIdentity:()=>({provider:'tencentoa',subject:actorId,expiresAt:Date.now()+60000})}),sendIm:async()=>{sends++;throw Error('Real delivery forbidden');}});
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},cacheDir:'node_modules/.vite-ioa-notification-defaults',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'ioa-defaults-fixture',configureServer(server){server.middlewares.use((req,res,next)=>{
 if(req.url?.startsWith('/__opencraft_notifications')){void service.handle(req,res);return;}
 if(req.url?.split('?')[0]!=='/')return next();res.setHeader('content-type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/turn-notifications.tsx"></script></body></html>');
});}}]});
let browser;
try{
 await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
 for(const touch of [false,true])for(const theme of ['light','dark']){
  actorId=`human-${touch}-${theme}`;ready=false;
  const context=await browser.newContext({viewport:touch?{width:390,height:844}:{width:1200,height:860},hasTouch:touch,isMobile:touch});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript('window.__name = value => value');
  await page.goto(origin);const master=page.getByRole('switch',{name:'回答结束时通知我',exact:true});await master.waitFor();
  assert.equal(store.devices(actorId).length,0,'Deferred readiness must not consume default');
  ready=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  const toggle=page.getByRole('switch',{name:'启用企业微信',exact:true});await toggle.waitFor();await page.evaluate(mode=>window.__turnNotificationFixture.theme(mode),theme);
  assert.equal(await toggle.getAttribute('aria-checked'),'true');assert.equal(store.devices(actorId).length,1);assert.equal(sends,0);
  await page.screenshot({path:join(artifacts,`${touch?'touch':'pointer'}-${theme}-default.png`),fullPage:true});
  await (touch?toggle.tap():toggle.click());await page.getByRole('switch',{name:'启用企业微信',exact:true,checked:false}).waitFor();
  await page.reload();await toggle.waitFor();assert.equal(await toggle.getAttribute('aria-checked'),'false');assert.equal(store.devices(actorId).length,1);
  const row=toggle.locator('xpath=..');const action=row.getByRole('button');await (touch?action.tap():action.click());
  const remove=page.getByRole('menuitem',{name:'移除',exact:true});await (touch?remove.tap():remove.click());await toggle.waitFor({state:'detached'});
  await page.reload();await master.waitFor();assert.equal(await toggle.count(),0);assert.equal(store.devices(actorId).length,0);assert.equal(sends,0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);await context.close();
 }
 console.log('PASS 4 pointer/touch light/dark cases: deferred readiness, automatic default, explicit off, reload and removal without resurrection; zero sends. Artifacts: '+artifacts);
}finally{await browser?.close();await vite.close();await service.close();await rm(join(directory,'push.sqlite'),{force:true});}
