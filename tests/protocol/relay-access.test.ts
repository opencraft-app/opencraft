import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, randomBytes, createCipheriv, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { AssertionProvider, AssertionSigner, ASSERTION_HEADER } from "../../packages/identity-core/src/node";
import { MembershipStore, InstanceAccess } from "../../packages/access-control/src/index";
import { createRelayServer } from "../../apps/relay-server/src/server";
import { connectRelay } from "../../plugins/relay-connect/src/server";
import { FixtureRequestIdentity, signedFixtureIdentity as signed } from "../fixtures/request-identity";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";
import { createHeadlessBackendProxy, isHeadlessBackendPath } from "../../scripts/web-deployment/headless-backend.mjs";
import { relayPathAllowed } from "../../packages/relay-protocol/src";
import { DatabaseSync } from 'node:sqlite';

function keys() { const pair = generateKeyPairSync('ed25519'); return { privateKey: pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(), publicKey: pair.publicKey.export({format:'pem',type:'spki'}).toString() }; }
async function waitFor(check: () => boolean) { const until = Date.now() + 5000; while (!check()) { if (Date.now() > until) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 25)); } }
const principal = { provider: 'fixture', subject: '123', displayName: 'employee.one', expiresAt: Date.now() + 3600_000 };
// Node's Fetch implementation owns Host; native HTTP deliberately exercises virtual hosts.
async function virtualFetch(url: string, init: {headers?: Record<string,string>;method?:string;body?:Buffer} = {}) {
  return new Promise<Response>((resolve,reject) => {
    const req=httpRequest(url,{headers:init.headers,method:init.method ?? 'GET'},res=>{
      const headers=new Headers();for(let i=0;i<res.rawHeaders.length;i+=2)headers.append(res.rawHeaders[i]!,res.rawHeaders[i+1]!);
      resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>,{status:res.statusCode,headers}));
    });req.on('error',reject);req.end(init.body);
  });
}

test('assertions reject forgery, wrong request/instance/origin, duplicates, expiry and replay', () => {
  const pair = keys(), scope = { issuer: 'island-a', instanceId: 'team-a', origin: 'https://team-a.test' };
  let now = Date.now(); const signer = new AssertionSigner(scope, pair.privateKey), provider = new AssertionProvider(scope, pair.publicKey, () => now);
  const issue = () => signer.issue(principal, 'GET', '/api', now);
  const req = (value: string, extra = {}) => ({ headers: { host: 'team-a.test', [ASSERTION_HEADER]: value }, method: 'GET', url: '/api', ...extra });
  const value = issue(), first = req(value); assert.equal(provider.authenticate(first)?.subject, '123'); assert.equal(provider.authenticate(first)?.subject, '123');
  assert.equal(provider.authenticate(req(value)), null, 'new request cannot replay');
  for (const request of [req(issue(), {method:'POST'}), req(issue(), {url:'/other'}), req(issue(), {headers:{host:'team-b.test',[ASSERTION_HEADER]:issue()}}), req(issue() + 'x'), req(issue(), {rawHeaders:[ASSERTION_HEADER,issue(),ASSERTION_HEADER,issue()]})]) assert.equal(provider.authenticate(request), null);
  const other = new AssertionProvider({...scope, instanceId:'team-b'}, pair.publicKey, () => now); assert.equal(other.authenticate(req(issue())), null);
  const stale = issue(); now += 31_000; assert.equal(provider.authenticate(req(stale)), null);
  for (const path of ['/__opencraft_updates', '/__opencraft_updates/install', '/%5f_opencraft_updates', '/a/../__opencraft_updates', '//evil.test/','/__opencraft_relay/control']) assert.equal(relayPathAllowed(path), false, path);
});

test('core membership persists, records administration, binds legacy grants once and fails closed without provider', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'membership-')); t.after(() => rm(dir,{recursive:true,force:true}));
  let store = new MembershipStore(join(dir,'members.sqlite'));
  const p = {...principal, aliases:['login:employee.one']};
  store.importBindings('legacy', [{ provider: 'fixture', subject: 'login:employee.one' }]);
  store.bindLegacyAlias(p); assert.equal(store.role(p),'member');
  assert.equal(store.role({...p,subject:'login:employee.one'}),null);
  store.set(p,'member',false,'test-admin'); store.importBindings('legacy',[p]); store.bindLegacyAlias(p); assert.equal(store.role(p),null);
  store.close(); store = new MembershipStore(join(dir,'members.sqlite')); t.after(() => store.close());
  assert.equal(store.role(p),null); assert.ok(store.audit().length >= 3);
  assert.equal(new InstanceAccess(store,[]).admissionStatus({headers:{staffid:'123'}}),401);
});
test('membership checksum drift fails closed and preserves stored grants',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'membership-drift-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'members.sqlite');
  const store=new MembershipStore(path);store.set(principal,'admin',true,'test-admin');store.close();
  const fixture=new DatabaseSync(path);fixture.prepare("UPDATE schema_migrations SET checksum='modified' WHERE version=1").run();fixture.close();
  assert.throws(()=>new MembershipStore(path));
  const inspect=new DatabaseSync(path,{readOnly:true});try{assert.equal(inspect.prepare('SELECT count(*) AS n FROM members').get()!.n,1);}finally{inspect.close();}
});

test('real HTTP/WS relay isolates two instances; preserves document admission and closes revoked sockets', async t => {
  const dir = await mkdtemp(join(tmpdir(),'relay-team-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const pair=keys(), verifier=new FixtureRequestIdentity(); t.after(() => verifier.close());
  const routes=[], clients: ReturnType<typeof connectRelay>[]=[];
  const stores: MembershipStore[]=[], lateFrames:string[]=[];
  for (const team of ['a','b']) {
    const scope={issuer:'department',instanceId:'team-'+team,origin:`http://team-${team}.test`};
    const store=new MembershipStore(join(dir,team+'.sqlite')); stores.push(store); t.after(() => store.close());
    store.set({provider:'fixture',subject:team==='a'?'123':'456'},'admin',true,'test-admin');
    const access=new InstanceAccess(store,[new AssertionProvider(scope,pair.publicKey)]);
    const root=join(dir,team); await import('node:fs/promises').then(fs=>fs.mkdir(root)); await writeFile(join(root,'index.html'),`<!doctype html><title>Team ${team}</title>`);
    const oa=new FixtureRequestIdentity(r=>access.authenticate(r)); t.after(() => oa.close());
    const web=await createWorkbenchWebServer({root,appServerTarget:null,loopbackOnly:true,accessService:access,identityService:oa,
      desktopService:{accept(ws:WebSocket){ws.send('connected-'+team);ws.on('message',(data,binary)=>{if(data.toString()==='after-revocation')lateFrames.push(team);ws.send(data,{binary});});},close(){}}}); t.after(() => web.close());
    const address=await web.listen({host:'127.0.0.1',port:0});
    const proxy=createHeadlessBackendProxy(`http://127.0.0.1:${address.port}`);
    const front=createServer(async(req,res)=>{if(req.url==='/') {if(await proxy.admitDocument(req,res))res.end('Managed team '+team);}else proxy.http(req,res,()=>{});});
    front.on('upgrade',(req,socket,head)=>proxy.upgrade(req,socket,head,()=>{},new Set())); front.listen(0,'127.0.0.1');await once(front,'listening');
    t.after(()=>new Promise<void>(resolve=>{front.close(()=>resolve());front.closeAllConnections();}));
    routes.push({...scope,credential:randomBytes(32).toString('base64url'),signer:new AssertionSigner(scope,pair.privateKey),identityProvider:verifier.identityProvider(),targetPort:(front.address() as any).port});
  }
  const relay=createRelayServer(routes); relay.server.listen(0,'127.0.0.1'); await once(relay.server,'listening'); t.after(()=>relay.close());
  const base=`http://127.0.0.1:${(relay.server.address() as any).port}`;
  for(const route of routes)clients.push(connectRelay({relay:base,credential:route.credential,targetPort:route.targetPort,allowLoopbackInsecure:true})); t.after(()=>clients.forEach(c=>c.close()));
  await waitFor(()=>routes.every(r=>relay.connected(r.instanceId)));
  const request=(team:string,path='/',headers={})=>virtualFetch(base+path,{headers:{host:`team-${team}.test`,...headers}});
  assert.equal((await request('a')).status,401);
  assert.equal((await request('a','/',signed())).status,200); assert.equal(await (await request('a','/',signed())).text(),'Managed team a');
  assert.equal((await request('b','/',signed())).status,403);
  assert.equal((await request('b','/',signed(456,'employee.two'))).status,200);
  assert.equal((await request('a','/',{...signed(),origin:'https://evil.test'})).status,403);
  const session=await (await request('a','/__opencraft_fixture/session',signed())).json();assert.equal(session.principal.subject,'123');
  const memberChange=(headers:Record<string,string>)=>virtualFetch(base+'/__opencraft_access/members',{method:'POST',headers:{host:'team-a.test',origin:'http://team-a.test','content-type':'application/json',...headers},body:Buffer.from(JSON.stringify({provider:'fixture',subject:'456',role:'member',enabled:true}))});
  assert.equal((await memberChange(signed())).status,200);
  assert.equal((await request('a','/__opencraft_access/session',signed(456,'employee.two'))).status,200);
  assert.equal((await request('a','/__opencraft_access/audit',signed(456,'employee.two'))).status,403);
  assert.equal((await memberChange(signed(456,'employee.two'))).status,403);
  assert.equal((await request('a','/__opencraft_updates',signed())).status,403);
  const socket=new WebSocket(base.replace('http:','ws:')+'/desktop/connect',{headers:{host:'team-a.test',...signed()},origin:'http://team-a.test'});
  const message=once(socket,'message');await once(socket,'open');assert.equal((await message)[0].toString(),'connected-a');
  const echo=once(socket,'message');socket.send(Buffer.from([0,1,255]));assert.deepEqual((await echo)[0],Buffer.from([0,1,255]));
  // Deliberately refuse the close handshake and try sending another application frame.
  (socket as any)._receiver.removeAllListeners('conclude');
  (socket as any)._receiver.on('conclude',()=>{if(socket.readyState===WebSocket.OPEN)socket.send('after-revocation');});
  const closed=once(socket,'close');let timeout:ReturnType<typeof setTimeout>;
  const deadline=new Promise<null>(resolve=>{timeout=setTimeout(()=>{resolve(null);socket.terminate();},1500);});
  stores[0]!.set(principal,'member',false,'test-admin');const retired=await Promise.race([closed,deadline]);clearTimeout(timeout!);
  assert.notEqual(retired,null,'revocation must force retirement without a peer close acknowledgement');
  assert.ok([1006,1008].includes(retired![0]));assert.deepEqual(lateFrames,[],'no application frame is handled after revocation close');
  assert.equal((await request('a','/',signed())).status,403);
  assert.equal((await request('b','/',signed(456,'employee.two'))).status,200,'other team remains live');
  stores[0]!.set(principal,'admin',true,'test-admin'); clients[0]!.close();
  await waitFor(()=>!relay.connected('team-a'));assert.equal((await request('a','/',signed())).status,503);
  clients[0]=connectRelay({relay:base,credential:routes[0]!.credential,targetPort:routes[0]!.targetPort,allowLoopbackInsecure:true});await waitFor(()=>relay.connected('team-a'));assert.equal((await request('a','/',signed())).status,200);
});

test('relay streams large uploads and incremental responses without changing binary payloads', async t => {
  const target=createServer(async(req,res)=>{
    if(req.url==='/headers'){res.end(JSON.stringify({assertion:typeof req.headers[ASSERTION_HEADER]==='string',ioa:req.headers['x-tai-identity']??null,forwarded:req.headers['x-forwarded-for']??null,cookie:req.headers.cookie??null,proxy:req.headers['proxy-authorization']??null}));return;}
    if(req.url==='/stream'){res.writeHead(200,{'content-type':'text/event-stream','set-cookie':['a=1; HttpOnly','b=2; HttpOnly']});res.write('first\n');setTimeout(()=>res.end('last\n'),300);return;}
    let size=0;const hash=createHash('sha256');for await(const chunk of req){size+=chunk.length;hash.update(chunk);}res.end(JSON.stringify({size,hash:hash.digest('hex')}));
  });target.listen(0,'127.0.0.1');await once(target,'listening');t.after(()=>new Promise<void>(r=>{target.close(()=>r());target.closeAllConnections();}));
  const echoes=new WebSocketServer({noServer:true,maxPayload:8*1024*1024,perMessageDeflate:false});
  target.on('upgrade',(req,socket,head)=>echoes.handleUpgrade(req,socket,head,ws=>ws.on('message',(data,binary)=>ws.send(data,{binary}))));t.after(()=>echoes.close());
  const pair=keys(),scope={issuer:'department',instanceId:'upload',origin:'http://upload.test'},credential=randomBytes(32).toString('base64url');
  const relay=createRelayServer([{...scope,credential,signer:new AssertionSigner(scope,pair.privateKey),identityProvider:{authenticate:()=>principal}}]);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');t.after(()=>relay.close());
  const base=`http://127.0.0.1:${(relay.server.address() as any).port}`,client=connectRelay({relay:base,credential,targetPort:(target.address() as any).port,allowLoopbackInsecure:true});t.after(()=>client.close());await waitFor(()=>relay.connected('upload'));
  const bytes=randomBytes(4*1024*1024),response=await virtualFetch(base+'/upload',{method:'POST',headers:{host:'upload.test'},body:bytes});assert.deepEqual(await response.json(),{size:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')});
  const sanitized=await virtualFetch(base+'/headers',{headers:{host:'upload.test',[ASSERTION_HEADER]:'forged','x-tai-identity':'forged','x-forwarded-for':'forged','proxy-authorization':'private-proxy','cookie':'opencraft-relay-session=private-relay; business=keep; __Host-opencraft-relay-login=private-login'}});
  assert.deepEqual(await sanitized.json(),{assertion:true,ioa:null,forwarded:null,cookie:'business=keep',proxy:null});
  const stream=await virtualFetch(base+'/stream',{headers:{host:'upload.test'}}),reader=stream.body!.getReader();
  assert.equal(Buffer.from((await reader.read()).value!).toString(),'first\n');assert.equal(stream.headers.getSetCookie().length,2);
  assert.equal(Buffer.from((await reader.read()).value!).toString(),'last\n');await reader.cancel();
  const ws=new WebSocket(base.replace('http:','ws:')+'/echo',{headers:{host:'upload.test'},origin:'http://upload.test',perMessageDeflate:false});await once(ws,'open');
  const echoed=once(ws,'message');ws.send(bytes);assert.deepEqual((await echoed)[0],bytes,'application WS messages larger than tunnel frames preserve their payload');ws.close();await once(ws,'close');
});

test('core expiry forcibly retires a WebSocket even when the peer ignores close', async t => {
  const dir=await mkdtemp(join(tmpdir(),'access-expiry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'index.html'),'Expiry test');const store=new MembershipStore(join(dir,'members.sqlite'));t.after(()=>store.close());
  const identity={...principal,expiresAt:Date.now()+1000};store.set(identity,'member',true,'test-admin');
  const web=await createWorkbenchWebServer({root:dir,appServerTarget:null,loopbackOnly:true,accessService:new InstanceAccess(store,[{authenticate:()=>identity}]),desktopService:{accept(){},close(){}}});t.after(()=>web.close());
  const address=await web.listen({host:'127.0.0.1',port:0}),origin=`http://127.0.0.1:${address.port}`;
  const socket=new WebSocket(origin.replace('http:','ws:')+'/desktop/connect',{origin});await once(socket,'open');
  (socket as any)._receiver.removeAllListeners('conclude');const closed=once(socket,'close');let timer:ReturnType<typeof setTimeout>;
  const deadline=new Promise<null>(resolve=>{timer=setTimeout(()=>{resolve(null);socket.terminate();},2000);});
  const result=await Promise.race([closed,deadline]);clearTimeout(timer!);assert.notEqual(result,null,'expired identity must force disconnect without a close acknowledgement');
  assert.equal(store.role(identity),'member','grant remains enabled; identity expiry caused the retirement');
});

test('provider admission accepts verified employees without enrollment, retains revocation/admin and writes no implicit grant', async t => {
  const { ActorStore } = await import("../../packages/access-control/src/actors");
  const dir = await mkdtemp(join(tmpdir(), 'provider-members-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store = new MembershipStore(join(dir,'members.sqlite')),actors = new ActorStore(join(dir,'actors.sqlite'));t.after(()=>{actors.close();store.close();});
  const pair=keys(),scope={issuer:'fixture',instanceId:'fixture',origin:'http://fixture.test'};
  let now=Date.now();const signer=new AssertionSigner(scope,pair.privateKey),provider=new AssertionProvider(scope,pair.publicKey,()=>now);
  const access=new InstanceAccess(store,[provider],actors,['fixture']);
  const request=(p=principal)=>({method:'GET',url:'/',headers:{host:'fixture.test',[ASSERTION_HEADER]:signer.issue(p,'GET','/')}});
  assert.equal(new InstanceAccess(store,[provider],actors).admissionStatus(request()),403,'old explicit-only policy reproduces missing-member failure');
  assert.equal(access.admissionStatus(request()),204);
  assert.equal(access.role(principal),'member');assert.equal(store.list().length,0);assert.equal(store.listActors().length,0,'implicit membership is not durable');
  assert.equal(new InstanceAccess(store,[provider],actors).admissionStatus(request()),403,'removing provider policy removes implicit access');
  assert.equal(access.admissionStatus({method:'GET',url:'/',headers:{host:'fixture.test',staffid:'123',staffname:'employee.one'}}),401);
  assert.equal(access.admissionStatus(request({...principal,provider:'local'})),403,'another verified provider is not admitted');
  const expiry=Date.now()+1000,expired=request({...principal,expiresAt:expiry});now=expiry+1;assert.equal(access.admissionStatus(expired),401);now=Date.now();
  store.set(principal,'admin',true,'fixture');assert.equal(access.role(principal),'admin');
  store.set(principal,'admin',false,'fixture');assert.equal(access.admissionStatus(request()),403,'stable-subject revocation wins');
  store.set(principal,'member',true,'fixture');const actor=actors.findHuman(principal)!;
  store.setActor(actor.id,'member',false,'fixture');assert.equal(access.admissionStatus(request()),403,'actor membership revocation wins');
  store.setActor(actor.id,'member',true,'fixture');actors.setEnabled(actor.id,false,'fixture');assert.equal(access.admissionStatus(request()),403,'disabled human wins');
});

test('IM list traverses relay, managed Web proxy, verified human admission and channel service', async t => {
  const {ActorStore} = await import('../../packages/access-control/src/actors');
  const {ActorAccess} = await import('../../packages/access-control/src/actor-access');
  const {ImChannelService} = await import('../../scripts/im-channel-service.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'relay-im-')); t.after(() => rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'index.html'),'IM');
  const pair=keys(), scope={issuer:'fixture',instanceId:'im',origin:'https://im.test'};
  const actors=new ActorStore(join(dir,'actors.sqlite')); t.after(()=>actors.close());
  const members=new MembershipStore(join(dir,'members.sqlite')); t.after(()=>members.close());members.set(principal,'admin',true,'fixture');
  const access=new InstanceAccess(members,[new AssertionProvider(scope,pair.publicKey)],actors);
  const human=new ActorAccess(actors,{authenticateHuman:r=>access.authenticate(r),admitted:p=>access.role(p)!==null,administrator:p=>access.role(p)==='admin',trustedOrigin:r=>access.trustedOrigin(r)});
  const im=await ImChannelService.open([],{dataDirectory:dir,actors,actorAccess:human,collaboration:{execution:{serverId:'im-server',hostId:'im-host'}},getAppHost:()=>null,admittedActor:id=>access.admitsActor(id)});t.after(()=>im.close());
  const {HeadlessConnectors}=await import('../../packages/connector-host/src/headless');
  const {SessionCapabilities}=await import('../../packages/session-capabilities/src/index');
  const connectors=new HeadlessConnectors(join(dir,'connectors'),human,{'connector-host':'server:relay:connectors'},new SessionCapabilities(),id=>access.admitsActor(id));t.after(()=>connectors.close());
  const web=await createWorkbenchWebServer({root:dir,appServerTarget:null,loopbackOnly:true,accessService:access,actorService:human,getImService:()=>im,connectorService:connectors});t.after(()=>web.close());
  const address=await web.listen({host:'127.0.0.1',port:0});const proxy=createHeadlessBackendProxy(`http://127.0.0.1:${address.port}`);
  // Match the managed entry dispatch: an omitted API route would first consume
  // the one-use relay assertion during document admission, then fail forwarding.
  const front=createServer(async(req,res)=>{
    const path=new URL(req.url!, 'http://entry.test').pathname;
    if(isHeadlessBackendPath(path))proxy.http(req,res,()=>{});
    else if(await proxy.admitDocument(req,res))proxy.http(req,res,()=>{});
  });front.listen(0,'127.0.0.1');await once(front,'listening');t.after(()=>new Promise<void>(resolve=>{front.close(()=>resolve());front.closeAllConnections();}));
  const identity=new FixtureRequestIdentity();t.after(()=>identity.close());
  const route={...scope,credential:randomBytes(32).toString('base64url'),signer:new AssertionSigner(scope,pair.privateKey),identityProvider:identity.identityProvider(),targetPort:(front.address() as any).port};
  const relay=createRelayServer([route]);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');t.after(()=>relay.close());
  const base=`http://127.0.0.1:${(relay.server.address() as any).port}`;const client=connectRelay({relay:base,credential:route.credential,targetPort:route.targetPort,allowLoopbackInsecure:true});t.after(()=>client.close());await waitFor(()=>relay.connected('im'));
  const response=await virtualFetch(base+'/__opencraft_im',{method:'POST',headers:{host:'im.test',origin:scope.origin,'content-type':'application/json',...signed()},body:Buffer.from(JSON.stringify({action:'list'}))});
  const document=await response.json();assert.equal(response.status,200,JSON.stringify(document));assert.deepEqual(document.channels,[]);assert.equal(document.serverId,'im-server');assert.equal(actors.get(document.actorId)?.kind,'human');
  const connectorResponse=await virtualFetch(base+'/__opencraft_connectors',{method:'POST',headers:{host:'im.test',origin:scope.origin,'content-type':'application/json',...signed()},body:Buffer.from(JSON.stringify({hostId:'connector-host',method:'state',params:{}}))});
  assert.equal(connectorResponse.status,200);assert.deepEqual((await connectorResponse.json()).instances,[],'connector route survives managed proxy and one-use relay assertion');

});
