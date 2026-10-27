import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import type { TransportStatus } from "@opencraft/appserver-client";

import { LocalAttachmentStagingService } from "../../apps/local-agent-host/src/attachments/local-attachment-staging.js";
import { AppHostServer } from "../../packages/app-host-server/src/index.js";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";

test("Web AppHost uploads binary files through the advertised 32 MiB staging limit", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-web-upload-"));
  await writeFile(join(root, "index.html"), "<!doctype html>");
  const staging = new LocalAttachmentStagingService(join(root, "attachments"));
  const listeners = new Set<(frame: string) => void>();
  let status: TransportStatus = { state: "idle" };
  const statuses = new Set<(value: TransportStatus) => void>();
  const publish = (value: TransportStatus) => { status = value; for (const listener of statuses) listener(value); };
  const appHost = new AppHostServer({
    createTransport: () => ({
      get status() { return status; },
      async connect() { publish({ state: "open" }); },
      async send(frame: string) {
        const request = JSON.parse(frame);
        let reply;
        try {
          reply = { result: await staging.handle(request.method, request.params) };
        } catch (error) {
          reply = { error: { code: -32602, message: (error as Error).message } };
        }
        for (const listener of listeners) listener(JSON.stringify({
          jsonrpc: "2.0", id: request.id, ...reply, __opencraftClient: request.__opencraftClient,
        }));
      },
      subscribeMessage(listener: (frame: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      subscribeStatus(listener: (value: TransportStatus) => void) { statuses.add(listener); return () => { statuses.delete(listener); }; },
      async close() { publish({ state: "closed" }); },
    }),
  });
  const web = await createWorkbenchWebServer({ root, appHostServer: appHost, appServerTarget: null });
  const address = await web.listen({ host: "127.0.0.1", port: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/apphost`);
  socket.on("error", () => {});
  const frames: any[] = [];
  socket.on("message", raw => frames.push(JSON.parse(raw.toString())));
  const waitFor = async (predicate: (frame: any) => boolean) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = frames.find(predicate);
      if (found) return found;
      assert.notEqual(socket.readyState, WebSocket.CLOSED, "Upload must not disconnect the Host");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Upload response did not arrive");
  };
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, rendererId: "upload-client" }));
    await waitFor(frame => frame.type === "ready");
    socket.send(JSON.stringify({ type: "host/connect", requestId: "connect", hostId: "upload-host", leaseId: "upload-lease" }));
    const connected = await waitFor(frame => frame.type === "response" && frame.requestId === "connect");
    assert.equal(connected.ok, true);
    const rpc = async (id: string, params: unknown) => {
      socket.send(JSON.stringify({
        type: "host/send", requestId: `send-${id}`, hostId: "upload-host", leaseId: "upload-lease",
        generation: connected.result.generation,
        frame: JSON.stringify({ jsonrpc: "2.0", id, method: "attachment/stage", params }),
      }));
      const response = await waitFor(frame => frame.type === "host/frame" && JSON.parse(frame.frame).id === id);
      return JSON.parse(response.frame);
    };
    for (const size of [1024, 13 * 1024 * 1024, 32 * 1024 * 1024]) {
      const bytes = size === 1024 ? Buffer.alloc(size, "A") : randomBytes(size);
      const reply = await rpc(`file-${size}`, {
        clientAttachmentId: `file-${size}`, name: size === 1024 ? "notes.txt" : "archive.bin",
        mimeType: size === 1024 ? "text/plain" : "application/octet-stream", size,
        source: { kind: "client-bytes", dataBase64: bytes.toString("base64") },
      });
      assert.equal(reply.error, undefined);
      assert.equal(reply.result.ref.size, size);
      const stored = await readFile(reply.result.ref.location.path);
      assert.equal(createHash("sha256").update(stored).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
    }
    const rejected = await rpc("oversize-file", {
      clientAttachmentId: "oversize-file", name: "oversize.bin", mimeType: "application/octet-stream",
      size: 33 * 1024 * 1024, source: { kind: "client-bytes", dataBase64: "AA==" },
    });
    assert.match(rejected.error.message, /exceeds/u);
    assert.equal(socket.readyState, WebSocket.OPEN, "A file size rejection must preserve the connection");
    // The transport remains bounded even after accommodating the Base64 envelope.
    const closed = new Promise<number>(resolve => socket.once("close", code => resolve(code)));
    socket.send("x".repeat(49 * 1024 * 1024));
    assert.equal(await closed, 1009);
  } finally {
    socket.terminate();
    await web.close();
    await appHost.close();
    await rm(root, { recursive: true, force: true });
  }
});
