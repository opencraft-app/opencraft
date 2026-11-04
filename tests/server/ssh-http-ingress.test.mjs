import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import ssh2 from 'ssh2';
import WebSocket, { WebSocketServer } from 'ws';
import { createSshHttpIngress, classifyIngress } from '../../plugins/ssh-http-ingress/src/index.mjs';
import { createProtocolIngress, classifyProtocol } from '../../scripts/web-deployment/protocol-ingress.mjs';
import { createSshNativeRpcGateway } from '../../scripts/ssh-native-rpc-gateway.mjs';
import { AppHostServer } from '../../packages/app-host-server/src/index.ts';

const identity = () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  return { privateKey, publicKey: 'ssh-rsa ' + ssh2.utils.parseKey(privateKey).getPublicSSH().toString('base64') };
};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const get = (port, path) => new Promise((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port, path }, res => { let body = ''; res.on('data', data => body += data); res.on('end', () => resolve({ code: res.statusCode, body })); });
  req.on('error', reject); req.end();
});

test('dynamic SSH keys retain trusted submission context and retire when their authority is revoked', { timeout: 15_000 }, async () => {
  const host = ssh2.utils.generateKeyPairSync('ed25519'), user = ssh2.utils.generateKeyPairSync('ed25519');
  const contexts = [], listeners = new Set(); let allowed = true;
  const adapter = {
    get status() { return { state: 'open' }; },
    subscribeMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); }, subscribeStatus() { return () => {}; },
    async connect() {}, async close() {},
    async send(frame) { const v = JSON.parse(frame); for (const fn of listeners) fn(JSON.stringify({ id: v.id, result: {}, __opencraftClient: v.__opencraftClient })); },
    async sendWithContext(frame, context) { contexts.push(context); await this.send(frame); },
  };
  const appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: 'server', createTransport: () => adapter });
  const native = await createSshNativeRpcGateway(appHost);
  const http = createServer((_req, res) => res.end('legacy'));
  const httpPort = await listen(http);
  const submissionContext = { sender: { kind: 'employee', loginName: 'new.member' } };
  let scoped;
  const ingress = createSshHttpIngress({ hostKey: host.private, authorizedKeys: { legacy: [host.public] }, httpPort, codexPort: native.port,
    resolveAuthorizedKeys: username => {
      if (username === 'legacy') throw Error('fixture optional key store unavailable');
      return allowed && username === 'new.member' ? [user.public] : [];
    },
    authorizeSession: () => ({ submissionContext, isCurrent: () => allowed }),
    createNativeSession: async authorization => scoped = await createSshNativeRpcGateway(appHost, authorization),
  });
  const address = await ingress.listen({ port: 0 });
  const clients = [];
  const connectClient = (username, privateKey = user.private) => {
    const c = new ssh2.Client(); c.on('error', () => {}); clients.push(c);
    const ready = new Promise((resolve, reject) => { c.once('ready', () => resolve(c)); c.once('error', reject); });
    c.connect({ host: '127.0.0.1', port: address.port, username, privateKey, readyTimeout: 1500 }); return ready;
  };
  try {
    const legacy = await connectClient('legacy', host.private); legacy.end();
    await assert.rejects(connectClient('other.member'), /authentication/);
    await assert.rejects(connectClient('new.member', host.private), /authentication/);
    const client = await connectClient('new.member');
    await assert.rejects(new Promise((resolve, reject) => client.exec('opencraft app-server proxy', (error, stream) => error ? reject(error) : resolve(stream))), /Unable to exec/);
    const stream = await new Promise((resolve, reject) => client.exec('codex app-server proxy', (error, channel) => error ? reject(error) : resolve(channel)));
    stream.on('error', () => {});
    const ws = new WebSocket('ws://127.0.0.1/rpc', { createConnection: () => stream });
    ws.on('error', () => {});
    await once(ws, 'open');
    const message = once(ws, 'message'); ws.send(JSON.stringify({ id: 1, method: 'initialize', params: {} })); await message;
    assert.equal(contexts.length, 1); assert.deepEqual(contexts[0], submissionContext);
    const intruder = new WebSocket(`ws://127.0.0.1:${scoped.port}/rpc`);
    intruder.on('error', () => {});
    await assert.rejects(once(intruder, 'open'), /socket hang up/);
    assert.equal(contexts.length, 1, 'an unrelated loopback peer cannot acquire the SSH identity');
    const closed = once(client, 'close'); allowed = false; await closed;
    assert.equal(ws.readyState, WebSocket.CLOSED);
    await assert.rejects(connectClient('new.member'), /authentication/);
  } finally {
    for (const client of clients) client.destroy();
    await ingress.close(); await scoped?.close(); await native.close(); await appHost.close();
    await new Promise(resolve => http.close(resolve));
  }
});

test('protocol classifier preserves fragmented HTTP/SSH boundaries and rejects other protocols', () => {
  for (const classifier of [classifyProtocol, classifyIngress]) {
    for (const text of ['S', 'SS', 'SSH', 'GE', 'OPTI']) assert.equal(classifier(Buffer.from(text)), 'pending');
    assert.equal(classifier(Buffer.from('SSH-2.0-test')), 'ssh');
    assert.equal(classifier(Buffer.from('GET / HTTP/1.1')), 'http');
    assert.equal(classifier(Buffer.from('GEX /')), 'reject');
    assert.equal(classifier(Buffer.from([0x16, 0x03])), 'reject');
  }
});

for (const direct of [false, true]) test(`same public port keeps ${direct ? 'direct' : 'proxied'} Web HTTP/WS separate from authenticated SSH native Host proxy`, { timeout: 30_000 }, async () => {
  const host = identity(), user = identity(), wrong = identity();
  const listeners = new Set(); let status = { state: 'idle' };
  const statuses = new Set();
  const adapter = {
    subscribeMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    subscribeStatus(fn) { statuses.add(fn); return () => statuses.delete(fn); },
    get status() { return status; },
    async connect() { status = { state: 'open' }; for (const fn of statuses) fn(status); },
    async close() { status = { state: 'closed' }; for (const fn of statuses) fn(status); },
    async send(frame) { const value = JSON.parse(frame); for (const fn of listeners) fn(JSON.stringify({ id: value.id, result: { echoed: value.method }, __opencraftClient: value.__opencraftClient })); },
  };
  const appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: 'server', createTransport: () => adapter });
  const native = await createSshNativeRpcGateway(appHost, { connectTimeoutMs: 1000 });
  const backendHttp = createServer((_req, res) => res.end('private-headless'));
  const staticHttp = createServer((req, res) => { res.setHeader('x-observed-local-port', String(req.socket.localPort)); res.end('web:' + req.headers['x-forwarded-for']); });
  const webSockets = new WebSocketServer({ server: staticHttp });
  webSockets.on('connection', socket => socket.on('message', data => socket.send('web:' + data)));
  const backendPort = await listen(backendHttp), webPort = await listen(staticHttp);
  const backend = createSshHttpIngress({ hostKey: host.privateKey, authorizedKeys: { fixture: [user.publicKey] }, httpPort: backendPort, codexPort: native.port });
  const backendAddress = await backend.listen({ port: 0 });
  const ingress = createProtocolIngress({ httpPort: webPort, ...(direct ? {httpServer: staticHttp} : {}), sshTarget: `http://127.0.0.1:${backendAddress.port}` });
  const publicAddress = await ingress.listen({ port: 0 });
  const clients = [];
  const ssh = async (key, username = 'fixture') => {
    const client = new ssh2.Client(); clients.push(client);
    const ready = new Promise((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); });
    client.connect({ host: '127.0.0.1', port: publicAddress.port, username, privateKey: key, readyTimeout: 1500,
      hostVerifier: value => value.equals(ssh2.utils.parseKey(host.privateKey).getPublicSSH()) });
    await ready; return client;
  };
  try {
    assert.equal((await get(publicAddress.port, '/')).body, 'web:undefined');
    const observedPort = await new Promise((resolve, reject) => {
      const req = request({hostname:'127.0.0.1',port:publicAddress.port,path:'/'}, res => { res.resume();res.once('end',()=>resolve(Number(res.headers['x-observed-local-port']))); });
      req.once('error',reject);req.end();
    });
    assert.equal(observedPort, direct ? publicAddress.port : webPort);
    const publicWs = new WebSocket(`ws://127.0.0.1:${publicAddress.port}/apphost`);
    await once(publicWs, 'open');
    const echoed = once(publicWs, 'message'); publicWs.send('synthetic-frame');
    assert.equal((await echoed)[0].toString(), 'web:synthetic-frame');
    publicWs.terminate();
    // Fragmented protocol bytes and forwarded header are passed unchanged, without adding trusted identity.
    const socket = connect(publicAddress.port, '127.0.0.1'); let response = '';
    socket.on('data', data => response += data);
    await once(socket, 'connect'); socket.write('G'); socket.write('ET / HTTP/1.1\r\nHost: fixture\r\nX-Forwarded-For: synthetic-peer\r\nConnection: close\r\n\r\n');
    await once(socket, 'close'); assert.match(response, /web:synthetic-peer/);
    await assert.rejects(ssh(wrong.privateKey), /authentication/);
    await assert.rejects(ssh(user.privateKey, 'other'), /authentication/);
    const client = await ssh(user.privateKey);
    await assert.rejects(new Promise((resolve, reject) => client.exec('sh', error => error ? reject(error) : resolve())), /Unable to exec/);
    const stream = await new Promise((resolve, reject) => client.exec('codex app-server proxy', (error, channel) => error ? reject(error) : resolve(channel)));
    const ws = new WebSocket('ws://127.0.0.1/rpc', { createConnection: () => stream });
    await once(ws, 'open');
    const message = once(ws, 'message'); ws.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }));
    assert.equal(JSON.parse((await message)[0].toString()).result.echoed, 'initialize');
    ws.terminate();
  } finally {
    for (const client of clients) client.destroy();
    for (const socket of webSockets.clients) socket.terminate();
    await new Promise(resolve => webSockets.close(resolve));
    await ingress.close(); await backend.close(); await native.close(); await appHost.close();
    await Promise.all([new Promise(resolve => staticHttp.close(resolve)), new Promise(resolve => backendHttp.close(resolve))]);
  }
});

for (const warm of [false,true]) test(`SSH initialize and collaboration receipts bypass a blocked history writer; native warm=${warm}`, {timeout:12000}, async t=>{
  const {ConversationHistoryTransport}=await import('../../packages/app-host-server/src/conversation-history-transport.ts');
  const hostKey=ssh2.utils.generateKeyPairSync('ed25519'),userKey=ssh2.utils.generateKeyPairSync('ed25519');
  let release;const blocked=new Promise(resolve=>release=resolve),observed=[],listeners=new Set();
  let discovery={userAgent:'fixture',capabilities:{extensions:{'opencraft/read-history':{exactResult:true,turnConfigurationObservation:true}}}},allowed=true;
  const context={sender:{kind:'employee',loginName:'synthetic'},actorContext:{actorId:'synthetic',generation:1,credentialId:null,expiresAt:Date.now()+60000},
    resourceOwner:{id:'synthetic',assertCurrent(){if(!allowed)throw Error('revoked');}}};
  const engine={status:{state:'open'},async connect(){},async close(){},subscribeStatus(){return()=>{};},subscribeMessage(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async send(frame){const request=JSON.parse(frame);if(request.id===undefined)return;
      const result=request.method==='initialize'?discovery:{action:request.params.action,synthetic:true};
      if(request.params?.revoke===true)allowed=false;
      for(const fn of listeners)fn(JSON.stringify({id:request.id,result,__opencraftClient:request.__opencraftClient}));},
    async sendWithContext(frame,proof){if(JSON.parse(frame).id!==undefined)assert.equal(proof.actorContext?.actorId,'synthetic');await this.send(frame);}};
  const history={scope:'synthetic',subscribeCommitted(){return()=>{};},initialization(value){if(value)discovery=value;return discovery;},
    async observe(_method,params){await blocked;observed.push(params.sequence);},async revision(){return 0;},async hasThreads(){return true;},
    async importResult(method,params){assert.ok(method==='initialize'||method==='opencraft/collaboration'&&params.action==='read','control receipts never enter history imports');return true;}};
  const transport=new ConversationHistoryTransport(engine,history);
  const appHost=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport:()=>transport});
  const http=createServer((_q,res)=>res.end('fixture'));const httpPort=await listen(http);
  let scoped;
  const ingress=createSshHttpIngress({hostKey:hostKey.private,authorizedKeys:{legacy:[hostKey.public]},httpPort,codexPort:1,
    resolveAuthorizedKeys:username=>username==='synthetic'?[userKey.public]:[],
    authorizeSession:()=>({submissionContext:context,isCurrent:()=>true}),
    createNativeSession:async authorization=>scoped=await createSshNativeRpcGateway(appHost,authorization)});
  const address=await ingress.listen({port:0});const client=new ssh2.Client();client.on('error',()=>{});
  t.after(async()=>{release();client.destroy();await ingress.close();await scoped?.close();await appHost.close();await new Promise(resolve=>http.close(resolve));});
  const ready=once(client,'ready');client.connect({host:'127.0.0.1',port:address.port,username:'synthetic',privateKey:userKey.private});await ready;
  const stream=await new Promise((resolve,reject)=>client.exec('codex app-server proxy',(error,stream)=>error?reject(error):resolve(stream)));stream.on('error',()=>{});
  const ws=new WebSocket('ws://127.0.0.1/rpc',{createConnection:()=>stream});ws.on('error',()=>{});await once(ws,'open');
  const rpc=(id,method,params={})=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.off('message',receive);reject(Error(`RPC ${id} blocked by unrelated history`));},2500);
    const receive=raw=>{const packet=JSON.parse(raw.toString());if(packet.id===id){clearTimeout(timer);ws.off('message',receive);resolve(packet);}};
    ws.on('message',receive);ws.send(JSON.stringify({id,method,params}));
  });
  assert.ok((await rpc(1,'initialize')).result);
  if(warm)assert.ok((await rpc(2,'opencraft/collaboration',{action:'servers'})).result);
  for(const fn of listeners)for(const sequence of [1,2])fn(JSON.stringify({method:'item/completed',params:{threadId:'synthetic',sequence}}));
  const servers=await rpc(3,'opencraft/collaboration',{action:'servers'});
  assert.ok(servers.result,JSON.stringify(servers.error));assert.equal(servers.result.action,'servers');
  for(const action of ['lookup','send','exactResult','turnConfigurationObservation']){
    const receipt=await rpc(action,'opencraft/collaboration',{action});assert.equal(receipt.result?.action,action);
  }
  const exactNative=await rpc('native-exact','opencraft/turn-result/read',{threadId:'synthetic',turnId:'target',output:false,cursor:null});assert.equal(exactNative.result?.synthetic,true);
  const configurationNative=await rpc('native-configuration','opencraft/turn-configuration/read',{threadId:'synthetic',turnId:'target'});assert.equal(configurationNative.result?.synthetic,true);
  let contentReturned=false;
  const content=rpc(6,'opencraft/collaboration',{action:'read'}).then(result=>{contentReturned=true;return result;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(contentReturned,false,'content reads keep the original history barrier');
  const revoked=await rpc(5,'opencraft/collaboration',{action:'lookup',revoke:true});
  assert.ok(revoked.error);assert.equal(revoked.result,undefined,'revoked authority cannot publish a successful receipt');
  assert.deepEqual(observed,[],'control replies finish before blocked content writes');
  release();await content;await transport.close();assert.deepEqual(observed,[1,2],'accepted content still drains in order');
  ws.terminate();
});

test('exact read transport deadline preserves read-unavailable while authority rejection does not',async()=>{
  const {ConversationHistoryTransport}=await import('../../packages/app-host-server/src/conversation-history-transport.ts');
  const listeners=new Set(),frames=[];let discovery={capabilities:{extensions:{'opencraft/read-history':{exactResult:true,turnConfigurationObservation:true}}}};
  const engine={status:{state:'open'},async connect(){},async close(){},subscribeStatus(){return()=>{};},subscribeMessage(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async send(frame){const req=JSON.parse(frame);if(req.id===undefined)return;const result=req.method==='initialize'?discovery:{matched:true,complete:true};
      const reply=()=>{for(const fn of listeners)fn(JSON.stringify({id:req.id,result,__opencraftClient:req.__opencraftClient}));};
      if(req.method==='opencraft/turn-result/read')setTimeout(reply,80);else reply();},async sendWithContext(frame){await this.send(frame);}};
  const history={scope:'deadline',subscribeCommitted(){return()=>{};},initialization(value){if(value)discovery=value;return discovery;},async hasThreads(){return false;}};
  const transport=new ConversationHistoryTransport(engine,history,()=>{},15);transport.subscribeMessage(frame=>frames.push(JSON.parse(frame)));
  try{
    await transport.connect();
    await transport.send(JSON.stringify({id:1,method:'initialize',params:{}}));
    await transport.send(JSON.stringify({id:2,method:'opencraft/turn-result/read',params:{threadId:'thread',turnId:'turn',output:false,cursor:null}}));
    assert.equal(frames.find(m=>m.id===2)?.error?.data?.code,'HISTORY_READ_UNAVAILABLE');
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(frames.filter(m=>m.id===2&&m.result).length,0,'late source reply cannot turn the deadline into public success');
    await transport.sendWithContext(JSON.stringify({id:3,method:'opencraft/turn-result/read',params:{threadId:'thread',turnId:'turn',output:false,cursor:null}}),{sender:null,resourceOwner:{id:'denied',assertCurrent(){throw Error('synthetic authority denied');}}});
    assert.ok(frames.find(m=>m.id===3)?.error,'authority rejection remains an error');
    assert.notEqual(frames.find(m=>m.id===3)?.error?.data?.code,'HISTORY_READ_UNAVAILABLE','do not reclassify arbitrary authority/storage errors as a read timeout');
  }finally{await transport.close();}
});

for (const stored of [false,true]) test(`exact read initialization deadline remains unavailable; cached discovery=${stored}`,async()=>{
  const {ConversationHistoryTransport}=await import('../../packages/app-host-server/src/conversation-history-transport.ts');
  const frames=[];let reads=0;
  const discovery={capabilities:{extensions:{'opencraft/read-history':{exactResult:true,turnConfigurationObservation:true}}}};
  const engine={status:{state:'open'},async connect(){},async close(){},subscribeStatus(){return()=>{};},subscribeMessage(){return()=>{};},
    async send(frame){if(JSON.parse(frame).method==='opencraft/turn-result/read')reads++;},async sendWithContext(frame){await this.send(frame);}};
  const history={scope:'init-deadline',subscribeCommitted(){return()=>{};},initialization(){return stored?discovery:null;},async hasThreads(){return false;}};
  const transport=new ConversationHistoryTransport(engine,history,()=>{},15);transport.subscribeMessage(frame=>frames.push(JSON.parse(frame)));
  try{
    await transport.connect();await transport.send(JSON.stringify({id:1,method:'initialize',params:{}}));
    if(stored) await transport.send(JSON.stringify({id:2,method:'opencraft/turn-result/read',params:{threadId:'thread',turnId:'turn',output:false,cursor:null}}));
    assert.equal(frames.find(m=>m.id===(stored?2:1))?.error?.data?.code,'HISTORY_READ_UNAVAILABLE');
    assert.equal(reads,0,'failed initialization cannot dispatch the target read or any input');
  }finally{await transport.close();}
});

for(const method of ['opencraft/turn-configuration/read','opencraft/thread-context/read'])test(method+' deadline cancels only the owned history read and old Host is unsupported',async()=>{
 const {ConversationHistoryTransport}=await import('../../packages/app-host-server/src/conversation-history-transport.ts');
 const frames=[],listeners=new Set(),sent=[];let capable=true;
 const discovery=()=>({capabilities:{extensions:{'opencraft/read-history':{turnConfigurationObservation:capable,contextUsage:capable}}}});
 const engine={status:{state:'open'},async connect(){},async close(){},subscribeStatus(){return()=>{};},subscribeMessage(fn){listeners.add(fn);return()=>listeners.delete(fn);},
  async send(frame){const request=JSON.parse(frame);sent.push(request);if(request.method==='initialize')for(const fn of listeners)fn(JSON.stringify({id:request.id,result:discovery(),__opencraftClient:request.__opencraftClient}));},async sendWithContext(frame){await this.send(frame);}};
 const history={scope:'configuration-deadline',subscribeCommitted(){return()=>{};},initialization(){return discovery();},async hasThreads(){return false;}};
 const transport=new ConversationHistoryTransport(engine,history,()=>{},15);transport.subscribeMessage(frame=>frames.push(JSON.parse(frame)));
 try{
  await transport.connect();await transport.send(JSON.stringify({id:1,method:'initialize',params:{}}));
  await transport.send(JSON.stringify({id:2,method,params:{threadId:'thread',...(method==='opencraft/turn-configuration/read'?{turnId:'turn'}:{})}}));
  assert.equal(frames.find(m=>m.id===2)?.error?.data?.code,'HISTORY_READ_UNAVAILABLE');
  const read=sent.find(m=>m.method===method),cancel=sent.find(m=>m.method==='thread/history/cancel');
  assert.equal(cancel?.params.historyReadId,read?.params.historyReadId);assert.equal(cancel?.params.threadId,'thread');assert.equal(sent.some(m=>['turn/start','thread/resume'].includes(m.method)),false);
  capable=false;await transport.send(JSON.stringify({id:3,method,params:{threadId:'thread',...(method==='opencraft/turn-configuration/read'?{turnId:'turn'}:{})}}));assert.equal(frames.find(m=>m.id===3)?.error?.code,-32601);
 }finally{await transport.close();}
});
