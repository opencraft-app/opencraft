import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PwaTurnPushController } from '../../apps/workbench-web/src/runtime/pwa-turn-push';
import { ApplePwaPushDevice } from '../../apps/workbench-web/src/runtime/push-device';
const subscription={endpoint:'https://web.push.apple.com/Q',keys:{p256dh:'key',auth:'auth'}};
const messages={completed:'Complete',failed:'Failed',interrupted:'Stopped',body:'Open',test:'Test'};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function setup() {
 const operations:string[]=[],order:string[]=[];let has=false,enabled=false,fail=false;let testGate:Promise<void>|null=null;
 const device={supported:true,permission:()=>'granted' as const,getSubscription:async()=>has?subscription:null,subscribe:async()=>{order.push('permission');has=true;return subscription;},unsubscribe:async()=>{has=false;},dispose(){}};
 const fetcher=(async (_input:any,init:any)=>{
  if(!init?.body)return Response.json({available:true,publicKey:'public',actorId:'actor',hosts:['local-codex']});
  const input=JSON.parse(init.body);operations.push(input.operation);order.push(input.operation);
  if(input.operation==='test' && testGate)await testGate;
  if(fail)return new Response('',{status:503});
  if(input.operation==='subscribe')enabled=true;if(input.operation==='unsubscribe')enabled=false;
  return Response.json({enabled,sent:input.operation==='test'});
 }) as typeof fetch;
 const controller=new PwaTurnPushController(device,fetcher);controller.configure('en-US',messages);
 return {controller,operations,order,setFail:()=>{fail=true;},has:()=>has,holdTest:()=>{let release=()=>{};testGate=new Promise<void>(resolve=>{release=resolve;});return release;}};
}
test('permission stays in user gesture; server acknowledgement owns enabled state and local notification routing',async()=>{
 const f=setup();await settle();assert.equal(f.controller.getSnapshot().phase,'disabled');
 const enabling=f.controller.enable();assert.deepEqual(f.order,['permission']);await enabling;
 assert.equal(f.controller.handles('local-codex'),true);assert.equal(f.controller.handles('external-host'),false);
 await f.controller.test();assert.equal(f.controller.getSnapshot().testSent,true);
 f.controller.dispose();assert.equal(f.has(),true,'retiring the page preserves push');
});
test('failed subscription does not claim push is enabled and disabling revokes server consent before device subscription',async()=>{
 const f=setup();await settle();await f.controller.enable();await f.controller.disable();assert.equal(f.has(),false);assert.equal(f.controller.getSnapshot().enabled,false);
 f.setFail();await f.controller.enable();assert.equal(f.controller.getSnapshot().phase,'error');assert.equal(f.controller.getSnapshot().enabled,false);f.controller.dispose();
});
test('disposed or replaced operations cannot publish late enrollment state',async()=>{
 const f=setup();await settle();const pending=f.controller.enable();f.controller.dispose();await pending;
 assert.equal(f.operations.includes('subscribe'),false);
});
test('only secure top-level Apple Home Screen apps expose a push device',()=>{
 const view:any={isSecureContext:true,navigator:{standalone:true},Notification:{permission:'default'},pushManager:{}};view.top=view;
 const device=new ApplePwaPushDevice({defaultView:view} as Document,'/worker.js','/scope/');
 assert.equal(device.supported,true);view.navigator.standalone=false;assert.equal(device.supported,false);
 view.navigator.standalone=true;view.top={};assert.equal(device.supported,false);view.top=view;view.isSecureContext=false;assert.equal(device.supported,false);
});
test('declarative devices use the window manager and never register a competing worker',async()=>{
 let requests=0,registrations=0;
 const view:any={isSecureContext:true,atob,Notification:{permission:'granted',requestPermission:async()=>{requests++;return 'granted';}},navigator:{standalone:true,serviceWorker:{register:()=>{registrations++;throw Error('unexpected');}}},pushManager:{getSubscription:async()=>null,subscribe:async()=>({toJSON:()=>subscription})}};view.top=view;
 const device=new ApplePwaPushDevice({defaultView:view} as Document,'/worker.js','/scope/');
 await device.subscribe(Buffer.alloc(65,1).toString('base64url'));assert.equal(requests,1);assert.equal(registrations,0);
});
test('legacy worker displays declarative payload and rejects cross-origin notification navigation',async()=>{
 const events:any={},shown:any[]=[],opened:string[]=[];
 const context=vm.createContext({URL,self:{location:{origin:'https://example.test'},addEventListener:(name:string,listener:any)=>{events[name]=listener;},registration:{showNotification:async(...args:any[])=>{shown.push(args);}},clients:{openWindow:async(url:string)=>{opened.push(url);}}}});
 vm.runInContext(readFileSync('apps/workbench-web/public/opencraft-push-worker.js','utf8'),context);
 let pending:Promise<unknown>=Promise.resolve();
 events.push({data:{json:()=>({web_push:8030,notification:{title:'Complete',body:'Open',navigate:'https://example.test/local/thread?hostId=local-codex'}})},waitUntil:(p:Promise<unknown>)=>{pending=p;}});await pending;assert.equal(shown.length,1);
 const click=(url:string)=>events.notificationclick({notification:{close(){},data:{navigate:url}},waitUntil:(p:Promise<unknown>)=>{pending=p;}});
 click('https://evil.test/');await pending;assert.equal(opened.length,0);click('https://example.test/local/thread?hostId=local-codex');await pending;assert.equal(opened.length,1);
});


test('a late test acknowledgement cannot re-enable a signed-out device',async()=>{
 const f=setup();await settle();await f.controller.enable();const release=f.holdTest();
 const pending=f.controller.test();await f.controller.beforeSignOut();assert.equal(f.has(),false);
 release();await pending;assert.equal(f.controller.getSnapshot().enabled,false);assert.equal(f.controller.getSnapshot().testSent,false);f.controller.dispose();
});
