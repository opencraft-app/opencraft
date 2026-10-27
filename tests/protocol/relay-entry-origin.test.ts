import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { selectorFixture } from '../fixtures/server-selector';

test('request-local entry origins keep login, callback, session, writes and WebSockets on the visiting host', async t => {
  const f = await selectorFixture({serverPaths:{defaultServer:'join'},entryOrigin: req => ['one.entry.test','two.entry.test'].includes(req.headers.host ?? '') ? 'http://' + req.headers.host : null});
  t.after(() => f.close());
  const login = async (host: string) => {
    const start = await f.get('/chat?id=42',{host,accept:'text/html'}); assert.equal(start.status,303);
    const challenge = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const loginUrl = new URL(start.headers.get('location')!); assert.equal(loginUrl.origin,'http://' + host);
    assert.equal((await f.get(loginUrl.pathname+loginUrl.search,{host:host === 'one.entry.test' ? 'two.entry.test':'one.entry.test','x-fixture-user':'alice'})).status,403);
    const verified = await f.get(loginUrl.pathname+loginUrl.search,{host,'x-fixture-user':'alice'}); assert.equal(verified.status,303);
    const callback = new URL(verified.headers.get('location')!); assert.equal(callback.origin,loginUrl.origin);
    assert.equal((await f.get(callback.pathname+callback.search,{host:f.host,cookie:challenge})).status,403);
    const session = await f.get(callback.pathname+callback.search,{host,cookie:challenge}); assert.equal(session.status,303);
    assert.equal(session.headers.get('location'),'http://' + host + '/chat?id=42');
    assert.equal((await f.get(callback.pathname+callback.search,{host,cookie:challenge})).status,403,'single-use ticket');
    return session.headers.getSetCookie().find(c=>c.startsWith('opencraft-relay-session='))!.split(';')[0]!;
  };
  const [one,two] = await Promise.all([login('one.entry.test'),login('two.entry.test')]);
  for (const [host,cookie] of [['one.entry.test',one],['two.entry.test',two]] as const) {
    const page = await f.get('/?chat=42',{host,cookie,accept:'text/html'}); assert.equal(page.status,200); assert.match(await page.text(),/opencraft-server-context/u);
    const access = await f.get('/servers/lighthouse/__opencraft_access/session',{host,cookie}); assert.equal(access.status,200); assert.equal((await access.json()).role,'member');
    const headers = await f.get('/servers/lighthouse/fixture/headers',{host,cookie,origin:'http://' + host}); assert.equal(headers.status,200); assert.equal((await headers.json()).origin,'http://lighthouse.selection.test:' + new URL(f.origin).port,'target keeps its signed origin');
    assert.equal((await f.get('/fixture/headers',{host,cookie,origin:'http://' + host},'POST')).status,200);
    assert.equal((await f.get('/fixture/headers',{host,cookie,origin:'http://evil.test'},'POST')).status,403);
  }
  assert.equal((await f.get('/fixture/headers',{host:'two.entry.test',cookie:one})).status,401,'copied cookie is bound to its browser origin');
  assert.equal((await f.get('/fixture/headers',{host:'evil.test',cookie:one})).status,403);
  assert.equal((await f.get('/__opencraft_relay/logout',{host:'one.entry.test',cookie:two,origin:'http://one.entry.test'},'POST')).status,204);
  assert.equal((await f.get('/fixture/headers',{host:'two.entry.test',cookie:two})).status,200,'logout cannot revoke a session belonging to another origin');
  const socket = new WebSocket(f.base.replace('http:','ws:') + '/servers/lighthouse/desktop/connect',{headers:{host:'one.entry.test',cookie:one,origin:'http://one.entry.test'}});
  t.after(()=>socket.terminate()); const first = once(socket,'message'); await once(socket,'open'); assert.equal(String((await first)[0]),'connected-lighthouse');
  const echoed = once(socket,'message'); socket.send('same-entry'); assert.equal(String((await echoed)[0]),'same-entry'); socket.close();
  assert.equal((await f.get('/__opencraft_relay/logout',{host:'one.entry.test',cookie:one,origin:'http://one.entry.test'},'POST')).status,204);
  assert.equal((await f.get('/fixture/headers',{host:'one.entry.test',cookie:one})).status,401);
  assert.equal((await f.get('/fixture/headers',{host:'two.entry.test',cookie:two})).status,200);
});


test('alias documents without a default path still forward under the enrolled target scope', async t => {
  const f = await selectorFixture({entryOrigin:req=>req.headers.host==='alias.entry.test'?'http://alias.entry.test':null});
  t.after(()=>f.close()); const host='alias.entry.test';
  const start=await f.get('/chat/42',{host,accept:'text/html'}),login=new URL(start.headers.get('location')!);
  const verified=await f.get(login.pathname+login.search,{host,'x-fixture-user':'alice'}),callback=new URL(verified.headers.get('location')!);
  const session=await f.get(callback.pathname+callback.search,{host,cookie:start.headers.getSetCookie()[0]!.split(';')[0]!});
  const cookie=session.headers.getSetCookie().find(c=>c.startsWith('opencraft-relay-session='))!.split(';')[0]!;
  assert.equal((await f.get('/fixture/headers',{host,cookie})).status,200);
  assert.equal((await f.get('/servers',{host,cookie})).status,200);
});
