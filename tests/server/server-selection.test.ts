import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { selectorFixture, waitFor } from '../fixtures/server-selector';
import { scopedHtml, selectedPath, scopedCookies, targetCookies, parseSelectionDefaults, selectionIdentity, selectionDefault } from '../../apps/relay-server/src/selection';

test('same-origin selection retains target authority, including users who cannot access entry instance',async t=>{
  const f=await selectorFixture();t.after(()=>f.close());
  const alice=await f.login('alice'),bob=await f.login('bob'),carol=await f.login('carol');
  for(const [cookie,expected] of [[alice,['join','lighthouse']],[bob,['join']],[carol,['lighthouse']]] as const){
    const page=await f.get('/servers',{cookie});assert.equal(page.status,200);const html=await page.text();
    const ids=[...html.matchAll(/data-server="([^"]+)"/gu)].map(m=>m[1]);assert.deepEqual(ids,expected);
  }
  const a=await f.get('/servers/join/__opencraft_access/session',{cookie:alice});assert.equal((await a.json()).role,'admin');
  const b=await f.get('/servers/lighthouse/__opencraft_access/session',{cookie:alice});assert.equal((await b.json()).role,'member');
  assert.equal((await f.get('/servers/lighthouse/__opencraft_access/audit',{cookie:alice})).status,403);
  assert.equal((await f.get('/servers/lighthouse/__opencraft_access/session',{cookie:bob})).status,403);
  assert.equal((await f.get('/servers/lighthouse/__opencraft_access/audit',{cookie:carol})).status,200);
  assert.equal((await f.get('/servers/join/__opencraft_access/session',{cookie:carol})).status,403);
  const context=await f.get('/servers/lighthouse/',{cookie:alice,accept:'text/html'});const html=await context.text();
  assert.equal(context.status,200);assert.match(html,/<base href="\/servers\/lighthouse\/">/u);assert.match(html,/id="opencraft-server-context"/u);
  assert.ok(html.includes('localStorage.setItem("opencraft.last-server.v1:'+selectionIdentity(f.principals.alice!)+'","lighthouse")'));
  assert.doesNotMatch(html,/login:alice/u);
  const background=await f.get('/servers/join/fixture/compressed.html',{cookie:alice,accept:'application/json'});
  assert.doesNotMatch(await background.text(),/localStorage.setItem/u);
  const chooser=await(await f.get('/servers',{cookie:alice})).text();
  assert.doesNotMatch(chooser,/localStorage.setItem/u,'chooser does not commit a target before successful navigation');
  const compressed=await f.get('/servers/lighthouse/fixture/compressed.html',{cookie:alice,accept:'text/html','accept-encoding':'gzip'});
  assert.equal(compressed.headers.get('content-encoding'),null);assert.match(await compressed.text(),/opencraft-server-context/u);
  const sanitized=await f.get('/servers/lighthouse/fixture/headers',{cookie:alice+'; opencraft.account.session=do-not-share',origin:f.origin,'x-opencraft-relay-assertion':'forged','staffid':'carol'});
  assert.deepEqual(await sanitized.json(),{id:'lighthouse',cookie:null,assertion:true,origin:'http://lighthouse.selection.test:'+new URL(f.origin).port});
  assert.equal((await f.get('/servers/lighthouse/__opencraft_access/session',{'x-fixture-user':'alice','x-opencraft-relay-assertion':'forged'})).status,401);
  assert.equal((await f.get('/servers/lighthouse/fixture/headers',{cookie:alice,origin:'http://evil.test'})).status,403);
  for(const path of ['/__opencraft_updates','/a/../__opencraft_updates','/%5f_opencraft_updates','/__opencraft_relay/control','/servers/join/'])assert.equal((await f.get('/servers/lighthouse'+path,{cookie:alice})).status,403,path);
  assert.equal((await f.get('/servers/unknown/',{cookie:alice,accept:'text/html'})).headers.get('location'),'/servers');
});

test('selected targets preserve streaming and retire only the revoked target socket',async t=>{
  const f=await selectorFixture();t.after(()=>f.close());const cookie=await f.login('alice');
  const bytes=randomBytes(4*1024*1024),uploaded=await f.get('/servers/lighthouse/fixture/upload',{cookie,origin:f.origin},'POST',bytes);
  assert.deepEqual(await uploaded.json(),{size:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')});
  const stream=await f.get('/servers/lighthouse/fixture/stream',{cookie}),reader=stream.body!.getReader();
  assert.equal(Buffer.from((await reader.read()).value!).toString(),'first\n');assert.match(stream.headers.getSetCookie()[0]!,/Path=\/servers\/lighthouse\/; HttpOnly/u);
  const targetCookie=stream.headers.getSetCookie()[0]!.split(';')[0]!;
  const ownCookie=await f.get('/servers/lighthouse/fixture/headers',{cookie:cookie+'; '+targetCookie});assert.equal((await ownCookie.json()).cookie,'private-target=not-shared');
  const otherCookie=await f.get('/servers/join/fixture/headers',{cookie:cookie+'; '+targetCookie});assert.equal((await otherCookie.json()).cookie,null);
  assert.equal(Buffer.from((await reader.read()).value!).toString(),'last\n');await reader.cancel();
  const sockets:WebSocket[]=[];
  for(const id of ['join','lighthouse']){
    const ws=new WebSocket(f.base.replace('http:','ws:')+`/servers/${id}/desktop/connect`,{headers:{host:f.host,cookie},origin:f.origin});sockets.push(ws);t.after(()=>ws.terminate());
    const ready=once(ws,'message');await once(ws,'open');assert.equal((await ready)[0].toString(),'connected-'+id);
    const echoed=once(ws,'message');ws.send(Buffer.from([0,1,255]));assert.deepEqual((await echoed)[0],Buffer.from([0,1,255]));
  }
  const closed=once(sockets[1]!,'close');f.stores[1]!.set(f.principals.alice!,'member',false,'fixture');await closed;
  assert.equal(sockets[0]!.readyState,WebSocket.OPEN);assert.equal((await f.get('/servers/lighthouse/__opencraft_access/session',{cookie})).status,403);
  assert.equal((await f.get('/servers/lighthouse/',{cookie,accept:'text/html'})).headers.get('location'),'/servers');
  const directory=await(await f.get('/servers',{cookie})).text();assert.doesNotMatch(directory,/data-server="lighthouse"/u);
  f.stores[1]!.set(f.principals.alice!,'member',true,'fixture');f.clients[1]!.close();await waitFor(()=>!f.relay.connected('lighthouse'));
  assert.equal((await f.get('/servers/lighthouse/',{cookie,accept:'text/html'})).headers.get('location'),'/servers');
  assert.equal((await f.get('/servers/join/__opencraft_access/session',{cookie})).status,200);
});

test('scope parser and HTML metadata cannot escape the enrolled target',()=>{
  assert.equal(selectedPath('/servers/a')?.path,'/');
  assert.equal(selectedPath('/servers/a?draftId=x')?.path,'/?draftId=x');
  assert.equal(selectedPath('/servers/%2e%2e/'),null);
  assert.equal(selectedPath('/__opencraft_servers/a?draftId=x')?.base,'/__opencraft_servers/a');
  const html=scopedHtml('<html><head><base href="/"><script src="/assets/a.js"></script></head></html>',{id:'a',name:'</script><script>bad()</script>',base:'/servers/a'});
  assert.match(html,/src="\/servers\/a\/assets\/a.js"/u);assert.equal([...html.matchAll(/<base /gu)].length,1);assert.doesNotMatch(html,/bad\(\)<\/script>/u);
  const cookies=scopedCookies(['__Host-owner=secret; Path=/; Secure; HttpOnly; SameSite=Strict; Domain=virtual.test'],'a','/servers/a')!;
  assert.doesNotMatch(cookies[0]!,/Domain=/u);assert.match(cookies[0]!,/^__Host-opencraft-server-.*Path=\/; Secure; HttpOnly; SameSite=Strict/u);
  assert.equal(targetCookies(cookies[0]!.split(';')[0],'a'),'__Host-owner=secret');assert.equal(targetCookies(cookies[0]!.split(';')[0],'b'),undefined);
});

test('old bookmarks become short URLs while old API, upload and sockets remain usable',async t=>{
  const f=await selectorFixture();t.after(()=>f.close());const cookie=await f.login('alice');
  for(const [path,location] of [
    ['/__opencraft_servers','/servers'],['/__opencraft_servers/','/servers'],['/servers/','/servers'],
    ['/__opencraft_servers/lighthouse/chat/42?draftId=kept','/servers/lighthouse/chat/42?draftId=kept'],
  ]) {
    const response=await f.get(path!,{cookie,accept:'text/html'});
    assert.equal(response.status,308);assert.equal(response.headers.get('location'),location);
  }
  const session=await f.get('/__opencraft_servers/lighthouse/__opencraft_access/session',{cookie});
  assert.equal(session.status,200);assert.equal((await session.json()).role,'member');
  const bytes=Buffer.from('retained legacy request body');
  const upload=await f.get('/__opencraft_servers/lighthouse/fixture/upload',{cookie,origin:f.origin},'POST',bytes);
  assert.deepEqual(await upload.json(),{size:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')});
  const ws=new WebSocket(f.base.replace('http:','ws:')+'/__opencraft_servers/lighthouse/desktop/connect',{headers:{host:f.host,cookie},origin:f.origin});
  t.after(()=>ws.terminate());const ready=once(ws,'message');await once(ws,'open');assert.equal((await ready)[0].toString(),'connected-lighthouse');
  const echoed=once(ws,'message');ws.send(Buffer.from([0,1,255]));assert.deepEqual((await echoed)[0],Buffer.from([0,1,255]));
  assert.equal((await f.get('/servers/lighthouse/__opencraft_servers/join/',{cookie})).status,403);
  assert.equal((await f.get('/__opencraft_servers/lighthouse/servers/join/',{cookie})).status,403);
});


test('migration defaults are identity scoped hints and do not add membership',async t=>{
  const f=await selectorFixture({defaultUsers:['carol'],legacyDefaultUsers:['alice'],entryName:'OpenCraft'});t.after(()=>f.close());
  for(const [name,hasDefault] of [['alice',true],['bob',false],['carol',true]] as const){
    const cookie=await f.login(name),page=await f.get('/',{cookie,accept:'text/html'}),html=await page.text();
    assert.equal(page.status,200);assert.ok(html.includes('initial='+JSON.stringify(hasDefault?'join':null)));
    assert.equal(html.includes('data-server="join"'),name!=='carol');
    if(name==='alice')assert.match(html,/>OpenCraft<\/a>/u);
  }
  assert.notEqual(selectionIdentity({provider:'one',subject:'same'}),selectionIdentity({provider:'two',subject:'same'}));
  const identity=selectionIdentity({provider:'one',subject:'same'});
  assert.equal(parseSelectionDefaults({schemaVersion:1,defaults:{[identity]:'team-a'}}).get(identity),'team-a');
  for(const value of [null,[],{schemaVersion:2,defaults:{}},{schemaVersion:1,defaults:[]},{schemaVersion:1,defaults:{alice:'a'}},{schemaVersion:1,defaults:{[identity]:'../bad'}},{schemaVersion:1,defaults:{},extra:1}])
    assert.throws(()=>parseSelectionDefaults(value));
});


test('verified legacy aliases provide navigation hints without replacing stable preferences',()=>{
  const p={provider:'generic-provider',subject:'stable-id',aliases:['verified-old-handle']};
  const hints=new Map([[selectionIdentity({provider:p.provider,subject:p.aliases[0]!}),'old-team']]);
  assert.equal(selectionDefault(p,hints),'old-team');
  assert.equal(selectionDefault({...p,aliases:[]},hints),undefined);
  assert.equal(selectionDefault({...p,provider:'different'},hints),undefined);
  hints.set(selectionIdentity(p),'current-team');assert.equal(selectionDefault(p,hints),'current-team');
});


test('relay SSH discovery requires explicit public ingress and reuses its origin-bound grant',async t=>{
  const disabled=await selectorFixture({sshPublicAccess:false});
  try {
    const cookie=await disabled.login('alice');
    assert.equal((await disabled.get('/servers/lighthouse/__opencraft_ssh/session',{cookie})).status,403);
  } finally {await disabled.close();}
  const f=await selectorFixture({sshPublicAccess:true});t.after(()=>f.close());
  const cookie=await f.login('alice'),origin='http://lighthouse.selection.test:'+new URL(f.origin).port;
  const html=await (await f.get('/servers/lighthouse/',{cookie,accept:'text/html'})).text();
  const context=JSON.parse(/id="opencraft-server-context" type="application\/json">([^<]+)/u.exec(html)![1]!);
  assert.equal(context.targetOrigin,origin);
  const grant=await f.get('/servers/lighthouse/__opencraft_ssh/session',{cookie,origin:f.origin,'content-type':'application/json'},'POST',Buffer.from('{}'));
  assert.equal(grant.status,200);
  const targetCookie=grant.headers.getSetCookie()[0]!.split(';')[0]!;
  for(let i=0;i<3;i++) {
    const headers={cookie:cookie+'; '+targetCookie,referer:f.origin+'/servers/lighthouse/chat/42'};
    const session=await f.get('/servers/lighthouse/__opencraft_ssh/session',headers);
    assert.deepEqual(await session.json(),{available:true,authenticated:true,accessMode:'shared',authenticatedOrigin:origin});
    assert.deepEqual(await (await f.get('/servers/lighthouse/__opencraft_ssh/connections',headers)).json(),[]);
  }
  for(const referer of [f.origin+'/servers/join/', 'http://evil.test/servers/lighthouse/']) {
    const session=await f.get('/servers/lighthouse/__opencraft_ssh/session',{cookie:cookie+'; '+targetCookie,referer});
    assert.equal((await session.json()).authenticated,false);
  }
  const other=await f.get('/servers/join/__opencraft_ssh/session',{cookie:cookie+'; '+targetCookie,referer:f.origin+'/servers/join/'});
  assert.equal((await other.json()).authenticated,false);
  assert.equal((await f.get('/servers/lighthouse/__opencraft_ssh/session',{cookie,origin:'http://evil.test'},'POST',Buffer.from('{}'))).status,403);
});


test('unprefixed entry document bookmarks retain their instance and gain selection context',async t=>{
  const f=await selectorFixture();t.after(()=>f.close());const cookie=await f.login('alice');
  const path='/settings/remote-connections?retained=one%2Ftwo';
  const legacy=await f.get(path,{cookie,accept:'text/html'});
  assert.equal(legacy.status,303);
  assert.equal(legacy.headers.get('location'),'/servers/join'+path);
  assert.equal(legacy.headers.get('cache-control'),'private, no-store');
  const scoped=await f.get(legacy.headers.get('location')!,{cookie,accept:'text/html'});
  assert.equal(scoped.status,200);assert.match(await scoped.text(),/opencraft-server-context/u);
  const api=await f.get('/fixture/headers',{cookie,accept:'application/json'});
  assert.equal(api.status,200);assert.equal(api.headers.get('location'),null);assert.equal((await api.json()).id,'join');
  const unadmitted=await f.login('carol');
  assert.equal((await f.get(path,{cookie:unadmitted,accept:'text/html'})).status,403);
  assert.equal((await f.get(path,{cookie,accept:'text/html',origin:'http://evil.test'})).status,403);
});

test('already-scoped dashboard HTML keeps its base and resource paths exactly once',()=>{
  const context={id:'example',name:'Example',base:'/servers/example'};
  const html=scopedHtml('<html><head><base href="/servers/example/__opencraft_observe/grafana/"><script src="/servers/example/__opencraft_observe/grafana/public/app.js"></script><link href="/plain.css"><script src="//cdn.invalid/app.js"></script></head></html>',context);
  assert(html.includes('<base href="/servers/example/__opencraft_observe/grafana/">'));
  assert(html.includes('src="/servers/example/__opencraft_observe/grafana/public/app.js"'));
  assert(html.includes('href="/servers/example/plain.css"'));
  assert(html.includes('src="//cdn.invalid/app.js"'));
  assert(!html.includes('/servers/example/servers/example'));
});
