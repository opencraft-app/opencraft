import assert from "node:assert/strict";
import test from "node:test";

import { bindCloudflareSockets } from "../src/runtime/cloudflare-sockets.ts";
import { PortForwardService } from "../src/services/port-forward.ts";

function createHarness() {
  const calls = [];
  const workerSocket = {
    opened: Promise.resolve({}),
    closed: new Promise(() => {}),
    readable: {},
    writable: {},
    close: async () => {},
    startTls() { return this; },
  };
  const transport = {
    write(bytes) { calls.push({ method: "write", bytes: [...bytes] }); },
    closeWrite() { calls.push({ method: "closeWrite" }); },
    drain() {
      calls.push({ method: "drain" });
      return { dataBytes: Uint8Array.of(4, 5), closed: false, error: null };
    },
    close() { calls.push({ method: "close" }); },
  };
  const outboundTcp = {
    connect(address, options) {
      calls.push({ method: "connect", address, options });
      return workerSocket;
    },
    claimTransport(socket) {
      assert.equal(socket, workerSocket);
      calls.push({ method: "claimTransport" });
      return transport;
    },
  };
  bindCloudflareSockets(outboundTcp);
  const service = Object.create(PortForwardService.prototype);
  service.ctx = { outboundTcp };
  service.sequence = 0;
  service.sockets = new Map();
  return { calls, service, transport };
}

const connection = {
  identity: { id: "user:alice" },
  metadata: { connectionId: "connection-1" },
};
const channel = { localId: 7 };

test("direct-tcpip forwarding requires identity and validates its target", () => {
  const { service } = createHarness();
  assert.throws(
    () => service.open({ metadata: { connectionId: "anonymous" } }, channel, {
      hostname: "localhost",
      port: 80,
    }),
    /authenticated identity/,
  );
  assert.throws(() => service.open(connection, channel, { hostname: "", port: 80 }), /invalid/);
  assert.throws(
    () => service.open(connection, channel, { hostname: "localhost", port: 65536 }),
    /invalid/,
  );
});

test("direct-tcpip forwarding preserves half-close and drain semantics", () => {
  const { calls, service } = createHarness();
  const socket = service.open(connection, channel, { hostname: "127.0.0.1", port: 8080 });

  assert.equal(socket.id, "vssh-forward:connection-1:7:1");
  assert.deepEqual(calls[0], {
    method: "connect",
    address: { hostname: "127.0.0.1", port: 8080 },
    options: { secureTransport: "off", allowHalfOpen: true },
  });
  assert.deepEqual(calls[1], { method: "claimTransport" });

  service.write(socket, Uint8Array.of(1, 2, 3));
  service.closeWrite(socket);
  assert.deepEqual(service.drain(socket), {
    dataBytes: Uint8Array.of(4, 5),
    closed: false,
    error: null,
  });
  service.close(socket);
  service.close(socket);

  assert.deepEqual(calls.slice(2), [
    { method: "write", bytes: [1, 2, 3] },
    { method: "closeWrite" },
    { method: "drain" },
    { method: "close" },
  ]);
  assert.deepEqual(service.drain(socket), {
    dataBytes: new Uint8Array(0),
    closed: true,
    error: null,
  });
});

test("transport failures become deterministic forward close results", () => {
  const { service, transport } = createHarness();
  const socket = service.open(connection, channel, { hostname: "example.com", port: 443 });
  transport.write = () => { throw new Error("write failed"); };

  service.write(socket, Uint8Array.of(9));
  assert.deepEqual(service.drain(socket), {
    dataBytes: new Uint8Array(0),
    closed: true,
    error: "write failed",
  });
  assert.throws(
    () => service.write(socket, new Uint8Array(4 * 1024 * 1024 + 1)),
    /exceeds limit/,
  );
});
