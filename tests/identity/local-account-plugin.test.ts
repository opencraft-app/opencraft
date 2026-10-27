import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, scryptSync } from 'node:crypto';
import { openManagedDatabase } from '@opencraft/sqlite-node';
import { parsePrincipal } from '@opencraft/identity-core';
import { LocalAccountServerPlugin } from '../../plugins/local-account/src/server';
import { ActorStore } from '../../packages/access-control/src/actors';
import { HumanAccounts } from '../../packages/access-control/src/human-accounts';
import { HumanAuth } from '../../packages/access-control/src/human-auth';
import { humanAuthFixture } from '../support/human-auth-fixture';

const password = 'plugin-fixture-passphrase';

test('two self-hosted deployments own independent same-name accounts and browser sessions', async t => {
  const a = await humanAuthFixture(t), b = await humanAuthFixture(t);
  const pa = await a.localAccounts.create('alice', 'Alice', password);
  const pb = await b.localAccounts.create('alice', 'Alice', password + '-other');
  assert.notEqual(pa.subject, pb.subject);
  assert.equal(await b.localAccounts.verify('alice', password), null);
  assert.equal(await a.localAccounts.verify('alice', password + '-other'), null);
  const login = a.accounts.issue(pa);
  assert.equal(b.accounts.authenticate(login.token), null);
  assert.notEqual(a.actors.findHuman(pa)?.id, b.actors.resolveHuman(pb)?.actorId);
  assert.equal(a.members.actorMembership(login.login.context.actorId), null);
  const session = await (await a.browser().call('/__opencraft_auth/session')).json() as any;
  assert.deepEqual(session.localPlugin, { id: 'opencraft.account', label: '本地账号' });
});

test('deactivation revokes only local logins; missing plugin cannot grant admission or issue proofs', async t => {
  const f = await humanAuthFixture(t), browser = f.browser();
  const local = await f.localAccounts.create('alice', 'Alice', password);
  const localLogin = f.accounts.issue(local);
  const oidc = parsePrincipal({ provider: 'oidc', subject: 'independent-verified-fixture', displayName: 'OIDC fixture', expiresAt: Date.now() + 60_000 });
  f.actors.bindHuman(localLogin.login.context, oidc);
  const oidcLogin = f.accounts.issue(oidc);
  const actorId = localLogin.login.context.actorId;
  f.members.setActor(actorId, 'member', true, 'operator');
  f.deactivateLocal();
  assert.equal(f.accounts.authenticate(localLogin.token), null);
  assert.equal(f.accounts.authenticate(oidcLogin.token)?.context.actorId, actorId);
  assert.throws(() => f.accounts.issue(local), /verification/);
  assert.equal((await browser.call('/')).status, 401);
  assert.equal((await browser.call('/__opencraft_auth/local', { mode: 'login', username: 'alice', password })).status, 404);
  assert.equal((await (await browser.call('/__opencraft_auth/session')).json() as any).local, false);
  assert.throws(() => new HumanAuth(f.accounts, f.actors, f.auth.configuration, () => ''), /plugin required/);
  assert.equal(f.members.actorMembership(actorId)?.enabled, true, 'credential plugin does not own grants');
  const next = new LocalAccountServerPlugin(f.accounts.localAccountRepository);
  const detach = f.accounts.registerLocalAccounts(next);
  try {
    assert.throws(() => f.accounts.issue(local), /verification/, 'retired verifier proof is not reusable');
    assert.equal(f.accounts.authenticate(localLogin.token), null, 'reactivation never resurrects revoked login');
    const fresh = f.accounts.issue((await next.verify('alice', password))!);
    assert.equal(fresh.login.context.actorId, actorId);
    f.deactivateLocal(); // stale disposer cannot deactivate a newer activation
    assert.ok(f.accounts.authenticate(fresh.token));
  } finally { detach(); next.close(); }
});

test('closed plugin fences in-flight password verification and account creation before storage writes', async t => {
  const f = await humanAuthFixture(t);
  await f.localAccounts.create('alice', 'Alice', password);
  const pending = f.localAccounts.verify('alice', password);
  const pendingCreate = f.localAccounts.create('late-user', 'Late', password);
  f.deactivateLocal();
  assert.equal(f.localAccounts.available, false);
  await Promise.all([assert.rejects(pending, /plugin unavailable/), assert.rejects(pendingCreate, /plugin unavailable/)]);
  assert.equal(f.accounts.localAccountRepository.byUsername('late-user'), null);
  assert.equal(f.localAccounts.currentVersion('not-an-account'), null);
  assert.throws(() => f.localAccounts.identity('alice'), /plugin unavailable/);
});

// Frozen pre-plugin v1 SQL, including whitespace: compatibility must not rewrite migration history.
const PRE_PLUGIN_V1 = `
CREATE TABLE local_accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 salt TEXT NOT NULL, password_digest TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), version INTEGER NOT NULL) STRICT;
CREATE TABLE human_logins (digest TEXT PRIMARY KEY, principal TEXT NOT NULL, actor_id TEXT NOT NULL,
 generation INTEGER NOT NULL, account_version INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
CREATE INDEX human_logins_expiry ON human_logins(expires_at);
CREATE TABLE human_identity_labels (binding TEXT PRIMARY KEY, label TEXT NOT NULL) STRICT;
`;

test('pre-plugin v1 password, subject, Actor, checksum and existing browser login survive unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'opencraft-local-plugin-v1-'));
  const actors = new ActorStore(join(directory, 'actors.sqlite'));
  let accounts: HumanAccounts | undefined, plugin: LocalAccountServerPlugin | undefined;
  t.after(async () => { plugin?.close(); accounts?.close(); actors.close(); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, 'human-logins.sqlite');
  const old = openManagedDatabase({ path, legacyPolicy: 'reject', migrations: [{ version: 1, name: 'human-browser-logins', sql: PRE_PLUGIN_V1 }] });
  const salt = 'legacy-fixture-salt', digest = scryptSync(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }).toString('hex');
  const principal = parsePrincipal({ provider: 'local', subject: 'pre-plugin-stable-subject', displayName: 'Existing Alice', expiresAt: Date.now() + 3600_000 });
  const actor = actors.resolveHuman(principal)!;
  const token = 'L'.repeat(43), tokenDigest = createHash('sha256').update(token).digest('hex');
  old.database.prepare('INSERT INTO local_accounts VALUES(?,?,?,?,?,1,7)').run(principal.subject, 'alice', principal.displayName, salt, digest);
  old.database.prepare('INSERT INTO human_logins VALUES(?,?,?,?,?,?,?)').run(tokenDigest, JSON.stringify(principal), actor.actorId, actor.generation, 7, Date.now(), principal.expiresAt);
  old.database.close();
  accounts = new HumanAccounts(path, actors);
  plugin = new LocalAccountServerPlugin(accounts.localAccountRepository); accounts.registerLocalAccounts(plugin);
  assert.equal(accounts.outcome.status, 'up-to-date');
  assert.equal(accounts.outcome.appliedVersion, 1);
  assert.equal(accounts.authenticate(token)?.context.actorId, actor.actorId);
  const proof = await plugin.verify('Alice', password);
  assert.equal(proof?.subject, principal.subject);
  assert.equal(accounts.issue(proof!).login.context.actorId, actor.actorId);
  assert.equal(accounts.localAccountRepository.byId(principal.subject)?.passwordDigest, digest);
  assert.equal(accounts.localAccountRepository.byId(principal.subject)?.version, 7);
  assert.throws(() => accounts!.issue(plugin!.identity('alice')!), /verification/, 'operator lookup is not password authentication');
});
