import test from 'node:test';
import assert from 'node:assert/strict';
import {createWeComTurnNotifications} from '../../plugins/wecom/turn-notifications.mjs';
import {deliverTurnNotification} from '../../plugins/wecom/mirror/turn-notifications.mjs';
import {humanKey} from '../../plugins/wecom/mirror/store.mjs';

const own={actorId:'human-a',recipient:'T1A',content:'Build · Completed\nOpen the conversation\nhttps://example.com/local/thread',requestId:'event-one'};
function relayFixture(){
 const data=new Map(),calls=[],server={id:'server-a'},prefix='fixture:';
 data.set(prefix+'server:'+server.id,JSON.stringify({id:server.id,humans:{[humanKey('wxfixture','T1A')]:'human-a'}}));
 const service={corpId:'wxfixture',abort:new AbortController(),store:{prefix,async command(action,key,value,...options){
  if(action==='GET')return data.get(key)??null;
  if(action==='SET'){if(options.includes('NX')&&data.has(key))return null;if(options.includes('XX')&&!data.has(key))return null;data.set(key,value);return 'OK';}
  throw Error('unexpected command');
 }},transport:{async sendDirectNotification(...args){await args[3]();calls.push(args);return 'delivered';}}};
 return {service,server,data,calls,prefix};
}
test('only a verified, enabled personal WeCom binding is available; no arbitrary RTX or prior private chat required',async()=>{
 let ready=false,enabled=true,bindings=[{provider:'tencentoa',subject:'123'},{provider:'wecom.wxfixture',subject:'T1A'}];const calls=[];
 const port=createWeComTurnNotifications({corpId:'wxfixture',ready:()=>ready,resolveRtx:()=> 'ruippan',actors:{get:id=>({kind:id==='bot'?'session':'human',enabled}),bindings:()=>bindings},deliver:async input=>{calls.push(input);return {status:'delivered'};}});
 assert.deepEqual(port.targets('human-a'),[]);ready=true;
 assert.deepEqual(port.targets('human-a'),[{channelId:'join.wecom.wxfixture',senderId:'T1A',label:'ruippan',methodId:'join.wecom',methodLabel:'企业微信'}]);
 assert.deepEqual(port.targets('bot'),[]);
 await assert.rejects(port.send('human-a',{channelId:'join.wecom.wxfixture',senderId:'TOTHER'},'你好','one',()=>{}));assert.equal(calls.length,0);
 await port.send('human-a',{channelId:'join.wecom.wxfixture',senderId:'T1A'},'Turn completed','one',()=>{});assert.equal(calls.length,1);
 enabled=false;assert.deepEqual(port.targets('human-a'),[]);enabled=true;
 bindings.push({provider:'wecom.wxfixture',subject:'T2A'});assert.deepEqual(port.targets('human-a'),[]);
});
test('Relay verifies the registered native Actor and sends only once across lost acknowledgements, concurrent retries and changed content',async()=>{
 const f=relayFixture();
 await assert.rejects(deliverTurnNotification(f.service,f.server,{...own,recipient:'T2A'}));assert.equal(f.calls.length,0);
 await assert.rejects(deliverTurnNotification(f.service,f.server,{...own,actorId:'human-b'}));assert.equal(f.calls.length,0);
 await assert.rejects(deliverTurnNotification(f.service,f.server,{...own,recipient:'fwbot'}));assert.equal(f.calls.length,0);
 const results=await Promise.all([deliverTurnNotification(f.service,f.server,own),deliverTurnNotification(f.service,f.server,own)]);
 assert.equal(f.calls.length,1);assert.ok(results.some(r=>r.status==='delivered'));
 assert.deepEqual(await deliverTurnNotification(f.service,f.server,own),{status:'delivered'});assert.equal(f.calls.length,1);
 await assert.rejects(deliverTurnNotification(f.service,f.server,{...own,content:'conflicting text'}));assert.equal(f.calls.length,1);
 f.data.delete(f.prefix+'server:'+f.server.id);await assert.rejects(deliverTurnNotification(f.service,f.server,own));assert.equal(f.calls.length,1);
});
test('provider effect uncertainty is durable and never replayed; no chat binding or model invocation is needed',async()=>{
 const f=relayFixture();f.service.transport.sendDirectNotification=async()=>{f.calls.push('submitted');throw Error('ACK lost');};
 assert.deepEqual(await deliverTurnNotification(f.service,f.server,own),{status:'unknown'});
 assert.deepEqual(await deliverTurnNotification(f.service,f.server,own),{status:'unknown'});assert.equal(f.calls.length,1);
});
test('recipient ownership is checked again before the provider write, including directory expiry',async()=>{
 const f=relayFixture();f.service.transport.sendDirectNotification=async(_recipient,_content,_signal,assertCurrent)=>{
  f.data.delete(f.prefix+'server:'+f.server.id);await assertCurrent();f.calls.push('should not send');return 'delivered';
 };
 assert.deepEqual(await deliverTurnNotification(f.service,f.server,own),{status:'unknown'});assert.equal(f.calls.length,0);
});

test('real Relay HTTP route requires a valid Server credential and negotiates the narrow capability',async()=>{
 const {createServer}=await import('node:http');const {MirrorService,MIRROR_PATH}=await import('../../plugins/wecom/mirror/service.mjs');
 const f=relayFixture(),credential='x'.repeat(43);
 const svc=new MirrorService({store:f.service.store,transport:{...f.service.transport,subscribe:()=>()=>{}},corpId:'wxfixture',servers:[{id:f.server.id,name:'Fixture',credential}],allowLoopbackInsecure:true});
 const server=createServer((req,res)=>{void svc.handle(req,res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}${MIRROR_PATH}/turn-notification`;
 const send=(input,secret=credential)=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-opencraft-mirror-server':f.server.id,authorization:'Bearer '+secret},body:JSON.stringify(input)});
 try {
  assert.equal((await send(own,'y'.repeat(43))).status,403);assert.equal(f.calls.length,0);
  const other=await send({...own,recipient:'TOTHER'});assert.equal(other.status,403);assert.equal(f.calls.length,0);
  const response=await send(own);assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'delivered'});assert.equal(f.calls.length,1);
  const duplicate=await send(own);assert.deepEqual(await duplicate.json(),{status:'delivered'});assert.equal(f.calls.length,1);
 }finally{await new Promise(resolve=>server.close(resolve));await svc.close();}
});

test('customer-service transport sends an actual single-recipient payload after the final ownership check',async()=>{
 const {createWeComChannelTransport}=await import('../../plugins/wecom/channel-transport.mjs');let authorized=true;const calls=[];
 const transport=createWeComChannelTransport({corpId:'wxfixture',corpSecret:'synthetic-secret',serviceId:'fwfixture',token:'fixture',aesKey:Buffer.alloc(32,1).toString('base64').replace(/=$/u,''),localGroups:[],relayIngress:true,
  fetcher:async(url,options)=>{if(url.pathname==='/cgi-bin/gettoken')return Response.json({errcode:0,access_token:'synthetic-access',expires_in:7200});calls.push({path:url.pathname,body:JSON.parse(options.body)});return Response.json({errcode:0});}});
 const check=async()=>{if(!authorized)throw Error('revoked');};
 assert.equal(await transport.sendDirectNotification('T1A','你好',AbortSignal.timeout(5000),check),'delivered');
 assert.deepEqual(calls,[{path:'/cgi-bin/tencent/chat/send',body:{receiver:{type:'single',id:'T1A'},msgtype:'text',text:{content:'你好'}}}]);
 authorized=false;await assert.rejects(transport.sendDirectNotification('T1A','Not sent',AbortSignal.timeout(5000),check));assert.equal(calls.length,1);
});

test('Mirror advertises the method only after Relay capability negotiation, including directory-only receivers',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'turn-notification-receiver-')),prior={OPENCRAFT_DATA_DIR:process.env.OPENCRAFT_DATA_DIR,OPENCRAFT_WORKSPACE_DIR:process.env.OPENCRAFT_WORKSPACE_DIR};
 process.env.OPENCRAFT_DATA_DIR=root;process.env.OPENCRAFT_WORKSPACE_DIR=root+'-workspace';
 t.after(async()=>{for(const[k,v]of Object.entries(prior))if(v===undefined)delete process.env[k];else process.env[k]=v;await rm(root,{recursive:true,force:true});});
 const {createMirrorTarget}=await import('../../plugins/wecom/mirror/target.mjs');
 const actors={get:()=>({kind:'human',enabled:true}),bindings:()=>[{provider:'wecom.wxfixture',subject:'T1A'}]};
 let capable=false,registrations=0;
 const receiver=await createMirrorTarget({relayOrigin:'http://127.0.0.1',allowLoopbackInsecure:true,serverId:'fixture',credential:'a'.repeat(43),corpId:'wxfixture'},
  {collaboration:{actors,synchronizeChannels:async command=>command.method==='mirrorDirectory'?{}:[]}},async(url)=>{
   const action=url.pathname.split('/').at(-1);if(action==='register'){registrations++;return Response.json({ok:true,turnNotifications:capable});}
   return Response.json(action==='link-poll'?{links:[]}:{deliveries:[]});
  },{directoryOnly:true,onError:()=>{}});
 try{
  assert.deepEqual(receiver.notifications.targets('human-a'),[]);receiver.subscribeWithReceipt(async()=>({messageId:'unused'}));
  for(let i=0;i<100&&!registrations;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(registrations);assert.deepEqual(receiver.notifications.targets('human-a'),[]);capable=true;
  for(let i=0;i<250&&!receiver.notifications.targets('human-a').length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(receiver.notifications.targets('human-a')[0]?.methodLabel,'企业微信');
 }finally{await receiver.close();}
});
