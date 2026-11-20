import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { profileFor } from "./helpers.mjs";
import { createCrewIntake } from "../src/runtime/crew-intake.mjs";

const bob = { actorId: "bob", displayName: "Bob", kind: "human" };
const alice = { actorId: "alice", displayName: "Alice", kind: "human" };
const work = (id, requesterId, chain, request = "tidy the release") =>
  ({ id, state: "open", origin: "member", requesterId, chain, request, openChildren: 0 });

/** Stands in for the Core crew ledger as the Host would forward it. */
function core(works, replies = []) {
  const calls = [];
  return {
    calls,
    works,
    replies,
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === "opencraft/crew/work/replies") return { replies: replies.filter((r) => r.seq > params.after) };
      if (method === "opencraft/crew/work/list") return { works: works.filter((w) => w.state === "open") };
      if (method === "opencraft/crew/work/finish") {
        works.find((w) => w.id === params.workId).state = "closed";
        return {};
      }
      if (method === "opencraft/crew/work/message") return { messageId: "sent:" + params.idempotencyKey };
      throw Error("unexpected " + method);
    },
  };
}

function setup(t, ledger) {
  const profile = profileFor(t);
  let store = new Store(profile);
  t.after(() => store.close());
  const runner = () => ({ uow: store.uow, dispatch: (r) => store.app.dispatch(r) });
  return {
    get store() { return store; },
    intake: () => createCrewIntake({ runner: runner(), request: ledger.request }),
    reopen() { store.close(); store = new Store(profile); },
  };
}

test("crew work becomes a turn in its dispatcher's conversation and closes only once quiet", async (t) => {
  const ledger = core([work("w1", "bob", [bob, alice])]);
  const s = setup(t, ledger);
  let crew = s.intake();
  await crew.poll(() => false);
  const turn = s.store.app.reception.turn("crew:w1");
  assert.equal(turn.text, "Bob:\ntidy the release");
  assert.notEqual(turn.conversation_id, s.store.app.history.main.id, "the owner's conversation stays separate");
  assert.equal(crew.isPeerConversation(turn.conversation_id), true);
  assert.equal(crew.isPeerConversation(s.store.app.history.main.id), false);

  await crew.poll(() => false);
  assert.equal(ledger.works[0].state, "open", "an unsettled turn keeps the work open");
  assert.equal(ledger.calls.filter(([m]) => m === "opencraft/crew/work/finish").length, 0);

  const receipt = await crew.deliver({ id: "m1", conversationId: turn.conversation_id }, "which branch?");
  assert.equal(receipt.messageId, "sent:m1");
  assert.deepEqual(ledger.calls.at(-1), ["opencraft/crew/work/message",
    { workId: "w1", targetActorId: "bob", content: "which branch?", idempotencyKey: "m1" }]);

  ledger.works.push(work("w2", "bob", [bob, alice], "main, please"));
  s.reopen();
  crew = s.intake();
  await crew.poll(() => false);
  assert.equal(s.store.app.reception.turn("crew:w2").conversation_id, turn.conversation_id,
    "a follow-up from the same dispatcher lands in the same conversation after a restart");

  s.store.db.prepare("UPDATE reception SET status='settled' WHERE id='crew:w1'").run();
  await crew.poll(() => false);
  assert.equal(ledger.works[0].state, "open", "the dispatcher's follow-up is still queued in the same conversation");
  s.store.db.prepare("UPDATE reception SET status='settled' WHERE id='crew:w2'").run();
  await crew.poll(() => false);
  assert.deepEqual(ledger.works.map((w) => w.state), ["closed", "closed"], "settled and quiet closes the work");
});

test("work whose dispatcher left before intake is closed without starting", async (t) => {
  const ledger = core([work("gone", "carol", [alice])]);
  const s = setup(t, ledger);
  await s.intake().poll(() => false);
  assert.equal(ledger.works[0].state, "closed");
  assert.throws(() => s.store.app.reception.turn("crew:gone"), /Unknown reception input/);
});

test("a reply is routed to the nearest person left on the chain", async (t) => {
  const ledger = core([work("w1", "bob", [bob, alice])]);
  const s = setup(t, ledger);
  const crew = s.intake();
  await crew.poll(() => false);
  const conversationId = s.store.app.reception.turn("crew:w1").conversation_id;
  ledger.works[0].chain = [alice];
  await crew.deliver({ id: "m2", conversationId }, "Bob left; who decides?");
  assert.equal(ledger.calls.at(-1)[1].targetActorId, "alice");
});

test("a reply from a Bot it handed work to returns to the conversation of the work it answers", async (t) => {
  const ledger = core([work("root", "bob", [bob, alice])]);
  const s = setup(t, ledger);
  const crew = s.intake();
  await crew.poll(() => false);
  const conversationId = s.store.app.reception.turn("crew:root").conversation_id;
  s.store.db.prepare("UPDATE reception SET status='settled' WHERE id='crew:root'").run();
  ledger.works[0].openChildren = 1;
  await crew.poll(() => false);
  assert.equal(ledger.works[0].state, "open", "work with an open hand-off stays open");

  const zhe = { actorId: "zhe", displayName: "Zhe", kind: "session" };
  ledger.replies.push({ seq: 1, messageId: "r1", workId: "root", requesterId: "bob", state: "open", from: zhe, content: "signatures look fine" });
  ledger.works[0].openChildren = 0;
  await crew.poll(() => false);
  const turn = s.store.app.reception.turn("crew-reply:r1");
  assert.equal(turn.conversation_id, conversationId);
  assert.equal(turn.text, "Zhe:\nsignatures look fine");
  assert.equal(ledger.works[0].state, "open", "the returned reply is still to be handled");

  await crew.poll(() => false);
  assert.equal(ledger.calls.filter(([m, p]) => m === "opencraft/crew/work/replies" && p.after === 1).length > 0, true, "the cursor moved past the reply");
  s.store.db.prepare("UPDATE reception SET status='settled' WHERE id='crew-reply:r1'").run();
  await crew.poll(() => false);
  assert.equal(ledger.works[0].state, "closed");
});
