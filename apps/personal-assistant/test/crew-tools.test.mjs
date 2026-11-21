import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionPorts } from "../src/runtime/execution-ports.mjs";
import { delegationTools } from "../src/domain/assistant.mjs";
import { assistantTools } from "../src/adapters/work-tools/assistant-tools.mjs";

const held = {
  id: "root", assigneeId: "alan", parentId: null, budget: { used: 1, limit: 8 },
  chain: [{ actorId: "bob", displayName: "Bob", kind: "human" }, { actorId: "alice", displayName: "Alice", kind: "human" }],
};

function fixture({ answers = true, child = { parentId: "root" } } = {}) {
  const calls = [], checks = [];
  const app = {
    works: { assertCurrent: () => undefined },
    executions: { assertCrewAction: (_work, tool) => checks.push(tool), assertAction: () => undefined },
  };
  const crew = {
    answers: (workId) => answers && workId === "w1",
    held: async () => held,
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === "opencraft/crew/phonebook/list") return { entries: [{ actorId: "zhe", displayName: "Zhe", kind: "session", extra: 1 }], members: [], editable: false };
      if (method === "opencraft/crew/work/dispatch") return { workId: "child", work: { budget: { used: 2, limit: 8 } } };
      if (method === "opencraft/crew/work/get") return { work: { id: params.workId, ...child } };
      if (method === "opencraft/crew/work/message") return { messageId: "m-" + params.idempotencyKey };
      throw Error("unexpected " + method);
    },
  };
  const ports = createExecutionPorts(app, () => undefined, undefined, undefined, undefined, crew);
  return { calls, checks, tools: ports.toolsFor({ id: "w1" }, { delegation: { tools: [], resources: [] } }) };
}

test("crew tools exist only where a crew binding was captured and the Work answers crew work", () => {
  assert.deepEqual(delegationTools([{ id: "crew.work", binding: "b" }]).filter((t) => t.startsWith("crew_")),
    ["crew_contacts", "crew_dispatch", "crew_message"]);
  assert.deepEqual(delegationTools([]).filter((t) => t.startsWith("crew_")), []);
  assert.equal(fixture({ answers: false }).tools.crewDispatch, undefined, "the owner's own tasks get no crew tools");
  const names = (tools, delegated) => assistantTools({ ports: { ...tools, assertAction: () => undefined }, snapshot: { delegation: { tools: delegated, resources: [] }, memoryEpoch: 0 },
    onBoundaryError: () => undefined }).map((t) => t.name).filter((n) => n.startsWith("crew_"));
  assert.deepEqual(names(fixture().tools, delegationTools([{ id: "crew.work", binding: "b" }])), ["crew_contacts", "crew_dispatch", "crew_message"]);
  assert.deepEqual(names(fixture().tools, delegationTools([])), [], "a delegation without the binding shows none");
});

test("a hand-off goes under the held work with a key fixed by the native call", async () => {
  const f = fixture();
  assert.deepEqual(await f.tools.crewContacts(), {
    contacts: [{ actorId: "zhe", displayName: "Zhe", kind: "session" }], answersTo: held.chain, budget: held.budget,
  });
  assert.deepEqual(await f.tools.crewDispatch({ to: "zhe", text: "check the signatures" }, "call-1"), { workId: "child", budget: { used: 2, limit: 8 } });
  assert.deepEqual(f.calls.find(([m]) => m === "opencraft/crew/work/dispatch")[1],
    { targetActorId: "zhe", content: "check the signatures", idempotencyKey: "crew:w1:crew_dispatch:call-1", parentWorkId: "root" });
  await assert.rejects(f.tools.crewDispatch({ to: "zhe", text: "x" }), /native call ID/);
  await assert.rejects(f.tools.crewDispatch({ to: "zhe", text: "  " }, "call-2"), /Invalid request/);
  assert.ok(f.checks.includes("crew_dispatch") && f.checks.includes("crew_contacts"), "every call is checked against the captured binding");
});

test("messages go up on the held work, or down only on a hand-off made from it", async () => {
  const f = fixture();
  await f.tools.crewMessage({ to: "bob", text: "2.3 or 2.3.1?" }, "call-3");
  assert.deepEqual(f.calls.at(-1), ["opencraft/crew/work/message", { workId: "root", targetActorId: "bob", content: "2.3 or 2.3.1?", idempotencyKey: "crew:w1:crew_message:call-3" }]);
  await f.tools.crewMessage({ to: "zhe", text: "thanks", workId: "child" }, "call-4");
  assert.equal(f.calls.at(-1)[1].workId, "child");
  await f.tools.crewMessage({ to: "bob", text: "2.3 or 2.3.1?", asks: true }, "call-6");
  assert.equal(f.calls.at(-1)[1].asks, true, "a question is marked so it waits on Bob");
  const stranger = fixture({ child: { parentId: "elsewhere" } });
  await assert.rejects(stranger.tools.crewMessage({ to: "zhe", text: "hi", workId: "other" }, "call-5"), /not made from this work/);
  assert.equal(stranger.calls.some(([m]) => m === "opencraft/crew/work/message"), false);
});
