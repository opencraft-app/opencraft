import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openServerCoreOwner } from "@opencraft/storage-node/server-owner";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { IdentityWrites, type IdentityWriteOwner } from "@opencraft/access-control/identity-writes";

const entry = new URL("../../apps/headless-server/src/server-core-worker.mjs", import.meta.url);
const principal = (subject: string) => ({
  provider: "oidc",
  subject,
  displayName: subject,
  expiresAt: Date.now() + 3_600_000,
});

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "identity-writes-"));
  const storage = await openServerCoreOwner<IdentityWriteOwner>(directory, { entry });
  const actors = new ActorStore(storage),
    accounts = new HumanAccounts(storage, actors);
  t.after(async () => {
    accounts.close();
    actors.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { actors, accounts, writes: new IdentityWrites(storage.call, actors, accounts) };
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
  const session = await writes.createSession("bot", login.context.actorId);
  assert.equal(actors.get(session.id)?.kind, "session");
  const credential = await writes.issueCredential(session.id, Date.now() + 60_000, login.context.actorId);
  assert.equal(actors.authenticateSession(credential.token)?.actorId, session.id);
  await assert.rejects(
    writes.setGrant(session.id, "hub://elsewhere/x", "read", true, login.context.actorId),
    /Resource authority required/,
  );
  actors.registerResourceAuthority((resource) => resource.startsWith("hub://elsewhere/"));
  await writes.setGrant(session.id, "hub://elsewhere/x", "read", true, login.context.actorId);
  assert.equal(actors.can(actors.authenticateSession(credential.token)!, "hub://elsewhere/x", "read"), true);
  await writes.revokeCredential(credential.credentialId, login.context.actorId);
  assert.equal(actors.authenticateSession(credential.token), null);
  await writes.setEnabled(session.id, false, login.context.actorId);
  assert.equal(actors.get(session.id)?.enabled, false);
});

test("a login stays on this thread while it registered hooks the owner cannot run", async (t) => {
  const { actors, writes } = await fixture(t);
  const registered: string[] = [];
  actors.onHumanRegistered((p) => registered.push(p.subject));
  await writes.issueLogin(principal("carol"));
  assert.deepEqual(registered, ["carol"]);
});
