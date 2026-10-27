import test from "node:test";
import assert from "node:assert/strict";
import { createBackgroundJobProofs } from "../../apps/local-agent-host/src/dsh-background-jobs.mjs";
function fixture() {
  let changed, inserted, jobs = [];
  const ctx = { jobs: { onJobsChanged: cb => changed = cb, list: () => jobs }, on: (_, cb) => inserted = cb };
  const agent = { id: "s", status: "running", session: { events: [{ type: "turn/start" }, { type: "user/message", data: { source: { rpcId: "origin" } } }, { type: "user/message", data: { source: { kind: "skill-catalog" } } }] } };
  const port = createBackgroundJobProofs(ctx);
  return { port, agent, change: next => { jobs = next; changed(agent); }, insert: (id, plugin = "tool-jobs") => inserted({ agent, message: { id, source: { kind: "plugin", plugin, form: "notice" } } }) };
}
test("only a live owned job creation plus settlement produces a one-use message proof", () => {
  const f = fixture(), job = { id: "bash-1", ownerSession: "s", status: "running", reported: false };
  f.change([job]); f.insert("early"); assert.equal(f.port.take("s", "early"), null);
  f.agent.status = "idle"; f.change([{ ...job, status: "completed" }]);
  f.insert("wrong", "schedule"); assert.equal(f.port.take("s", "wrong"), null);
  f.insert("done"); assert.equal(f.port.take("other", "done"), null);
  assert.deepEqual(f.port.take("s", "done"), { originRpcId: "origin" });
  assert.equal(f.port.take("s", "done"), null);
  f.insert("replay"); assert.equal(f.port.take("s", "replay"), null);
});
test("unowned, cold, reported and ambiguous owners cannot grant continuation", () => {
  for (const job of [{ id: "unowned", status: "running" }, { id: "cold", ownerSession: "s", status: "completed" }, { id: "read", ownerSession: "s", status: "running", reported: true }]) {
    const f = fixture(); f.change([job]); f.change([{ ...job, status: "completed", reported: job.reported }]); f.insert("n"); assert.equal(f.port.take("s", "n"), null);
  }
  const f = fixture();
  const a = { id: "a", ownerSession: "s", status: "running" };
  f.change([a]); f.agent.session.events.push({ type: "user/message", data: { source: { rpcId: "other" } } });
  const b = { id: "b", ownerSession: "s", status: "running" }; f.change([a, b]);
  f.change([{ ...a, status: "completed" }, { ...b, status: "completed" }]); f.insert("ambiguous");
  assert.equal(f.port.take("s", "ambiguous"), null);
});
test("a new autonomous turn cannot borrow a prior turn's input through catalog messages", () => {
  const f = fixture(); f.agent.session.events.push({ type: "turn/start" }, { type: "user/message", data: { source: { kind: "goal" } } });
  const job = { id: "goal-job", ownerSession: "s", status: "running" };
  f.change([job]); f.change([{ ...job, status: "completed" }]); f.insert("unproven");
  assert.equal(f.port.take("s", "unproven"), null);
});
