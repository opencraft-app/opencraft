import assert from "node:assert/strict";
import test from "node:test";
import { VirtualWebSocketServer } from "../src/runtime/virtual-websocket.ts";

function maskedTextFrame(text) {
  const payload = new TextEncoder().encode(text);
  const mask = Uint8Array.from([0x12, 0x34, 0x56, 0x78]);
  const frame = new Uint8Array(2 + mask.length + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  frame.set(mask, 2);
  for (let index = 0; index < payload.length; index += 1) {
    frame[6 + index] = payload[index] ^ mask[index % mask.length];
  }
  return frame;
}

test("virtual WebSocket performs the RFC handshake and routes masked text frames", () => {
  const server = new VirtualWebSocketServer();
  const received = [];
  server.route("/rpc", (socket, metadata) => {
    assert.equal(metadata.path, "/rpc");
    assert.equal(metadata.sessionId, "session-1");
    socket.on("message", (message) => {
      received.push(message);
      socket.send({ ok: true });
    });
  });
  const connection = server.connect("session-1");
  const request = new TextEncoder().encode([
    "GET /rpc HTTP/1.1",
    "Host: localhost",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "",
    "",
  ].join("\r\n"));

  const handshake = new TextDecoder().decode(connection.feed(request));
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/m);
  assert.match(handshake, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);

  const response = connection.feed(maskedTextFrame("hello"));
  assert.deepEqual(received, ["hello"]);
  assert.equal(response[0], 0x81);
  assert.equal(new TextDecoder().decode(response.slice(2)), JSON.stringify({ ok: true }));
});

test("virtual WebSocket rejects an unknown route without constructing a socket", () => {
  const server = new VirtualWebSocketServer();
  const connection = server.connect("session-2");
  const request = new TextEncoder().encode([
    "GET /missing HTTP/1.1",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "",
    "",
  ].join("\r\n"));
  assert.equal(
    new TextDecoder().decode(connection.feed(request)),
    "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n",
  );
});
