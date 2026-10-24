import assert from "node:assert/strict";
import test from "node:test";

import {
  AppServerInteractionLedger,
  AppServerInteractionLedgerError,
} from "@opencraft/composer-appserver";
import type {
  InteractionResponse,
  PendingInteraction,
} from "@opencraft/chat-runtime";

function interaction(requestId = "appserver-rpc:[\"string\",\"picker-1\"]") {
  return {
    requestId,
    method: "item/tool/requestOptionPicker",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    receivedAtMs: 1,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      question: "Choose",
      options: [{ label: "One" }, { label: "Two" }],
    },
  } satisfies PendingInteraction & { readonly threadId: string };
}

function skip(requestId = interaction().requestId): InteractionResponse {
  return {
    type: "option-picker",
    requestId,
    action: "skip",
    selectedOptions: [],
    freeformAnswer: null,
  };
}

test("interaction ledger makes an exact response idempotent and rejects drift", () => {
  const ledger = new AppServerInteractionLedger();
  const pending = interaction();
  const response = skip();

  assert.equal(ledger.remember(pending, response).state, "resolving");
  assert.deepEqual(ledger.remember(pending, structuredClone(response)), {
    response,
    state: "resolving",
  });
  ledger.markDelivered(pending, response);
  assert.deepEqual(ledger.recall(pending), { response, state: "delivered" });

  assert.throws(
    () => ledger.remember(pending, { ...response, action: "dismiss" }),
    AppServerInteractionLedgerError,
  );
  assert.throws(
    () => ledger.recall({
      ...pending,
      params: { ...pending.params, question: "A different request" },
    }),
    AppServerInteractionLedgerError,
  );
});

test("interaction ledger bounds reconnect replay with a TTL", () => {
  let now = 1_000;
  const ledger = new AppServerInteractionLedger({ now: () => now, ttlMs: 100 });
  const pending = interaction();
  ledger.remember(pending, skip());
  now = 1_099;
  assert.notEqual(ledger.recall(pending), null);
  now = 1_200;
  assert.equal(ledger.recall(pending), null);
});
