import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { selectorFixture } from '../fixtures/server-selector';
import { parseServerPaths, selectionIdentity } from '../../apps/relay-server/src/selection';
import { parseServerContext } from '../../apps/workbench-web/src/runtime/server-context';

const serverPaths = { aliases: { join: 'main', lighthouse: 'research' }, defaultServer: 'join' };
test('routing policy separates public labels from immutable instance identity', () => {
  assert.deepEqual(parseServerPaths(serverPaths), serverPaths);
  for (const value of [null, [], { extra: true }, { defaultServer: '..' }, { aliases: [] },
    { aliases: { one: 'team', two: 'team' } }, { aliases: { one: 'two', two: 'other' } },
    { aliases: { one: 'A' } }, { aliases: { one: '../team' } }]) assert.throws(() => parseServerPaths(value));
  const context = { id: 'stable-id', name: 'Team', basePath: '/servers/research', selectorPath: '/servers' };
  assert.equal(parseServerContext(JSON.stringify(context))?.id, 'stable-id');
  assert.equal(parseServerContext(JSON.stringify({ ...context, basePath: '' }))?.basePath, '');
  for (const basePath of ['/servers/..', '/servers/.', '/servers/research/extra', '//other', '/different/research'])
    assert.throws(() => parseServerContext(JSON.stringify({ ...context, basePath })));
});

test('default root and named routes preserve target roles, streaming, cookies and sockets', async t => {
  const f = await selectorFixture({ serverPaths, sshPublicAccess: true }); t.after(() => f.close());
  const cookie = await f.login('alice'), bob = await f.login('bob'), carol = await f.login('carol');
  const chooser = await (await f.get('/servers', { cookie })).text();
  assert.match(chooser, /data-server="join" href="\/servers\/main\/"/u);
  assert.match(chooser, /data-server="lighthouse" href="\/servers\/research\/"/u);
  assert.match(await (await f.get('/', { cookie, accept: 'text/html' })).text(), /initial="join"/u);
  const doc = await f.get('/servers/main/settings/servers?retained=one%2Ftwo', { cookie, accept: 'text/html' });
  assert.equal(doc.status, 200); const html = await doc.text();
  assert.match(html, /"id":"join".*"basePath":""/u);
  assert.ok(html.includes('history.replaceState(history.state,"","/settings/servers?retained=one%2Ftwo"+location.hash)'));
  assert.ok(html.includes('localStorage.setItem("opencraft.last-server.v1:' + selectionIdentity(f.principals.alice!) + '","join")'));
  const root = await f.get('/settings/servers', { cookie, accept: 'text/html' });
  assert.equal(root.status, 200); assert.equal(root.headers.get('location'), null);
  assert.match(await root.text(), /"basePath":""/u);
  const draft = await f.get('/?hostId=local&draftId=retained', { cookie, accept: 'text/html' });
  assert.equal(draft.status, 200); assert.match(await draft.text(), /opencraft-server-context/u);
  const named = await f.get('/servers/research/', { cookie, accept: 'text/html' });
  assert.equal(named.status, 200); assert.match(await named.text(), /"id":"lighthouse".*"basePath":"\/servers\/research"/u);
  assert.equal((await (await f.get('/__opencraft_access/session', { cookie })).json()).role, 'admin');
  assert.equal((await (await f.get('/servers/research/__opencraft_access/session', { cookie })).json()).role, 'member');
  assert.equal((await f.get('/servers/research/__opencraft_access/session', { cookie: bob })).status, 403);
  assert.equal((await f.get('/__opencraft_access/session', { cookie: carol })).status, 403);
  assert.equal((await f.get('/settings/servers', { cookie, accept: 'text/html', origin: 'http://evil.test' })).status, 403);
  assert.equal((await f.get('/servers/lighthouse/__opencraft_access/session', { cookie })).status, 404, 'configured labels are the public route keys');
  const stream = await f.get('/fixture/stream', { cookie });
  assert.equal(await stream.text(), 'first\nlast\n');
  const set = stream.headers.getSetCookie()[0]!; assert.match(set, /Path=\/;/u);
  const ownCookie = set.split(';')[0]!, headers = { cookie: cookie + '; ' + ownCookie };
  assert.equal((await (await f.get('/fixture/headers', headers)).json()).cookie, 'private-target=not-shared');
  assert.equal((await (await f.get('/servers/research/fixture/headers', headers)).json()).cookie, null);
  const bytes = Buffer.from('request body remains on the selected target');
  const upload = await f.get('/servers/research/fixture/upload', { cookie, origin: f.origin }, 'POST', bytes);
  assert.equal(upload.status, 200); assert.equal((await upload.json()).size, bytes.length);
  for (const path of ['/desktop/connect', '/servers/research/desktop/connect']) {
    const ws = new WebSocket(f.base.replace('http:', 'ws:') + path, { headers: { host: f.host, cookie }, origin: f.origin });
    t.after(() => ws.terminate()); const message = once(ws, 'message'); await once(ws, 'open');
    assert.equal((await message)[0].toString(), path.startsWith('/servers/') ? 'connected-lighthouse' : 'connected-join');
  }
  for (const [base, referer, origin] of [['', '/settings/servers', f.origin],
    ['/servers/research', '/servers/research/settings/servers', 'http://lighthouse.selection.test:' + new URL(f.origin).port]]) {
    const grant = await f.get(base + '/__opencraft_ssh/session', { cookie, origin: f.origin, 'content-type': 'application/json' }, 'POST', Buffer.from('{}'));
    assert.equal(grant.status, 200); const sshCookie = grant.headers.getSetCookie()[0]!.split(';')[0]!;
    const session = await f.get(base + '/__opencraft_ssh/session', { cookie: cookie + '; ' + sshCookie, referer: f.origin + referer });
    assert.equal((await session.json()).authenticatedOrigin, origin);
  }
});
