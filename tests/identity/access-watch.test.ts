// Instance and Actor access watches on the owner wake-up port (gateway-split §4.2 "G5 定时器"):
// the default keeps the runtime's own timeouts at the previous 500 ms period, an
// injected wake-up (a single-alarm owner such as the InstallationCore object)
// drives the same rechecks, and closing a watch disarms it.
import test from "node:test";
import assert from "node:assert/strict";
import { InstanceAccess, MembershipStore } from "@opencraft/access-control";
import { ActorAccess } from "@opencraft/access-control/actor-access";
import { ActorStore } from "@opencraft/access-control/actors";
import { mergedOwnerWake } from "@opencraft/owner-wake";
import type { Principal } from "@opencraft/identity-core";
import { fakeAlarm, fakeOwnerWake, fakeWakeClock } from "../support/fake-wake-clock.ts";

const person = (subject: string): Principal => ({
  provider: "local",
  subject,
  displayName: subject,
  expiresAt: Date.now() + 3_600_000,
  attributes: {},
  aliases: [],
});

function instance(t: test.TestContext) {
  const members = new MembershipStore(":memory:");
  t.after(() => members.close());
  const alice = person("alice");
  members.set(alice, "member", true, "fixture");
  const access = new InstanceAccess(members, [{ authenticate: () => alice }]);
  return { members, alice, access };
}

test("instance access watch rechecks every 500 ms on an injected owner wake-up and stops when closed", (t) => {
  const { members, alice, access } = instance(t);
  const fake = fakeWakeClock();
  access.useOwnerWake(fakeOwnerWake(fake));
  let revoked = 0;
  const unwatch = access.watch(alice, () => revoked++);
  fake.elapse(1_499);
  assert.equal(revoked, 0, "an admitted member is never revoked");
  assert.equal(fake.pending, 1, "one pending wake-up per watch");
  members.set(alice, "member", false, "fixture");
  fake.elapse(1);
  assert.equal(revoked, 1, "the next recheck after revocation revokes");
  unwatch();
  assert.equal(fake.pending, 0, "a closed watch disarms its wake-up");
  fake.elapse(5_000);
  assert.equal(revoked, 1);
});

test("instance and Actor access watches share one alarm and each disarms on close", (t) => {
  const { members, alice, access } = instance(t);
  const fake = fakeWakeClock();
  const alarm = fakeAlarm(fake);
  const wake = mergedOwnerWake(alarm.wake);
  access.useOwnerWake(wake);
  const actors = new ActorStore(":memory:");
  t.after(() => actors.close());
  const actorAccess = new ActorAccess(actors, {
    authenticateHuman: () => alice,
    admitted: (principal) => access.role(principal) !== null,
    administrator: () => false,
  });
  actorAccess.useOwnerWake(wake);
  const request = { headers: {} };
  const revoked: string[] = [];
  const stopInstance = access.watch(alice, () => revoked.push("instance"));
  const stopActor = actorAccess.watch(request, () => revoked.push("actor"));
  assert.equal(alarm.state.armed, fake.now + 500);
  fake.jump(500);
  assert.equal(alarm.fire(), true);
  assert.deepEqual(revoked, []);
  assert.equal(alarm.state.armed, fake.now + 500, "both rechecks re-armed the one alarm");
  members.set(alice, "member", false, "fixture");
  fake.jump(500);
  alarm.fire();
  assert.deepEqual(revoked.sort(), ["actor", "instance"]);
  stopInstance();
  stopActor();
  assert.equal(alarm.state.armed, null, "no alarm is left once both watches closed");
});

test("without an injected wake-up the watch keeps the runtime's own 500 ms timeouts", async (t) => {
  const { members, alice, access } = instance(t);
  let revoked = 0;
  const unwatch = access.watch(alice, () => revoked++);
  t.after(unwatch);
  members.set(alice, "member", false, "fixture");
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(revoked >= 1, true, "revoked on the 500 ms recheck");
});
