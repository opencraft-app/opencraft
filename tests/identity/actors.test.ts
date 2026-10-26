import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';
import { ActorStore } from "../../packages/access-control/src/actors";
import { ActorAccess } from "../../packages/access-control/src/actor-access";
import { InstanceAccess, MembershipStore } from "../../packages/access-control/src/index";
import { parsePrincipal } from "../../packages/identity-core/src/index";
import { FixtureRequestIdentity, signedFixtureIdentity as signed } from "../fixtures/request-identity";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { releaseFixture } from "../support/web-deployment-fixture.mjs";
import { createManagedWebServer } from "../../scripts/web-deployment/server.mjs";
import { buildHeadlessBundle } from "../../scripts/package-headless-linux.mjs";
import { fileURLToPath, pathToFileURL } from 'node:url';

const cleanups = new WeakMap<object, Array<() => unknown>>();
function cleanup(t: any, close: () => unknown) {
  let stack = cleanups.get(t);
  if (!stack) {
    stack = []; cleanups.set(t, stack);
    t.after(async () => {
      const errors = [];
      for (const dispose of stack!.reverse()) { try { await dispose(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, 'Actor test cleanup failed');
    });
  }
  stack.push(close);
}

const human = (subject = '123', displayName = 'employee.one', expiresAt = Date.now() + 60_000) =>
  parsePrincipal({ provider: 'fixture', subject, displayName, expiresAt });
async function fixture(t: any, now?: () => number) {
  const dir = await mkdtemp(join(tmpdir(), 'opencraft-actors-'));
  cleanup(t, () => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'actors.sqlite');
  const store = new ActorStore(path, now);
  cleanup(t, () => store.close());
  return { dir, path, store };
}

test('trusted Human registration subscribers run after commit and do not replay on login, rename or binding', async t => {
  const { store, path } = await fixture(t);
  const seen: string[] = [];
  const unsubscribe = store.onHumanRegistered((principal, context) => {
    const reader = new DatabaseSync(path, { readOnly: true });
    try { assert.ok(reader.prepare('SELECT 1 FROM actors WHERE id=?').get(context.actorId), 'actor is committed before notification'); }
    finally { reader.close(); }
    assert.equal(principal.subject, '123'); seen.push(context.actorId);
  });
  assert.equal(store.resolveHuman(human('expired', 'expired', Date.now() - 1)), null);
  const first = store.resolveHuman(human())!;
  store.resolveHuman(human('123', 'renamed'));
  store.bindHuman(first, human('second-binding'));
  assert.deepEqual(seen, [first.actorId]);
  unsubscribe(); store.resolveHuman(human('new-after-unsubscribe'));
  assert.equal(seen.length, 1);
});

test('human identity survives rename and restart; provider scope and aliases cannot merge actors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'actor-restart-')); cleanup(t, () => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'actors.sqlite');
  let store = new ActorStore(path);
  const first = store.resolveHuman(human())!;
  const authority = store.authority;
  assert.match(first.actorId, /^human:\/\//);
  assert.equal(store.resolveHuman(human('123', 'renamed'))!.actorId, first.actorId);
  assert.equal(store.get(first.actorId)!.displayName, 'renamed');
  assert.notEqual(store.resolveHuman(human('456', 'renamed'))!.actorId, first.actorId);
  assert.notEqual(store.resolveHuman({ ...human(), provider: 'other', aliases: ['123'] })!.actorId, first.actorId);
  store.close(); store = new ActorStore(path); cleanup(t, () => store.close());
  assert.equal(store.authority, authority);
  assert.equal(store.resolveHuman(human())!.actorId, first.actorId);
  assert.equal(store.resolveHuman(human('777', 'expired', Date.now() - 1)), null);
  assert.equal(store.list().length, 3);
});

test('Session owns its credential, never inherits creator grants; exact resources/actions and live revoke', async t => {
  const { store } = await fixture(t);
  const creator = store.resolveHuman(human())!;
  const target = store.createSession('target', 'local-operator').id;
  store.setGrant(creator.actorId, target, 'send', true, 'local-operator');
  const session = store.createSession('worker', creator.actorId);
  const credential = store.issueCredential(session.id, Date.now() + 60_000, creator.actorId);
  const context = store.authenticateSession(credential.token)!;
  assert.match(session.id, /^session:\/\//);
  assert.equal(session.createdBy, creator.actorId);
  assert.equal(store.can(creator, target, 'send'), true);
  assert.equal(store.can(context, target, 'send'), false);
  store.setGrant(session.id, target, 'send', true, 'local-operator');
  assert.equal(store.can(context, target, 'send'), true);
  assert.equal(store.can(context, target + '/child', 'send'), false);
  assert.equal(store.can(context, target, 'control'), false);
  assert.throws(() => store.setGrant(session.id, 'session://foreign/target', 'send', true, 'local-operator'));
  store.setGrant(session.id, target, 'send', false, 'local-operator');
  assert.equal(store.can(context, target, 'send'), false);
  assert.equal(store.authenticateSession(credential.token + 'a'), null);
  assert.throws(() => store.issueCredential(creator.actorId, Date.now() + 1000, 'local-operator'));
  store.revokeCredential(credential.credentialId, creator.actorId);
  assert.equal(store.authenticateSession(credential.token), null);
  assert.equal(store.isCurrent(context), false);
  assert.equal(JSON.stringify(store.audit()).includes(credential.token), false);
});

test('expiry and disable/re-enable fence contexts; new credential retains Session identity', async t => {
  let now = Date.now();
  const { store } = await fixture(t, () => now);
  const owner = store.resolveHuman(human())!;
  const s = store.createSession('worker', owner.actorId);
  const c = store.issueCredential(s.id, now + 1000, owner.actorId);
  assert.ok(store.authenticateSession(c.token));
  now += 1000; assert.equal(store.authenticateSession(c.token), null);
  const c2 = store.issueCredential(s.id, now + 60_000, owner.actorId);
  const context = store.authenticateSession(c2.token)!;
  store.setEnabled(s.id, false, owner.actorId);
  assert.equal(store.isCurrent(context), false);
  store.setEnabled(s.id, true, owner.actorId);
  assert.equal(store.authenticateSession(c2.token), null);
  assert.equal(store.get(s.id)!.id, s.id);
  const c3 = store.issueCredential(s.id, now + 60_000, owner.actorId);
  assert.ok(store.authenticateSession(c3.token));
  store.setEnabled(owner.actorId, false, 'local-operator');
  assert.equal(store.resolveHuman(human()), null, 'login never resurrects a disabled human');
  store.setEnabled(owner.actorId, true, 'local-operator');
  assert.equal(store.isCurrent(owner), false, 'old human context is fenced too');
  assert.ok(store.resolveHuman(human()));
});

test('credentials survive reopen, are audience-bound, and plaintext never enters database/WAL', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'actor-durable-')); cleanup(t, () => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'actors.sqlite'); let store = new ActorStore(path);
  const s = store.createSession('durable', 'local-operator');
  const credential = store.issueCredential(s.id, Date.now() + 60_000, 'local-operator');
  for (const suffix of ['', '-wal']) {
    const bytes = await readFile(path + suffix).catch(() => Buffer.alloc(0));
    assert.equal(bytes.includes(Buffer.from(credential.token)), false);
    assert.equal(bytes.includes(Buffer.from(credential.token.split('.').at(-1)!)), false);
  }
  store.close(); store = new ActorStore(path); cleanup(t, () => store.close());
  assert.equal(store.authenticateSession(credential.token)!.actorId, s.id);
  const other = new ActorStore(join(dir, 'other.sqlite')); cleanup(t, () => other.close());
  assert.equal(other.authenticateSession(credential.token), null);
  const changed = credential.token.split('.'); changed[1] = other.authority;
  assert.equal(other.authenticateSession(changed.join('.')), null);
});

test('schema checksum drift fails closed without destroying Actor identities', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'actor-schema-')); cleanup(t, () => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'actors.sqlite'); const store = new ActorStore(path);
  const id = store.createSession('keep', 'local-operator').id; store.close();
  const db = new DatabaseSync(path);
  db.exec("UPDATE schema_migrations SET checksum='changed' WHERE version=1"); db.close();
  assert.throws(() => new ActorStore(path));
  const read = new DatabaseSync(path, { readOnly: true }); cleanup(t, () => read.close());
  assert.equal(read.prepare('SELECT id FROM actors').get()!.id, id);
});

async function serverFixture(t: any, protectedInstance = false) {
  const { store, dir } = await fixture(t);
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Actors</title>');
  const oa = new FixtureRequestIdentity(); cleanup(t, () => oa.close());
  const members = new MembershipStore(join(dir, 'members.sqlite')); cleanup(t, () => members.close());
  const verifier = oa.identityProvider();
  members.set(human(), 'admin', true, 'local-operator');
  const access = new ActorAccess(store, { authenticateHuman: r => verifier.authenticate(r),
    admitted: p => !protectedInstance || members.role(p) !== null, administrator: p => members.role(p) === 'admin' });
  const web = await createWorkbenchWebServer({ root: dir, appServerTarget: null, actorService: access,
    ...(protectedInstance ? { accessService: new InstanceAccess(members, [verifier]) } : {}), onAppHostDiagnostic() {},
    desktopAccess: 'trusted-internal', desktopService: { accept(ws: WebSocket) { ws.send('connected'); } } });
  cleanup(t, () => web.close());
  const address = await web.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const call = (path: string, headers = {}, body?: unknown) => fetch(origin + path, {
    headers: { ...(body !== undefined ? { origin, 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  return { store, members, access, origin, call, dir };
}

test('real HTTP verifies provider human and Session through same me API; rejects spoofing, ambiguity and legacy HTTP/WS', async t => {
  const { store, origin, call } = await serverFixture(t);
  assert.equal((await call('/')).status, 200, 'legacy anonymous policy preserved');
  assert.equal((await call('/', signed())).status, 200);
  assert.equal(store.list().filter(a => a.kind === 'human').length, 1, 'normal access registers a verified human');
  assert.equal((await call('/__opencraft_actors/me', { actorId: 'human://forged/123', staffid: '123' })).status, 401);
  const me = await (await call('/__opencraft_actors/me', signed())).json() as any;
  assert.equal(me.actor.kind, 'human');
  const renamed = await (await call('/__opencraft_actors/me', signed(123, 'new.name'))).json() as any;
  assert.equal(me.actor.id, renamed.actor.id);
  const sessionResponse = await call('/__opencraft_actors/sessions', signed(), { displayName: 'my bot' });
  assert.equal(sessionResponse.status, 201); const { actor } = await sessionResponse.json() as any;
  const credentialResponse = await call('/__opencraft_actors/credentials', signed(), { actorId: actor.id, expiresAt: Date.now() + 60_000 });
  assert.equal(credentialResponse.status, 201); const credential = await credentialResponse.json() as any;
  const authorization = { authorization: 'Bearer ' + credential.token };
  const sessionMe = await (await call('/__opencraft_actors/me', authorization)).json() as any;
  assert.equal(sessionMe.actor.id, actor.id);
  assert.equal((await call('/__opencraft_actors/actors', authorization)).status, 403, 'no creator administration inheritance');
  assert.equal((await call('/__opencraft_actors/me', { ...authorization, ...signed() })).status, 401);
  assert.equal((await call('/__opencraft_actors/me', { authorization: authorization.authorization + 'x' })).status, 401);
  assert.equal((await call('/__opencraft_actors/sessions', signed(456), { displayName: 'forged' })).status, 403);
  assert.equal((await call('/__opencraft_actors/sessions', signed(), { displayName: 'x', actorId: actor.id })).status, 400);
  for (const path of ['/', '/__opencraft_access/session', '/__opencraft_speech/capabilities']) assert.equal((await call(path, authorization)).status, 403);
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/apphost', { headers: authorization });
    ws.on('error', () => {}); ws.on('open', () => { ws.close(); reject(new Error('Session entered unscoped WS')); });
    ws.on('unexpected-response', (_, res) => { res.resume(); assert.equal(res.statusCode, 403); resolve(); });
  });
  store.revokeCredential(credential.credentialId, me.actor.id);
  assert.equal((await call('/__opencraft_actors/me', authorization)).status, 401);
});

test('a specifically granted Session can administer Actors; revoking the grant takes effect immediately', async t => {
  const { store, call } = await serverFixture(t, true);
  const s = store.createSession('administrator bot', 'local-operator');
  const credential = store.issueCredential(s.id, Date.now() + 60_000, 'local-operator');
  const headers = { authorization: 'Bearer ' + credential.token };
  assert.equal((await call('/__opencraft_actors/me', headers)).status, 200, 'actor admission is not a human membership');
  assert.equal((await call('/__opencraft_actors/sessions', headers, { displayName: 'child' })).status, 403);
  store.setGrant(s.id, store.managementResource, 'actors.manage', true, 'local-operator');
  assert.equal((await call('/__opencraft_actors/sessions', headers, { displayName: 'child' })).status, 201);
  store.setGrant(s.id, store.managementResource, 'actors.manage', false, 'local-operator');
  assert.equal((await call('/__opencraft_actors/actors', headers)).status, 403);
  assert.equal((await call('/__opencraft_actors/me', signed(456))).status, 401, 'unadmitted human cannot register');
});

test('slow request body cannot retain revoked human administrator authority', async t => {
  const { origin, call, members, store } = await serverFixture(t);
  await call('/__opencraft_actors/me', signed());
  const result = new Promise<number>((resolve, reject) => {
    const req = httpRequest(origin + '/__opencraft_actors/sessions', { method: 'POST', headers: {
      ...signed(), origin, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => {
      res.resume(); resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.write('{"displayName":');
    setTimeout(() => { members.set(human(), 'member', true, 'local-operator'); req.end('"late bot"}'); }, 100);
  });
  assert.equal(await result, 403);
  assert.equal(store.list().filter(a => a.kind === 'session').length, 0);
});

test('managed artifact routes human and Session Actor APIs to core, not its static worker', async t => {
  const { store, origin: backend, dir } = await serverFixture(t, true);
  const fixture = await releaseFixture(join(dir, 'release')); cleanup(t, () => fixture.close());
  const managed = await createManagedWebServer({ initialRelease: fixture.releases.get('1.0.0').packageRoot,
    stateDirectory: join(dir, 'managed'), headlessBackendTarget: backend });
  cleanup(t, () => managed.close());
  const address = await managed.listen({ port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const me = await fetch(origin + '/__opencraft_actors/me', { headers: signed() });
  assert.equal(me.status, 200); assert.equal((await me.json() as any).actor.kind, 'human');
  const s = store.createSession('managed bot', 'local-operator');
  const credential = store.issueCredential(s.id, Date.now() + 60_000, 'local-operator');
  const headers = { authorization: 'Bearer ' + credential.token };
  const bot = await fetch(origin + '/__opencraft_actors/me', { headers });
  assert.equal(bot.status, 200); assert.equal((await bot.json() as any).actor.id, s.id);
  assert.equal((await fetch(origin + '/__opencraft_access/session', { headers })).status, 403);
  assert.equal((await fetch(origin + '/__opencraft_actors/me')).status, 401);
});

test('versioned worker admits Actor APIs when the fixed launcher falls back without knowing the route', async t => {
  const { store, origin: backend, dir } = await serverFixture(t, true);
  const fixture = await releaseFixture(join(dir, 'release')); cleanup(t, () => fixture.close());
  const previousBackend = process.env.OPENCRAFT_HEADLESS_BACKEND_URL;
  process.env.OPENCRAFT_HEADLESS_BACKEND_URL = backend;
  cleanup(t, () => {
    if (previousBackend === undefined) delete process.env.OPENCRAFT_HEADLESS_BACKEND_URL;
    else process.env.OPENCRAFT_HEADLESS_BACKEND_URL = previousBackend;
  });
  // No outer Headless route table: exercise the launcher's generic fallback and
  // the real packaged worker, matching a pre-Actor stable launcher after upgrade.
  const managed = await createManagedWebServer({ initialRelease: fixture.releases.get('1.0.0').packageRoot,
    stateDirectory: join(dir, 'managed') });
  cleanup(t, () => managed.close());
  const address = await managed.listen({ port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const me = await fetch(origin + '/__opencraft_actors/me', { headers: signed() });
  assert.equal(me.status, 200); assert.equal((await me.json() as any).actor.kind, 'human');
  const s = store.createSession('hot-upgraded bot', 'local-operator');
  const credential = store.issueCredential(s.id, Date.now() + 60_000, 'local-operator');
  const headers = { authorization: 'Bearer ' + credential.token };
  const bot = await fetch(origin + '/__opencraft_actors/me', { headers });
  assert.equal(bot.status, 200); assert.equal((await bot.json() as any).actor.id, s.id);
  assert.equal((await fetch(origin + '/__opencraft_actors/me', { headers: { actorId: s.id } })).status, 401);
  assert.equal((await fetch(origin + '/__opencraft_actors/actors', { headers })).status, 403);
  assert.equal((await fetch(origin + '/__opencraft_actors/sessions', { method: 'POST', headers: {
    ...signed(), 'content-type': 'application/json', origin: 'http://foreign.test',
  }, body: JSON.stringify({ displayName: 'forged' }) })).status, 403);
  assert.equal((await fetch(origin + '/__opencraft_access/session', { headers })).status, 403);
  assert.equal((await fetch(origin + '/version.json')).status, 200, 'metadata remains owned by worker/launcher');
  assert.equal((await fetch(origin + '/__opencraft_health')).status, 200, 'worker readiness stays independent');
});

test('revocation during a Session request body is checked at mutation time; split UTF8 names remain intact', async t => {
  const { store, origin, call } = await serverFixture(t);
  const s = store.createSession('delegated', 'local-operator');
  const credential = store.issueCredential(s.id, Date.now() + 60_000, 'local-operator');
  store.setGrant(s.id, store.managementResource, 'actors.manage', true, 'local-operator');
  const result = new Promise<number>((resolve, reject) => {
    const req = httpRequest(origin + '/__opencraft_actors/sessions', { method: 'POST', headers: {
      authorization: 'Bearer ' + credential.token, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => {
      res.resume(); resolve(res.statusCode!);
    });
    req.on('error', reject); req.write('{"displayName":');
    setTimeout(() => { store.revokeCredential(credential.credentialId, 'local-operator'); req.end('"late bot"}'); }, 100);
  });
  assert.equal(await result, 403);
  const bytes = Buffer.from('{"displayName":"中文机器人"}');
  const body = await new Promise<any>((resolve, reject) => {
    const req = httpRequest(origin + '/__opencraft_actors/sessions', { method: 'POST', headers: {
      ...signed(), origin, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject); req.write(bytes.subarray(0, 17));
    setTimeout(() => req.end(bytes.subarray(17)), 30);
  });
  assert.equal(body.actor.displayName, '中文机器人');
  assert.equal((await call('/__opencraft_actors/sessions', { ...signed(), origin: 'http://foreign.test' }, { displayName: 'bad origin' })).status, 403);
});

test('disabled recognized human cannot downgrade to anonymous and its existing socket is revoked', async t => {
  const { store, origin, call } = await serverFixture(t);
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/desktop/connect', { origin, headers: signed() });
  cleanup(t, () => ws.terminate());
  await once(ws, 'message');
  const actor = store.list().find(a => a.kind === 'human')!;
  const closed = once(ws, 'close');
  store.setEnabled(actor.id, false, 'local-operator');
  const [code] = await closed; assert.ok([1006, 1008].includes(code as number));
  assert.equal((await call('/', signed())).status, 403);
  assert.equal((await call('/__opencraft_actors/me', signed())).status, 401);
  assert.equal((await call('/')).status, 200, 'explicitly shared anonymous mode is still not resource isolation');
});

test('actual Headless bundle wires generic identity admission and durable Session credentials across restart', async t => {
  const runtime = fileURLToPath(new URL("../../.runtime/", import.meta.url)); await mkdir(runtime, { recursive: true });
  const dir = await mkdtemp(join(runtime, 'actor-artifact-')); cleanup(t, () => rm(dir, { recursive: true, force: true }));
  const bundle = join(dir, 'server.mjs'); await buildHeadlessBundle(bundle);
  const { startHeadlessServer } = await import(pathToFileURL(bundle).href);
  const webRoot = join(dir, 'web'); await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Actor artifact</title>');
  await writeFile(join(webRoot, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'actor-test', headlessServer: true, headlessHostId: 'opencraft-server' }));
  const dataDirectory = join(dir, 'data');
  const members = new MembershipStore(join(dataDirectory, 'memberships.sqlite'));
  members.set(human(), 'admin', true, 'local-operator'); members.close();
  const options = { root: dir, webRoot, dataDirectory, port: 0, accessControl: true,
    machineName: 'Synthetic Actor Host',
    // Only the engine is a substitute; bundle, HTTP, identity admission and SQLite are real.
    startAgentHost: async () => ({ websocketUrl: 'ws://127.0.0.1:9/rpc', async close() {} }) };
  const composition = { createIdentity: async () => { const identity = new FixtureRequestIdentity(); return { providers: [identity.identityProvider()], service: identity, close: () => identity.close() }; } };
  let app = await startHeadlessServer(options, composition); cleanup(t, () => app.close());
  const call = (path: string, headers = {}, body?: unknown) => fetch(app.url + path, {
    headers: { ...headers, ...(body === undefined ? {} : { origin: app.url, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  assert.equal((await call('/__opencraft_actors/me')).status, 401);
  const first = await (await call('/__opencraft_actors/me', signed())).json() as any;
  const created = await (await call('/__opencraft_actors/sessions', signed(), { displayName: 'durable bot' })).json() as any;
  const credential = await (await call('/__opencraft_actors/credentials', signed(), { actorId: created.actor.id, expiresAt: Date.now() + 60_000 })).json() as any;
  assert.ok(credential.token, 'credential issued through real Headless wiring');
  await app.close(); app = await startHeadlessServer(options, composition);
  const after = await (await call('/__opencraft_actors/me', signed(123, 'new.name'))).json() as any;
  assert.equal(after.actor.id, first.actor.id);
  const bot = await (await call('/__opencraft_actors/me', { authorization: 'Bearer ' + credential.token })).json() as any;
  assert.equal(bot.actor.id, created.actor.id);
  const health = await (await call('/__opencraft_health')).json() as any;
  assert.equal(health.ok, true);
});

test('a Web entry without an Actor authority does not serve HTML as a successful identity response', async t => {
  const { dir } = await fixture(t);
  await writeFile(join(dir, 'index.html'), '<!doctype html>Shared static entry');
  const web = await createWorkbenchWebServer({ root: dir, appServerTarget: null }); cleanup(t, () => web.close());
  const address = await web.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`http://127.0.0.1:${address.port}/__opencraft_actors/me`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'missing' });
});

test('statistics authority follows current human instance role, never management grants or Session proofs', async t => {
  const {store}=await fixture(t);
  const principal=human();let administrator=false,admitted=true,current=true;
  const access=new ActorAccess(store,{authenticateHuman:request=>request.headers.cookie==='verified-human'?principal:null,
    admitted:()=>admitted,administrator:()=>administrator,isHumanCurrent:()=>current});
  const request={headers:{cookie:'verified-human'}};
  const actor=access.authenticate(request)!;
  assert.deepEqual(access.usageAuthority(request),{actorId:actor.actorId,administrator:false});
  store.setGrant(actor.actorId,store.managementResource,'actors.manage',true,'local-operator');
  assert.equal(access.manages(request,actor),true);
  assert.equal(access.usageAuthority(request)?.administrator,false,'actors.manage is not statistics team authority');
  administrator=true;assert.equal(access.usageAuthority(request)?.administrator,true);
  administrator=false;assert.equal(access.usageAuthority(request)?.administrator,false,'role downgrade is observed on an existing connection');
  current=false;assert.equal(access.usageAuthority(request),null);current=true;
  admitted=false;assert.equal(access.usageAuthority(request),null);admitted=true;
  const session=store.createSession('machine','local-operator');const credential=store.issueCredential(session.id,Date.now()+60000,'local-operator');
  assert.equal(access.usageAuthority({headers:{authorization:'Bearer '+credential.token}}),null,'a Session cannot become a human dashboard viewer');
  store.setEnabled(actor.actorId,false,'local-operator');assert.equal(access.usageAuthority(request),null);
});
