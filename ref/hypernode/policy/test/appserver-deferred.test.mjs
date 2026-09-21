import assert from "node:assert/strict";
import test from "node:test";

import {
  AppServerVService,
  deferredAppServerResponse,
} from "../src/services/appserver.ts";

function harness(handler) {
  const sent = [];
  const audits = [];
  const service = Object.create(AppServerVService.prototype);
  service.handlers = new Map([["test/deferred", handler]]);
  service.interceptors = new Set();
  service.afterRequestListeners = new Set();
  service.afterResponseListeners = new Set();
  service.outboundProjectors = new Set();
  service.connections = new Set();
  service.presentationBarriers = { flush() {} };
  service.send = (_connection, message) => sent.push(message);
  service.audit = (_connection, type, payload) => audits.push({ type, payload });
  service.flushNotifications = () => {};
  const connection = {
    socket: {},
    clientInfo: null,
    initializeParams: null,
    initialized: true,
    pendingNotifications: [],
    deferredActions: [],
    watches: new Map(),
    unroutableWatchPaths: new Set(),
    identity: null,
    connectionId: "test",
    sessionId: "test",
  };
  service.connections.add(connection);
  return { service, connection, sent, audits };
}

test("app-server deferred handlers send exactly one later response", () => {
  let controller;
  const { service, connection, sent, audits } = harness(() => (
    deferredAppServerResponse((value) => { controller = value; })
  ));
  service.onMessage(connection.socket, JSON.stringify({
    id: "request-1",
    method: "test/deferred",
    params: {},
  }), connection);
  assert.deepEqual(sent, []);
  controller.resolve({ ok: true });
  controller.resolve({ ignored: true });
  assert.deepEqual(sent, [{ id: "request-1", result: { ok: true } }]);
  assert.equal(audits.at(-1).type, "rpc.response");
});

test("app-server deferred handlers preserve JSON-RPC errors", () => {
  let controller;
  const { service, connection, sent, audits } = harness(() => (
    deferredAppServerResponse((value) => { controller = value; })
  ));
  service.onMessage(connection.socket, JSON.stringify({
    id: "request-2",
    method: "test/deferred",
    params: {},
  }), connection);
  controller.reject(Object.assign(new Error("upstream unavailable"), { code: -32042 }));
  assert.deepEqual(sent, [{
    id: "request-2",
    error: { code: -32042, message: "upstream unavailable" },
  }]);
  assert.equal(audits.at(-1).type, "rpc.error");
});

test("app-server deferred work requests a host wake and advances on service tick", () => {
  const previousHostEvents = globalThis.hostEvents;
  const wakes = [];
  globalThis.hostEvents = { wakeAfter: (delayMs) => wakes.push(delayMs) };
  try {
    const { service } = harness(() => ({}));
    let runs = 0;
    service.defer([...service.connections][0], 7, () => { runs += 1; });
    assert.deepEqual(wakes, [7]);
    service.tick(Date.now() + 6);
    assert.equal(runs, 0);
    service.tick(Date.now() + 8);
    assert.equal(runs, 1);
  } finally {
    globalThis.hostEvents = previousHostEvents;
  }
});
