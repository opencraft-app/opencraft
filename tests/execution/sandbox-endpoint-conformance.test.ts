/** Contract conformance for `openSandboxEndpoint` and `attached` process lifetime.
 * Every SandboxBackend harness in fixtures/sandbox-endpoint-backends.ts runs the same
 * assertions through createSandboxPool()/createSandbox(); a backend that cannot pass
 * them must not advertise endpoint support. */
import test from "node:test";
import assert from "node:assert/strict";
import type { Socket } from "node:net";
import {
  createSandbox,
  createSandboxPool,
  createWorkspaceRuntime,
  openSandboxEndpoint,
  parseSandboxEnvironmentUri,
  parseWorkspaceEndpointUri,
  SandboxFault,
  type Sandbox,
  type SandboxPool,
  type WorkspacePlacementRecord,
} from "@opencraft/sandbox";
import { harnesses, type EndpointHarness } from "./fixtures/sandbox-endpoint-backends";

const until = async (condition: () => boolean, ms = 10000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const echo = (socket: Socket) => {
  socket.on("data", (data) => socket.write(data));
  socket.on("end", () => socket.end());
  socket.on("error", () => {});
};

for (const make of await harnesses()) {
  const probe = await make();
  const name = probe.name;
  await probe.dispose();
  test(`endpoint conformance: ${name}`, { concurrency: false, timeout: 120000 }, async (t) => {
    const h: EndpointHarness = await make();
    const pool: SandboxPool = await createSandboxPool(
      { id: "endpoint", capacity: h.resources, defaults: h.resources },
      h.backend,
    );
    const open = async (sandbox: Sandbox, path: string, chunks: Buffer[]) =>
      openSandboxEndpoint(sandbox, {
        target: { unix: path },
        python: h.python,
        onData: (data) => chunks.push(Buffer.from(data)),
      });
    t.after(async () => {
      await h.dispose();
      await pool.close().catch(() => {});
    });

    await t.test("binary bytes round trip unchanged and the relay is an attached pipe process", async () => {
      const sandbox = await createSandbox(pool, { owner: "conformance" });
      const path = await h.listen(echo),
        chunks: Buffer[] = [];
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
      const path = await h.listen((socket) => {
        socket.on("data", (data) => {
          received += data;
        });
        socket.on("end", () => socket.end("bye:" + received));
      });
      const chunks: Buffer[] = [],
        connection = await open(sandbox, path, chunks);
      await connection.write(Buffer.from("hello"));
      await connection.end();
      assert.equal(await connection.closed, "ended");
      assert.equal(Buffer.concat(chunks).toString(), "bye:hello");
      await assert.rejects(
        connection.write(Buffer.from("late")),
        (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_CLOSED",
      );
      await connection.close();
      await sandbox.close();
    });

    await t.test("target close ends only that connection", async () => {
      const sandbox = await createSandbox(pool, { owner: "conformance" });
      const path = await h.listen((socket) => {
        socket.end("goodbye");
      });
      const chunks: Buffer[] = [],
        connection = await open(sandbox, path, chunks);
      assert.equal(await connection.closed, "ended");
      assert.equal(Buffer.concat(chunks).toString(), "goodbye");
      const again = await open(sandbox, await h.listen(echo), []);
      await again.close();
      await sandbox.close();
    });

    await t.test("Host close ends the target connection and leaves the environment usable", async () => {
      const sandbox = await createSandbox(pool, { owner: "conformance" });
      let targetClosed = false,
        targetConnected = false;
      const path = await h.listen((socket) => {
        targetConnected = true;
        socket.on("end", () => {
          targetClosed = true;
          socket.end();
        });
        socket.on("close", () => {
          targetClosed = true;
        });
        socket.on("error", () => {});
      });
      const connection = await open(sandbox, path, []);
      await until(() => targetConnected);
      await connection.close();
      await connection.close();
      await until(() => targetClosed);
      const chunks: Buffer[] = [],
        next = await open(sandbox, await h.listen(echo), chunks);
      await next.write(Buffer.from("still alive"));
      await until(() => Buffer.concat(chunks).toString() === "still alive");
      await next.close();
      const closes = h.closes.count;
      await sandbox.close();
      assert.equal(h.closes.count, closes + 1);
    });

    await t.test(
      "Host writes wait for a target that is not reading (back-pressure), then complete in order",
      async () => {
        const sandbox = await createSandbox(pool, { owner: "conformance" });
        let target!: Socket;
        const received: Buffer[] = [];
        const path = await h.listen((socket) => {
          target = socket;
          socket.pause();
          socket.on("data", (data: Buffer) => received.push(data));
        });
        const connection = await open(sandbox, path, []);
        const total = 12 * 1024 * 1024,
          chunk = Buffer.alloc(64 * 1024, 0x5a);
        let accepted = 0;
        const writing = (async () => {
          for (let sent = 0; sent < total; sent += chunk.length) {
            await connection.write(chunk);
            accepted += chunk.length;
          }
        })();
        await until(() => target !== undefined);
        await new Promise((resolve) => setTimeout(resolve, 750));
        assert.ok(accepted < total, `writes must stall while the target does not read (accepted ${accepted})`);
        target.resume();
        await writing;
        await until(() => received.reduce((n, b) => n + b.length, 0) === total, 30000);
        await connection.close();
        await sandbox.close();
      },
    );

    await t.test(
      "an attached relay failing ends only its connection; environment and other processes stay alive",
      async () => {
        const sandbox = await createSandbox(pool, { owner: "conformance" });
        const closes = h.closes.count;
        const longRunning = await sandbox.spawn({ command: [...h.catCommand], cwd: "/", env: {} }, () => {});
        const chunks: Buffer[] = [],
          healthy = await open(sandbox, await h.listen(echo), chunks);
        const broken = await open(sandbox, h.missing(), []);
        assert.equal(await broken.closed, "failed");
        await broken.close();
        await healthy.write(Buffer.from("after failure"));
        await until(() => Buffer.concat(chunks).toString() === "after failure");
        let exited = false;
        void longRunning.exited.then(
          () => {
            exited = true;
          },
          () => {
            exited = true;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(exited, false, "a non-attached process in the same environment keeps running");
        assert.equal(h.closes.count, closes, "relay failure never retires the environment");
        await healthy.close();
        await longRunning.terminate();
        await sandbox.close();
      },
    );

    await t.test("named targets resolve only inside the agent endpoint directory", async () => {
      const sandbox = await createSandbox(pool, { owner: "conformance" });
      const path = await h.listen(echo, "files"),
        endpointDirectory = path.slice(0, path.lastIndexOf("/"));
      const chunks: Buffer[] = [];
      const connection = await openSandboxEndpoint(sandbox, {
        target: { name: "files" },
        endpointDirectory,
        python: h.python,
        onData: (data) => chunks.push(Buffer.from(data)),
      });
      await connection.write(Buffer.from("named"));
      await until(() => Buffer.concat(chunks).toString() === "named");
      assert.equal(h.commands.at(-1)!.command.at(-1), endpointDirectory + "/files");
      await connection.close();
      const count = h.commands.length;
      for (const name of ["../files", "files/../x", "/etc/passwd", "unknown", "", "Files"])
        await assert.rejects(
          openSandboxEndpoint(sandbox, { target: { name } as never, endpointDirectory, onData() {} }),
          (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_POLICY",
        );
      await assert.rejects(
        openSandboxEndpoint(sandbox, { target: { name: "files" }, endpointDirectory: "relative", onData() {} }),
        (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_POLICY",
      );
      await assert.rejects(
        openSandboxEndpoint(sandbox, {
          target: { name: "files", unix: path } as never,
          endpointDirectory,
          onData() {},
        }),
        (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_POLICY",
      );
      assert.equal(h.commands.length, count, "rejected names never spawn a relay");
      await sandbox.close();
    });

    await t.test("receipt re-attach binds only the same instance; otherwise SANDBOX_UNAVAILABLE", async () => {
      const unavailable = (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_UNAVAILABLE";
      if (!h.backend.attach) {
        await assert.rejects(
          pool.attachSandbox({ owner: "conformance", receipt: { backend: h.backend.id, instanceId: "x" } }),
          unavailable,
        );
        return;
      }
      const first = await createSandbox(pool, { owner: "conformance" });
      const receipt = first.receipt!;
      assert.equal(receipt.backend, h.backend.id);
      // A restarted Host: a new backend and pool over the same provider instances.
      const restarted = await createSandboxPool(
        { id: "endpoint-restarted", capacity: h.resources, defaults: h.resources },
        h.reconnect!(),
      );
      try {
        const again = await restarted.attachSandbox({ owner: "conformance", receipt });
        assert.deepEqual(again.receipt, receipt);
        const chunks: Buffer[] = [],
          connection = await open(again, await h.listen(echo), chunks);
        await connection.write(Buffer.from("re-attached"));
        await until(() => Buffer.concat(chunks).toString() === "re-attached");
        await connection.close();
        await again.close();
        await assert.rejects(
          restarted.attachSandbox({
            owner: "conformance",
            receipt: { backend: "another-provider", instanceId: receipt.instanceId },
          }),
          unavailable,
        );
        await assert.rejects(
          restarted.attachSandbox({
            owner: "conformance",
            receipt: { ...receipt, instanceId: receipt.instanceId.replace(/.$/u, (c) => (c === "0" ? "1" : "0")) },
          }),
          unavailable,
        );
        await h.replaceInstance!();
        await assert.rejects(
          restarted.attachSandbox({ owner: "conformance", receipt }),
          unavailable,
          "a replaced instance is never re-attached",
        );
      } finally {
        await restarted.close().catch(() => {});
        await first.close().catch(() => {});
      }
    });

    await t.test(
      "workspace:// endpoints resolve through the agent control endpoint of the provider's environment",
      async () => {
        const incarnation = { id: "a".repeat(32), evidence: "e", startedAt: new Date(0).toISOString() };
        // An owner replaced in place moves the agent's endpoint generation; its description changes with it.
        let generation = 0;
        const control = await h.listen((socket) => {
          let text = "";
          socket.on("data", (data) => {
            text += data;
            if (!text.includes("\n")) return;
            const request = JSON.parse(text.slice(0, text.indexOf("\n")));
            socket.end(
              JSON.stringify(
                request.type === "describe"
                  ? {
                      protocol: 1,
                      type: "endpoint",
                      name: request.name,
                      descriptor: { token: `from-control-${generation}` },
                    }
                  : {
                      protocol: 1,
                      type: "healthy",
                      state: "ready",
                      roles: ["hands"],
                      incarnation,
                      endpoints: ["terminal"],
                      ...(generation ? { endpointGeneration: generation } : {}),
                    },
              ) + "\n",
            );
          });
          socket.on("error", () => {});
        }, "control");
        const endpointDirectory = control.slice(0, control.lastIndexOf("/"));
        await h.listen(echo, "terminal");
        const records = new Map<string, WorkspacePlacementRecord>(),
          events: string[] = [];
        const runtime = createWorkspaceRuntime({
          workspaceId: "default",
          owner: "conformance",
          onEvent: (event) => events.push(event.type),
          environments: [
            {
              address: parseSandboxEnvironmentUri(`${h.backend.id}://conformance`),
              pool,
              python: h.python,
              endpointDirectory,
            },
          ],
          store: {
            read: async (address) => records.get(address.target),
            write: async (address, record) => {
              records.set(address.target, record);
            },
          },
        });
        try {
          const chunks: Buffer[] = [];
          const connection = await runtime.connect(
            parseWorkspaceEndpointUri("workspace://default/endpoints/terminal"),
            (data) => chunks.push(Buffer.from(data)),
          );
          await connection.write(Buffer.from("by uri"));
          await until(() => Buffer.concat(chunks).toString() === "by uri");
          await connection.close();
          const terminal = parseWorkspaceEndpointUri("workspace://default/endpoints/terminal");
          assert.deepEqual(await runtime.describe(terminal), { token: "from-control-0" });
          assert.deepEqual(
            (await runtime.observe()).map((value) => value.incarnation),
            [incarnation.id],
          );
          generation = 1;
          assert.deepEqual(
            await runtime.describe(terminal),
            { token: "from-control-0" },
            "cached until the agent is observed",
          );
          assert.deepEqual(
            (await runtime.observe()).map((value) => value.incarnation),
            [incarnation.id],
          );
          assert.deepEqual(
            await runtime.describe(terminal),
            { token: "from-control-1" },
            "a moved generation drops the cache, not the binding",
          );
          assert.equal(records.get("conformance")?.agentIncarnation, incarnation.id);
          assert.equal(records.get("conformance")?.receipt?.backend, h.backend.attach ? h.backend.id : undefined);
          assert.deepEqual(events, ["created"]);
          await assert.rejects(
            runtime.connect(parseWorkspaceEndpointUri("workspace://default/endpoints/pi"), () => {}),
            (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_UNAVAILABLE",
          );
          await assert.rejects(
            runtime.connect(parseWorkspaceEndpointUri("workspace://other/endpoints/terminal"), () => {}),
            (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_POLICY",
          );
        } finally {
          await runtime.close();
        }
      },
    );

    await t.test("contract validation: attached is pipe-only and invalid targets never spawn", async () => {
      const sandbox = await createSandbox(pool, { owner: "conformance" });
      const count = h.commands.length;
      await assert.rejects(
        sandbox.spawn({ command: ["/bin/true"], cwd: "/", env: {}, attached: true, terminal: { cols: 80, rows: 24 } }),
        (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_POLICY",
      );
      await assert.rejects(
        sandbox.spawn({ command: ["/bin/true"], cwd: "/", env: {}, attached: false as unknown as true }),
        (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_POLICY",
      );
      for (const unix of ["relative.sock", "/tmp/../etc/x.sock", "/tmp/" + "x".repeat(120), "/tmp/a\0b"])
        await assert.rejects(
          openSandboxEndpoint(sandbox, { target: { unix }, onData() {} }),
          (e: unknown) => e instanceof SandboxFault && e.code === "SANDBOX_POLICY",
        );
      assert.equal(h.commands.length, count);
      await sandbox.close();
    });
  });
}
