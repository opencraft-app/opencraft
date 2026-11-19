import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { startEngineHost } from "../../apps/local-agent-host/src/engine-host.js";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";
import { DshConsumerReceipts } from "../../scripts/server-deployment/dsh-consumer-receipts.mjs";
import { LOGICAL_CLIENT_FIELD } from "../../packages/app-host-protocol/src/index.js";
for (const proxy of [false, true])
  test(`current Gateway consumes/ACKs DSH replies once, including errors (${proxy ? "Web" : "direct"})`, async (t) => {
    const root = await mkdtemp("/tmp/engine-receipt-");
    await writeFile(join(root, "index.html"), "<!doctype html>");
    const ledger = await DshConsumerReceipts.open(root),
      server = createServer(),
      sockets = new WebSocketServer({ server });
    let acknowledged = 0;
    sockets.on("connection", (peer) =>
      peer.on("message", async (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.method === "opencraft/owner/receipt") {
          await ledger.acknowledge(frame.params);
          acknowledged++;
          return;
        }
        if (frame.id === undefined) return;
        const finish = await ledger.begin(frame),
          packet = {
            jsonrpc: "2.0",
            id: frame.id,
            [LOGICAL_CLIENT_FIELD]: frame[LOGICAL_CLIENT_FIELD],
            ...(frame.method === "initialize"
              ? { result: { userAgent: "fixture", platformFamily: "unix", platformOs: "linux" } }
              : { error: { code: -32004, message: "Missing", data: { code: "THREAD_NOT_FOUND" } } }),
          };
        peer.send(JSON.stringify({ ...packet, opencraftDshReceipt: await finish(packet) }));
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const target = `ws://127.0.0.1:${(server.address() as any).port}`;
    const host = await startEngineHost({
      providers: [],
      defaultEngine: "dsh",
      legacy: { id: "dsh", label: "DSH", start: async () => ({ websocketUrl: target, async close() {} }) },
    });
    let web: any,
      url = host.websocketUrl;
    if (proxy) {
      web = await createWorkbenchWebServer({ root, appServerTarget: url });
      const address = await web.listen({ host: "127.0.0.1", port: 0 });
      url = `ws://127.0.0.1:${address.port}/appserver`;
    }
    const client = new WebSocket(url);
    await once(client, "open");
    t.after(async () => {
      client.terminate();
      await web?.close();
      await host.close();
      for (const peer of sockets.clients) peer.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ledger.close();
      await rm(root, { recursive: true, force: true });
    });
    for (const [i, method] of ["initialize", "thread/resume"].entries()) {
      const response = once(client, "message");
      client.send(
        JSON.stringify({ id: i, method, params: { threadId: "dsh-missing" }, [LOGICAL_CLIENT_FIELD]: "logical" }),
      );
      const reply = JSON.parse(String((await response)[0]));
      assert.equal(reply.id, i);
      assert.equal(reply[LOGICAL_CLIENT_FIELD], "logical");
      assert.equal(reply.opencraftDshReceipt, undefined);
      if (i) assert.deepEqual(reply.error, { code: -32004, message: "Missing", data: { code: "THREAD_NOT_FOUND" } });
    }
    for (let i = 0; i < 100 && acknowledged < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(acknowledged, 2);
    assert.equal(ledger.observation().activeCount, 0);
  });
