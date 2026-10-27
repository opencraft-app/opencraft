import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import WebSocket from 'ws';
import { HumanAccounts } from '../../packages/access-control/src/human-accounts';
import { LocalAccountServerPlugin } from '../../plugins/local-account/src/server';
import { MembershipStore } from '../../packages/access-control/src/index';
import { parseHumanAuthConfiguration } from '../../packages/access-control/src/human-auth';
import { humanAuthFixture, AuthBrowser } from '../support/human-auth-fixture';

const password = 'fixture-passphrase-only';
const local = (browser: AuthBrowser, username = 'alice', mode = 'login') => browser.call('/__opencraft_auth/local', { username, password, mode });

test('local login persists, stores no plaintext, grants no membership; explicit Actor grant works', async t => {
  const f = await humanAuthFixture(t), browser = f.browser();
  const principal = await f.localAccounts.create('Alice', 'Alice', password);
  assert.equal((await browser.call('/')).status, 401);
  assert.equal((await browser.call('/__opencraft_auth/')).status, 200);
  assert.equal((await local(browser)).status, 200);
  assert.equal((await browser.call('/')).status, 403, 'authentication alone grants no membership');
  const id = f.actors.findHuman(principal)!.id;
  f.members.setActor(id, 'admin', true, 'local-operator');
  assert.equal((await browser.call('/')).status, 200);
  assert.equal((await (await browser.call('/__opencraft_actors/me')).json() as any).actor.id, id);
  const reopened = new HumanAccounts(join(f.directory, 'human-logins.sqlite'), f.actors);
  const restoredPlugin = new LocalAccountServerPlugin(reopened.localAccountRepository); reopened.registerLocalAccounts(restoredPlugin);
  try { assert.equal(reopened.authenticate(browser.cookies.get('oc_human')!)!.context.actorId, id); } finally { reopened.close(); }
  for (const suffix of ['', '-wal']) {
    const bytes = await readFile(join(f.directory, 'human-logins.sqlite') + suffix).catch(() => Buffer.alloc(0));
    assert.equal(bytes.includes(Buffer.from(password)), false);
    assert.equal(bytes.includes(Buffer.from(browser.cookies.get('oc_human')!)), false);
  }
  const stranger = f.browser();
  assert.equal((await stranger.call('/__opencraft_auth/local', { username: 'alice', password: 'wrong', mode: 'login' })).status, 401);
  assert.equal((await stranger.call('/__opencraft_auth/local/create', { username: 'attacker', password, mode: 'link' })).status, 401);
});

test('OIDC links to local Actor and preserves grants; later OIDC login resolves that same person', async t => {
  const f = await humanAuthFixture(t), browser = f.browser();
  const p = await f.localAccounts.create('alice', 'Alice', password);
  await local(browser); const actor = f.actors.findHuman(p)!;
  f.members.setActor(actor.id, 'admin', true, 'operator');
  const bot = f.actors.createSession('bot', actor.id);
  f.actors.setGrant(actor.id, bot.id, 'send', true, 'operator');
  const callback = await browser.start('link');
  const completed = await browser.call(callback);
  assert.equal(completed.status, 303); assert.equal(completed.headers.get('location'), '/__opencraft_auth/');
  assert.equal(f.actors.bindings(actor.id).length, 2);
  const after = await (await browser.call('/__opencraft_actors/me')).json() as any;
  assert.equal(after.actor.id, actor.id);
  assert.equal(f.actors.can(f.accounts.authenticate(browser.cookies.get('oc_human')!)!.context, bot.id, 'send'), true);
  await browser.call('/__opencraft_auth/logout', {});
  assert.equal((await browser.call('/')).status, 401);
  const standalone = await browser.start(); await browser.call(standalone);
  assert.equal((await browser.call('/')).status, 200);
  assert.equal((await (await browser.call('/__opencraft_actors/me')).json() as any).actor.id, actor.id);
  assert.equal(f.actors.list().filter(a => a.kind === 'human').length, 1);
  assert.equal((await browser.call(standalone)).status, 400, 'callback cannot be replayed');
});

test('matching profile/email never merges people, and an already-owned identity cannot be linked', async t => {
  const f = await humanAuthFixture(t, false), first = f.browser(), second = f.browser();
  const p = await f.localAccounts.create('alice', 'Example Person', password); await local(first);
  await second.call(await second.start());
  const oidcActor = (await (await second.call('/__opencraft_auth/session')).json() as any).actor.id;
  assert.notEqual(oidcActor, f.actors.findHuman(p)!.id);
  const result = await first.call(await first.start('link'));
  assert.match(result.headers.get('location')!, /error=login_failed/);
  assert.equal(f.actors.bindings(oidcActor).length, 1);
  assert.equal(f.actors.bindings(f.actors.findHuman(p)!.id).length, 1);
});

test('OIDC checks issuer, audience, nonce, expiry and cryptographic signature', async t => {
  const f = await humanAuthFixture(t, false);
  for (const patch of [{ iss: 'https://other.example' }, { aud: 'other-client' }, { nonce: 'wrong' }, { exp: 1 }]) {
    const browser = f.browser(); f.issuer.setClaims(patch);
    const result = await browser.call(await browser.start());
    assert.match(result.headers.get('location')!, /error=login_failed/);
    assert.equal(browser.cookies.has('oc_human'), false);
  }
  f.issuer.setClaims({}); f.issuer.setBadSignature(true);
  const browser = f.browser(), result = await browser.call(await browser.start());
  assert.match(result.headers.get('location')!, /error=login_failed/);
  assert.equal(f.actors.list().length, 0);
});

test('state is browser-bound; wrong state, cancellation and late token response cannot establish login', async t => {
  const f = await humanAuthFixture(t), browser = f.browser(), stranger = f.browser();
  const callback = await browser.start();
  assert.equal((await stranger.call(callback)).status, 400);
  assert.equal((await browser.call(callback.replace(/state=[^&]+/, 'state=wrong'))).status, 400);
  const hold = f.issuer.holdToken(), completing = browser.call(callback);
  await hold.reached;
  await browser.call('/__opencraft_auth/cancel', {}); hold.resume();
  const result = await completing;
  assert.match(result.headers.get('location')!, /error=login_failed/);
  assert.equal(browser.cookies.has('oc_human'), false);
  assert.equal(f.actors.list().length, 0);
});

test('logout during a pending OIDC link fences the original owner before a late token response', async t => {
  const f = await humanAuthFixture(t), browser = f.browser();
  const p = await f.localAccounts.create('alice', 'Alice', password); await local(browser);
  const callback = await browser.start('link'), hold = f.issuer.holdToken(), result = browser.call(callback);
  await hold.reached; await browser.call('/__opencraft_auth/logout', {}); hold.resume();
  assert.match((await result).headers.get('location')!, /error=login_failed/);
  assert.equal(f.actors.bindings(f.actors.findHuman(p)!.id).length, 1);
  assert.equal(browser.cookies.has('oc_human'), false);
});

test('password reset/disable revoke local sessions; logout retires established WebSocket', async t => {
  const f = await humanAuthFixture(t), browser = f.browser();
  const p = await f.localAccounts.create('alice', 'Alice', password); await local(browser);
  f.members.setActor(f.actors.findHuman(p)!.id, 'admin', true, 'operator');
  const ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/desktop/connect', { headers: { cookie: browser.cookie }, origin: f.origin });
  const connected = once(ws, 'message'); await once(ws, 'open'); await connected;
  const closed = once(ws, 'close'); await browser.call('/__opencraft_auth/logout', {});
  const deadline = setTimeout(() => ws.terminate(), 2000); const [code] = await closed; clearTimeout(deadline);
  assert.ok([1006, 1008].includes(code));
  await local(browser); const token = browser.cookies.get('oc_human')!;
  await f.localAccounts.resetPassword('alice', password + '-new'); assert.equal(f.accounts.authenticate(token), null);
  const p2 = await f.localAccounts.verify('alice', password + '-new'); assert.ok(p2);
  const issued = f.accounts.issue(p2!); f.localAccounts.setEnabled('alice', false); f.localAccounts.setEnabled('alice', true);
  assert.equal(f.accounts.authenticate(issued.token), null, 're-enable cannot resurrect previous browser sessions');
  assert.throws(() => f.accounts.issue(p2!), 'a stale password proof cannot mint a new session after reset/re-enable');
});

test('unbind preserves Actor, refuses last identity and fences all old contexts', async t => {
  const f = await humanAuthFixture(t, false), browser = f.browser();
  const p = await f.localAccounts.create('alice', 'Alice', password); await local(browser);
  const id = f.actors.findHuman(p)!.id;
  assert.equal((await browser.call('/__opencraft_auth/unbind', { provider: p.provider, subject: p.subject })).status, 400);
  await browser.call(await browser.start('link'));
  const old = f.accounts.authenticate(browser.cookies.get('oc_human')!)!.context;
  const oidc = f.actors.bindings(id).find(p => p.provider === 'oidc')!;
  assert.equal((await browser.call('/__opencraft_auth/unbind', oidc)).status, 200);
  assert.equal(f.actors.isCurrent(old), false);
  assert.equal(f.actors.findHuman(oidc), null);
  await local(browser); assert.equal((await (await browser.call('/__opencraft_auth/session')).json() as any).actor.id, id);
});

test('same-origin JSON, size limits, bearer separation and attempt budget apply before mutations', async t => {
  const f = await humanAuthFixture(t), browser = f.browser();
  assert.equal((await browser.call('/__opencraft_auth/logout', {}, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await browser.call('/__opencraft_auth/session', undefined, { authorization: 'Bearer oc_actor_v1.forged' })).status, 403);
  assert.equal((await browser.call('/__opencraft_auth/logout', { huge: 'x'.repeat(20_000) })).status, 413);
  for (let n = 0; n < 12; n++) await browser.call('/__opencraft_auth/oidc/start', { provider: 'missing', mode: 'login' });
  assert.equal((await browser.call('/__opencraft_auth/oidc/start', { provider: 'missing', mode: 'login' })).status, 429);
  assert.equal((await browser.call('/__opencraft_auth/logout', {})).status, 200, 'logout and cancellation remain available after throttling');
  assert.equal(f.actors.list().length, 0);
});

test('membership v1 upgrades with grants/audit preserved; canonical Actor revocation wins over legacy grants', async t => {
  const f = await humanAuthFixture(t, false);
  const path = join(f.directory, 'upgrade.sqlite'); let store = new MembershipStore(path);
  const p = await f.localAccounts.create('alice', 'Alice', password);
  store.set(p, 'admin', true, 'operator'); store.close();
  const v1 = new DatabaseSync(path); v1.exec('DROP TABLE actor_members; DELETE FROM schema_migrations WHERE version=2'); v1.close();
  store = new MembershipStore(path);
  assert.equal(store.outcome.appliedVersion, 2); assert.equal(store.role(p), 'admin'); assert.equal(store.audit().length, 1);
  store.close();
  const corrupt = new DatabaseSync(path); corrupt.exec("UPDATE schema_migrations SET checksum='changed' WHERE version=1"); corrupt.close();
  assert.throws(() => new MembershipStore(path));
  const context = f.actors.resolveHuman(p)!;
  f.members.set(p, 'admin', true, 'operator'); assert.equal(f.access.role(p), 'admin');
  f.members.setActor(context.actorId, 'member', false, 'operator'); assert.equal(f.access.role(p), null);
  assert.equal(f.members.role(p), 'admin', 'old grant remains history but cannot restore access');
});

test('authentication configuration rejects insecure remote origins and ambiguous/unknown settings', () => {
  const valid = { origin: 'https://workbench.example', local: true, oidc: [] };
  assert.equal(parseHumanAuthConfiguration(valid).local, true);
  assert.throws(() => parseHumanAuthConfiguration({ ...valid, origin: 'http://workbench.example' }));
  assert.throws(() => parseHumanAuthConfiguration({ ...valid, bootstrapAdmin: true }));
  assert.throws(() => parseHumanAuthConfiguration({ ...valid, local: false }));
  assert.throws(() => parseHumanAuthConfiguration({ ...valid, oidc: [{ id: 'enterprise', label: 'SSO', issuer: 'http://idp.example', clientId: 'client' }] }));
});

test('OIDC-first user can create or bind local credentials without changing Actor; stale cookies cannot become anonymous', async t => {
  const f = await humanAuthFixture(t, false), browser = f.browser();
  await browser.call(await browser.start());
  const id = (await (await browser.call('/__opencraft_auth/session')).json() as any).actor.id;
  assert.equal((await browser.call('/__opencraft_auth/local/create', { username: 'alice', password, mode: 'link' })).status, 200);
  assert.equal(f.actors.bindings(id).length, 2);
  await f.localAccounts.create('second', 'Second local login', password);
  assert.equal((await local(browser, 'second', 'link')).status, 200);
  assert.equal(f.actors.bindings(id).length, 3);
  const old = browser.cookies.get('oc_human')!;
  f.accounts.revoke(old);
  assert.equal((await browser.call('/')).status, 401, 'invalid browser proof is never silently downgraded to anonymous');
  assert.equal((await browser.call('/__opencraft_auth/')).status, 200, 'recovery login page remains available');
  await browser.call('/__opencraft_auth/logout', {});
  assert.equal((await browser.call('/')).status, 200, 'explicit logout restores configured anonymous access');
  await local(browser, 'second');
  assert.equal((await (await browser.call('/__opencraft_auth/session')).json() as any).actor.id, id);
});
