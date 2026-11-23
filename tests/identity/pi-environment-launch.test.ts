import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  EnvironmentLaunchIssuer,
  type EnvironmentLaunchContext,
  type EnvironmentLaunchTarget,
} from "@opencraft/execution-environment/environment-delivery";
import { ExecutionEnvironmentSnapshot } from "@opencraft/execution-environment/execution-snapshot";
import { createRemoteEnvironmentLaunch } from "@opencraft/execution-environment/remote-environment-launch";
import type { GitExecutionHandoff, GitExecutionLocator } from "@opencraft/execution-environment/git-execution";
import { SessionCapabilityMcp, capabilitySigningKey } from "@opencraft/session-capabilities/mcp";
import { fileKeyMaterial } from "@opencraft/secret-storage/file";
import { SessionCapabilities, type CapabilitySession } from "@opencraft/session-capabilities";
import { RemoteSessionCapabilities } from "@opencraft/session-capabilities/remote";
import { createHostEnvironmentLaunch } from "../../apps/headless-server/src/host-environment-launch.ts";
import { PiDurableSession } from "../../plugins/pi-engine/src/session.js";
import { PiEngine } from "../../plugins/pi-engine/src/index.js";

const SECRET = "synthetic-vault-only-pi-value";
const threadId = "pi_public",
  inputId = "original-input",
  requestId = `${threadId}:turn:client:${inputId}`,
  attachment = "server:fixture:pi";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check: () => Promise<boolean> | boolean, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail("Expected condition did not arrive");
    await pause(20);
  }
}
const admitted = (): GitExecutionHandoff => ({
  scope: {
    account: "actor:human://fixture/one",
    hostId: "opencraft-server",
    threadId,
    inputId,
    executionId: "original-execution",
    leaseGeneration: 1,
    actorGeneration: 1,
    membershipRevision: 0,
    projectId: null,
  },
  authority: "a".repeat(64),
  capability: "v3.synthetic",
  native: { turnId: "pi-native-turn", incarnation: "native-original" },
});
const contextOf = (h: GitExecutionHandoff): EnvironmentLaunchContext => ({ scope: h.scope, native: h.native });
/** A Git port shaped like the remote Git owner: an admitted grant, or an empty
 * snapshot for an unowned input. Its capability stands in for the broker token. */
function gitPort(state: { owned: EnvironmentLaunchContext | null; capability: string; calls: GitExecutionLocator[] }) {
  return {
    async prepare(input: GitExecutionLocator) {
      state.calls.push(structuredClone(input));
      if (!state.owned)
        return new ExecutionEnvironmentSnapshot({ account: null, ...input, projectId: input.projectId ?? null }, {});
      return new ExecutionEnvironmentSnapshot(
        state.owned.scope,
        {},
        {
          ready: Promise.resolve(),
          environment: { OPENCRAFT_GIT_CAPABILITY: state.capability },
          bindThread() {},
          bindExecution() {},
        },
      );
    },
  };
}

/** Real loopback Gateway relay for the Pi attachment, a vault-owner port using
 * the real issuer, and the receiver inside the (test) engine-host process. */
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-env-launch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = await capabilitySigningKey(fileKeyMaterial(directory));
  const vault = new EnvironmentLaunchIssuer();
  const state = {
    lease: admitted() as GitExecutionHandoff | null,
    owned: contextOf(admitted()) as EnvironmentLaunchContext | null,
    values: { SERVICE_KEY: SECRET } as Record<string, string>,
    capability: "v3.grant-one",
    calls: [] as GitExecutionLocator[],
    relayed: [] as string[],
    targets: [] as EnvironmentLaunchTarget[],
    reads: 0,
  };
  const relay = createHostEnvironmentLaunch({
    port: {
      issuer: vault.key,
      async seal(target, context) {
        state.targets.push(target);
        return vault.seal(
          target,
          context,
          () => {
            state.reads++;
            return state.values;
          },
          () => {},
        );
      },
    },
    handoff: async (locator) =>
      state.lease && locator.threadId === threadId && locator.inputId === state.lease.scope.inputId
        ? structuredClone(state.lease)
        : null,
    routes: (session) => session.serverId === attachment && session.threadId === threadId,
  });
  const gateway = new SessionCapabilityMcp(new SessionCapabilities(), key, undefined, {
    descriptorPath: join(directory, "session-capabilities.json"),
    hostEnvironment: async (session, recipient) => {
      const reply = await relay(session, recipient);
      state.relayed.push(JSON.stringify(reply));
      return reply;
    },
  });
  await gateway.listen();
  t.after(() => gateway.close());
  const launch = createRemoteEnvironmentLaunch({
    purpose: "pi",
    instance: attachment,
    issuer: vault.key,
    capabilities: new RemoteSessionCapabilities(directory, attachment),
    // The engine host's own durable admission, never the relayed context.
    admission: async () => state.owned && structuredClone(state.owned),
  });
  t.after(() => {
    launch.close();
    vault.close();
  });
  return { directory, state, launch, git: gitPort(state) };
}

async function piSession(
  t: test.TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  responses: unknown[],
  options: { launch?: boolean; projectId?: string } = {},
) {
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses(responses as never);
  const models = createModels();
  models.setProvider(faux.provider);
  const faults: Error[] = [];
  const native = await PiDurableSession.open({
    threadId,
    cwd: f.directory,
    file: join(f.directory, "native.sqlite"),
    agentDirectory: join(f.directory, "agent"),
    models: models as unknown as ModelRuntime,
    tools: [],
    executionGit: f.git,
    ...(options.launch === false ? {} : { executionLaunch: f.launch }),
    ...(options.projectId ? { projectId: options.projectId } : {}),
    onSnapshot() {},
    onTool: async () => {
      throw Error("Unexpected platform call");
    },
    onExit: (error) => faults.push(error),
  });
  t.after(async () => {
    await native.close();
    assert.deepEqual(faults, []);
  });
  await native.configure({ model: { provider: "faux", modelId: "faux-1" }, cwd: f.directory });
  const run = async () => {
    const admission = await native.submit(
      "run",
      { turnId: requestId, clientId: inputId, input: [{ type: "text", text: "run" }], createdAtMs: Date.now() },
      requestId,
    );
    await admission.wait(BACKGROUND_CONTEXT);
  };
  /** Shell workers that hold a delivered snapshot (the idle worker never does). */
  const environmentWorkers = () => native.workerProcessIds.filter((pid) => pid !== native.idleWorkerPid);
  return { native, run, environmentWorkers };
}
const lastResult = (ctx: any) =>
  JSON.stringify(ctx.messages.filter((message: any) => message.role === "toolResult").at(-1) ?? null);
const printEnvironment = () =>
  fauxAssistantMessage(
    fauxToolCall("bash", {
      command: 'printf "<%s|%s>" "$SERVICE_KEY" "$OPENCRAFT_GIT_CAPABILITY"',
      yield_time_ms: 5000,
    }),
    { stopReason: "toolUse" },
  );

test("Pi combines delivered ENV and its Git grant into one snapshot, one shell worker per snapshot, reused by key", async (t) => {
  const f = await fixture(t);
  const results: string[] = [],
    workers: number[][] = [];
  const ref = {} as { s: Awaited<ReturnType<typeof piSession>> };
  const observe = (ctx: any) => {
    results.push(lastResult(ctx));
    workers.push(ref.s.environmentWorkers());
  };
  ref.s = await piSession(t, f, [
    printEnvironment(),
    (ctx: any) => {
      observe(ctx);
      return printEnvironment();
    },
    (ctx: any) => {
      observe(ctx);
      f.state.values = { SERVICE_KEY: "rotated-" + SECRET };
      return printEnvironment();
    },
    (ctx: any) => {
      observe(ctx);
      return fauxAssistantMessage("done");
    },
  ]);
  const s = ref.s;
  await s.run();
  assert.match(results[0]!, new RegExp(`<${SECRET}\\|v3\\.grant-one>`));
  assert.match(results[1]!, new RegExp(`<${SECRET}\\|v3\\.grant-one>`));
  assert.match(results[2]!, new RegExp(`<rotated-${SECRET}\\|v3\\.grant-one>`));
  // The same snapshot reuses its worker; a different snapshot gets its own, and
  // the idle predecessor is retired instead of accumulating.
  assert.equal(workers[0]!.length, 1);
  assert.deepEqual(workers[1], workers[0]);
  assert.equal(workers[2]!.length, 1);
  assert.notEqual(workers[2]![0], workers[0]![0]);
  // Every launch is a fresh one-shot delivery for the Pi attachment.
  assert.equal(f.state.reads, 3);
  assert.deepEqual(
    new Set(f.state.targets.map((target) => `${target.purpose}:${target.instance}`)),
    new Set([`pi:${attachment}`]),
  );
  // Main relays only ciphertext and routing metadata; the locator names no Project.
  assert.equal(f.state.relayed.length, 3);
  for (const reply of f.state.relayed)
    assert.ok(!reply.includes(SECRET) && !reply.includes("rotated-"), "relay carries no value");
  assert.ok(f.state.calls.every((call) => call.inputId === inputId && call.projectId === null));
});

test("a revoked admission retires the worker holding delivered values and interrupts its command", async (t) => {
  const f = await fixture(t);
  const pidFile = join(f.directory, "background.pid");
  const workers: number[][] = [];
  let refused = "";
  const ref = {} as { s: Awaited<ReturnType<typeof piSession>> };
  ref.s = await piSession(t, f, [
    fauxAssistantMessage(
      fauxToolCall("bash", { command: `echo $$ > '${pidFile}'; exec sleep 30`, yield_time_ms: 20 }),
      { stopReason: "toolUse" },
    ),
    async () => {
      await eventually(() =>
        access(pidFile).then(
          () => true,
          () => false,
        ),
      );
      workers.push(ref.s.environmentWorkers());
      // The engine host's own admission moves on (lease replaced, Actor revoked).
      f.state.owned = { ...contextOf(admitted()), scope: { ...admitted().scope, executionId: "successor-execution" } };
      return printEnvironment();
    },
    (ctx: any) => {
      refused = lastResult(ctx);
      workers.push(ref.s.environmentWorkers());
      return fauxAssistantMessage("done");
    },
    fauxAssistantMessage("acknowledged"),
    fauxAssistantMessage("acknowledged"),
  ]);
  const s = ref.s;
  await s.run();
  const background = Number(await readFile(pidFile, "utf8"));
  assert.equal(workers[0]!.length, 1);
  assert.deepEqual(workers[1], [], "the revoked snapshot's worker is retired");
  assert.ok(!refused.includes(SECRET));
  await eventually(() => {
    try {
      process.kill(background, 0);
      return false;
    } catch {
      return true;
    }
  });
  const records = (await s.native.snapshot()).shell?.records ?? [];
  assert.equal(records.length, 1);
  assert.equal(records[0]!.state, "interrupted");
  assert.match(records[0]!.output, /revoked/);
});

test("an unowned input launches with neither personal values nor another Human's grant", async (t) => {
  const f = await fixture(t);
  f.state.lease = null;
  f.state.owned = null;
  let result = "";
  const s = await piSession(t, f, [
    printEnvironment(),
    (ctx: any) => {
      result = lastResult(ctx);
      return fauxAssistantMessage("done");
    },
  ]);
  await s.run();
  assert.match(result, /<\|>/);
  assert.equal(f.state.reads, 0, "no vault read without an admitted Human");
});

test("delivered values and the Git grant must belong to the same admission", () => {
  const scope = admitted().scope;
  const grant = (environment: Record<string, string>) => ({
    ready: Promise.resolve(),
    environment,
    bindThread() {},
    bindExecution() {},
  });
  const values = new ExecutionEnvironmentSnapshot(scope, { SERVICE_KEY: SECRET });
  const git = new ExecutionEnvironmentSnapshot(scope, {}, grant({ OPENCRAFT_GIT_CAPABILITY: "v3.cap" }));
  const combined = ExecutionEnvironmentSnapshot.combine(values, git);
  assert.deepEqual(combined.overlay(), { SERVICE_KEY: SECRET, OPENCRAFT_GIT_CAPABILITY: "v3.cap" });
  assert.equal(combined.owner, values.owner);
  assert.ok(!JSON.stringify(combined).includes(SECRET));
  const other = new ExecutionEnvironmentSnapshot({ ...scope, account: "actor:human://fixture/two" }, {}, grant({}));
  assert.throws(() => ExecutionEnvironmentSnapshot.combine(values, other), {
    message: "environment_launch_unavailable",
  });
  const unowned = new ExecutionEnvironmentSnapshot({ ...scope, account: null }, {});
  assert.throws(() => ExecutionEnvironmentSnapshot.combine(values, unowned));
  // A delivered name never shadows a Git variable, and neither part is doubled.
  const shadow = new ExecutionEnvironmentSnapshot(scope, { OPENCRAFT_GIT_CAPABILITY: "forged" });
  assert.throws(() => ExecutionEnvironmentSnapshot.combine(shadow, git));
  assert.throws(() => ExecutionEnvironmentSnapshot.combine(combined, git));
  assert.throws(() => ExecutionEnvironmentSnapshot.combine(values, combined));
});

test("in-process Pi refuses a receiver: delivery needs the Git port and a single ENV owner", () => {
  const launch = {
    prepare: async () =>
      new ExecutionEnvironmentSnapshot({ account: null, hostId: "opencraft-server", threadId, projectId: null }, {}),
  };
  const base = { directory: join(tmpdir(), "pi-env-launch-unused"), cwd: tmpdir() };
  assert.throws(() => new PiEngine({ ...base, executionLaunch: launch }), /requires the Git execution port/);
  assert.throws(
    () =>
      new PiEngine({
        ...base,
        executionLaunch: launch,
        executionGit: gitPort({ owned: null, capability: "", calls: [] }),
        executionEnvironment: {} as never,
      }),
    /two owners/,
  );
});

test("compatibility: without delivery Pi keeps its Git port unchanged and the relay serves only receiver attachments", async (t) => {
  const f = await fixture(t);
  let result = "";
  const s = await piSession(
    t,
    f,
    [
      printEnvironment(),
      (ctx: any) => {
        result = lastResult(ctx);
        return fauxAssistantMessage("done");
      },
    ],
    { launch: false, projectId: "project-a" },
  );
  await s.run();
  assert.match(result, /<\|v3\.grant-one>/);
  assert.equal(f.state.relayed.length, 0, "no ENV request without delivery");
  assert.deepEqual(
    f.state.calls.map((call) => call.projectId),
    ["project-a"],
  );
  const relay = createHostEnvironmentLaunch({
    port: { issuer: "unused", seal: async () => assert.fail("must not seal") },
    handoff: async () => admitted(),
    routes: () => true,
  });
  const session = (serverId: string) =>
    ({ serverId, threadId, execution: { inputId } }) as unknown as CapabilitySession;
  for (const serverId of ["server:fixture:acp", "server:fixture:codex", "server:fixture:claude-code"])
    await assert.rejects(relay(session(serverId), "recipient"), { message: "environment_launch_unavailable" });
});
