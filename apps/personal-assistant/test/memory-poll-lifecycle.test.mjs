import test from "node:test";
import assert from "node:assert/strict";
import { profileFor, until } from "./helpers.mjs";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { createAssistantSession } from "../src/runtime/assistant-session.mjs";
import { MemoryFilesChangedError } from "../src/adapters/memory/file-authority.mjs";

async function observationFault(t, error) {
  const profile = profileFor(t, { telemetry: { enabled: false } });
  const original = LocalRunner.prototype.dispatch;
  const notices = [];
  let injected = false, observations = 0, stopped = 0;
  t.mock.method(LocalRunner.prototype, "dispatch", function (request) {
    if (request.op === "status") {
      observations++;
      if (!injected) { injected = true; throw error; }
    }
    return original.call(this, request);
  });
  const session = createAssistantSession({
    request() { throw Error("Standalone fixture must not acquire platform authority"); },
    notify(method) { notices.push(method); },
  }, () => { stopped++; });
  t.after(() => session.close());
  // A terminal startup poll can close before initialize replies. Both orders
  // must still satisfy the explicit lifecycle assertions below.
  await session.handle("initialize", { protocolVersion: 1, profile: profile.path })
    .catch(() => {});
  return { session, notices, injected: () => injected, observations: () => observations,
    stopped: () => stopped };
}

test("a rolled-back memory fingerprint conflict does not retire the session", async t => {
  const f = await observationFault(t, new MemoryFilesChangedError());
  await until(() => f.notices.includes("activity-unavailable"));
  assert.equal(f.injected(), true);
  assert.equal(f.stopped(), 0);
  assert.equal(f.notices.includes("failed"), false);
  const observed = await f.session.handle("observe", {});
  assert.deepEqual(observed.value, { queued: 0, running: 0 });
  assert.ok(f.observations() >= 2, "the existing session serves a fresh observation");
});

for (const [label, makeError] of [
  ["lookalike message", () => Error("Memory files changed during the transaction")],
  ["storage failure", () => Object.assign(Error("fixture storage failure"), { code: "SQLITE_IOERR" })],
  ["authority revocation", () => Object.assign(Error("fixture authority revoked"), { code: "personal_assistant_revoked" })],
  ["unknown external effect", () => Object.assign(Error("fixture external effect unknown"), { code: "ENVIRONMENT_OUTCOME_UNKNOWN" })],
]) {
  test(`${label} remains terminal and cannot enter memory-conflict retry`, async t => {
    const f = await observationFault(t, makeError());
    await until(() => f.stopped() === 1);
    assert.equal(f.injected(), true);
    assert.equal(f.notices.includes("failed"), true);
    assert.equal(f.notices.includes("activity-unavailable"), false);
    assert.equal(f.observations(), 1, "terminal failures must not retry the observation");
    await assert.rejects(f.session.handle("observe", {}), /unavailable/i);
  });
}
