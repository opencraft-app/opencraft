import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createWeComChannelTransport} from '../../plugins/wecom/channel-transport.mjs';
const channelId='group:00000000-0000-0000-0000-000000000001';
const config={corpId:'wxfixture',corpSecret:'synthetic-fixture',serviceId:'fwfixture',token:'fixture',aesKey:Buffer.alloc(32,1).toString('base64').replace(/=$/,''),localGroups:[{chatId:'room',channelId}]};
test('WeCom is an explicit native channel transport, without a directory, ACL or timeline',async()=>{
 const calls=[];const transport=createWeComChannelTransport({...config,fetcher:async(url,options)=>{calls.push([url.pathname,options.body&&JSON.parse(options.body)]);return Response.json({errcode:0,access_token:'synthetic-access'});}});
 assert.deepEqual(transport.bindings,[{source:JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']),channelId}]);
 assert.equal(transport.discovery,undefined);assert.equal(transport.bindings[0].readers,undefined);
 assert.equal(await transport.send({source:transport.bindings[0].source,requestId:'1',text:'hello',author:'Alice'},new AbortController().signal),'delivered');assert.equal(calls[1][1].receiver.id,'room');
});
test('legacy-only configs, unbound and ambiguous mappings fail closed',()=>{
 assert.throws(()=>createWeComChannelTransport({...config,callbackPath:'/arbitrary'}));
 assert.throws(()=>createWeComChannelTransport({...config,localGroups:undefined,chatId:'room',actorId:'admin'}));
 assert.throws(()=>createWeComChannelTransport({...config,localGroups:[{chatId:'room',channelId:'bad'}]}));
 assert.throws(()=>createWeComChannelTransport({...config,localGroups:[...config.localGroups,{chatId:'other',channelId}]}));
});

test('provider directory IDs resolve to verified employee accounts and lookup failures never become empty identities',async()=>{
 let lookups=0,fail=false;const profiles=[];
 const transport=createWeComChannelTransport({...config,fetcher:async(url,options)=>{
  if(url.pathname.endsWith('/gettoken'))return Response.json({errcode:0,access_token:'fixture-access',expires_in:7200});
  assert.ok(url.pathname.endsWith('/convert_to_name'));const input=JSON.parse(options.body);lookups++;
  return Response.json({errcode:0,user_list:fail?[]:[{userid:input.userid_list[0],name:'skipzhang'}]});
 }},{onSenderProfile:profile=>profiles.push(profile)});
 const source=transport.bindings[0].source,signal=new AbortController().signal;
 assert.equal(await transport.resolveSender(source,'T10001A',signal),'skipzhang');
 assert.equal(await transport.resolveSender(source,'T10001A',signal),'skipzhang');assert.equal(lookups,1);
 assert.equal(await transport.resolveSender(source,'skipzhang',signal),'skipzhang');
 assert.equal(profiles.length,2,'only authenticated directory mappings, including cached results, become photo evidence');
 assert.deepEqual(profiles[0],{source,id:'T10001A',name:'skipzhang'});
 fail=true;await assert.rejects(()=>transport.resolveSender(source,'T20002',signal),/wecom_identity_unavailable/);
 await assert.rejects(()=>transport.resolveSender('untrusted','T10001A',signal),/invalid_wecom_sender/);
});

for (const callbackPath of ['/__opencraft_im/channel-callback/wecom','/__opencraft_im/shadow-callback/wecom']) for (const relayIngress of [false, true]) test(`signed callbacks ${callbackPath} enforce ${relayIngress ? 'explicit relay ingress' : 'native bindings'}, signatures, echoes and durable ACK`,async t=>{
 const {createServer}=await import('node:http');const {createCipheriv,createHash}=await import('node:crypto');
 const mentions=[];const transport=createWeComChannelTransport({...config,callbackPath,relayIngress,localGroups:relayIngress?[]:config.localGroups,onMention:event=>mentions.push(event)}),seen=[];let reject=false;
 const stop=transport.subscribe(async arrival=>{if(reject)throw Error('native storage unavailable');seen.push(arrival);});t.after(stop);
 const server=createServer((req,res)=>void transport.callback.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const origin='http://127.0.0.1:'+server.address().port;
 function envelope(group='room',sender='wei'){
   const xml=`<xml><ServiceId>fwfixture</ServiceId><ToUserName>wxfixture</ToUserName><AgentType>chat</AgentType><Msg><From><Type>group</Type><Id>${group}</Id><Sender>${sender}</Sender></From><MsgType>text</MsgType><MentionedType>1</MentionedType><MsgId>external-id</MsgId><Content>hello</Content><CreateTime>1000</CreateTime></Msg></xml>`;
   const body=Buffer.from(xml),size=Buffer.alloc(4);size.writeUInt32BE(body.length);
   const clear=Buffer.concat([Buffer.alloc(16),size,body,Buffer.from('fwfixture')]);const pad=32-clear.length%32;
   const key=Buffer.alloc(32,1),cipher=createCipheriv('aes-256-cbc',key,key.subarray(0,16));cipher.setAutoPadding(false);
   const encrypted=Buffer.concat([cipher.update(Buffer.concat([clear,Buffer.alloc(pad,pad)])),cipher.final()]).toString('base64');
   const timestamp=String(Math.floor(Date.now()/1000)),nonce='fixture';const signature=createHash('sha1').update([config.token,timestamp,nonce,encrypted].sort().join('')).digest('hex');
   return {url:origin+transport.callback.path+'?'+new URLSearchParams({msg_signature:signature,timestamp,nonce}),body:`<xml><Encrypt>${encrypted}</Encrypt></xml>`};
 }
 async function post(e){return fetch(e.url,{method:'POST',body:e.body});}
 assert.equal((await post(envelope())).status,200);assert.equal(seen.length,1);assert.equal(seen[0].mentioned,true);assert.equal(seen[0].source,JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']));assert.equal(mentions.length,relayIngress?1:0);
 assert.equal((await post(envelope('unbound'))).status,200);assert.equal((await post(envelope('room','fwfixture'))).status,200);assert.equal(seen.length,relayIngress?2:1);
 const forged=envelope();forged.url=forged.url.replace(/msg_signature=[^&]+/,'msg_signature='+ '0'.repeat(40));assert.equal((await post(forged)).status,401);assert.equal(seen.length,relayIngress?2:1);
 reject=true;const prior=mentions.length;assert.equal((await post(envelope())).status,503);assert.equal(mentions.length,prior);
});


test('identity bridge bypasses name caches and rejects recycled RTX and ambiguous directory replies',async()=>{
 let reverseId='T10001A', name='alice', duplicate=false, forwardCalls=0;
 const transport=createWeComChannelTransport({...config,fetcher:async(url,options)=>{
  if(url.pathname.endsWith('/gettoken'))return Response.json({errcode:0,access_token:'fixture-access',expires_in:7200});
  if(url.pathname.endsWith('/convert_to_name')){
   forwardCalls++;const row={userid:JSON.parse(options.body).userid_list[0],name};
   return Response.json({errcode:0,user_list:duplicate?[row,row]:[row]});
  }
  assert.ok(url.pathname.endsWith('/convert_to_userid'));
  return Response.json({errcode:0,user_list:[{name,userid:reverseId}]});
 }});
 const source=transport.bindings[0].source,signal=new AbortController().signal;
 assert.equal(await transport.resolveSender(source,'T10001A',signal),'alice');
 name='bob';
 assert.equal(await transport.employeeIdentity(source,'T10001A',signal),'bob');
 assert.equal(forwardCalls,2,'cached display lookup must not become account evidence');
 reverseId='T20002A';
 await assert.rejects(transport.employeeIdentity(source,'T10001A',signal),/wecom_identity_conflict/);
 duplicate=true;
 await assert.rejects(transport.employeeIdentity(source,'T10001A',signal),/wecom_identity_unavailable/);
 await assert.rejects(transport.employeeIdentity(source,'wbfixture',signal),/invalid_wecom_employee/);
});

test('member identity evidence uses bounded batch reads and excludes nonreciprocal employees',async()=>{
 const ids=Array.from({length:1000},(_,i)=>'T'+(i+1)+'A');let requests=0;
 const transport=createWeComChannelTransport({...config,fetcher:async(url)=>{
  if(url.pathname.endsWith('/gettoken'))return Response.json({errcode:0,access_token:'fixture-access',expires_in:7200});
  requests++;
  return Response.json({errcode:0,user_list:ids.map((id,i)=>({userid:requests===2&&i===0?'Tchanged':id,name:'employee'+i}))});
 }});
 const result=await transport.employeeIdentities(transport.bindings[0].source,ids,new AbortController().signal);
 assert.equal(requests,2);assert.equal(result.size,999);assert.equal(result.has(ids[0]),false);
 assert.equal(result.get(ids[999]),'employee999');
});
