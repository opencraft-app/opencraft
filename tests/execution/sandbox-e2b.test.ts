import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { SandboxNotFoundError, AuthenticationError, SandboxError } from "e2b";
import {
  createSandboxPool,
  createSandbox,
  SandboxCreationFault,
} from "@opencraft/sandbox";
import {
  e2bSandboxBackend,
  type E2BConnection,
} from "../../packages/sandbox-e2b/src/index";
const resources = { cpuMillis: 8000, memoryBytes: 16 * 1024 ** 3 };
const policy = {
  id: "e2b-test",
  capacity: resources,
  defaults: resources,
  queueLimit: 0,
};
const opts = {
  apiUrl: "https://api.example.test",
  sandboxUrl: "https://proxy.example.test",
  templateId: "approved-template",
  readApiKey: async () => "synthetic-only-key",
};
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-e2b-test-"));
  let creates = 0,
    kills = 0,
    gone = false,
    uncertain = false,
    infoFail = false,
    cpuCount = 8;
  const controls: any[] = [],
    children = new Set<ReturnType<typeof spawn>>();
  const remote = {
    sandboxId: "test-only-id",
    async getInfo() {
      if (gone) throw new SandboxNotFoundError("gone");
      if (infoFail) throw Error("secret must not leak");
      return { cpuCount, memoryMB: 16384 };
    },
    async kill() {
      kills++;
      if (uncertain) throw Error("unconfirmed secret");
      gone = true;
      for (const child of children) child.kill("SIGKILL");
    },
    files: {
      async write(path: string, data: string) {
        await writeFile(join(directory, basename(path)), data);
      },
    },
    commands: {
      async run(command: string, options: any) {
        const rewritten = command.replace(
          /\/tmp\/opencraft-exec-/g,
          directory + "/opencraft-exec-",
        );
        controls.push({ command, options });
        const child = spawn("/bin/sh", ["-c", rewritten], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.add(child);
        const done = once(child, "close");
        void done.then(() => children.delete(child));
        child.stdout.on("data", (data) =>
          options.onStdout(data.toString("ascii")),
        );
        child.stderr.on("data", (data) =>
          options.onStderr(data.toString("utf8")),
        );
        return {
          sendStdin: (data: string) =>
            new Promise<void>((resolve, reject) =>
              child.stdin.write(data, (e) => (e ? reject(e) : resolve())),
            ),
          wait: async () => {
            const [code] = await done;
            if (code !== 0) throw Error("transport stopped");
            return { exitCode: code };
          },
        };
      },
    },
  };
  const driver = {
    async create(template: string, options: any) {
      creates++;
      controls.push({ template, options });
      return remote;
    },
  } as unknown as E2BConnection;
  const backend = e2bSandboxBackend(opts, driver),
    pool = await createSandboxPool(policy, backend);
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });
  return {
    pool,
    driver,
    remote,
    controls,
    directory,
    get creates() {
      return creates;
    },
    get kills() {
      return kills;
    },
    failCleanup() {
      uncertain = true;
    },
    failInfo() {
      infoFail = true;
    },
    mismatch() {
      cpuCount = 4;
    },
  };
}
test("E2B adapter preserves binary pipes, literal argv, stdin EOF, environment and multiple commands", async (t) => {
  const f = await fixture(t);
  let sandbox;
  try {
    sandbox = await createSandbox(f.pool, { owner: "bot:test" });
    assert.equal(sandbox.identity.backend, "e2b");
    assert.deepEqual(sandbox.resources, resources);
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    const code =
      'import os,sys; data=sys.stdin.buffer.read();sys.stdout.buffer.write(data);sys.stderr.write(os.environ["PAYLOAD"]);assert sys.argv[1]=="a b;$(false)"';
    const child = await sandbox.spawn(
      {
        command: ["/usr/bin/python3", "-c", code, "a b;$(false)"],
        cwd: f.directory,
        env: { PAYLOAD: "payload-not-launcher" },
      },
      (v) =>
        (v.stream === "stdout" ? stdout : stderr).push(Buffer.from(v.data)),
    );
    assert.equal(child.kind, "process");
    assert.notEqual(child.id, "test-only-id");
    await child.writeStdin(Buffer.from([0, 255, 128, 10, 13, 0]));
    if (child.kind === "process") await child.closeStdin();
    assert.equal((await child.exited).code, 0);
    assert.deepEqual(
      Buffer.concat(stdout),
      Buffer.from([0, 255, 128, 10, 13, 0]),
    );
    assert.equal(Buffer.concat(stderr).toString(), "payload-not-launcher");
    const second = await sandbox.spawn({
      command: ["/usr/bin/printf", "second"],
      cwd: f.directory,
      env: {},
    });
    assert.equal((await second.exited).code, 0);
    assert.equal(f.kills, 0);
    assert.ok(
      f.controls
        .filter((c) => c.command)
        .every(
          (c) =>
            !c.command.includes("payload-not-launcher") &&
            !c.command.includes("synthetic-only-key"),
        ),
    );
    assert.ok(f.controls[0].options.metadata["opencraft-correlation"]);
  } finally {
    await sandbox?.close();
    await f.pool.close();
  }
  assert.equal(f.kills, 1);
});
test("E2B termination waits for the remote child exit and never advertises unsupported PTY", async (t) => {
  const f = await fixture(t),
    sandbox = await createSandbox(f.pool, { owner: "bot:test" });
  try {
    assert.equal(sandbox.capabilities.terminal, false);
    await assert.rejects(
      sandbox.spawn({
        command: ["echo"],
        cwd: f.directory,
        env: {},
        terminal: { cols: 80, rows: 24 },
      }),
      /terminals/,
    );
    const child = await sandbox.spawn({
      command: ["/bin/sleep", "60"],
      cwd: f.directory,
      env: {},
    });
    await child.terminate();
    assert.equal((await child.exited).signal, "SIGKILL");
  } finally {
    await sandbox.close();
    await f.pool.close();
  }
});
test("mismatched template resources are destroyed before admission", async (t) => {
  const f = await fixture(t);
  f.mismatch();
  await assert.rejects(
    createSandbox(f.pool, { owner: "wrong-resources" }),
    /resources differ/,
  );
  assert.equal(f.kills, 1);
  await f.pool.close();
});
test("unconfirmed creation retains capacity, never replays, and never echoes vendor diagnostics", async () => {
  let creates = 0;
  const backend = e2bSandboxBackend(opts, {
      create: async () => {
        creates++;
        throw Error("vendor-secret");
      },
    }),
    pool = await createSandboxPool(policy, backend);
  await assert.rejects(
    createSandbox(pool, { owner: "first" }),
    (e) =>
      e instanceof SandboxCreationFault &&
      e.outcome === "unknown" &&
      !e.message.includes("vendor-secret"),
  );
  await assert.rejects(
    createSandbox(pool, { owner: "second" }),
    /admission queue/,
  );
  assert.equal(creates, 1);
  await assert.rejects(pool.close(), /unverified/);
});
test("unconfirmed deletion does not return capacity", async (t) => {
  const f = await fixture(t),
    sandbox = await createSandbox(f.pool, { owner: "first" });
  f.failCleanup();
  await assert.rejects(sandbox.close(), /destruction is unconfirmed/);
  await assert.rejects(
    createSandbox(f.pool, { owner: "second" }),
    /admission queue/,
  );
  await assert.rejects(f.pool.close(), /unverified/);
});
test("cancelled late creation is reclaimed and cannot become a ready environment", async (t) => {
  const f = await fixture(t);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const driver = {
    create: async (...args: any[]) => {
      await gate;
      return (f.driver.create as any)(...args);
    },
  };
  const pool = await createSandboxPool(policy, e2bSandboxBackend(opts, driver));
  const controller = new AbortController();
  const creating = createSandbox(pool, {
    owner: "late",
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  resume();
  await assert.rejects(creating, /cancelled/);
  assert.equal(f.kills, 1);
  await pool.close();
  await f.pool.close();
});
test("explicit credential and endpoint policy fail closed without provisioning", async () => {
  assert.throws(
    () => e2bSandboxBackend({ ...opts, apiUrl: "http://remote.example.test" }),
    /HTTPS/,
  );
  let calls = 0;
  const pool = await createSandboxPool(
    policy,
    e2bSandboxBackend(
      { ...opts, readApiKey: async () => "" },
      {
        create: async () => {
          calls++;
          throw Error();
        },
      },
    ),
  );
  await assert.rejects(
    createSandbox(pool, { owner: "missing-key" }),
    /could not initialize/,
  );
  assert.equal(calls, 0);
  await pool.close();
});

test("known creation whose information cannot be read is reclaimed before capacity is returned", async (t) => {
  const f = await fixture(t);
  f.failInfo();
  await assert.rejects(
    createSandbox(f.pool, { owner: "unreadable" }),
    (e) => e instanceof SandboxCreationFault && e.outcome === "not-created",
  );
  assert.equal(f.kills, 1);
  await f.pool.close();
});
test("large binary writes preserve order against concurrent EOF", async (t) => {
  const f = await fixture(t),
    sandbox = await createSandbox(f.pool, { owner: "large-input" });
  try {
    const output: Buffer[] = [];
    const child = await sandbox.spawn(
      {
        command: [
          "/usr/bin/python3",
          "-c",
          "import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())",
        ],
        cwd: f.directory,
        env: {},
      },
      (event) => {
        if (event.stream === "stdout") output.push(Buffer.from(event.data));
      },
    );
    const first = Buffer.alloc(1024 * 1024, 255),
      second = Buffer.from([0, 1, 128, 10]);
    await Promise.all([
      child.writeStdin(first),
      child.writeStdin(second),
      child.kind === "process" ? child.closeStdin() : Promise.resolve(),
    ]);
    assert.equal((await child.exited).code, 0);
    assert.deepEqual(Buffer.concat(output), Buffer.concat([first, second]));
  } finally {
    await sandbox.close();
    await f.pool.close();
  }
});

test("explicit API authentication rejection returns admission without blind retry", async () => {
  let calls = 0;
  const pool = await createSandboxPool(
    policy,
    e2bSandboxBackend(opts, {
      create: async () => {
        calls++;
        throw new AuthenticationError("never echo this vendor diagnostic");
      },
    }),
  );
  for (const owner of ["one", "two"])
    await assert.rejects(
      createSandbox(pool, { owner }),
      (e) => e instanceof SandboxCreationFault && e.outcome === "not-created",
    );
  assert.equal(calls, 2);
  await pool.close();
});

test("bounded E2B lease renews only while authority is current; loss reclaims without replay", async () => {
  let enabled = true,
    gone = false,
    renewals = 0,
    lost = 0;
  const remote: any = {
    sandboxId: "lease-fixture",
    getInfo: async () => {
      if (gone) throw new SandboxNotFoundError("gone");
      return { cpuCount: 8, memoryMB: 16384 };
    },
    kill: async () => {
      gone = true;
    },
    setTimeout: async () => {
      renewals++;
    },
  };
  const backend = e2bSandboxBackend(
    {
      ...opts,
      timeoutMs: 10000,
      lease: {
        renewEveryMs: 100,
        maxLifetimeMs: 1000,
        authorize: async () => {
          if (!enabled) throw Error("retired");
        },
        onLost: () => {
          lost++;
        },
      },
    },
    { create: async () => remote },
  );
  const pool = await createSandboxPool(policy, backend),
    environment = await createSandbox(pool, { owner: "leased-bot" });
  await new Promise((r) => setTimeout(r, 160));
  assert.ok(renewals >= 1);
  enabled = false;
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(lost, 1);
  assert.equal(gone, true);
  await environment.close();
  await pool.close();
  const stopped = renewals;
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(renewals, stopped);
});
test("maximum E2B lease lifetime ends an idle environment and stops renewal", async () => {
  let gone = false,
    lost = 0;
  const remote: any = {
    sandboxId: "max-lease-fixture",
    getInfo: async () => {
      if (gone) throw new SandboxNotFoundError("gone");
      return { cpuCount: 8, memoryMB: 16384 };
    },
    kill: async () => {
      gone = true;
    },
    setTimeout: async () => {},
  };
  const pool = await createSandboxPool(
    policy,
    e2bSandboxBackend(
      {
        ...opts,
        timeoutMs: 10000,
        lease: {
          renewEveryMs: 100,
          maxLifetimeMs: 250,
          authorize: async () => {},
          onLost: () => {
            lost++;
          },
        },
      },
      { create: async () => remote },
    ),
  );
  const environment = await createSandbox(pool, { owner: "bounded-bot" });
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(lost, 1);
  assert.equal(gone, true);
  await environment.close();
  await pool.close();
});

test("trusted persistent binding is sent without volume mounts and verified before commands", async (t) => {
  const f = await fixture(t);
  const id = "ws-" + "a".repeat(32);
  const info = f.remote.getInfo.bind(f.remote);
  f.remote.getInfo = async () => ({
    ...(await info()),
    metadata: { workspace_id: id },
  });
  const backend = e2bSandboxBackend(
    { ...opts, readWorkspaceId: async () => id },
    f.driver,
  );
  const pool = await createSandboxPool(policy, backend);
  const sb = await createSandbox(pool, { owner: "bot:trusted" });
  const call = f.controls.find((c) => c.options?.metadata);
  assert.equal(call.options.metadata.workspace_id, id);
  assert.equal("volumeMounts" in call.options, false);
  assert.equal("volume_mounts" in call.options, false);
  await sb.close();
  await pool.close();
  assert.equal(f.kills, 1);
});
test("workspace mismatch is reclaimed; resolver failure submits no create", async (t) => {
  const f = await fixture(t);
  const pool = await createSandboxPool(
    policy,
    e2bSandboxBackend(
      { ...opts, readWorkspaceId: async () => "ws-" + "a".repeat(32) },
      f.driver,
    ),
  );
  await assert.rejects(createSandbox(pool, { owner: "bot:trusted" }));
  assert.equal(f.kills, 1);
  await pool.close();
  const blocked = await createSandboxPool(
    policy,
    e2bSandboxBackend(
      {
        ...opts,
        readWorkspaceId: async () => {
          throw Error("revoked");
        },
      },
      f.driver,
    ),
  );
  await assert.rejects(createSandbox(blocked, { owner: "bot:revoked" }));
  assert.equal(f.creates, 1);
  await blocked.close();
});
test('closing stdin after a fast command exited preserves its successful result',async(t)=>{
 const f=await fixture(t);const sb=await createSandbox(f.pool,{owner:'bot:quick'});
 const p=await sb.spawn({command:['/bin/true'],cwd:'/tmp',env:{}});
 assert.equal((await p.exited).code,0);if(p.kind==='process')await p.closeStdin();
 await sb.close();await f.pool.close();
});


test("SDK occupancy response releases only the rejected create admission", async () => {
  let creates = 0;
  const backend = e2bSandboxBackend(opts, {
    create: async () => {
      creates++;
      throw Object.assign(new SandboxError("409: Workspace has live family members; connect to one, or delete the whole family before rebuilding"), { statusCode: 409 });
    },
  });
  const pool = await createSandboxPool(policy, backend);
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(createSandbox(pool, { owner: "same-workspace" }),
      (error) => error instanceof SandboxCreationFault && error.outcome === "not-created");
  assert.equal(creates, 2);
  await pool.close();
});

test("other conflict responses retain uncertain create admission", async () => {
  let creates = 0;
  const backend = e2bSandboxBackend(opts, {
    create: async () => {
      creates++;
      throw Object.assign(new SandboxError("409: A previous creation has an uncertain result; reconcile its workspace_request_id before retrying"), { statusCode: 409 });
    },
  });
  const pool = await createSandboxPool(policy, backend);
  await assert.rejects(createSandbox(pool, { owner: "pending-workspace" }),
    (error) => error instanceof SandboxCreationFault && error.outcome === "unknown");
  await assert.rejects(createSandbox(pool, { owner: "pending-workspace" }), /admission queue/);
  assert.equal(creates, 1);
  await assert.rejects(pool.close(), /unverified/);
});
