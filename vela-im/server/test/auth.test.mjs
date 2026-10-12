import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SignJWT} from 'jose';
import {buildApp} from '../dist/app.js';
import {Store} from '../dist/store.js';
import {userSig} from '../dist/signature.js';
import tls from 'tls-sig-api-v2';
import {inflateSync} from 'node:zlib';

const key='test-only-sso-secret-32-bytes-long-12345';
const config=dir=>({appId:1600166071,imSecret:'test-only-im-key',admin:'administrator',restHost:'console.tim.qq.com',host:'127.0.0.1',port:0,dataDir:dir,ssoSecret:key,ssoIssuer:'test-login',ssoAudience:'vela-im',allowedOrigins:['http://localhost'],demoMode:false,webDir:'/nonexistent'});
const assertion=(sub,options={})=>new SignJWT({name:'测试用户'}).setProtectedHeader({alg:'HS256'}).setSubject(sub).setIssuer(options.issuer??'test-login').setAudience('vela-im').setIssuedAt().setExpirationTime(options.exp??'5m').sign(new TextEncoder().encode(key));

test('SSO rejects spoofed/expired login and separates owner authority from peer authority',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-auth-'));const {app}=await buildApp(config(dir),{provision:async()=>{}});
 try {
  const request=(method,url,token,payload)=>app.inject({method,url,payload,headers:token?{authorization:`Bearer ${token}`}:{}});
  assert.equal((await request('POST','/api/auth/demo','',{})).statusCode,404);
  assert.equal((await request('POST','/api/auth/exchange','',{assertion:await assertion('one',{issuer:'evil'})})).statusCode,401);
  assert.equal((await request('POST','/api/auth/exchange','',{assertion:await assertion('one',{exp:'-1m'})})).statusCode,401);
  const a=(await request('POST','/api/auth/exchange','',{assertion:await assertion('one')})).json();
  const b=(await request('POST','/api/auth/exchange','',{assertion:await assertion('two')})).json();
  const repeated=(await request('POST','/api/auth/exchange','',{assertion:await assertion('one')})).json();
  assert.equal(repeated.ownerId,a.ownerId);assert.equal(repeated.identities[0].id,a.identities[0].id);
  const agent=(await request('POST','/api/identities',a.token,{name:'Agent',kind:'agent'})).json();
  assert.equal((await request('POST',`/api/identities/${agent.id}/tokens`,b.token,{})).statusCode,404);
  const p=(await request('POST',`/api/identities/${agent.id}/tokens`,a.token,{})).json();
  assert.equal((await request('GET','/api/credentials',a.token)).statusCode,403);
  assert.equal((await request('GET','/api/credentials',p.token)).json().userID,agent.id);
  // The identity service never relays IM traffic: every client logs into Tencent itself.
  for(const [method,url] of [['POST','/api/sdk/call'],['POST','/api/messages'],['GET','/api/events'],['GET','/api/capabilities'],['POST','/api/groups/reply-input']])assert.equal((await request(method,url,p.token,method==='POST'?{}:undefined)).statusCode,404);
  assert.equal((await request('POST','/api/identities',p.token,{name:'Escalated',kind:'agent'})).statusCode,403);
  assert.equal((await request('POST',`/api/identities/${a.identities[0].id}/tokens`,p.token,{})).statusCode,403);
  await request('DELETE',`/api/identities/${agent.id}/tokens`,a.token);
  assert.equal((await request('GET','/api/credentials',p.token)).statusCode,401);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true})}
});
test('owners choose who may command their identities; an identity learns its policy and its owner',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-control-'));const {app}=await buildApp(config(dir),{provision:async()=>{}});
 try {
  const request=(method,url,token,payload)=>app.inject({method,url,payload,headers:token?{authorization:`Bearer ${token}`}:{}});
  const a=(await request('POST','/api/auth/exchange','',{assertion:await assertion('owner-a')})).json();
  const b=(await request('POST','/api/auth/exchange','',{assertion:await assertion('owner-b')})).json();
  const agent=(await request('POST','/api/identities',a.token,{name:'助手',kind:'agent'})).json();
  const agentToken=(await request('POST',`/api/identities/${agent.id}/tokens`,a.token,{})).json().token;
  assert.equal((await request('GET',`/api/identities/${agent.id}/settings`,a.token)).json().commandPolicy,'owner');
  let control=(await request('GET','/api/control',agentToken)).json();
  assert.equal(control.commandPolicy,'owner');
  assert.deepEqual(control.owner.identities.map(i=>i.id).sort(),[a.identities[0].id,agent.id].sort());
  assert.equal((await request('PUT',`/api/identities/${agent.id}/settings`,b.token,{commandPolicy:'anyone'})).statusCode,404);
  assert.equal((await request('PUT',`/api/identities/${agent.id}/settings`,agentToken,{commandPolicy:'anyone'})).statusCode,403);
  assert.equal((await request('PUT',`/api/identities/${agent.id}/settings`,a.token,{commandPolicy:'root'})).statusCode,400);
  assert.equal((await request('PUT',`/api/identities/${agent.id}/settings`,a.token,{commandPolicy:'anyone'})).json().commandPolicy,'anyone');
  control=(await request('GET','/api/control',agentToken)).json();assert.equal(control.commandPolicy,'anyone');
  assert.equal((await request('GET','/api/control',a.token)).statusCode,403);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true})}
});
test('Tencent UserSig matches the official signing library',()=>{
 const time=Math.floor(Date.now()/1000);const secret='a-test-secret';const api=new tls.Api(1600166071,secret);
 const decode=s=>JSON.parse(inflateSync(Buffer.from(s.replaceAll('*','+').replaceAll('-','/').replaceAll('_','='),'base64')));
 assert.deepEqual(decode(userSig(1600166071,secret,'peer-123',3600,time)),decode(api.genUserSig('peer-123',3600)));
});
