/** Contract conformance for `openSandboxEndpoint` and `attached` process lifetime.
 * Every SandboxBackend harness in fixtures/sandbox-endpoint-backends.ts runs the same
 * assertions through createSandboxPool()/createSandbox(); a backend that cannot pass
 * them must not advertise endpoint support. */
import test from "node:test";
import assert from "node:assert/strict";
import type { Socket } from "node:net";
import { createSandbox, createSandboxPool, openSandboxEndpoint, SandboxFault, type Sandbox, type SandboxPool } from "@opencraft/sandbox";
import { harnesses, type EndpointHarness } from "./fixtures/sandbox-endpoint-backends";

const until = async (condition: () => boolean, ms = 10000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const echo = (socket: Socket) => {
  socket.on("data", data => socket.write(data));
  socket.on("end", () => socket.end());
  socket.on("error", () => {});
};

for (const make of await harnesses()) {
  const probe = await make();
  const name = probe.name;
  await probe.dispose();
  test(`endpoint conformance: ${name}`, { concurrency: false, timeout: 120000 }, async t => {
    const h: EndpointHarness = await make();
    const pool: SandboxPool = await createSandboxPool({ id: "endpoint", capacity: h.resources, defaults: h.resources }, h.backend);
    const open = async (sandbox: Sandbox, path: string, chunks: Buffer[]) =>
      openSandboxEndpoint(sandbox, { target: { unix: path }, python: h.python, onData: data => chunks.push(Buffer.from(data)) });
    t.after(async () => { await h.dispose(); await pool.close().catch(() => {}); });

    await t.test("binary bytes round trip unchanged and the relay is an attached pipe process", async () => {
      const sandbox = await createSandbox(pool, { owner: "conformance" });
      const path = await h.listen(echo), chunks: Buffer[] = [];
      const connection = await open(sandbox, path, chunks);
      const payload = Buffer.alloc(300 * 1024).map((_, i) => (i * 7) % 256);
      await connection.write(payload);
      await until(() => Buffer.concat(chunks).length >= payload.length);
      assert.ok(Buffer.concat(chunks).equals(payload));
      assert.equal(h.commands.at(-1)!.attached, true);
      assert.equal(h.commands.at(-1)!.terminal, undefined);
      // `attached` is Host-side lifetime; a guest broker never receives it.
      if (h.wire) assert.equal(h.wire.at(-1)!.attached, undefined);
      await connection.close();
      assert.equal(await connection.closed, "ended");
      await sandbox.close();
    });

    await t.test("Host EOF half-closes the target; target data and EOF still arrive", async () => {
      const sandbox = await createSandbox(pool, { owner: "conformance" });
      let received = "";
      const path = await h.listen(socket => {
        socket.on("data", data => { received += data; });
        socket.on("end", () => socket.end("bye:" + received));
      });
      const chunks: Buffer[] = [], connection = await open(sandbox, path, chunks);
      await connection.write(Buffer.from("hello"));
      await connection.end();
      assert.equal(await connection.closed, "ended");
      assert.equal(Buffer.concat(chunks).toString(), "bye:hello");
      await assert.rejects(connection.write(Buffer.from("late")), (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_CLOSED");
      await connection.close();
      await sandbox.close();
    });

    await t.test("target close ends only that connection", async () => {
      const sandbox = await createSandbox(pool, { owner: "conformance" });
      const path = await h.listen(socket => { socket.end("goodbye"); });
      const chunks: Buffer[] = [], connection = await open(sandbox, path, chunks);
      assert.equal(await connection.closed, "ended");
      assert.equal(Buffer.concat(chunks).toString(), "goodbye");
      const again = await open(sandbox, await h.listen(echo), []);
      await again.close();
      await sandbox.close();
    });

    await t.test("Host close ends the target connection and leaves the environment usable", async () => {
      const sandbox = await createSandbox(pool, { owner: "conformance" });
      let targetClosed = false, targetConnected = false;
      const path = await h.listen(socket => { targetConnected = true; socket.on("end", () => { targetClosed = true; socket.end(); }); socket.on("close", () => { targetClosed = true; }); socket.on("error", () => {}); });
      const connection = await open(sandbox, path, []);
      await until(() => targetConnected);
      await connection.close();
      await connection.close();
      await until(() => targetClosed);
      const chunks: Buffer[] = [], next = await open(sandbox, await h.listen(echo), chunks);
      await next.write(Buffer.from("still alive"));
      await until(() => Buffer.concat(chunks).toString() === "still alive");
      await next.close();
      const closes = h.closes.count;
      await sandbox.close();
      assert.equal(h.closes.count, closes + 1);
    });

    await t.test("Host writes wait for a target that is not reading (back-pressure), then complete in order", async () => {
      const sandbox = await createSandbox(pool, { owner: "conformance" });
      let target!: Socket;
      const received: Buffer[] = [];
      const path = await h.listen(socket => { target = socket; socket.pause(); socket.on("data", (data: Buffer) => received.push(data)); });
      const connection = await open(sandbox, path, []);
      const total = 12 * 1024 * 1024, chunk = Buffer.alloc(64 * 1024, 0x5a);
      let accepted = 0;
      const writing = (async () => { for (let sent = 0; sent < total; sent += chunk.length) { await connection.write(chunk); accepted += chunk.length; } })();
      await until(() => target !== undefined);
      await new Promise(resolve => setTimeout(resolve, 750));
      assert.ok(accepted < total, `writes must stall while the target does not read (accepted ${accepted})`);
      target.resume();
      await writing;
      await until(() => received.reduce((n, b) => n + b.length, 0) === total, 30000);
      await connection.close();
      await sandbox.close();
    });

    await t.test("an attached relay failing ends only its connection; environment and other processes stay alive", async () => {
      const sandbox = await createSandbox(pool, { owner: "conformance" });
      const closes = h.closes.count;
      const longRunning = await sandbox.spawn({ command: [...h.catCommand], cwd: "/", env: {} }, () => {});
      const chunks: Buffer[] = [], healthy = await open(sandbox, await h.listen(echo), chunks);
      const broken = await open(sandbox, h.missing(), []);
      assert.equal(await broken.closed, "failed");
      await broken.close();
      await healthy.write(Buffer.from("after failure"));
      await until(() => Buffer.concat(chunks).toString() === "after failure");
      let exited = false;
      void longRunning.exited.then(() => { exited = true; }, () => { exited = true; });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(exited, false, "a non-attached process in the same environment keeps running");
      assert.equal(h.closes.count, closes, "relay failure never retires the environment");
      await healthy.close();
      await longRunning.terminate();
      await sandbox.close();
    });

    await t.test("contract validation: attached is pipe-only and invalid targets never spawn", async () => {
      const sandbox = await createSandbox(pool, { owner: "conformance" });
      const count = h.commands.length;
      await assert.rejects(sandbox.spawn({ command: ["/bin/true"], cwd: "/", env: {}, attached: true, terminal: { cols: 80, rows: 24 } }),
        (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_POLICY");
      await assert.rejects(sandbox.spawn({ command: ["/bin/true"], cwd: "/", env: {}, attached: false as unknown as true }),
        (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_POLICY");
      for (const unix of ["relative.sock", "/tmp/../etc/x.sock", "/tmp/" + "x".repeat(120), "/tmp/a\0b"])
        await assert.rejects(openSandboxEndpoint(sandbox, { target: { unix }, onData() {} }), (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_POLICY");
      assert.equal(h.commands.length, count);
      await sandbox.close();
    });
  });
}
