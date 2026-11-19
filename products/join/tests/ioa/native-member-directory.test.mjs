import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createNativeMemberEvidence} from '../../plugins/tencentoa/src/native-member-directory.mjs';
import {MirrorService,MIRROR_PATH} from '../../plugins/wecom/mirror/service.mjs';
import {humanKey} from '../../plugins/wecom/mirror/store.mjs';
const corpId='wxfixture',now=()=>1000;
const claim=(subject='123',rtx='jasminzhao')=>({provider:'tencentoa',subject,attributes:{loginName:rtx},aliases:['login:'+rtx],expiresAt:2000});
const member={actorId:'human://622f90de-df1d-43bc-bfa2-1cfff27e20ea/2e560ff8-f5be-4da4-9435-ec1aaf8bfbe3',subject:'123'};
const key=rtx=>'wecom-directory:v1:identity:'+createHash('sha256').update(JSON.stringify(['wecom',corpId,rtx])).digest('hex');
function directory(claims=[],seed=[]) {
 const rows=new Map(seed.map(([rtx,value])=>[key(rtx),JSON.stringify(value)]));
 return {rows,knownPrincipals:async()=>claims,read:async k=>rows.get(k)??null,evaluate:async(_,[k],[old,next])=>{if((rows.get(k)??'')!==old)return 0;rows.set(k,next);return 1;}};
}
const employee=async rtx=>({corpId,rtx,userId:'T001A'});
test('verified login alias resolves exact OA subject and expires within 60 seconds',async()=>{
 const resolve=createNativeMemberEvidence(directory([claim()]),employee,corpId,now);
 assert.deepEqual(await resolve([member]),{corpId,members:[{...member,rtx:'jasminzhao',userId:'T001A',expiresAt:61000}]});
});
test('hint can recover durable trusted mapping after login expiry without creating login',async()=>{
 const redis=directory([], [['jasminzhao',claim()]]);
 const resolve=createNativeMemberEvidence(redis,employee,corpId,now);
 const value=await resolve([{...member,rtxHint:'jasminzhao'}]);
 assert.equal(value.members[0].subject,'123');assert.equal(value.members[0].identity,undefined);
});
test('hints, labels, wrong subjects, expired claims and missing aliases never prove identity',async()=>{
 for (const claims of [[],[{...claim(),subject:'999'}],[{...claim(),expiresAt:999}],[{...claim(),aliases:[]}],
   [{provider:'tencentoa',subject:'123',displayName:'jasminzhao',expiresAt:2000}],[{...claim(),provider:'other'}]]) {
  assert.deepEqual((await createNativeMemberEvidence(directory(claims),employee,corpId,now)([{...member,rtxHint:'jasminzhao'}])).members,[]);
 }
 assert.deepEqual((await createNativeMemberEvidence(directory([], [['jasminzhao',claim('999')]]),employee,corpId,now)([{...member,rtxHint:'jasminzhao'}])).members,[]);
});
test('retained or live conflicts and multiple verified aliases omit evidence',async()=>{
 for (const redis of [directory([claim(),claim('999')]),directory([claim('999')],[['jasminzhao',claim()]]),directory([], [['jasminzhao',{state:'conflict'}]]),directory([claim(),claim('123','walkercao')])]) {
  assert.deepEqual((await createNativeMemberEvidence(redis,employee,corpId,now)([{...member,rtxHint:'jasminzhao'}])).members,[]);
 }
});
test('directory failures, robot ids, corp and reverse RTX mismatches omit only unverified member',async()=>{
 for (const lookup of [async()=>{throw Error('unavailable')},async rtx=>({corpId:'wxwrong',rtx,userId:'T001A'}),async()=>({corpId,rtx:'stranger',userId:'T001A'}),async rtx=>({corpId,rtx,userId:'wb123'}),async rtx=>({corpId,rtx,userId:'external:123'})])
  assert.deepEqual((await createNativeMemberEvidence(directory([claim()]),lookup,corpId,now)([member])).members,[]);
 const result=await createNativeMemberEvidence(directory([claim(),claim('456','walkercao')]),async rtx=>rtx==='walkercao'?{corpId,rtx,userId:'T002A'}:Promise.reject(Error()),corpId,now)([member,{actorId:'actor-2',subject:'456'}]);
 assert.deepEqual(result.members.map(m=>m.actorId),['actor-2']);
});
test('cross-person directory collisions cannot bind one userid to two actors',async()=>{
 const value=await createNativeMemberEvidence(directory([claim(),claim('456','walkercao')]),employee,corpId,now)([member,{actorId:'actor-2',subject:'456'}]);
 assert.deepEqual(value.members,[]);
});
test('aborted resolution cannot issue evidence',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(createNativeMemberEvidence(directory([claim()]),employee,corpId,now)([member],controller.signal));
});
test('native-member-resolve authenticates and authorizes owner without a bound source',async t=>{
 const registered=JSON.stringify({humans:{[humanKey(corpId,'OWNER')]:'actor-owner'}});let calls=0;
 const store={prefix:'fixture:',command:async(verb,k)=>{assert.equal(verb,'GET');return k==='fixture:server:one'?registered:null;},snapshot:async()=>{throw Error('source must not be required')}};
 const transport={subscribe:()=>()=>{}};
 const service=new MirrorService({store,transport,corpId,servers:[{id:'one',name:'One',credential:'x'.repeat(43)},{id:'two',name:'Two',credential:'y'.repeat(43)}],allowLoopbackInsecure:true,nativeMemberEvidence:async(members,signal)=>{calls++;assert.equal(signal.aborted,false);return{corpId,members};}});
 const server=createServer((req,res)=>void service.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await service.close();await new Promise(r=>server.close(r));});
 const request=async(body,headers={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+MIRROR_PATH+'/native-member-resolve',{method:'POST',headers:{'content-type':'application/json','x-opencraft-mirror-server':'one',authorization:'Bearer '+'x'.repeat(43),...headers},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
 const input={owner:'OWNER',members:[member]};
 assert.equal((await request(input,{authorization:'Bearer '+'z'.repeat(43)})).status,403);
 assert.equal((await request(input,{origin:'https://untrusted.example'})).status,403);
 assert.equal((await request({...input,owner:'stranger'})).status,403);
 assert.equal((await request(input,{'x-opencraft-mirror-server':'two',authorization:'Bearer '+'y'.repeat(43)})).status,403);
 for(const members of [Array.from({length:33},(_,i)=>({...member,actorId:'a'+i})),[{...member,subject:'login:name'}],[{...member,actorId:'a'.repeat(257)}],[{...member,actorId:'human://bad authority/id'}],[{...member,provider:'other'}],[{...member,rtxHint:'bad/hint'}],[{...member,rtx:'jasminzhao'}],[{...member,rtx:'jasminzhao',identitySource:'arbitrary'}],[{...member,identitySource:'ioa-admission'}],[member,member]])assert.equal((await request({...input,members})).status,503);
 assert.equal(calls,0);assert.equal((await request(input)).status,200);assert.equal(calls,1);assert.equal((await request({owner:'OWNER',members:[{...member,rtx:'jasminzhao',identitySource:'ioa-admission'}]})).status,200);
 assert.deepEqual((await request({owner:'OWNER',members:[]})).body,{corpId,members:[]});
});

test('production transport requires forward and reverse enterprise directory agreement',async()=>{
 const {createWeComChannelTransport}=await import('../../plugins/wecom/channel-transport.mjs');
 for(const conflict of [false,true]) {
  const paths=[];
  const transport=createWeComChannelTransport({corpId,serviceId:'fwfixture',corpSecret:'fixture',token:'fixture',aesKey:Buffer.alloc(32,7).toString('base64').replace(/=$/u,''),relayIngress:true,fetcher:async(url,options)=>{
   const path=new URL(url).pathname;paths.push(path);
   if(path.endsWith('/gettoken'))return Response.json({errcode:0,access_token:'fixture',expires_in:7200});
   if(path.endsWith('/convert_to_userid'))return Response.json({errcode:0,user_list:[{name:'jasminzhao',userid:'T001A'}]});
   if(path.endsWith('/convert_to_name'))return Response.json({errcode:0,user_list:[{name:conflict?'stranger':'jasminzhao',userid:'T001A'}]});
   throw Error('unexpected provider write '+path);
  }});
  const resolve=createNativeMemberEvidence(directory([claim()]),(rtx,signal)=>transport.employeeForRtx(rtx,signal),corpId,now);
  const value=await resolve([member],AbortSignal.timeout(2000));
  assert.equal(value.members.length,conflict?0:1);
  assert.ok(paths.includes('/cgi-bin/tencent/user/convert_to_name'));
  assert.ok(paths.every(p=>p.endsWith('/gettoken')||p.endsWith('/convert_to_userid')||p.endsWith('/convert_to_name')));
 }
});

test('authenticated installation admission metadata resolves after all browser sessions expire',async()=>{
 const redis=directory();const resolve=createNativeMemberEvidence(redis,employee,corpId,now);
 const value=await resolve([{...member,rtx:'jasminzhao',identitySource:'ioa-admission'}]);
 assert.equal(value.members[0].subject,member.subject);assert.equal(value.members[0].rtx,'jasminzhao');
 assert.equal(JSON.parse(redis.rows.get(key('jasminzhao'))).subject,member.subject);
 assert.equal((await resolve([{...member,rtxHint:'jasminzhao'}])).members.length,1);
});
test('admission metadata conflicts with live or durable OA association fail closed and retain conflict',async()=>{
 for(const redis of [directory([claim('999')]),directory([], [['jasminzhao',claim('999')]]),directory([claim('123','walkercao')]),directory([], [['jasminzhao',{state:'conflict'}]])]) {
  const result=await createNativeMemberEvidence(redis,employee,corpId,now)([{...member,rtx:'jasminzhao',identitySource:'ioa-admission'}]);
  assert.deepEqual(result.members,[]);assert.deepEqual(JSON.parse(redis.rows.get(key('jasminzhao'))),{state:'conflict'});
 }
});
test('plain RTX string is not trusted installation assertion',async()=>{
 assert.deepEqual((await createNativeMemberEvidence(directory(),employee,corpId,now)([{...member,rtx:'jasminzhao'}])).members,[]);
});

test('concurrent contradictory installation assertions cannot leak earlier evidence',async()=>{
 const redis=directory();
 const value=await createNativeMemberEvidence(redis,employee,corpId,now)([
  {...member,rtx:'jasminzhao',identitySource:'ioa-admission'},
  {actorId:'actor-2',subject:'456',rtx:'jasminzhao',identitySource:'ioa-admission'}]);
 assert.deepEqual(value.members,[]);assert.deepEqual(JSON.parse(redis.rows.get(key('jasminzhao'))),{state:'conflict'});
});
