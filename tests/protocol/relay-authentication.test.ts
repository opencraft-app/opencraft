import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { RelayAuthentication } from '../../apps/relay-server/src/authentication';
import { createRelayServer } from '../../apps/relay-server/src/server';
import { AssertionSigner } from '../../packages/identity-core/src/node';
import { CONTROL_PATH, RELAY_PROTOCOL } from '../../packages/relay-protocol/src';
import WebSocket from 'ws';
async function get(base:string,path:string,host:string,headers:Record<string,string>={},method='GET') {
  return new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:string}>((resolve,reject)=>{
    const req=request(base+path,{method,headers:{host,...headers}},res=>{let body='';res.on('data',c=>{body+=c});res.once('end',()=>resolve({status:res.statusCode!,headers:res.headers,body}));});req.on('error',reject);req.end();
  });
}
test('one approved login origin hands off only to enrolled team and initiating browser',async t=>{
  let identity={provider:'corporate-oidc',subject:'stable-user',displayName:'Employee',expiresAt:Date.now()+60_000};
  const routes=[{instanceId:'a',origin:'https://team-a.test'},{instanceId:'b',origin:'https://team-b.test'}];
  const auth=new RelayAuthentication('https://login.test',{authenticate:r=>r.headers['x-test-verified']==='yes'?identity:null},routes);
  const server=createServer((req,res)=>{if(auth.handle(req,res))return;const route=routes.find(r=>new URL(r.origin).host===req.headers.host);if(!route){res.writeHead(404);res.end();return;}const principal=auth.authenticate(req,route);if(principal)res.end(principal.subject);else auth.begin(req,res,route);});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const start=await get(base,'/chat?id=42','team-a.test');assert.equal(start.status,303);
  const challenge=start.headers['set-cookie']![0]!.split(';')[0]!;assert.match(start.headers['set-cookie']![0]!,/HttpOnly; SameSite=Lax.*Secure/u);
  const login=new URL(String(start.headers.location));assert.equal(login.origin,'https://login.test');
  assert.equal((await get(base,login.pathname+login.search,'team-b.test',{'x-test-verified':'yes'})).status,403,'enterprise identity verification cannot move to team origin');
  assert.equal((await get(base,login.pathname+login.search,'login.test')).status,401);
  const signed=await get(base,login.pathname+login.search,'login.test',{'x-test-verified':'yes'});assert.equal(signed.status,303);
  const callback=new URL(String(signed.headers.location));assert.equal(callback.origin,'https://team-a.test');
  assert.equal((await get(base,callback.pathname+callback.search,'team-b.test',{cookie:challenge})).status,403);
  assert.equal((await get(base,callback.pathname+callback.search,'team-a.test')).status,403,'ticket alone is insufficient');
  const exchanged=await get(base,callback.pathname+callback.search,'team-a.test',{cookie:challenge});assert.equal(exchanged.status,303);assert.equal(exchanged.headers.location,'https://team-a.test/chat?id=42');
  assert.equal((await get(base,callback.pathname+callback.search,'team-a.test',{cookie:challenge})).status,403,'single use ticket');
  const session=exchanged.headers['set-cookie']!.find(c=>c.startsWith('__Host-opencraft-relay-session='))!.split(';')[0]!;
  assert.equal((await get(base,'/','team-a.test',{cookie:session})).body,'stable-user');
  assert.equal((await get(base,'/','team-b.test',{cookie:session})).status,303,'session is team bound');
  assert.equal((await get(base,'/__opencraft_relay/logout','team-a.test',{cookie:session,origin:'https://evil.test'},'POST')).status,403);
  assert.equal((await get(base,'/__opencraft_relay/logout','team-a.test',{cookie:session,origin:'https://team-a.test'},'POST')).status,204);
  assert.equal((await get(base,'/','team-a.test',{cookie:session})).status,303);
});
test('independent relays reject each other enrollment credentials',async t=>{
  const pair=generateKeyPairSync('ed25519'),privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const first=randomBytes(32).toString('base64url'),second=randomBytes(32).toString('base64url');
  for(const [issuer,credential] of [['one',first],['two',second]]){
    const scope={issuer:issuer!,instanceId:'team',origin:'http://team.test'};
    const app=createRelayServer([{...scope,credential:credential!,signer:new AssertionSigner(scope,privateKey),identityProvider:{authenticate:()=>null}}]);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.close());
    const wrong=issuer==='one'?second:first;
    await assert.rejects(new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${(app.server.address() as any).port}${CONTROL_PATH}`,RELAY_PROTOCOL,{headers:{authorization:'Bearer '+wrong}});ws.once('open',()=>{ws.terminate();resolve(null)});ws.once('error',reject);}),/401/u);
  }
});
