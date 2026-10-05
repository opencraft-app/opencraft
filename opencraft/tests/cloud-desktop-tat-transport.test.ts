import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import type { TencentTatSessionMultiplexer, TsshProxyTarget } from "../plugins/lightvela-hermes/src/lib/tencent-tat-session-multiplexer";
import { createTatWebSocketConstructor } from "../plugins/lightvela-hermes/src/lib/tat-websocket";

// Exercise the real RFC6455 adapter; replace only the external TAT byte stream.
// This is not a live cloud tunnel, noVNC decoder or desktop-input authorization test.
function desktopTunnelFixture() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const writes: Uint8Array[] = [];
  const targets: TsshProxyTarget[] = [];
  let opened = false;
  let closes = 0;
  const connection = {
    readable: new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
    write(data: Uint8Array | ArrayBuffer | string) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data)
        : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      if (opened) { writes.push(bytes.slice()); return true; }
      opened = true;
      const head = new TextDecoder().decode(bytes);
      assert.match(head, /^GET \/websockify HTTP\/1\.1\r\n/u);
      assert.match(head, /Sec-WebSocket-Protocol: binary\r\n/iu);
      const key = /Sec-WebSocket-Key:\s*([^\r\n]+)/iu.exec(head)?.[1]?.trim();
      assert.ok(key);
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      controller.enqueue(new TextEncoder().encode([
        "HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`, "Sec-WebSocket-Protocol: binary", "", "",
      ].join("\r\n")));
      return true;
    },
    close() { closes += 1; controller.close(); },
  };
  const proxy = {
    async openProxy(target: TsshProxyTarget) { targets.push(target); return connection; },
    close() { throw new Error("viewer must not close the shared Host tunnel"); },
  } as unknown as TencentTatSessionMultiplexer;
  const Constructor = createTatWebSocketConstructor(proxy, {
    origin: "https://desktop.example.test", closeTimeoutMs: 0,
  });
  const socket = new Constructor("ws://127.0.0.1:6080/websockify", "binary");
  socket.binaryType = "arraybuffer";
  return { socket, writes, targets, feed: (bytes: Uint8Array) => controller.enqueue(bytes), closes: () => closes };
}

test("desktop TAT WebSocket preserves fragmented binary data and masked client bytes", { timeout: 3000 }, async () => {
  const f = desktopTunnelFixture();
  await once(f.socket, "open");
  assert.deepEqual(f.targets, [{ ip: "127.0.0.1", port: "6080" }]);
  assert.equal(f.socket.protocol, "binary");
  const incoming = once(f.socket, "message");
  // Fragmented binary message, split again at arbitrary raw TCP boundaries.
  f.feed(new Uint8Array([0x02]));
  f.feed(new Uint8Array([3, 0, 255, 128, 0x80, 3]));
  f.feed(new Uint8Array([1, 13, 10]));
  const [event] = await incoming as [MessageEvent<ArrayBuffer>];
  assert.deepEqual(new Uint8Array(event.data), new Uint8Array([0, 255, 128, 1, 13, 10]));
  const input = new Uint8Array([0, 255, 128, 3, 13, 10]);
  f.socket.send(new Blob([input]));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.writes.length, 1);
  const frame = f.writes[0]!;
  assert.equal(frame[0], 0x82);
  assert.equal(frame[1]! & 0x80, 0x80);
  assert.equal(frame[1]! & 0x7f, input.length);
  const unmasked = frame.slice(6).map((byte, index) => byte ^ frame[2 + index % 4]!);
  assert.deepEqual(unmasked, input);
  const closed = once(f.socket, "close");
  f.feed(new Uint8Array([0x88, 2, 3, 232])); // Clean server Close(1000).
  await closed;
  assert.equal(f.closes(), 1);
  assert.equal(f.socket.readyState, WebSocket.CLOSED);
});

test("desktop TAT WebSocket accepts a large binary frame without text decoding", { timeout: 3000 }, async () => {
  const f = desktopTunnelFixture();
  await once(f.socket, "open");
  const size = 1024 * 1024;
  const payload = Uint8Array.from({ length: size }, (_, index) => index % 256);
  const frame = new Uint8Array(10 + size);
  frame[0] = 0x82; frame[1] = 127;
  new DataView(frame.buffer).setBigUint64(2, BigInt(size));
  frame.set(payload, 10);
  const incoming = once(f.socket, "message");
  for (let offset = 0; offset < frame.length; offset += 65536) f.feed(frame.slice(offset, offset + 65536));
  const [event] = await incoming as [MessageEvent<ArrayBuffer>];
  assert.deepEqual(new Uint8Array(event.data), payload);
  const closed = once(f.socket, "close");
  f.feed(new Uint8Array([0x88, 2, 3, 232]));
  await closed;
  assert.equal(f.closes(), 1);
});
