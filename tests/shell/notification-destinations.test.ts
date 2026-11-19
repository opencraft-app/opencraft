import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationDestinationsController } from '../../apps/workbench-web/src/runtime/notification-destinations';
const configuration={actorId:'human-a',enabled:true,hosts:['local-codex'],destinations:[],imTargets:[]};
const messages={completed:'Complete',failed:'Failed',interrupted:'Stopped',body:'Return',test:'Test'};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('sign out fences late configuration and mutation responses',async()=>{
  let resolve!:(response:Response)=>void;
  const owner=new NotificationDestinationsController((()=>new Promise<Response>(r=>resolve=r)) as typeof fetch);
  owner.configure('en-US',messages);owner.reset();resolve(Response.json(configuration));await flush();assert.equal(owner.getSnapshot().configuration,null);
  owner.dispose();
});
test('configuration writes bind the expected human, preserve on failure and clear after account change',async()=>{
  const calls:any[]=[];let status=200;
  const owner=new NotificationDestinationsController((async(_input,init)=>{
    if(!init?.body)return Response.json(configuration);
    calls.push(JSON.parse(String(init.body)));return status===200?Response.json({...configuration,enabled:false}):Response.json({error:'failure'},{status});
  }) as typeof fetch);
  owner.configure('en-US',messages);await flush();
  await owner.operation('master',{enabled:false});assert.equal(calls[0].expectedActorId,'human-a');assert.equal(owner.getSnapshot().configuration?.enabled,false);
  status=500;await assert.rejects(owner.operation('master',{enabled:true}));assert.equal(owner.getSnapshot().configuration?.enabled,false);assert.equal(owner.getSnapshot().busy,null);
  status=409;await assert.rejects(owner.operation('master',{enabled:true}));assert.equal(owner.getSnapshot().configuration,null);owner.dispose();
});

test('notification failures classify safe reasons, including old servers and non-JSON proxies',async()=>{
  const cases:[number,unknown,string][]=[
    [400,{error:'invalid_destination'},'address'],[400,{error:'invalid_target'},'im'],
    [400,{error:'device_limit'},'limit'],[401,{},'account'],[409,{},'account'],
    [403,{error:'same_origin_json_required'},'forbidden'],[404,{error:'not_found'},'missing'],
    [404,{},'unavailable'],[429,{},'rate'],[503,{error:'notification_storage_unavailable'},'storage'],
    [502,{error:'notification_delivery_failed'},'delivery'],[400,{error:'push_operation_failed'},'unknown'],
    [500,{error:'https://secret.example/private-token'},'unknown'],[502,'<html>proxy error</html>','unknown'],
  ];
  for(const [status,body,reason] of cases){
    const owner=new NotificationDestinationsController((async(_input,init)=>!init?.body?Response.json(configuration):
      typeof body==='string'?new Response(body,{status}):Response.json(body,{status})) as typeof fetch);
    owner.configure('en-US',messages);await flush();
    await assert.rejects(owner.operation('save'),(error:any)=>error.reason===reason&&!error.message.includes('private-token'));
    assert.equal(owner.getSnapshot().busy,null);owner.dispose();
  }
  const owner=new NotificationDestinationsController((async(_input,init)=>{if(init?.body)throw new TypeError('Failed to fetch');return Response.json(configuration);}) as typeof fetch);
  owner.configure('en-US',messages);await flush();await assert.rejects(owner.operation('save'),(error:any)=>error.reason==='network');owner.dispose();
});

test('trusted product defaults use explicit localized POST, defer/retry readiness and stop after one decision per account',async()=>{
 const calls:any[]=[];let ready=false;
 const owner=new NotificationDestinationsController((async(_input,init)=>{
  if(!init?.body)return Response.json({...configuration,defaultsAvailable:true});
  const body=JSON.parse(String(init.body));calls.push(body);
  return Response.json({...configuration,defaultsAvailable:true,defaultsStatus:ready?'complete':'deferred'});
 }) as typeof fetch);
 try{
  owner.configure('zh-CN',{...messages,completed:'本轮已完成'});await flush();
  assert.equal(calls.length,1);assert.equal(calls[0].operation,'defaults');assert.equal(calls[0].expectedActorId,'human-a');assert.equal(calls[0].locale,'zh-CN');assert.equal(calls[0].messages.completed,'本轮已完成');
  ready=true;await owner.refresh();assert.equal(calls.length,2);await owner.refresh();assert.equal(calls.length,2);
  owner.reset();await owner.refresh();assert.equal(calls.length,3,'Relogin can repeat the atomic server decision, never recreate a removed target');
 }finally{owner.dispose();}
});

test('default readiness retries automatically, disposal cancels retries, late default replies cannot cross account reset',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let posts=0,ready=false;
 const owner=new NotificationDestinationsController((async(_input,init)=>{
  if(init?.body)posts++;
  return Response.json({...configuration,defaultsAvailable:true,...(init?.body?{defaultsStatus:ready?'complete':'deferred'}:{})});
 }) as typeof fetch);
 owner.configure('en-US',messages);await flush();assert.equal(posts,1);
 ready=true;t.mock.timers.tick(30000);await flush();assert.equal(posts,2);
 t.mock.timers.tick(30000);await flush();assert.equal(posts,2);
 owner.dispose();t.mock.timers.tick(30000);await flush();assert.equal(posts,2);
 let release!:(value:Response)=>void;
 const late=new NotificationDestinationsController((async(_input,init)=>init?.body?new Promise<Response>(resolve=>{release=resolve;}):Response.json({...configuration,defaultsAvailable:true})) as typeof fetch);
 late.configure('en-US',messages);await flush();late.reset();release(Response.json({...configuration,defaultsAvailable:true,defaultsStatus:'complete'}));await flush();assert.equal(late.getSnapshot().configuration,null);late.dispose();
});

test('an ineligible login does not consume the same Actor default decision after switching to an eligible identity',async()=>{
 let eligible=false,posts=0;
 const owner=new NotificationDestinationsController((async(_input,init)=>{
  if(init?.body)posts++;
  return Response.json({...configuration,defaultsAvailable:true,...(init?.body?{defaultsStatus:eligible?'complete':'ineligible'}:{})});
 }) as typeof fetch);
 try{owner.configure('en-US',messages);await flush();assert.equal(posts,1);eligible=true;await owner.refresh();assert.equal(posts,2);await owner.refresh();assert.equal(posts,2);}finally{owner.dispose();}
});

test("malformed destination and host data never enters the ready state", async () => {
  for (const malformed of [
    { ...configuration, hosts: [null] },
    { ...configuration, defaultsAvailable: "yes" },
    { ...configuration, defaultsStatus: "other" },
    { ...configuration, imTargets: [{ channelId: "channel", senderId: "sender", label: "account", methodLabel: 17 }] },
    { ...configuration, destinations: [null] },
    { ...configuration, destinations: [{ id: "x", kind: "webhook", label: "x", enabled: "yes", authorized: true }] },
    { ...configuration, imTargets: [{ channelId: "channel", senderId: 17, label: "account" }] },
  ]) {
    const owner = new NotificationDestinationsController((async () => Response.json(malformed)) as typeof fetch);
    owner.configure("en-US", messages);
    await flush();
    assert.equal(owner.getSnapshot().phase, "error");
    assert.equal(owner.getSnapshot().configuration, null);
    owner.dispose();
  }
});
