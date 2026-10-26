import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorStore } from '../../packages/access-control/src/actors';
import { HumanAccounts } from '../../packages/access-control/src/human-accounts';
import { HumanAuth } from '../../packages/access-control/src/human-auth';
import { MembershipStore, InstanceAccess } from '../../packages/access-control/src/index';
import { HumanAccountManagement } from '../../packages/access-control/src/account-management';
import { LocalAccountServerPlugin } from '../../plugins/local-account/src/server';
import { LocalAccountApplication } from '../../plugins/local-account/src/application';
import { humanLoginPage } from '../../scripts/human-login-page';
import { createWorkbenchWebServer } from '../../scripts/serve-workbench-web.mjs';
import { AuthBrowser } from '../support/human-auth-fixture';

const password = 'Only-for-local-synthetic-tests-42';
async function fixture(t: any, directory?: string) {
  const root = directory ?? await mkdtemp(join(tmpdir(), 'account-setup-'));
  const actors = new ActorStore(join(root, 'actors.sqlite')), accounts = new HumanAccounts(join(root, 'human-logins.sqlite'), actors);
  const provider = new LocalAccountServerPlugin(accounts.localAccountRepository); accounts.registerLocalAccounts(provider);
  const members = new MembershipStore(join(root, 'memberships.sqlite'));
  const configuration = { origin: 'http://127.0.0.1', local: true, oidc: [] };
  const auth = new HumanAuth(accounts, actors, configuration, humanLoginPage);
  const management = new HumanAccountManagement(join(root, 'account-onboarding.sqlite'), accounts, actors, members);
  const proof = randomBytes(32).toString('base64url'), nativeProof = randomBytes(32).toString('base64url');
  const application = new LocalAccountApplication({ auth, management, setupToken: proof,
    nativeOwner: request => request.headers['x-test-native-proof'] === nativeProof });
  const access = new InstanceAccess(members, [auth], actors);
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Account fixture</title>');
  const web = await createWorkbenchWebServer({ root, appServerTarget: null, authService: auth,
    accessService: access, accountService: application } as any);
  const address = await web.listen({ host: '127.0.0.1', port: 0 }); configuration.origin = `http://127.0.0.1:${address.port}`;
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await web.close(); application.close(); management.close(); auth.close(); accounts.close(); members.close(); actors.close(); };
  t.after(async () => { await close(); if (!directory) await rm(root, { recursive: true, force: true }); });
  return { root, actors, accounts, provider, members, management, proof, nativeProof, origin: configuration.origin, close,
    browser: () => new AuthBrowser(configuration.origin) };
}
async function initialize(f: Awaited<ReturnType<typeof fixture>>) {
  const browser = f.browser();
  assert.equal((await browser.call('/__opencraft_account/setup', { proof: f.proof, mode: 'web', username: 'owner', password })).status, 200);
  return browser;
}
test('/setup reaches the first-party account plugin before admission, and requires installer proof', async t => {
  const f = await fixture(t), browser = f.browser();
  assert.equal((await browser.call('/')).status, 401);
  assert.equal((await browser.call('/setup')).status, 200);
  assert.equal((await browser.call('/__opencraft_account/setup', { mode: 'web', username: 'owner', password })).status, 403);
  assert.equal((await browser.call('/__opencraft_account/setup', { proof: f.proof, mode: 'desktop' })).status, 400);
  const owner = await initialize(f);
  assert.equal((await owner.call('/')).status, 200);
  assert.equal((await owner.call('/setup')).status, 303);
  assert.equal((await owner.call('/__opencraft_account/setup', { proof: f.proof, mode: 'web', username: 'owner', password })).status, 409);
});
test('parallel setup reserves one credential subject and creates exactly one administrator', async t => {
  const f = await fixture(t), one = f.browser(), two = f.browser();
  const body = { proof: f.proof, mode: 'web', username: 'owner', password };
  const results = await Promise.all([one.call('/__opencraft_account/setup', body), two.call('/__opencraft_account/setup', body)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.actors.list().length, 1); assert.equal(f.accounts.listLocalAccounts().length, 1);
  assert.equal(f.members.listActors().filter(m => m.role === 'admin').length, 1);
});
test('interrupted credential creation resumes after reopening the real stores without duplicate Humans', async t => {
  const f = await fixture(t), original = f.provider.createWithId.bind(f.provider);
  f.provider.createWithId = async (...args) => { await original(...args); throw new Error('Simulated process stop after credential commit'); };
  await assert.rejects(f.management.initialize({ mode: 'web', username: 'owner', password }));
  assert.equal(f.management.status().state, 'pending'); const subject = f.accounts.listLocalAccounts()[0]!.id;
  await f.close(); const resumed = await fixture(t, f.root);
  await assert.rejects(resumed.management.initialize({ mode: 'desktop' }), /resume_original_setup/);
  await assert.rejects(resumed.management.initialize({ mode: 'web', username: 'owner', password: 'Incorrect-test-password-42' }), /account_verification_required/);
  const principal = await resumed.management.initialize({ mode: 'web', username: 'owner', password });
  assert.equal(principal.subject, subject); assert.equal(resumed.actors.list().length, 1);
  assert.equal(resumed.management.status().state, 'complete');
});
test('pre-existing accounts or members close setup and disabling every Human never reopens it', async t => {
  const f = await fixture(t), browser = await initialize(f);
  const human = f.actors.list()[0]!; f.actors.setEnabled(human.id, false, 'fixture');
  assert.equal(f.management.status().state, 'complete');
  assert.equal((await browser.call('/__opencraft_account/setup', { proof: f.proof, mode: 'web', username: 'other', password })).status, 409);
  await f.close(); const resumed = await fixture(t, f.root); assert.equal(resumed.management.status().state, 'complete');
});
test('native desktop initialization and password binding preserve the same Human and administration', async t => {
  const f = await fixture(t), native = f.browser();
  assert.equal((await native.call('/__opencraft_account/setup', { mode: 'desktop' }, { 'x-test-native-proof': f.nativeProof })).status, 200);
  const before = (await (await native.call('/__opencraft_auth/session')).json() as any).actor.id;
  assert.equal((await native.call('/__opencraft_auth/local/create', { mode: 'link', username: 'owner', password })).status, 200);
  const remote = f.browser(); assert.equal((await remote.call('/__opencraft_auth/local', { mode: 'login', username: 'owner', password })).status, 200);
  const after = (await (await remote.call('/__opencraft_auth/session')).json() as any).actor.id;
  assert.equal(after, before); assert.equal(f.members.actorMembership(after)?.role, 'admin'); assert.equal(f.actors.list().length, 1);
  assert.equal((await remote.call('/__opencraft_account/native', {})).status, 403);
});
test('invitations create ordinary members once; member management and account hashes stay private', async t => {
  const f = await fixture(t), owner = await initialize(f);
  const { code } = await (await owner.call('/__opencraft_account/invitations', {})).json() as any;
  const member = f.browser(); assert.equal((await member.call('/__opencraft_account/accept', { code, username: 'member', password })).status, 201);
  assert.equal((await member.call('/')).status, 200);
  assert.equal((await member.call('/__opencraft_account/members')).status, 403);
  assert.equal((await member.call('/__opencraft_account/invitations', {})).status, 403);
  assert.equal((await f.browser().call('/__opencraft_account/accept', { code, username: 'another', password })).status, 410);
  const data = await (await owner.call('/__opencraft_account/members')).text();
  assert.doesNotMatch(data, /password_digest|passwordDigest|"salt"/);
  const actorId = (await (await member.call('/__opencraft_auth/session')).json() as any).actor.id;
  assert.equal((await owner.call('/__opencraft_account/members', { actorId, role: 'member', enabled: false })).status, 200);
  assert.equal((await member.call('/')).status, 403);
});
test('an interrupted invitation cannot acquire a colliding credential created by another operation', async t => {
  const f = await fixture(t), owner = await initialize(f);
  const { code } = await (await owner.call('/__opencraft_account/invitations', {})).json() as any;
  const original = f.provider.createWithId.bind(f.provider); let intercepted = false;
  f.provider.createWithId = async (...args) => {
    if (!intercepted) { intercepted = true; throw new Error('Stopped before account insertion'); }
    return original(...args);
  };
  await assert.rejects(f.management.accept({ code, username: 'member', password }));
  await f.provider.create('member', 'Unrelated Human', password);
  await assert.rejects(f.management.accept({ code, username: 'member', password }), /username_unavailable/);
  assert.equal(f.members.listActors().length, 1);
});
test('same-origin and unknown-field checks happen before account changes', async t => {
  const f = await fixture(t), browser = f.browser();
  assert.equal((await browser.call('/__opencraft_account/setup', { mode: 'web', proof: f.proof, username: 'owner', password }, { origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await browser.call('/__opencraft_account/setup', { mode: 'web', proof: f.proof, username: 'owner', password, actorId: 'injected' })).status, 400);
  assert.equal(f.accounts.listLocalAccounts().length, 0);
});

test('admin revocation during password hashing cannot commit a reset', async t => {
  const f = await fixture(t); await initialize(f);
  const principal = await f.provider.verify('owner', password); assert.ok(principal);
  const context = f.actors.resolveHuman(principal)!;
  const reset = f.management.password(context, 'owner', 'A-different-synthetic-password-42');
  f.members.setActor(context.actorId, 'admin', false, 'revoked-during-hash');
  await assert.rejects(reset, /administrator_required/);
  assert.ok(await f.provider.verify('owner', password));
  assert.equal(await f.provider.verify('owner', 'A-different-synthetic-password-42'), null);
});

test('interrupted invitation cannot restore a membership explicitly revoked before resume', async t => {
  const f = await fixture(t); await initialize(f);
  const owner = f.actors.resolveHuman((await f.provider.verify('owner', password))!)!;
  const { code } = f.management.invite(owner), grant = f.members.setActor.bind(f.members);
  f.members.setActor = (...args) => { grant(...args); throw new Error('Simulated stop after grant'); };
  await assert.rejects(f.management.accept({ code, username: 'member', password }), /Simulated stop/);
  f.members.setActor = grant;
  const human = f.actors.findHuman({ provider: 'local', subject: f.accounts.localAccountRepository.byUsername('member')!.id })!;
  grant(human.id, 'member', false, 'revoked-after-crash');
  await assert.rejects(f.management.accept({ code, username: 'member', password }), /existing_membership/);
  assert.equal(f.members.actorMembership(human.id)?.enabled, false);
});
