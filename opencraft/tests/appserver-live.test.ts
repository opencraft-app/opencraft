import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";

import { createCordisAppServerClient } from "@opencraft/appserver-client";
import {
  type AppServerWebSocket,
  WebSocketTransport,
} from "@opencraft/appserver-transport-websocket";

test("real HyperNode 9988 AppServer completes WebSocket initialize", async () => {
  const url = process.env.OPENCRAFT_APPSERVER_WS_URL ?? "ws://127.0.0.1:9988/rpc";
  const transport = new WebSocketTransport({
    url,
    closeTimeoutMs: 250,
    // The live gate runs under Node. `ws` supplies terminate() so a peer that
    // omits the closing frame cannot keep the test process alive.
    createSocket: (socketUrl) => new WebSocket(socketUrl) as unknown as AppServerWebSocket,
  });
  const runtime = await createCordisAppServerClient({
    hostId: "hypernode-local",
    transport,
    requestTimeoutMs: 5_000,
  });

  try {
    const initialized = await runtime.client.connect({
      clientInfo: { name: "opencraft-live-gate", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    assert.equal(initialized.platformFamily, "unix");
    assert.equal(initialized.platformOs, "linux");
    assert.ok(initialized.codexHome.length > 0);
    assert.ok(initialized.userAgent.length > 0);
  } finally {
    await runtime.dispose();
  }
});
