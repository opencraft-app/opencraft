import assert from "node:assert/strict";
import test from "node:test";
import { HostInteractions } from "../../packages/app-host-server/src/interactions";
import { isHumanInteraction, humanInteractionWaitReason, parseSharedInteractionSnapshot } from "@opencraft/appserver-protocol";

const source = (id: string | number = 1, method = "item/tool/requestUserInput") => ({
  id, method, params: { threadId: "thread", turnId: "turn", itemId: `item-${id}`, questions: [] },
});

test("all human kinds share the same passive state while executable tools stay exclusive", () => {
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
    "item/tool/requestUserInput", "mcpServer/elicitation/request", "item/tool/requestOptionPicker", "item/tool/requestSetupCodexContextPicker"]) {
    assert.equal(isHumanInteraction(method, {}), true);
    const waits = new HostInteractions(); waits.capture(source(1, method));
    assert.equal(parseSharedInteractionSnapshot(waits.snapshot("thread", true))?.requests.length, 1);
  }
  for (const tool of ["request_onboarding_input", "request_option_picker", "setup_codex_context_picker"]) {
    assert.equal(isHumanInteraction("item/tool/call", { tool }), true);
    assert.equal(isHumanInteraction("item/tool/call", { tool, namespace: "other" }), false);
  }
  assert.equal(isHumanInteraction("item/tool/call", { tool: "setup_codex_step", arguments: { step: "role" } }), true);
  assert.equal(isHumanInteraction("item/tool/call", { tool: "setup_codex_step", arguments: { step: "execute" } }), false);
  assert.equal(isHumanInteraction("item/tool/call", { tool: "run_shell" }), false);
});

test("a second subscriber sees every pending request and owner departure changes no source state", () => {
  const waits = new HostInteractions(); waits.capture(source(1)); waits.capture(source("1"));
  const before = waits.snapshot("thread", true), old: unknown[] = [], next: unknown[] = [];
  waits.offerLegacy("thread", "old", r => old.push(r)); waits.forgetClient("old");
  waits.offerLegacy("thread", "next", r => next.push(r));
  assert.equal(old.length, 2); assert.equal(next.length, 2);
  assert.deepEqual(waits.snapshot("thread", true), before);
  assert.notEqual(before.requests[0]!.id, before.requests[1]!.id, "typed native IDs cannot collide");
});

test("opposite concurrent answers and reentrant observers admit exactly one native response", async () => {
  const waits = new HostInteractions(), id = waits.capture(source());
  let release!: () => void, writes = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = waits.respond("thread", id, "a", { answers: {} }, async () => { writes++; await held; });
  assert.equal(waits.snapshot("thread", true).requests[0]!.state, "responding");
  assert.equal(await waits.respond("thread", id, "b", { answers: { different: true } }, async () => { writes++; }), "already-submitted");
  assert.equal(writes, 1); release(); assert.equal(await first, "submitted");
  assert.equal(waits.size, 1, "transport delivery cannot claim native resolution");
  waits.resolveNative(1, "other"); assert.equal(waits.size, 1);
  waits.resolveNative(1, "thread"); assert.equal(waits.size, 0);
  assert.equal(await waits.respond("thread", id, "a", { answers: {} }, async () => { writes++; }), "resolved");
  assert.equal(writes, 1);
});

test("a writer failure retains unconfirmed state and cannot admit another answer", async () => {
  const waits = new HostInteractions(), id = waits.capture(source()); let writes = 0;
  await assert.rejects(waits.respond("thread", id, "a", { answers: {} }, async () => { writes++; throw Error("pre-write fault"); }), /pre-write fault/);
  assert.equal(waits.snapshot("thread", true).requests[0]!.state, "unconfirmed");
  assert.equal(await waits.respond("thread", id, "b", { answers: {} }, async () => { writes++; }), "already-submitted");
  assert.equal(writes, 1); assert.equal(waits.size, 1);
});

test("source replay updates the route without reviving a submitted answer; terminal ID reuse is fresh", async () => {
  const waits = new HostInteractions(), origin = { ...source("old-route"), __opencraftInteractionKey: "native-lifetime" };
  const id = waits.capture(origin);
  await waits.respond("thread", id, "answer", { answers: {} }, async () => {});
  const replayId = waits.capture({ ...origin, id: "new-route", __opencraftInteractionState: "responding" });
  assert.equal(replayId, id); assert.equal(waits.size, 1);
  waits.resolveNative("old-route", "thread"); assert.equal(waits.size, 1, "retired route cannot settle the replacement");
  waits.resolveNative("new-route", "thread"); assert.equal(waits.size, 0);
  const fresh = waits.capture(source("new-route")); assert.notEqual(fresh, id);
  await waits.respond("thread", id, "late", { answers: {} }, async () => assert.fail("old answer executed"));
  assert.equal(waits.snapshot("thread", true).requests[0]!.state, "pending");
});

test("terminal Turns retire only their own requests and malformed snapshots fail closed", () => {
  const waits = new HostInteractions(); waits.capture(source(1)); waits.capture({ ...source(2), params: { ...source(2).params, turnId: "other" } });
  waits.resolveTurn("thread", "turn"); assert.equal(waits.size, 1);
  const snapshot = waits.snapshot("thread", false);
  assert.equal(parseSharedInteractionSnapshot({ ...snapshot, requests: [...snapshot.requests, ...snapshot.requests] }), null);
  assert.equal(parseSharedInteractionSnapshot({ ...snapshot, requests: [{ ...snapshot.requests[0], params: { threadId: "foreign" } }] }), null);
});

test("a synchronous terminal observer cannot send a retired native response", async () => {
  const waits = new HostInteractions(), id = waits.capture(source());
  waits.subscribe(() => { if (waits.snapshot("thread", true).requests[0]?.state === "responding") waits.resolveNative(1, "thread"); });
  assert.equal(await waits.respond("thread", id, "answer", { answers: {} }, async () => assert.fail("retired response executed")), "resolved");
});
test("only explicit native active flags establish a human wait", () => {
  assert.equal(humanInteractionWaitReason({ type: "active", activeFlags: ["waitingOnApproval"] }), "approval");
  assert.equal(humanInteractionWaitReason({ type: "active", activeFlags: ["waitingOnUserInput"] }), "input");
  for (const status of [null, {}, { type: "idle", activeFlags: ["waitingOnApproval"] }, { type: "active", activeFlags: [] }]) assert.equal(humanInteractionWaitReason(status), null);
});
