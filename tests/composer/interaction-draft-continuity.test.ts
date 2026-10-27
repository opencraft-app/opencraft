import assert from "node:assert/strict";
import { test } from "node:test";
import { InteractionDraftStore, interactionDraftIdentity } from "../../apps/workbench-web/src/components/conversation-renderers/interaction/interaction-drafts";
import type { AttachedInteractionTimelineBlock } from "@opencraft/chat-core";

test("a disconnected panel can reclaim its input without a transport generation", () => {
  const store = new InteractionDraftStore();
  const scope = JSON.stringify(["host", "thread", "view"]);
  const entry = store.prepare(scope, "turn:request:form-definition");
  store.retain(scope, entry);
  entry.values.set("form", { name: "中文草稿", count: "3", enabled: false });
  assert.equal(store.prepare(scope, entry.identity), entry);
  assert.deepEqual(store.prepare(scope, entry.identity).values.get("form"), { name: "中文草稿", count: "3", enabled: false });
});

test("Host, Thread and View scopes never share pending input", () => {
  const store = new InteractionDraftStore();
  const scope = JSON.stringify(["host", "thread", "view"]);
  const entry = store.prepare(scope, "request");
  store.retain(scope, entry);
  entry.values.set("form", { secret: "synthetic draft" });
  for (const other of [["other", "thread", "view"], ["host", "other", "view"], ["host", "thread", "other"]]) {
    assert.equal(store.prepare(JSON.stringify(other), "request").values.size, 0);
  }
});

test("new requests, turns and definitions reset input; an abandoned render does not", () => {
  const store = new InteractionDraftStore();
  const first = store.prepare("scope", "turn1:request1:definition1");
  store.retain("scope", first);
  first.values.set("freeform", "draft");
  for (const identity of ["turn1:request2:definition1", "turn2:request1:definition1", "turn1:request1:definition2"]) {
    assert.equal(store.prepare("scope", identity).values.size, 0);
    assert.equal(store.prepare("scope", first.identity), first);
  }
});

test("successful submission clears its draft and a late completion cannot clear a new request", () => {
  const store = new InteractionDraftStore();
  const first = store.prepare("scope", "first");
  store.retain("scope", first);
  first.values.set("form", { name: "first draft" });
  store.release("scope", first);
  assert.equal(store.prepare("scope", "first").values.size, 0);
  const next = store.prepare("scope", "next");
  store.retain("scope", next);
  next.values.set("form", { name: "next draft" });
  store.release("scope", first);
  assert.equal(store.prepare("scope", "next"), next);
});

test("equivalent projected definitions retain identity; request and schema changes do not", () => {
  const block = { type: "elicitation", id: "presentation", sourceItemIds: [], state: "pending", requestId: "request", method: "mcpServer/elicitation/request", requestedSchema: { type: "object", properties: { name: { type: "string" } } } } as unknown as AttachedInteractionTimelineBlock;
  assert.equal(interactionDraftIdentity(block), interactionDraftIdentity({ ...JSON.parse(JSON.stringify(block)), id: "new presentation", sourceItemIds: ["new source"] }));
  assert.notEqual(interactionDraftIdentity(block), interactionDraftIdentity({ ...block, requestId: "new request" }));
  assert.notEqual(interactionDraftIdentity(block), interactionDraftIdentity({ ...block, requestedSchema: { type: "object", properties: { count: { type: "number" } } } } as AttachedInteractionTimelineBlock));
});
