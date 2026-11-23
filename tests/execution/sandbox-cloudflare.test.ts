/** `cloudflare` provider specifics beyond the shared endpoint conformance suite: the
 * container lifecycle in its Durable Object (start options, incarnation receipt, loss
 * signal, attach after a Durable Object reset, inactivity backstop, close fencing),
 * against the `ctx.container` double in fixtures/cloudflare-container.ts. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSandboxPool,
  createWorkspaceRuntime,
  parseSandboxEnvironmentUri,
  parseWorkspaceEndpointUri,
  SandboxFault,
  type SandboxPool,
  type WorkspacePlacementEvent,
  type WorkspacePlacementRecord,
} from "@opencraft/sandbox";
import { createSandboxProviderRegistry } from "@opencraft/sandbox/providers";
import {
  CLOUDFLARE_INCARNATION_LABEL,
  cloudflareSandboxBackend,
  cloudflareSandboxProvider,
  type CloudflareInstallation,
  type CloudflareSandboxOptions,
} from "@opencraft/sandbox-cloudflare";
import { FakeDurableObjectContainer } from "./fixtures/cloudflare-container";

const budget = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
const fault = (code: string) => (e: unknown) => e instanceof SandboxFault && e.code === code;
const settledWithin = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
const output = async (pool: SandboxPool, command: string[], env: Record<string, string> = {}) => {
  const sandbox = await pool.createSandbox({ owner: "cloudflare-test" });
  const chunks: Buffer[] = [];
  const process = await sandbox.spawn({ command, cwd: "/", env }, (data) => chunks.push(Buffer.from(data.data)));
  const exit = await process.exited;
  return { sandbox, exit, text: Buffer.concat(chunks).toString() };
};

async function setup(options: Partial<CloudflareSandboxOptions> = {}, container = new FakeDurableObjectContainer()) {
  const backend = () =>
    cloudflareSandboxBackend({
      container,
      image: container.images.base,
      python: "/usr/bin/python3",
      requestTimeoutMs: 5000,
      inactivityTimeoutMs: 900_000,
      ...options,
    });
  const pool = await createSandboxPool({ id: "cloudflare", capacity: budget, defaults: budget }, backend());
  return { container, pool, backend };
}

test("create starts a labelled custom instance, verifies it and issues an incarnation receipt", async (t) => {
  const { container, pool } = await setup();
  t.after(() => pool.close());
  const sandbox = await pool.createSandbox({ owner: "cloudflare-test" });
  const [start] = container.starts;
  assert.equal(start!.image, container.images.base);
  assert.equal(start!.enableInternet, false, "outbound traffic only through Worker intercepts by default");
  assert.deepEqual(start!.instance, { vcpu: 4, memoryMib: 8192, diskMb: 20000 });
  const incarnation = start!.labels![CLOUDFLARE_INCARNATION_LABEL]!;
  assert.match(incarnation, /^[a-f0-9]{32}$/u);
  assert.equal(sandbox.receipt?.backend, "cloudflare");
  assert.match(sandbox.receipt!.instanceId, new RegExp(`^${incarnation}\\.[a-f0-9]{32}\\.[a-f0-9]{32}$`, "u"));
  assert.deepEqual(sandbox.resources, budget);
  assert.deepEqual(sandbox.enforcement, { resources: "enforced", containment: "complete" });
  assert.deepEqual(container.timeouts, [900_000], "the inactivity backstop is armed after start");
  await sandbox.close();
  await sandbox.close();
  assert.equal(container.running, false);
  assert.equal(container.destroys, 1);
});

test("a budget the platform cannot provide is not created; a fractional vCPU is reported as requested", async () => {
  const { container, pool } = await setup();
  await assert.rejects(
    pool.createSandbox({ owner: "cloudflare-test", resources: { cpuMillis: 4100 } }),
    fault("SANDBOX_CAPACITY"),
  );
  const small = await createSandboxPool(
    { id: "cloudflare-small", capacity: budget, defaults: { cpuMillis: 250, memoryBytes: 512 * 1024 ** 2 } },
    cloudflareSandboxBackend({ container, image: container.images.base, python: "/usr/bin/python3", diskMb: 2000 }),
  );
  await assert.rejects(
    small.createSandbox({ owner: "cloudflare-test", resources: { cpuMillis: 300 } }),
    fault("SANDBOX_UNAVAILABLE"),
  );
  assert.equal(container.starts.length, 0, "an unsupported budget never starts a container");
  const sandbox = await small.createSandbox({ owner: "cloudflare-test" });
  assert.deepEqual(container.starts[0]!.instance, { vcpu: 0.25, memoryMib: 512, diskMb: 2000 });
  assert.deepEqual(sandbox.resources, { cpuMillis: 250, memoryBytes: 512 * 1024 ** 2 });
  await sandbox.close();
  await small.close();
  await pool.close();
});

test("exec never sees the start environment; each command gets only its own", async (t) => {
  const { pool } = await setup({ env: { OC_START_ONLY: "start-secret" } });
  t.after(() => pool.close());
  const { sandbox, exit, text } = await output(
    pool,
    ["/bin/sh", "-c", 'printf "%s|%s" "$OC_START_ONLY" "$OC_COMMAND"'],
    { OC_COMMAND: "command" },
  );
  assert.equal(exit.code, 0);
  assert.equal(text, "|command");
  await sandbox.close();
});

test("terminate reaches the whole process session although exec kill reaches one process", async (t) => {
  const { container, pool } = await setup();
  t.after(() => pool.close());
  const sandbox = await pool.createSandbox({ owner: "cloudflare-test" });
  let text = "";
  const process = await sandbox.spawn(
    { command: ["/bin/sh", "-c", "sleep 300 & echo $!; wait"], cwd: "/", env: {} },
    (data) => {
      text += Buffer.from(data.data).toString();
    },
  );
  const deadline = Date.now() + 5000;
  while (!/\d+\n/u.test(text) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const child = Number(text.trim());
  // A killed process whose new parent does not reap it stays a zombie here; it is not running.
  const running = (pid: number) =>
    existsSync(`/proc/${pid}`) && !/\) Z /u.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  assert.ok(running(child));
  await process.terminate();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(running(child), false, "the backgrounded descendant is gone");
  // Terminating processes that already exited never signals them.
  const done = await sandbox.spawn({ command: ["/bin/true"], cwd: "/", env: {} });
  await done.exited;
  await done.terminate();
  await process.terminate();
  assert.equal(container.killAfterExit, 0);
  await sandbox.close();
});

test("a container that stops by itself is reported lost; an owner close is not", async (t) => {
  const { container, pool } = await setup();
  t.after(() => pool.close());
  const crashed = await pool.createSandbox({ owner: "cloudflare-test" });
  await container.exitMain(7);
  assert.deepEqual(await crashed.lost, { reason: "crashed", code: 7 });
  await assert.rejects(crashed.spawn({ command: ["/bin/true"], cwd: "/", env: {} }), fault("SANDBOX_START"));
  await crashed.close();
  const closed = await pool.createSandbox({ owner: "cloudflare-test" });
  await closed.close();
  assert.equal(await settledWithin(closed.lost!, 100), false, "close() is not a loss");
  const exited = await pool.createSandbox({ owner: "cloudflare-test" });
  await container.exitMain(0);
  assert.deepEqual(await exited.lost, { reason: "exited", code: 0 });
  await exited.close();
  const destroyed = await pool.createSandbox({ owner: "cloudflare-test" });
  await container.destroy(new Error("platform stop"));
  assert.deepEqual(await destroyed.lost, { reason: "stopped" });
  await destroyed.close();
});

test("attach binds the same incarnation after a Durable Object reset and nothing else", async () => {
  const { container, pool, backend } = await setup();
  const first = await pool.createSandbox({ owner: "cloudflare-test" });
  const receipt = first.receipt!;
  // Durable Object reset: exec handles are gone; a new backend in the new object.
  container.resetDurableObject();
  const restarted = await createSandboxPool({ id: "cloudflare-reset", capacity: budget, defaults: budget }, backend());
  const timeouts = container.timeouts.length;
  const again = await restarted.attachSandbox({ owner: "cloudflare-test", receipt });
  assert.ok(container.timeouts.length >= timeouts + 1, "the inactivity backstop is re-armed in the new object");
  const process = await again.spawn({ command: ["/bin/echo", "attached"], cwd: "/", env: {} });
  assert.equal((await process.exited).code, 0);
  // Admission holds one environment's budget: release it before probing other receipts.
  await again.close();
  await first.close();
  const restartedAgain = await createSandboxPool(
    { id: "cloudflare-reset-2", capacity: budget, defaults: budget },
    backend(),
  );
  container.resetDurableObject();
  container.start({ image: container.images.base, enableInternet: false, labels: container.starts[0]!.labels });
  const [incarnation, boot, placement] = receipt.instanceId.split(".");
  for (const instanceId of [
    `${incarnation}.${"0".repeat(32)}.${placement}`,
    `${"f".repeat(32)}.${boot}.${placement}`,
    `${incarnation}.${boot}`,
    `${incarnation}.${boot}.other`,
  ])
    await assert.rejects(
      restartedAgain.attachSandbox({ owner: "cloudflare-test", receipt: { backend: "cloudflare", instanceId } }),
      fault("SANDBOX_UNAVAILABLE"),
      instanceId,
    );
  // Same label, restarted container: a new boot, so the receipt does not bind it.
  await assert.rejects(
    restartedAgain.attachSandbox({ owner: "cloudflare-test", receipt }),
    fault("SANDBOX_UNAVAILABLE"),
  );
  assert.equal(container.starts.length, 2, "attach never starts a container");
  await container.destroy();
  await restartedAgain.close();
  await restarted.close();
  await pool.close();
});

test("initialization re-arms the backstop of a running container; create reclaims a stale one", async () => {
  const container = new FakeDurableObjectContainer();
  container.start({ image: container.images.base, enableInternet: false, labels: { other: "stale" } });
  const { pool } = await setup({}, container);
  const sandbox = await pool.createSandbox({ owner: "cloudflare-test" });
  assert.equal(container.timeouts[0], 900_000, "set by initialize() before anything else");
  assert.equal(container.destroys, 1, "the stale incarnation was destroyed before the start");
  assert.equal(container.starts.length, 2);
  // An outside replacement: closing the old environment never stops the new incarnation.
  await container.restart();
  await sandbox.close();
  assert.equal(container.running, true);
  await container.destroy();
  await pool.close();
});

test("WorkspaceRuntime drops a lost binding at once and creates a new incarnation on next use", async (t) => {
  const { container, pool } = await setup();
  const directory = await mkdtemp(join(tmpdir(), "oc-cf-")),
    servers: Server[] = [];
  t.after(async () => {
    for (const server of servers) server.close();
    await pool.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  let agent = 0;
  const listen = (name: string, handler: Parameters<typeof createServer>[1]) =>
    new Promise<void>((resolve) => {
      const server = createServer({ allowHalfOpen: true }, handler);
      servers.push(server);
      server.listen(join(directory, name), () => resolve());
    });
  await listen("control", (socket) => {
    socket.once("data", () =>
      socket.end(
        JSON.stringify({
          protocol: 1,
          type: "healthy",
          state: "ready",
          roles: [],
          incarnation: { id: String(agent).repeat(32), evidence: "e", startedAt: new Date(0).toISOString() },
          endpoints: ["files"],
        }) + "\n",
      ),
    );
  });
  await listen("files", (socket) => socket.pipe(socket));
  const records = new Map<string, WorkspacePlacementRecord>(),
    events: WorkspacePlacementEvent[] = [];
  const runtime = createWorkspaceRuntime({
    workspaceId: "default",
    owner: "cloudflare-test",
    onEvent: (event) => events.push(event),
    environments: [
      {
        address: parseSandboxEnvironmentUri("cloudflare://WorkspaceContainer"),
        pool,
        python: "/usr/bin/python3",
        endpointDirectory: directory,
      },
    ],
    store: {
      read: async (address) => records.get(address.target),
      write: async (address, record) => {
        records.set(address.target, record);
      },
    },
  });
  const files = parseWorkspaceEndpointUri("workspace://default/endpoints/files");
  const first = await runtime.connect(files, () => {});
  await first.close();
  const receipt = records.get("WorkspaceContainer")!.receipt!;
  agent = 1;
  await container.exitMain(137);
  const deadline = Date.now() + 5000;
  while (!events.some((event) => event.type === "released") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events.at(-1), {
    type: "released",
    environment: "cloudflare://WorkspaceContainer",
    reason: "lost:crashed",
  });
  const second = await runtime.connect(files, () => {});
  await second.close();
  assert.notEqual(records.get("WorkspaceContainer")!.receipt!.instanceId, receipt.instanceId);
  assert.deepEqual(
    events.map((event) => event.type),
    ["created", "released", "attach-failed", "created"],
  );
  await runtime.close();
});

test("the provider serves only its own container class and a named image", () => {
  const container = new FakeDurableObjectContainer();
  const registry = createSandboxProviderRegistry<CloudflareInstallation>({
    cloudflare: cloudflareSandboxProvider({ containerClass: "WorkspaceContainer", container }),
  });
  const installation: CloudflareInstallation = { backend: "cloudflare", image: "base" };
  const selected = registry.environment(installation, parseSandboxEnvironmentUri("cloudflare://WorkspaceContainer"));
  assert.equal(selected.templateId, "WorkspaceContainer");
  const request = (templateId: string, image = "base") => ({
    installation: { ...installation, image },
    readSecret: async () => "",
    templateId,
    timeoutMs: 60_000,
    requestTimeoutMs: 10_000,
  });
  assert.equal(selected.definition.createBackend(request("WorkspaceContainer")).id, "cloudflare");
  assert.throws(
    () => registry.environment(installation, parseSandboxEnvironmentUri("cloudflare://OtherContainer")),
    fault("SANDBOX_POLICY"),
  );
  assert.throws(() => selected.definition.createBackend(request("OtherContainer")), fault("SANDBOX_POLICY"));
  assert.throws(
    () => selected.definition.createBackend(request("WorkspaceContainer", "missing")),
    fault("SANDBOX_POLICY"),
  );
  assert.throws(() => cloudflareSandboxProvider({ containerClass: "not a class", container }), fault("SANDBOX_POLICY"));
});
