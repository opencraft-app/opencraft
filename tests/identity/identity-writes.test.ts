import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openServerCoreOwner } from "@opencraft/storage-node/server-owner";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { MembershipStore } from "@opencraft/access-control";
import { IdentityWrites, type IdentityWriteOwner } from "@opencraft/access-control/identity-writes";
import { createCommitFenceBuffer } from "@opencraft/access-control/commit-fence";

const entry = new URL("../../apps/headless-server/src/server-core-worker.mjs", import.meta.url);
const principal = (subject: string) => ({
  provider: "oidc",
  subject,
  displayName: subject,
  expiresAt: Date.now() + 3_600_000,
});

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "identity-writes-"));
  const identityFence = createCommitFenceBuffer();
  const storage = await openServerCoreOwner<IdentityWriteOwner>(directory, { entry, data: { identityFence } });
  const actors = new ActorStore(storage);
  const accounts = new HumanAccounts(storage, actors);
  const members = new MembershipStore(storage);
  const writes = new IdentityWrites(storage.call, actors, accounts, identityFence, members);
  t.after(async () => {
    writes.close();
    members.close();
    accounts.close();
    actors.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  /** Holds the database writer lock from another connection, so owner writes wait in its queue. */
  const holdWriter = () => {
    const holder = new DatabaseSync(join(directory, "opencraft-server.sqlite"));
    holder.exec("BEGIN IMMEDIATE");
    return () => {
      holder.exec("ROLLBACK");
      holder.close();
    };
  };
  return { actors, accounts, members, writes, holdWriter };
}

// docs/architecture/server/server-core-owner.md: identity writes commit in the
// owner Worker; this thread's projection and observers see them after the await.
test("a login committed by the owner is visible to this thread's projection and authenticates", async (t) => {
  const { actors, accounts, writes } = await fixture(t);
  let changes = 0;
  accounts.onAuthorityChanged(() => changes++);
  const { token, login } = await writes.issueLogin(principal("alice"));
  assert.equal(
    actors.findHuman(principal("alice"))?.id,
    login.context.actorId,
    "the registration reached the projection",
  );
  assert.ok(actors.isCurrent(login.context));
  assert.equal(accounts.authenticate(token)?.context.actorId, login.context.actorId);
  assert.ok(changes > 0, "observers were notified after the commit");
  await writes.revokeLogin(token);
  assert.equal(accounts.authenticate(token), null);
});

test("binding changes fence the Actor through the owner and notify identity observers here", async (t) => {
  const { actors, writes } = await fixture(t);
  const { login } = await writes.issueLogin(principal("bob"));
  const changed: string[] = [];
  actors.onIdentityChanged((id) => changed.push(id));
  await writes.bindHuman(login.context, principal("bob-second"));
  assert.equal(actors.findHuman(principal("bob-second"))?.id, login.context.actorId);
  await writes.unbindHuman(login.context, principal("bob-second"));
  assert.equal(actors.findHuman(principal("bob-second")), null);
  assert.equal(actors.isCurrent(login.context), false, "unbinding fenced the old context");
  assert.deepEqual(changed, [login.context.actorId, login.context.actorId]);
  await assert.rejects(writes.unbindHuman(login.context, principal("bob")), /Human verification required/);
});

test("Actor administration commits in the owner; resource authorities are checked on this thread", async (t) => {
  const { actors, writes } = await fixture(t);
  const { login } = await writes.issueLogin(principal("admin"));
  const allowed = () => actors.isCurrent(login.context);
  const session = await writes.createSession(allowed, "bot", login.context.actorId);
  assert.equal(actors.get(session.id)?.kind, "session");
  const credential = await writes.issueCredential(allowed, session.id, Date.now() + 60_000, login.context.actorId);
  assert.equal(actors.authenticateSession(credential.token)?.actorId, session.id);
  await assert.rejects(
    writes.setGrant(allowed, session.id, "hub://elsewhere/x", "read", true, login.context.actorId),
    /Resource authority required/,
  );
  actors.registerResourceAuthority((resource) => resource.startsWith("hub://elsewhere/"));
  await writes.setGrant(allowed, session.id, "hub://elsewhere/x", "read", true, login.context.actorId);
  assert.equal(actors.can(actors.authenticateSession(credential.token)!, "hub://elsewhere/x", "read"), true);
  await writes.revokeCredential(allowed, credential.credentialId, login.context.actorId);
  assert.equal(actors.authenticateSession(credential.token), null);
  await writes.setEnabled(allowed, session.id, false, login.context.actorId);
  assert.equal(actors.get(session.id)?.enabled, false);
  await assert.rejects(
    writes.createSession(() => false, "denied", login.context.actorId),
    /denied/,
    "a caller without authority never reaches the owner",
  );
});

// Review on #463: authority can be revoked or expire while the write waits in
// the owner's queue, so the owner rechecks it under its writer lock.
test("authority revoked while an administration write waits in the owner queue commits nothing", async (t) => {
  const { actors, writes, holdWriter } = await fixture(t);
  const { login: admin } = await writes.issueLogin(principal("admin"));
  const { login: operator } = await writes.issueLogin(principal("operator"));
  const sessions = () => actors.list().filter((actor) => actor.kind === "session").length;
  const release = holdWriter();
  // All three queue behind the held lock. The first disables the operator; the
  // other two were authorized by the operator before that and must not commit.
  const disable = writes.setEnabled(
    () => actors.isCurrent(admin.context),
    operator.context.actorId,
    false,
    admin.context.actorId,
  );
  const create = writes.createSession(() => actors.isCurrent(operator.context), "late", operator.context.actorId);
  const grant = writes.setGrant(
    () => actors.isCurrent(operator.context),
    admin.context.actorId,
    actors.managementResource,
    "actors.manage",
    true,
    operator.context.actorId,
  );
  setTimeout(release, 200);
  await disable;
  await assert.rejects(create, /Authorization changed before the write committed/);
  await assert.rejects(grant, /Authorization changed before the write committed/);
  assert.equal(sessions(), 0, "no session committed");
  assert.equal(actors.can(admin.context, actors.managementResource, "actors.manage"), false, "no grant committed");
});

test("authority that expires while queued commits no credential, state or revocation change", async (t) => {
  const { actors, writes, holdWriter } = await fixture(t);
  const { login: admin } = await writes.issueLogin(principal("admin"));
  const always = () => actors.isCurrent(admin.context);
  const session = await writes.createSession(always, "bot", admin.context.actorId);
  const credential = await writes.issueCredential(always, session.id, Date.now() + 60_000, admin.context.actorId);
  const expiresAt = Date.now() + 100;
  const expiring = () => Date.now() < expiresAt;
  const release = holdWriter();
  const held = [
    writes.issueCredential(expiring, session.id, Date.now() + 60_000, admin.context.actorId),
    writes.revokeCredential(expiring, credential.credentialId, admin.context.actorId),
    writes.setEnabled(expiring, session.id, false, admin.context.actorId),
  ];
  setTimeout(release, 300);
  for (const pending of held) await assert.rejects(pending, /Authorization changed before the write committed/);
  assert.equal(actors.authenticateSession(credential.token)?.actorId, session.id, "the credential was not revoked");
  assert.equal(actors.get(session.id)?.enabled, true, "the session was not disabled");
  const next = await writes.issueCredential(always, session.id, Date.now() + 60_000, admin.context.actorId);
  assert.ok(next.credentialId, "the owner continues after refusing");
});

test("a login stays on this thread while it registered hooks the owner cannot run", async (t) => {
  const { actors, writes } = await fixture(t);
  const registered: string[] = [];
  actors.onHumanRegistered((p) => registered.push(p.subject));
  await writes.issueLogin(principal("carol"));
  assert.deepEqual(registered, ["carol"]);
});

test("membership administration commits in the owner and is fenced like Actor administration", async (t) => {
  const { actors, members, writes, holdWriter } = await fixture(t);
  const { login: admin } = await writes.issueLogin(principal("admin"));
  const { login: member } = await writes.issueLogin(principal("member"));
  const allowed = () => actors.isCurrent(admin.context);
  await writes.setMembership(
    allowed,
    principal("member"),
    "member",
    true,
    admin.context.actorId,
    member.context.actorId,
  );
  assert.deepEqual(members.membership(principal("member")), { role: "member", enabled: true });
  assert.deepEqual(
    members.actorMembership(member.context.actorId),
    { role: "member", enabled: true },
    "both rows commit together",
  );
  // Revoked while queued: the admin is disabled by an earlier queued write.
  const release = holdWriter();
  const disable = writes.setEnabled(allowed, admin.context.actorId, false, admin.context.actorId);
  const promote = writes.setActorMembership(allowed, member.context.actorId, "admin", true, admin.context.actorId);
  setTimeout(release, 200);
  await disable;
  await assert.rejects(promote, /Authorization changed before the write committed/);
  assert.deepEqual(
    members.actorMembership(member.context.actorId),
    { role: "member", enabled: true },
    "no promotion committed",
  );
});

// Authentication calls bindLegacyAlias on every request; without an enabled
// legacy alias it must not take the writer lock or publish a change.
test("authenticating a principal without a legacy alias publishes no membership change", async (t) => {
  const { members } = await fixture(t);
  let changes = 0;
  members.onAuthorityChanged(() => changes++);
  members.bindLegacyAlias({ ...principal("plain"), aliases: [] });
  members.bindLegacyAlias({ ...principal("aliased"), aliases: ["nobody"] });
  assert.equal(changes, 0);
  members.set({ provider: "oidc", subject: "old-name" }, "member", true, "test");
  changes = 0;
  members.bindLegacyAlias({ ...principal("renamed"), aliases: ["old-name"] });
  assert.equal(changes, 1, "a real legacy alias still moves");
  assert.equal(members.role(principal("renamed")), "member");
});
