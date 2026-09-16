import assert from "node:assert/strict";
import test from "node:test";

import {
  ProtocolAuditTable,
  protocolThreadId,
  redactProtocolValue,
  reduceProtocolProjection,
} from "../src/services/protocol-audit.ts";

test("protocolThreadId recognizes request and response shapes", () => {
  assert.equal(protocolThreadId({ params: { threadId: "thread-a" } }), "thread-a");
  assert.equal(protocolThreadId({ result: { thread: { id: "thread-b" } } }), "thread-b");
  assert.equal(protocolThreadId({ result: {} }), null);
});

test("redactProtocolValue removes nested credentials without changing other fields", () => {
  assert.deepEqual(redactProtocolValue({
    model: "kimi-k3",
    apiKey: "secret",
    nested: { Authorization: "Bearer secret", enabled: true },
  }), {
    model: "kimi-k3",
    apiKey: "[REDACTED]",
    nested: { Authorization: "[REDACTED]", enabled: true },
  });
});

test("reduceProtocolProjection preserves event order and direction counts", () => {
  const initial = { total: 0, inbound: 0, outbound: 0, methods: {}, last: null };
  const inbound = reduceProtocolProjection(initial, {
    type: "hypernode/protocol", seq: 0,
    data: { direction: "inbound", method: "turn/start", rpcId: 7 },
  });
  const outbound = reduceProtocolProjection(inbound, {
    type: "hypernode/protocol", seq: 1,
    data: { direction: "outbound", method: "turn/start", rpcId: 7 },
  });
  assert.deepEqual(outbound, {
    total: 2,
    inbound: 1,
    outbound: 1,
    methods: { "turn/start": 2 },
    last: { seq: 1, direction: "outbound", method: "turn/start", rpcId: 7 },
  });
});

test("protocol audit uses an isolated append-only ledger", () => {
  const table = new ProtocolAuditTable({ available: false });
  const first = table.append("thread-1", {
    direction: "inbound", method: "turn/start", rpcId: 7,
  });
  const second = table.append("thread-1", {
    direction: "outbound", method: "turn/start", rpcId: 7,
  });
  assert.equal(first.seq, 0);
  assert.equal(second.seq, 1);
  assert.deepEqual(table.events("thread-1").map((event) => event.data.direction), [
    "inbound", "outbound",
  ]);
});
