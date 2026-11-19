import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryGitIdentityBroker } from "../../scripts/git-identity-ipc.js";

for (const [name, response, expected] of [
  ["malformed", "not JSON\n", "response-invalid"],
  ["non-object", "null\n", "response-invalid"],
  ["truncated", '{"status":', "broker-disconnected"],
  ["oversized", "x".repeat(33000), "response-too-large"],
  ["timeout", null, "request-timeout"],
] as const)
  test(`broker IPC preserves a sanitized ${name} transport reason`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "git-ipc-")),
      path = join(root, "broker.sock");
    const clients = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      clients.add(socket);
      socket.on("error", () => {});
      socket.once("data", () => {
        if (response !== null) socket.end(response);
      });
      socket.once("close", () => clients.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    t.after(async () => {
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    await assert.rejects(
      queryGitIdentityBroker(path, { op: "probe" }, 500),
      (error: any) => error.code === expected && !error.message.includes(root),
    );
  });

test("missing broker is distinct from malformed authorization and exposes no path", async () => {
  const path = join(tmpdir(), "opencraft-missing-" + Date.now(), "broker.sock");
  await assert.rejects(
    queryGitIdentityBroker(path, { op: "probe" }),
    (error: any) => error.code === "connect-missing" && !error.message.includes(path),
  );
});
