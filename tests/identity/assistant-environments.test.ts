import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxCreationFault } from "@opencraft/sandbox";
import { createSandboxAssistantProvider } from "../../apps/personal-assistant/src/runtime/sandbox-environment-provider.mjs";
import { loadAssistantEnvironments } from "../../apps/opencraft-daemon/src/assistant-environments";
import { localSandboxFixture } from "../fixtures/assistant-sandbox";
const resources = { cpuMillis: 8000, memoryBytes: 16 * 1024 ** 3 };
async function setup(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "bot-sandbox-"));
  const f = localSandboxFixture(resources),
    starts: any[] = [],
    accesses = new Map();
  const provider = await createSandboxAssistantProvider({
    backendId: "e2b",
    templates: [
      { id: "approved", name: "Approved", resources, workspaceRoot: directory },
    ],
    capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 },
    createBackend: () => f.backend(),
    spawnLocal: ((options: any) => {
      starts.push(options);
      return {
        ready: Promise.resolve(),
        failed: () => false,
        close: async () => {},
      };
    }) as any,
  });
  const start = async (id: string) => {
    accesses.set(id, {
      binding: {
        serverId: "server",
        botId: id,
        assignmentId: "assignment-" + id,
        owner: { kind: "human", id: "owner" },
      },
      epoch: "epoch-" + id,
      expiresAt: Date.now() + 60000,
    });
    const handle = await provider.spawn(
      { kind: "sandbox", backendId: "e2b", templateId: "approved" },
      { directory, profileOptions: {}, request: async () => accesses.get(id) },
    );
    return {
      handle,
      request: starts.at(-1).request,
      descriptor: starts.at(-1).executionEnvironment,
    };
  };
  t.after(async () => {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { provider, f, start, accesses, starts, directory };
}
test("selected Bot gets a lazy isolated workspace, no Host environment, and independent placement", async (t) => {
  const f = await setup(t),
    a = await f.start("a"),
    b = await f.start("b");
  assert.equal(f.f.owners.length, 0);
  assert.notEqual(a.descriptor.binding, b.descriptor.binding);
  const run = (client: any, argv: string[], callId: string) =>
    client.request("environment/run", { argv, workId: "work", callId });
  const first = await run(
    a,
    [
      "/usr/bin/python3",
      "-c",
      'open("proof.txt","w").write("only-a");print("only-a")',
    ],
    "one",
  );
  assert.equal(first.state, "completed");
  assert.equal(first.stdout.trim(), "only-a");
  const second = await run(
    b,
    ["/usr/bin/python3", "-c", 'import os;print(os.path.exists("proof.txt"))'],
    "two",
  );
  assert.equal(second.stdout.trim(), "False");
  assert.notEqual(first.workspace, second.workspace);
  assert.ok(f.f.calls.every((c) => Object.keys(c.env).length === 0));
  assert.equal(f.f.owners.length, 2);
  await a.handle.close();
  assert.equal(f.f.destroyed, 1);
  await b.handle.close();
  assert.equal(f.f.destroyed, 2);
});
test("current assignment/epoch and cwd are checked before any user command", async (t) => {
  const f = await setup(t),
    a = await f.start("a");
  assert.equal(
    (
      await a.request("environment/run", {
        argv: ["echo"],
        cwd: "../",
        workId: "w",
        callId: "c",
      })
    ).state,
    "rejected",
  );
  assert.equal(f.f.owners.length, 0);
  f.accesses.get("a").epoch = "retired";
  await assert.rejects(
    a.request("environment/run", { argv: ["echo"], workId: "w", callId: "c" }),
    /authority changed/,
  );
  assert.equal(f.f.owners.length, 0);
});
test("command timeout terminates the selected process, bounds output and records effects were not rolled back", async (t) => {
  const f = await setup(t),
    a = await f.start("a");
  const timed = await a.request("environment/run", {
    argv: [
      "/usr/bin/python3",
      "-u",
      "-c",
      'import time;print("before-timeout");time.sleep(60)',
    ],
    timeoutMs: 1000,
    workId: "w",
    callId: "timeout",
  });
  assert.equal(timed.state, "completed");
  assert.equal(timed.timedOut, true);
  assert.equal(timed.signal, "SIGKILL");
  assert.match(timed.stdout, /before-timeout/);
  const large = await a.request("environment/run", {
    argv: ["/usr/bin/python3", "-c", 'print("x"*100000)'],
    workId: "w",
    callId: "large",
  });
  assert.equal(large.truncated, true);
  assert.equal(Buffer.byteLength(large.stdout), 32768);
});
test("restarted brain has a new environment binding, never silently adopts the old workspace", async (t) => {
  const f = await setup(t),
    first = await f.start("a");
  await first.request("environment/run", {
    argv: ["/usr/bin/printf", "one"],
    workId: "w",
    callId: "one",
  });
  await first.handle.close();
  const next = await f.start("a");
  assert.notEqual(next.descriptor.binding, first.descriptor.binding);
  const result = await next.request("environment/run", {
    argv: ["/usr/bin/printf", "two"],
    workId: "new-work",
    callId: "two",
  });
  assert.equal(result.stdout, "two");
  assert.equal(f.f.owners.length, 2);
});
test("installation configuration is private, optional, and never accepts credentials from Bot input", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-env-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await loadAssistantEnvironments(), {});
  const file = join(directory, "config.json");
  await writeFile(file, "{}", { mode: 0o644 });
  await assert.rejects(
    loadAssistantEnvironments(file),
    /configuration unavailable/,
  );
  await chmod(file, 0o600);
  await assert.rejects(
    loadAssistantEnvironments(file),
    /configuration unavailable/,
  );
  const key = join(directory, "key");
  await writeFile(key, "synthetic-only-key", { mode: 0o600 });
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      backend: "e2b",
      apiUrl: "https://example.test",
      sandboxUrl: "https://example.test",
      apiKeyFile: key,
      capacity: resources,
      templates: [
        {
          id: "approved",
          name: "Approved",
          resources,
          workspaceRoot: "/home/user/work",
        },
      ],
      lease: { timeoutMs: 30000, renewEveryMs: 5000, maxLifetimeMs: 60000 },
    }),
  );
  const providers = await loadAssistantEnvironments(file);
  assert.deepEqual(await providers.e2b.templates(), [
    { id: "approved", name: "Approved" },
  ]);
  await providers.e2b.close?.();
});

test("a schemaVersion 1 configuration without backend is E2B; other backends fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-env-backend-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, "key"),
    file = join(directory, "config.json");
  await writeFile(key, "synthetic-only-key", { mode: 0o600 });
  const config = {
    schemaVersion: 1,
    apiUrl: "https://example.test",
    sandboxUrl: "https://example.test",
    apiKeyFile: key,
    capacity: resources,
    templates: [{ id: "approved", name: "Approved", resources, workspaceRoot: "/home/user/work" }],
    lease: { timeoutMs: 30000, renewEveryMs: 5000, maxLifetimeMs: 60000 },
  };
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const providers = await loadAssistantEnvironments(file);
  assert.deepEqual(Object.keys(providers), ["e2b"]);
  await providers.e2b.close?.();
  for (const backend of ["cloudflare", "local", ""]) {
    await writeFile(file, JSON.stringify({ ...config, backend }), { mode: 0o600 });
    await assert.rejects(loadAssistantEnvironments(file), /configuration unavailable/);
  }
});

test("unknown creation is reported with correlation, retains admission and cannot respawn or retry", async () => {
  const reports: any[] = [],
    access = {
      binding: {
        serverId: "s",
        botId: "b",
        assignmentId: "a",
        owner: { kind: "human", id: "h" },
      },
      epoch: "one",
      expiresAt: Date.now() + 60000,
    };
  let request: any,
    creates = 0;
  const tiny = { cpuMillis: 1000, memoryBytes: 1024 ** 3 };
  const provider = await createSandboxAssistantProvider({
    backendId: "e2b",
    templates: [
      {
        id: "small",
        name: "Small",
        workspaceRoot: "/tmp/bot-small",
        resources: tiny,
      },
    ],
    capacity: tiny,
    onReconciliation: (i) => reports.push(i),
    createBackend: () => ({
      id: "e2b",
      async initialize() {},
      async close() {},
      async create(identity) {
        creates++;
        throw new SandboxCreationFault("unknown", identity);
      },
    }),
    spawnLocal: ((options: any) => {
      request = options.request;
      return {
        ready: Promise.resolve(),
        failed: () => false,
        async close() {},
      };
    }) as any,
  });
  const selection = {
      kind: "sandbox" as const,
      backendId: "e2b",
      templateId: "small",
    },
    options = {
      directory: "/tmp/unused",
      profileOptions: {},
      request: async () => access,
    };
  const handle = await provider.spawn(selection, options);
  try {
    assert.equal(
      (
        await request("environment/run", {
          argv: ["echo"],
          workId: "w",
          callId: "c",
        })
      ).state,
      "rejected",
    );
    assert.equal(creates, 1);
    assert.equal(reports.length, 1);
    assert.match(reports[0].id, /^[a-f0-9]{32}$/);
    assert.match(reports[0].owner, /^assistant:/);
    await assert.rejects(handle.close(), /reconciliation/);
    await assert.rejects(provider.spawn(selection, options), /not retired/);
    assert.equal(creates, 1);
  } finally {
    await assert.rejects(provider.close(), {code:'SANDBOX_CLEANUP'});
  }
});

test("authority loss during a command kills its environment and suppresses a late success", async (t) => {
  const f = await setup(t),
    a = await f.start("a");
  const run = a.request("environment/run", {
    argv: [
      "/usr/bin/python3",
      "-u",
      "-c",
      'import time;print("started");time.sleep(60)',
    ],
    workId: "w",
    callId: "revoked",
  });
  while (
    !f.f.calls.some((c) => c.command.some((v) => v.includes("time.sleep")))
  )
    await new Promise((r) => setTimeout(r, 20));
  f.accesses.get("a").epoch = "revoked";
  const result = await run;
  assert.equal(result.state, "unknown");
  assert.equal(a.handle.failed(), true);
  assert.equal(f.f.destroyed, 1);
});


test("derived personal and platform backend IDs fit the native pool ID contract", async () => {
  for (const backendId of ["e2b-" + "a".repeat(40), "e2b-shared-" + "b".repeat(40)]) {
    let allocations = 0;
    const provider = await createSandboxAssistantProvider({
      backendId,
      templates: [{id:"python",name:"Named environment",resources,workspaceRoot:"/home/user/opencraft"}],
      capacity: resources,
      createBackend: () => ({id:backendId,initialize:async()=>{},close:async()=>{},create:async()=>{allocations++;throw Error("not called");}}),
    });
    await provider.validate({kind:"sandbox",backendId,templateId:"python"});
    assert.equal(allocations,0,"listing/validation cannot allocate a billable sandbox");
    await provider.close();
  }
});
