import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, scryptSync } from 'node:crypto';
import { openManagedDatabase } from '@opencraft/sqlite-node';
import { parsePrincipal } from '@opencraft/identity-core';
import { LocalAccountServerPlugin } from '../../plugins/local-account/src/server';
import { createNodePasswordHasher } from '../../plugins/local-account/src/password-hash-node';
import { createPortablePasswordHasher } from '../../plugins/local-account/src/password-hash-portable';
import { ARGON2ID_PARAMETERS, formatArgon2id, parseArgon2id, storedPasswordShape, UNKNOWN_ACCOUNT_PASSWORD, type PasswordHasher } from '../../plugins/local-account/src/password-hash';
import { ActorStore } from '../../packages/access-control/src/actors';
import { HumanAccounts } from '../../packages/access-control/src/human-accounts';
import { HumanAuth } from '../../packages/access-control/src/human-auth';
import { humanAuthFixture } from '../support/human-auth-fixture';
import { openServerCoreOwner } from '@opencraft/storage-node/server-owner';
import { MembershipStore } from '@opencraft/access-control';
import { IdentityWrites, type IdentityWriteOwner } from '@opencraft/access-control/identity-writes';
import { createCommitFenceBuffer } from '@opencraft/access-control/commit-fence';
import type { LocalAccountRepository } from '@opencraft/identity-core/local-account';

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
  const next = new LocalAccountServerPlugin(f.accounts.localAccountRepository, createNodePasswordHasher());
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
  plugin = new LocalAccountServerPlugin(accounts.localAccountRepository, createNodePasswordHasher()); accounts.registerLocalAccounts(plugin);
  assert.equal(accounts.outcome.status, 'up-to-date');
  assert.equal(accounts.outcome.appliedVersion, 1);
  assert.equal(accounts.authenticate(token)?.context.actorId, actor.actorId);
  const proof = await plugin.verify('Alice', password);
  assert.equal(proof?.subject, principal.subject);
  assert.equal(accounts.issue(proof!).login.context.actorId, actor.actorId);
  // No storage owner commits upgrades here: the scrypt record is kept and keeps verifying.
  assert.equal(accounts.localAccountRepository.byId(principal.subject)?.passwordDigest, digest);
  assert.equal(accounts.localAccountRepository.byId(principal.subject)?.version, 7);
  assert.throws(() => accounts!.issue(plugin!.identity('alice')!), /verification/, 'operator lookup is not password authentication');
});

const scryptRecord = (secret: string, salt = 'f'.repeat(64)) =>
  ({ salt, passwordDigest: scryptSync(secret, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }).toString('hex') });
const legacyAccount = (f: { accounts: { localAccountRepository: LocalAccountRepository } }, username: string, version = 3) => {
  const id = crypto.randomUUID();
  f.accounts.localAccountRepository.insert({ id, username, displayName: username, ...scryptRecord(password), enabled: true, version });
  return id;
};

test('new accounts and password changes store Argon2id PHC records that both runtimes verify', async t => {
  const f = await humanAuthFixture(t);
  const created = await f.localAccounts.create('alice', 'Alice', password);
  const record = f.accounts.localAccountRepository.byId(created.subject)!;
  assert.equal(record.salt, '');
  assert.equal(storedPasswordShape(record), 'argon2id');
  assert.deepEqual(parseArgon2id(record.passwordDigest)?.parameters, ARGON2ID_PARAMETERS);
  const portable = createPortablePasswordHasher(), node = createNodePasswordHasher();
  assert.deepEqual(await portable.verify(password, record), { ok: true, needsRehash: false });
  const fromPortable = { salt: '', passwordDigest: await portable.hash(password) };
  assert.deepEqual(await node.verify(password, fromPortable), { ok: true, needsRehash: false });
  assert.deepEqual(await node.verify(password + 'x', fromPortable), { ok: false, needsRehash: false });
  await f.localAccounts.resetPassword('alice', password + '-next');
  const changed = f.accounts.localAccountRepository.byId(created.subject)!;
  assert.equal(changed.version, record.version + 1);
  assert.equal(storedPasswordShape(changed), 'argon2id');
  assert.notEqual(parseArgon2id(changed.passwordDigest)!.salt.join(), parseArgon2id(record.passwordDigest)!.salt.join(), 'fresh salt');
  assert.equal(await f.localAccounts.verify('alice', password), null);
  assert.equal((await f.localAccounts.verify('alice', password + '-next'))?.subject, created.subject);
});

/** Headless shape: the Server owner Worker commits login upgrades; this thread reads the same database. */
async function ownerFixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'opencraft-local-upgrade-'));
  const identityFence = createCommitFenceBuffer();
  const storage = await openServerCoreOwner<IdentityWriteOwner>(directory, {
    entry: new URL('../../apps/headless-server/src/server-core-worker.mjs', import.meta.url), data: { identityFence } });
  const actors = new ActorStore(storage);
  const accounts = new HumanAccounts(storage, actors);
  const members = new MembershipStore(storage);
  const writes = new IdentityWrites(storage.call, actors, accounts, identityFence, members);
  const localAccounts = new LocalAccountServerPlugin(accounts.localAccountRepository, createNodePasswordHasher());
  accounts.registerLocalAccounts(localAccounts);
  localAccounts.useOwnerWrites(writes);
  t.after(async () => {
    writes.close(); members.close(); accounts.close(); actors.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { accounts, localAccounts, writes };
}

test('without a storage owner a proven scrypt record is kept and keeps verifying', async t => {
  const f = await humanAuthFixture(t);
  const id = legacyAccount(f, 'legacy');
  const before = f.accounts.localAccountRepository.byId(id)!;
  assert.equal((await f.localAccounts.verify('legacy', password))?.subject, id);
  assert.deepEqual(f.accounts.localAccountRepository.byId(id), before);
});

test('a scrypt record upgrades to Argon2id on login only; wrong passwords never rewrite it', async t => {
  const f = await ownerFixture(t);
  const id = legacyAccount(f, 'legacy');
  const before = f.accounts.localAccountRepository.byId(id)!;
  assert.equal(storedPasswordShape(before), 'scrypt');
  assert.equal(await f.localAccounts.verify('legacy', 'wrong-passphrase-value'), null);
  assert.deepEqual(f.accounts.localAccountRepository.byId(id), before, 'wrong password leaves the record');
  f.accounts.localAccountRepository.setEnabled(id, false);
  const disabled = f.accounts.localAccountRepository.byId(id)!;
  assert.equal(await f.localAccounts.verify('legacy', password), null);
  assert.deepEqual(f.accounts.localAccountRepository.byId(id), disabled, 'disabled account is not upgraded');
  f.accounts.localAccountRepository.setEnabled(id, true);
  const version = f.accounts.localAccountRepository.byId(id)!.version;
  const proof = await f.localAccounts.verify('legacy', password);
  assert.equal(proof?.subject, id);
  const after = f.accounts.localAccountRepository.byId(id)!;
  assert.equal(after.salt, '');
  assert.equal(storedPasswordShape(after), 'argon2id');
  assert.equal(after.version, version, 'upgrade is not a password change');
  assert.ok(f.accounts.issue(proof!), 'proof from the upgrading login is still current');
  assert.equal((await f.localAccounts.verify('legacy', password))?.subject, id, 'old password still works');
  assert.equal(f.accounts.localAccountRepository.byId(id)!.passwordDigest, after.passwordDigest, 'current record is not rehashed again');
});

test('a weaker Argon2id record is upgraded; a stronger one is kept', async t => {
  const f = await ownerFixture(t);
  const hasher = createNodePasswordHasher();
  // A record written with weaker parameters than today's (derived directly with node:crypto).
  const { argon2Sync } = await import('node:crypto') as any;
  const tag = argon2Sync('argon2id', { message: Buffer.from(password), nonce: Buffer.alloc(16, 7), parallelism: 1, tagLength: 32, memory: 4096, passes: 1 });
  const weakRecord = { salt: '', passwordDigest: formatArgon2id({ parameters: { m: 4096, t: 1, p: 1 }, salt: new Uint8Array(16).fill(7), tag: new Uint8Array(tag) }) };
  assert.deepEqual(await hasher.verify(password, weakRecord), { ok: true, needsRehash: true });
  const id = crypto.randomUUID();
  f.accounts.localAccountRepository.insert({ id, username: 'weak', displayName: 'weak', ...weakRecord, enabled: true, version: 1 });
  assert.equal((await f.localAccounts.verify('weak', password))?.subject, id);
  assert.deepEqual(parseArgon2id(f.accounts.localAccountRepository.byId(id)!.passwordDigest)?.parameters, ARGON2ID_PARAMETERS);
  const strongTag = argon2Sync('argon2id', { message: Buffer.from(password), nonce: Buffer.alloc(16, 9), parallelism: 1, tagLength: 32, memory: 32768, passes: 3 });
  const strong = formatArgon2id({ parameters: { m: 32768, t: 3, p: 1 }, salt: new Uint8Array(16).fill(9), tag: new Uint8Array(strongTag) });
  assert.deepEqual(await hasher.verify(password, { salt: '', passwordDigest: strong }), { ok: true, needsRehash: false });
});

test('a password change during a login upgrade is never overwritten', async t => {
  const f = await ownerFixture(t);
  const id = legacyAccount(f, 'racer');
  const pending = f.localAccounts.verify('racer', password);
  // Another writer changes the password while the old one is being verified and rehashed.
  const replacement = { salt: '', passwordDigest: await createNodePasswordHasher().hash('replacement-passphrase') };
  assert.ok(f.accounts.localAccountRepository.updatePassword(id, replacement.salt, replacement.passwordDigest));
  assert.equal(await pending, null, 'the login proved a superseded password');
  const stored = f.accounts.localAccountRepository.byId(id)!;
  assert.equal(stored.passwordDigest, replacement.passwordDigest);
  assert.equal(stored.version, 4);
  // The owner's compare-and-set refuses a stale expectation outright, and applies a current one without a version bump.
  const stale = { version: 3, ...scryptRecord(password) };
  assert.equal(await f.writes.upgradeLocalPassword(id, stale, '', 'x'), false);
  assert.equal(await f.writes.upgradeLocalPassword(id, { ...stored, version: 3 }, '', 'x'), false);
  assert.equal(f.accounts.localAccountRepository.byId(id)!.passwordDigest, replacement.passwordDigest);
  f.accounts.localAccountRepository.setEnabled(id, false);
  assert.equal(await f.writes.upgradeLocalPassword(id, { ...stored, version: 5 }, '', 'x'), false, 'disabled accounts are not upgraded');
  f.accounts.localAccountRepository.setEnabled(id, true);
  const reenabled = f.accounts.localAccountRepository.byId(id)!;
  assert.equal(await f.writes.upgradeLocalPassword(id, reenabled, reenabled.salt, reenabled.passwordDigest), true);
  assert.equal(f.accounts.localAccountRepository.byId(id)!.version, reenabled.version);
  assert.equal((await f.localAccounts.verify('racer', 'replacement-passphrase'))?.subject, id);
});

test('a failed owner upgrade never changes the login result', async t => {
  const f = await humanAuthFixture(t);
  const id = legacyAccount(f, 'unlucky');
  const before = f.accounts.localAccountRepository.byId(id)!;
  let attempts = 0;
  f.localAccounts.useOwnerWrites({ upgradeLocalPassword: async () => { attempts++; throw new Error('owner unavailable'); } });
  assert.equal((await f.localAccounts.verify('unlucky', password))?.subject, id);
  assert.equal(attempts, 1);
  assert.deepEqual(f.accounts.localAccountRepository.byId(id), before);
  f.localAccounts.useOwnerWrites({ upgradeLocalPassword: async () => { attempts++; return false; } });
  assert.equal((await f.localAccounts.verify('unlucky', password))?.subject, id, 'a refused compare-and-set is not a login failure');
  assert.equal(await f.localAccounts.verify('unlucky', 'wrong-passphrase-value'), null);
  assert.equal(attempts, 2, 'wrong passwords never reach the owner');
});

test('unknown users pay one Argon2id derivation; the concurrency limit covers every derivation', async t => {
  const f = await humanAuthFixture(t);
  const calls: string[] = [];
  const node = createNodePasswordHasher();
  const counting: PasswordHasher = {
    hash: async secret => { calls.push('hash'); return node.hash(secret); },
    verify: async (secret, record) => { calls.push(record === UNKNOWN_ACCOUNT_PASSWORD ? 'verify-unknown' : 'verify'); return node.verify(secret, record); },
  };
  const plugin = new LocalAccountServerPlugin(f.accounts.localAccountRepository, counting);
  t.after(() => plugin.close());
  assert.equal(await plugin.verify('nobody-here', password), null);
  assert.equal(await plugin.verify('!!invalid name', password), null);
  assert.deepEqual(calls, ['verify-unknown', 'verify-unknown']);
  assert.equal(storedPasswordShape(UNKNOWN_ACCOUNT_PASSWORD), 'argon2id');
  assert.deepEqual(parseArgon2id(UNKNOWN_ACCOUNT_PASSWORD.passwordDigest)?.parameters, ARGON2ID_PARAMETERS);
  legacyAccount(f, 'limited');
  const [first, second, third] = [plugin.verify('limited', password), plugin.verify('nobody', password), plugin.verify('nobody', password)];
  await assert.rejects(third, /Password verification unavailable/u);
  assert.ok(await first);
  assert.equal(await second, null);
  await assert.rejects(plugin.verify('nobody', 'x'.repeat(1025)), /Password verification unavailable/u);
});

test('PHC parsing rejects malformed, non-canonical and oversized records without deriving them', async () => {
  const salt = 'c2FsdHNhbHRzYWx0c2FsdA', tag = 'A'.repeat(43);
  const good = `$argon2id$v=19$m=19456,t=2,p=1$${salt}$${tag}`;
  assert.ok(parseArgon2id(good));
  for (const bad of [
    good.replace('argon2id', 'argon2i'), good.replace('v=19', 'v=16'), good.replace('m=19456', 'm=065536'),
    good.replace('m=19456', 'm=65537'), good.replace('m=19456', 'm=4294967295'), good.replace('t=2', 't=11'), good.replace('p=1', 'p=5'),
    good.replace('m=19456,t=2,p=1', 'm=8,t=1,p=2'), good.replace('m=19456', 'm=19456 '), good.replace(',t=2', ''),
    good.replace(salt, 'c2FsdA'), good.replace(salt, salt + '='), good.replace(salt, 'A'.repeat(87)), good.replace(tag, 'A'.repeat(42) + 'B'),
    good.replace(tag, tag + '$'), good + '$extra', good.replace(salt, salt.replace('c', '-')), '$argon2id$' + 'x'.repeat(300), '',
  ]) assert.equal(parseArgon2id(bad), null, bad);
  assert.equal(storedPasswordShape({ salt: 'not-empty', passwordDigest: good }), 'invalid', 'PHC records carry their salt inline');
  assert.equal(storedPasswordShape({ salt: '', passwordDigest: 'a'.repeat(64) }), 'invalid', 'scrypt records always had a salt');
  assert.equal(storedPasswordShape({ salt: 'x', passwordDigest: 'A'.repeat(64) }), 'invalid');
  const hasher = createPortablePasswordHasher();
  assert.deepEqual(await hasher.verify(password, { salt: '', passwordDigest: good.replace('m=19456', 'm=1000000') }), { ok: false, needsRehash: false });
  await assert.rejects(hasher.verify(password, scryptRecord(password)), /Legacy password record unsupported/u);
});
