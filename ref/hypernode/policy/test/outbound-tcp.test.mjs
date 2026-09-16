import assert from "node:assert/strict";
import test from "node:test";

import { connect, bindCloudflareSockets } from "../src/runtime/cloudflare-sockets.ts";
import { OutboundTcpService } from "../src/services/outbound-tcp.ts";

function createHarness() {
  const calls = [];
  const queues = new Map();
  const driver = {
    open(id, address, options) {
      calls.push({ method: "open", id, address, options });
      queues.set(id, []);
      return { localAddress: "127.0.0.1:40000", remoteAddress: `${address.hostname}:${address.port}` };
    },
    write(id, bytes) { calls.push({ method: "write", id, bytes: [...bytes] }); return bytes.byteLength; },
    shutdownWrite(id) { calls.push({ method: "shutdownWrite", id }); },
    drain(id) { return queues.get(id).shift() ?? { dataBytes: new Uint8Array(0), closed: false, error: null }; },
    startTls(id) {
      calls.push({ method: "startTls", id });
      return { localAddress: "127.0.0.1:40000", remoteAddress: "example.com:443" };
    },
    close(id) { calls.push({ method: "close", id }); queues.delete(id); },
  };
  const service = Object.create(OutboundTcpService.prototype);
  service.driver = driver;
  service.sequence = 0;
  service.sockets = new Map();
  bindCloudflareSockets(service);
  return { calls, connect, driver, queues, service };
}

test("cloudflare:sockets connect exposes the Worker Socket contract", async () => {
  const { calls, queues, service } = createHarness();
  const socket = connect({ hostname: "example.com", port: 80 }, {
    secureTransport: "off",
    allowHalfOpen: true,
  });

  assert.equal(typeof socket.readable.getReader, "function");
  assert.equal(typeof socket.writable.getWriter, "function");
  assert.equal(typeof socket.close, "function");
  assert.equal(typeof socket.startTls, "function");
  assert.deepEqual(await socket.opened, {
    localAddress: "127.0.0.1:40000",
    remoteAddress: "example.com:80",
  });

  const writer = socket.writable.getWriter();
  await writer.write(Uint8Array.of(1, 2, 3));
  assert.deepEqual(calls.at(-1), { method: "write", id: socket.id, bytes: [1, 2, 3] });

  const reader = socket.readable.getReader();
  const pendingRead = reader.read();
  queues.get(socket.id).push({ dataBytes: Uint8Array.of(4, 5), closed: false, error: null });
  service.drain(socket);
  assert.deepEqual(await pendingRead, { value: Uint8Array.of(4, 5), done: false });

  await writer.close();
  assert.equal(calls.at(-1).method, "shutdownWrite");
  reader.releaseLock();
  await socket.close();
  assert.equal(calls.at(-1).method, "close");
  await socket.closed;
});

test("startTls replaces a starttls socket and detaches the plaintext streams", async () => {
  const { calls } = createHarness();
  const plain = connect("example.com:443", { secureTransport: "starttls" });
  await plain.opened;
  const secure = plain.startTls();

  assert.notEqual(secure, plain);
  assert.equal(calls.at(-1).method, "startTls");
  assert.deepEqual(await secure.opened, {
    localAddress: "127.0.0.1:40000",
    remoteAddress: "example.com:443",
  });
  await plain.closed;
  await secure.close();
});

test("connect validates Cloudflare SocketAddress and SocketOptions", () => {
  createHarness();
  assert.throws(() => connect("missing-port"), /host:port/);
  assert.throws(() => connect({ hostname: "localhost", port: 70000 }), /between 1 and 65535/);
  assert.throws(() => connect("localhost:80", { secureTransport: "maybe" }), /secureTransport/);
});

test("a claimed transport has one inbound consumer and is not drained by the stream pump", async () => {
  const { queues, service } = createHarness();
  const socket = connect("127.0.0.1:22", { allowHalfOpen: true });
  await socket.opened;
  const transport = service.claimTransport(socket);
  queues.get(socket.id).push({ dataBytes: Uint8Array.of(7, 8, 9), closed: false, error: null });

  service.tick();
  assert.deepEqual(transport.drain(), {
    dataBytes: Uint8Array.of(7, 8, 9),
    closed: false,
    error: null,
  });
  transport.close();
  await socket.closed;
});
