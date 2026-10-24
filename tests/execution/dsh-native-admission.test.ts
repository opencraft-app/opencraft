import test from "node:test";
import assert from "node:assert/strict";
import { DshExecutionAuthority } from "../../apps/local-agent-host/src/dsh-execution-authority.js";
import { DshNativeAdmission } from "../../apps/local-agent-host/src/dsh-native-admission.js";
const owner = { connectionId: "connection", identity: { id: "local", username: "local" } };
const event = (type: string, data: any, seq = 1) => ({ type, data, seq, time: seq * 1000 });

test("native start is buffered until exact caller identity arrives, then ordered prefix is released", async () => {
  const authority = new DshExecutionAuthority(":memory:");
  const gate = new DshNativeAdmission(authority);
  try {
    const pending = gate.begin("s", owner, "request");
    assert.deepEqual(gate.accept("s", event("turn/start", { turn: 1 })), []);
    assert.equal(authority.table.get("s").state, "admitted");
    assert.deepEqual(gate.accept("s", event("step/start", { step: 1 }, 2)), []);
    const released = gate.accept("s", event("user/message", { source: { kind: "user", rpcId: pending.rpcId } }, 3));
    assert.deepEqual(released.map(e => e.type), ["turn/start", "step/start", "user/message"]);
    assert.equal(await pending.started, 1);
    assert.equal(authority.table.get("s").state, "running");
    gate.finish("s", "completed", "done");
  } finally { gate.failAll(new Error("test cleanup")); authority.close(); }
});
test("late start from timed-out request cannot steal a newer epoch", async () => {
  const authority = new DshExecutionAuthority(":memory:");
  const gate = new DshNativeAdmission(authority);
  try {
    const old = gate.begin("s", owner, "old");
    old.cancel(new Error("dispatch timeout"));
    await assert.rejects(old.started, /timeout/);
    const next = gate.begin("s", owner, "next");
    gate.accept("s", event("turn/start", { turn: 1 }));
    assert.deepEqual(gate.accept("s", event("user/message", { source: { kind: "user", rpcId: old.rpcId } }, 2)), []);
    assert.equal(authority.table.get("s").epoch, next.admission.epoch);
    assert.equal(authority.table.get("s").nativeTurnId, undefined);
    gate.accept("s", event("turn/start", { turn: 2 }, 3));
    gate.accept("s", event("user/message", { source: { kind: "user", rpcId: next.rpcId } }, 4));
    assert.equal(await next.started, 2);
    assert.deepEqual(gate.accept("s", event("turn/end", { turn: 1 }, 5)), []);
  } finally { gate.failAll(new Error("test cleanup")); authority.close(); }
});

test("queued native consumption receives a new epoch only for its reserved request", async () => {
  const authority = new DshExecutionAuthority(":memory:");
  const gate = new DshNativeAdmission(authority);
  try {
    const first = gate.begin("s", owner, "first", "user-1");
    gate.accept("s", event("turn/start", { turn: 1 }));
    gate.accept("s", event("user/message", { source: { kind: "user", rpcId: first.rpcId } }, 2));
    await first.started;
    const queued = gate.reserveQueued("s", owner, "queued", "user-2");
    assert.equal(gate.queuedClientId("s", queued), "user-2");
    gate.finish("s", "completed", "done");
    gate.accept("s", event("turn/start", { turn: 2 }, 3));
    const accepted = gate.accept("s", event("user/message", { source: { kind: "user", rpcId: queued } }, 4));
    assert.equal(accepted.length, 2);
    assert.equal((accepted[1].data as any).source.rpcId, "user-2");
    assert.ok(authority.table.get("s").epoch > first.admission.epoch);
    assert.equal(authority.queuedInputs().length, 0);
    assert.equal(authority.table.get("s").requestId, "queued");
  } finally { gate.failAll(new Error("cleanup")); authority.close(); }
});

test("only an explicitly armed exact Goal revision admits automatic rounds, including after socket loss", () => {
  const authority = new DshExecutionAuthority(":memory:");
  const gate = new DshNativeAdmission(authority);
  const source = { kind: "goal", goalId: "goal-a", revision: 1, round: 1 };
  const changed = (phase: string, revision = 1) => event("goal/change", { goal: { id: "goal-a", revision, phase } });
  try {
    gate.authorizeGoal("s", owner, "goal-request");
    assert.equal(gate.accept("s", changed("active")).length, 1);
    gate.accept("s", event("turn/start", { turn: 1 }));
    assert.deepEqual(gate.accept("s", event("user/message", { source: { ...source, goalId: "wrong" } })), []);
    assert.equal(authority.table.get("s"), null);
    authority.disconnect(owner);
    gate.accept("s", event("turn/start", { turn: 2 }));
    assert.equal(gate.accept("s", event("user/message", { source })).length, 2);
    assert.equal(authority.table.get("s").connection.identity.id, owner.identity.id);
    gate.finish("s", "completed", "done");
    gate.accept("s", event("turn/start", { turn: 3 }));
    assert.deepEqual(gate.accept("s", event("user/message", { source })), [], "round cannot be reused");
    gate.accept("s", changed("paused", 2));
    gate.accept("s", event("turn/start", { turn: 4 }));
    assert.deepEqual(gate.accept("s", event("user/message", { source: { ...source, revision: 2, round: 2 } })), []);
  } finally { gate.failAll(new Error("cleanup")); authority.close(); }
});

test("a goal source cannot steal a pending human admission and cold Goal events do not arm", async () => {
  const authority = new DshExecutionAuthority(":memory:");
  const gate = new DshNativeAdmission(authority);
  try {
    gate.accept("s", event("goal/change", { goal: { id: "goal", revision: 1, phase: "active" } }));
    const pending = gate.begin("s", owner, "human");
    gate.accept("s", event("turn/start", { turn: 1 }));
    assert.deepEqual(gate.accept("s", event("user/message", { source: { kind: "goal", goalId: "goal", revision: 1, round: 1 } })), []);
    assert.equal(authority.table.get("s").state, "admitted");
    pending.cancel(new Error("cleanup")); await assert.rejects(pending.started);
  } finally { gate.failAll(new Error("cleanup")); authority.close(); }
});

test("background wake requires an exact live input/message proof and cannot steal a pending human", async () => {
  const authority = new DshExecutionAuthority(":memory:"); const gate = new DshNativeAdmission(authority);
  try {
    const first = gate.begin("s", owner, "human");
    gate.accept("s", event("turn/start", { turn: 1 }));
    gate.accept("s", event("user/message", { source: { kind: "user", rpcId: first.rpcId } })); await first.started;
    gate.finish("s", "completed", "done"); authority.disconnect(owner);
    const notice = { id: "message", source: { kind: "plugin", plugin: "tool-jobs", form: "notice" } };
    gate.authorizeBackground("other", "message", first.rpcId);
    gate.accept("s", event("turn/start", { turn: 2 })); assert.deepEqual(gate.accept("s", event("user/message", notice)), []);
    gate.authorizeBackground("s", "message", first.rpcId);
    gate.accept("s", event("turn/start", { turn: 3 })); assert.equal(gate.accept("s", event("user/message", notice)).length, 2);
    assert.equal(authority.table.get("s").connection.identity.id, owner.identity.id);
    gate.finish("s", "completed", "done");
    gate.accept("s", event("turn/start", { turn: 4 })); assert.deepEqual(gate.accept("s", event("user/message", notice)), []);
    gate.failAll(Error("restart")); gate.authorizeBackground("s", "message", first.rpcId);
    gate.accept("s", event("turn/start", { turn: 5 })); assert.deepEqual(gate.accept("s", event("user/message", notice)), []);
  } finally { gate.failAll(Error("cleanup")); authority.close(); }
});
test("background proof cannot replace a pending human request", async () => {
  const authority = new DshExecutionAuthority(":memory:"), gate = new DshNativeAdmission(authority);
  try {
    const first = gate.begin("s", owner, "first"); gate.accept("s", event("turn/start", { turn: 1 }));
    gate.accept("s", event("user/message", { source: { kind: "user", rpcId: first.rpcId } })); await first.started; gate.finish("s", "completed", "done");
    const next = gate.begin("s", owner, "next"); gate.authorizeBackground("s", "job-notice", first.rpcId);
    gate.accept("s", event("turn/start", { turn: 2 }));
    assert.deepEqual(gate.accept("s", event("user/message", { id: "job-notice", source: { kind: "plugin", plugin: "tool-jobs", form: "notice" } })), []);
    assert.equal(authority.table.get("s").epoch, next.admission.epoch);
    gate.accept("s", event("turn/start", { turn: 3 })); gate.accept("s", event("user/message", { source: { kind: "user", rpcId: next.rpcId } }));
    assert.equal(await next.started, 3);
  } finally { gate.failAll(Error("cleanup")); authority.close(); }
});
