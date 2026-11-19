import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createWorkspaceExecutionAuthority,
  consumeWorkspaceExecutionGrant,
  workspaceGrantField,
  validateWorkspaceExecutionSelection,
  type WorkspaceExecutionSelection,
} from "../../packages/sandbox-node/src/workspace-execution-channel.js";
import { privateWorkspaceExecutionPolicy } from "../../apps/codex-core/src/workspace-execution-policy.js";
import { workspaceExecutionTransport } from "../../apps/opencraft-daemon/src/workspace-execution-transport.js";

const token = "synthetic-private-core-token-not-a-secret";
const remote = (generation = 1): WorkspaceExecutionSelection => ({
  kind: "bound",
  workspaceId: "ws-test",
  generation,
  environmentId: "workspace-ws-test",
  cwd: "/workspace",
  execServerUrl: "ws://127.0.0.1:4321/" + String(generation).repeat(64),
});
async function fixture(t: test.TestContext, options: { maxPending?: number; lifetimeMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "workspace-authority-")),
    socketPath = join(dir, "owner.sock");
  const authority = await createWorkspaceExecutionAuthority({ socketPath, token, ...options });
  t.after(async () => {
    await authority.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { authority, socketPath, token };
}
const request = { threadId: "thread-old", approvalPolicy: "never", input: [{ text: "test" }] };

test("private authority uses a private socket and never replaces an existing owner", async (t) => {
  const f = await fixture(t);
  assert.equal((await stat(f.socketPath)).mode & 0o777, 0o600);
  await assert.rejects(createWorkspaceExecutionAuthority(f), /EADDRINUSE/);
  const grant = f.authority.mint("turn/start", request, async () => remote());
  assert.deepEqual(await consumeWorkspaceExecutionGrant(f, grant.ticket, "turn/start", request), remote());
});

test("one-shot grants reauthorize on consume, reject replay and do not expose resolver errors", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const grant = f.authority.mint("turn/start", request, async () => {
    calls++;
    return remote();
  });
  assert.equal(calls, 0);
  assert.deepEqual(await consumeWorkspaceExecutionGrant(f, grant.ticket, "turn/start", request), remote());
  await assert.rejects(consumeWorkspaceExecutionGrant(f, grant.ticket, "turn/start", request), /authority unavailable/);
  assert.equal(calls, 1);
  const revoked = f.authority.mint("turn/start", request, async () => {
    throw Error("secret source credential");
  });
  await assert.rejects(consumeWorkspaceExecutionGrant(f, revoked.ticket, "turn/start", request), {
    message: "Workspace execution authority unavailable",
  });
});

test("wrong token cannot consume; changed method or request cannot use another admission", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const make = () =>
    f.authority.mint("turn/start", request, async () => {
      calls++;
      return remote();
    });
  const valid = make();
  await assert.rejects(
    consumeWorkspaceExecutionGrant({ ...f, token: "wrong".repeat(10) }, valid.ticket, "turn/start", request),
  );
  await consumeWorkspaceExecutionGrant(f, valid.ticket, "turn/start", {
    input: request.input,
    approvalPolicy: "never",
    threadId: "thread-old",
  });
  for (const [method, params] of [
    ["thread/resume", request],
    ["turn/start", { ...request, threadId: "other" }],
    ["turn/start", { ...request, approvalPolicy: "on-request" }],
  ] as const) {
    const grant = make();
    await assert.rejects(consumeWorkspaceExecutionGrant(f, grant.ticket, method, params));
    await assert.rejects(consumeWorkspaceExecutionGrant(f, grant.ticket, "turn/start", request));
  }
  assert.equal(calls, 1);
});

test("expired, cancelled and over-capacity grants fail closed", async (t) => {
  const f = await fixture(t, { maxPending: 1, lifetimeMs: 30 });
  const grant = f.authority.mint("turn/start", request, async () => remote());
  assert.throws(() => f.authority.mint("turn/start", request, async () => remote()));
  grant.cancel();
  await assert.rejects(consumeWorkspaceExecutionGrant(f, grant.ticket, "turn/start", request));
  const expired = f.authority.mint("turn/start", request, async () => remote());
  await new Promise((resolve) => setTimeout(resolve, 45));
  await assert.rejects(consumeWorkspaceExecutionGrant(f, expired.ticket, "turn/start", request));
  f.authority.mint("turn/start", request, async () => remote()).cancel();
});

test("in-flight authorization retains capacity and a disconnected receiver is not replayed", async (t) => {
  const f = await fixture(t, { maxPending: 1 });
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const grant = f.authority.mint("turn/start", request, async () => {
    entered();
    await wait;
    return remote();
  });
  const pending = consumeWorkspaceExecutionGrant(f, grant.ticket, "turn/start", request);
  const rejected = assert.rejects(pending);
  await ready;
  assert.throws(() => f.authority.mint("turn/start", request, async () => remote()));
  await f.authority.close();
  release();
  await rejected;
});

test("remote descriptors cannot select local/foreign endpoints or escape the private root", () => {
  for (const patch of [
    { execServerUrl: "ws://example.test:4321/" + "1".repeat(64) },
    { execServerUrl: "ws://127.0.0.1:99999/" + "1".repeat(64) },
    { cwd: "/workspace/../shared" },
    { cwd: "/workspace-other" },
    { environmentId: "opencraft" },
    { generation: 0 },
    { secret: "extra" },
  ]) {
    assert.throws(() => validateWorkspaceExecutionSelection({ ...remote(), ...patch }), {
      message: "Workspace execution authority unavailable",
    });
  }
});

test("separate client processes cannot both consume one Gateway admission", async (t) => {
  const f = await fixture(t),
    grant = f.authority.mint("turn/start", request, async () => remote());
  const modulePath = fileURLToPath(
    new URL("../../packages/sandbox-node/src/workspace-execution-channel.ts", import.meta.url),
  );
  const script = `const {consumeWorkspaceExecutionGrant}=await import(process.argv[1]);let input='';for await(const c of process.stdin)input+=c;const x=JSON.parse(input);try{await consumeWorkspaceExecutionGrant(x,x.ticket,'turn/start',x.params);process.stdout.write('accepted')}catch{process.stdout.write('rejected')}`;
  const child = () =>
    new Promise<string>((resolve, reject) => {
      const processChild = spawn(process.execPath, ["--input-type=module", "-e", script, modulePath], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "",
        error = "";
      processChild.stdout.on("data", (c) => {
        output += c;
      });
      processChild.stderr.on("data", (c) => {
        error += c;
      });
      processChild.once("error", reject);
      processChild.once("exit", (code) => (code === 0 ? resolve(output) : reject(Error(error))));
      processChild.stdin.end(
        JSON.stringify({ socketPath: f.socketPath, token, ticket: grant.ticket, params: request }),
      );
    });
  assert.deepEqual((await Promise.all([child(), child()])).sort(), ["accepted", "rejected"]);
});

test("physical Gateway decorator and strict Native policy compose without leaking grants to Native", async (t) => {
  const f = await fixture(t),
    registrations: string[] = [],
    forwarded: Record<string, unknown>[] = [];
  const policy = privateWorkspaceExecutionPolicy({
    ...f,
    readThread: async () => {
      throw Error("local fallback");
    },
    nativeRequest: async (method, params) => {
      registrations.push(method);
      assert.equal(params.environmentId, "workspace-ws-test");
    },
  });
  const native = {
    status: { state: "open" as const },
    connect: async () => {},
    close: async () => {},
    subscribeMessage: () => () => {},
    subscribeStatus: () => () => {},
    async send(frame: string) {
      const message = JSON.parse(frame);
      forwarded.push(await policy(message.method, message.params));
    },
  };
  const physicalIds: unknown[] = [];
  const transport = workspaceExecutionTransport(native, f.authority, async (_method, params, request) => {
    physicalIds.push(request.id);
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(params), true);
    return async () => remote();
  });
  for (const method of ["thread/resume", "turn/start", "turn/start"])
    await transport.send(JSON.stringify({ id: 1, method, params: request }));
  assert.deepEqual(physicalIds, [1, 1, 1]);
  assert.deepEqual(registrations, ["environment/add"]);
  assert.equal(forwarded.length, 3);
  for (const params of forwarded) {
    assert.equal(Object.hasOwn(params, workspaceGrantField), false);
    assert.equal(params.approvalPolicy, "never");
    assert.deepEqual(params.environments, [{ environmentId: "workspace-ws-test", cwd: "/workspace" }]);
  }
  await assert.rejects(policy("turn/start", request), /workspace-binding-unavailable/);
  await assert.rejects(
    transport.send(JSON.stringify({ method: "turn/start", params: { ...request, [workspaceGrantField]: "injected" } })),
    /Caller cannot supply/,
  );
});

test("strict Native policy requires explicit local classification and rejects stale remote generations", async (t) => {
  const f = await fixture(t),
    added: string[] = [];
  const policy = privateWorkspaceExecutionPolicy({
    ...f,
    readThread: async () => ({ thread: { cwd: "/local" } }),
    nativeRequest: async (_method, params) => {
      added.push(String(params.execServerUrl));
    },
  });
  const invoke = async (selection: WorkspaceExecutionSelection) => {
    const grant = f.authority.mint("turn/start", request, async () => selection);
    return policy("turn/start", { ...request, [workspaceGrantField]: grant.ticket });
  };
  assert.deepEqual((await invoke({ kind: "local" })).environments, [{ environmentId: "opencraft", cwd: "/local" }]);
  await invoke(remote(1));
  await invoke(remote(2));
  await assert.rejects(invoke(remote(1)), /workspace-binding-unavailable/);
  assert.equal(added.length, 2);
});

test("uncertain registration is not upserted again, even with a fresh authorized ticket", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const policy = privateWorkspaceExecutionPolicy({
    ...f,
    readThread: async () => null,
    nativeRequest: async () => {
      calls++;
      throw Error("lost response");
    },
  });
  for (let i = 0; i < 2; i++) {
    const grant = f.authority.mint("turn/start", request, async () => remote());
    await assert.rejects(
      policy("turn/start", { ...request, [workspaceGrantField]: grant.ticket }),
      /workspace-binding-unavailable/,
    );
  }
  assert.equal(calls, 1);
});

test("Gateway restart invalidates old tickets instead of reviving local or remote execution", async (t) => {
  const f = await fixture(t),
    old = f.authority.mint("turn/start", request, async () => remote());
  await f.authority.close();
  const replacement = await createWorkspaceExecutionAuthority(f);
  t.after(() => replacement.close());
  await assert.rejects(consumeWorkspaceExecutionGrant(f, old.ticket, "turn/start", request));
  const fresh = replacement.mint("turn/start", request, async () => remote(2));
  assert.deepEqual(await consumeWorkspaceExecutionGrant(f, fresh.ticket, "turn/start", request), remote(2));
});

test("a newer incarnation waits for old registration and prevents old request forwarding", async (t) => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const began = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
  const urls: unknown[] = [];
  const policy = privateWorkspaceExecutionPolicy({
    ...f,
    readThread: async () => null,
    nativeRequest: async (_method, params) => {
      urls.push(params.execServerUrl);
      if (urls.length === 1) {
        entered();
        await wait;
      }
    },
  });
  const invoke = (selection: WorkspaceExecutionSelection) => {
    const grant = f.authority.mint("turn/start", request, async () => selection);
    return policy("turn/start", { ...request, [workspaceGrantField]: grant.ticket });
  };
  const first = assert.rejects(invoke(remote(1)), /workspace-binding-unavailable/);
  await began;
  const second = invoke(remote(2));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(urls.length, 1);
  release();
  await first;
  await second;
  assert.equal(urls.length, 2);
  const sameGenerationOtherUrl = { ...remote(2), execServerUrl: "ws://127.0.0.1:4322/" + "2".repeat(64) };
  await assert.rejects(invoke(sameGenerationOtherUrl), /workspace-binding-unavailable/);
  assert.equal(urls.length, 2);
});

test("callback-relay-owned metadata is excluded without relaxing Native parameter binding", async (t) => {
  const f = await fixture(t);
  const decorated = {
    ...request,
    __opencraftDeferPublication: true,
    __opencraftOrchestrationOperation: "operation",
    __opencraftOrchestrationFingerprint: "fingerprint",
    __opencraftOrchestrationIncarnation: "incarnation",
    __opencraftOrchestrationSourceThreadId: "source",
    __opencraftDelegationId: null,
  };
  const grant = f.authority.mint("turn/start", decorated, async () => remote());
  assert.deepEqual(await consumeWorkspaceExecutionGrant(f, grant.ticket, "turn/start", request), remote());
  const tampered = f.authority.mint("turn/start", decorated, async () => remote());
  await assert.rejects(consumeWorkspaceExecutionGrant(f, tampered.ticket, "turn/start", { ...request, cwd: "/other" }));
});
