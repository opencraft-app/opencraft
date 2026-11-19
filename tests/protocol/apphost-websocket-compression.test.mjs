import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { appHostWebSocketOptions } from "../../scripts/apphost-websocket-options.mjs";

const cases = [
  { name: "enabled", compression: true },
  { name: "disabled", compression: false },
  { name: "without a client window offer", compression: { clientMaxWindowBits: false } },
  { name: "with a smaller client window", compression: { clientMaxWindowBits: 10 } },
];

for (const { name, compression } of cases) {
  test(`AppHost compression interoperates ${name}`, { timeout: 5000 }, async (t) => {
    const http = createServer();
    const server = new WebSocketServer(appHostWebSocketOptions());
    http.on("upgrade", (request, socket, head) =>
      server.handleUpgrade(request, socket, head, (client) => server.emit("connection", client, request)),
    );
    server.on("connection", (socket) => socket.on("message", (data, binary) => socket.send(data, { binary })));
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const client = new WebSocket(`ws://127.0.0.1:${http.address().port}`, { perMessageDeflate: compression });
    t.after(async () => {
      client.terminate();
      for (const socket of server.clients) socket.terminate();
      await new Promise((r) => server.close(r));
      await new Promise((r) => http.close(r));
    });
    let negotiated = "";
    client.on("upgrade", (response) => {
      negotiated = response.headers["sec-websocket-extensions"] ?? "";
    });
    await once(client, "open");
    if (compression) {
      assert.match(negotiated, /server_no_context_takeover/);
      assert.match(negotiated, /client_no_context_takeover/);
      if (compression.clientMaxWindowBits === false) assert.doesNotMatch(negotiated, /client_max_window_bits/);
      if (typeof compression.clientMaxWindowBits === "number") {
        assert.match(negotiated, new RegExp(`client_max_window_bits=${compression.clientMaxWindowBits}(?:;|$)`));
      }
    } else assert.equal(negotiated, "");
    for (const body of ["ping", JSON.stringify({ method: "history", text: "你好 ".repeat(20000) })]) {
      const received = once(client, "message");
      const wire = once(client._socket, "data");
      client.send(body);
      const [data, binary] = await received;
      assert.equal(binary, false);
      assert.equal(data.toString(), body);
      const [frame] = await wire;
      assert.equal(
        Boolean(frame[0] & 0x40),
        compression && Buffer.byteLength(body) >= 1024,
        "RSV1 follows negotiated compression and the small-frame threshold",
      );
    }
  });
}
