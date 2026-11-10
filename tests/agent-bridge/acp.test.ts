import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AcpDeltaTranslator,
  declarationFor,
  profileFromEnv,
  resolvePermission,
  AcpClientHost,
  type AcpProfile,
} from "../../packages/agent-bridge-acp/src/index.js";

const fixture = resolve("tests/agent-bridge/fixtures/acp-agent.mjs");
const main = resolve("packages/agent-bridge-acp/src/main.ts");

interface Started {
  readonly child: ChildProcessWithoutNullStreams;
  readonly env: NodeJS.ProcessEnv;
  readonly profile: AcpProfile;
  readonly logPath: string;
  readonly stderr: () => string;
}

async function startBridge(
  root: string,
  options: {
    dialect?: "generic" | "amp" | "copilot";
    mode?: "read-only" | "accept-edits" | "auto" | "full";
    model?: string;
    fixtureEnv?: Record<string, string>;
    provider?: string;
  } = {},
): Promise<Started> {
  const logPath = join(root, `fixture-${Math.random().toString(36).slice(2)}.ndjson`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_BRIDGE_ACP_PROVIDER: options.provider ?? "fixture",
    AGENT_BRIDGE_ACP_DIALECT: options.dialect ?? "generic",
    AGENT_BRIDGE_ACP_COMMAND: process.execPath,
    AGENT_BRIDGE_ACP_ARGS: JSON.stringify([fixture]),
    AGENT_BRIDGE_ACP_CWD: root,
    AGENT_BRIDGE_ACP_PERMISSION_MODE: options.mode ?? "accept-edits",
    ...(options.model === undefined ? {} : { AGENT_BRIDGE_ACP_MODEL: options.model }),
    ACP_FIXTURE_LOG: logPath,
    ...options.fixtureEnv,
  };
  const child = spawn(process.execPath, ["--import", "tsx", main], {
    cwd: resolve("."),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return { child, env, profile: profileFromEnv(env), logPath, stderr: () => stderr };
}

class BridgeClient {
  readonly frames: any[] = [];
  readonly callbacks: any[] = [];
  private readonly pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private sequence = 0;

  constructor(readonly started: Started) {
    createInterface({ input: started.child.stdout }).on("line", (line) => {
      let frame: any;
      try { frame = JSON.parse(line); } catch { return; }
      this.frames.push(frame);
      if (typeof frame.method === "string" && frame.id !== undefined) {
        this.callbacks.push(frame);
        started.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { durable: true } }) + "\n");
        return;
      }
      if (frame.id !== undefined && this.pending.has(String(frame.id))) {
        const waiter = this.pending.get(String(frame.id))!;
        this.pending.delete(String(frame.id));
        clearTimeout(waiter.timer);
        if (frame.error) waiter.reject(Object.assign(new Error(frame.error.message), { kind: frame.error.kind, code: frame.error.code }));
        else waiter.resolve(frame.result);
      }
    });
    started.child.once("exit", (code) => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`bridge exited ${code}; stderr: ${started.stderr().slice(-2000)}`));
      }
      this.pending.clear();
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 8_000): Promise<any> {
    const id = `test:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge request ${method} timed out; stderr: ${this.started.stderr().slice(-2000)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.started.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async initialize(): Promise<any> {
    return this.request("initialize", {
      protocolVersion: 1,
      grammarRange: { min: 1, max: 1 },
      hostCapabilities: ["test"],
    });
  }

  deltas(threadId?: string): any[] {
    return this.callbacks
      .filter((frame) => frame.method === "thread/delta")
      .flatMap((frame) => frame.params.deltas)
      .filter((delta: any) => threadId === undefined || delta.scope.threadId === threadId);
  }

  callbackFor(method: string, threadId?: string): any[] {
    return this.callbacks.filter((frame) => frame.method === method
      && (threadId === undefined || frame.params.threadId === threadId));
  }

  async waitFor<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, timeoutMs = 6_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (predicate(value)) return value;
      if (Date.now() > deadline) {
        throw new Error(`condition timed out; stderr: ${this.started.stderr().slice(-3000)}; frames: ${JSON.stringify(this.frames.slice(-8))}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async close(): Promise<void> {
    if (this.started.child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => this.started.child.once("exit", () => resolve()));
    this.started.child.kill("SIGTERM");
    await exited;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("initialize probes the installed agent and narrows native steer/image capabilities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const full = await startBridge(root, { fixtureEnv: { ACP_FIXTURE_NATIVE_STEER: "1", ACP_FIXTURE_IMAGE: "1" } });
  t.after(() => full.child.kill("SIGTERM"));
  const fullClient = new BridgeClient(full);
  const fullInit = await fullClient.initialize();
  assert.equal(fullInit.protocolVersion, 1);
  assert.deepEqual(fullInit.effectiveCapabilities.inputContentTypes, ["text", "image"]);
  assert(fullInit.effectiveCapabilities.steer.deliveryMethods.includes("native-inject"));
  assert(fullInit.effectiveCapabilities.steer.deliveryMethods.includes("next-turn"));
  await fullClient.close();

  const plain = await startBridge(root, { fixtureEnv: { ACP_FIXTURE_NATIVE_STEER: "0", ACP_FIXTURE_IMAGE: "0" } });
  t.after(() => plain.child.kill("SIGTERM"));
  const plainClient = new BridgeClient(plain);
  const plainInit = await plainClient.initialize();
  assert.equal(plainInit.effectiveCapabilities.inputContentTypes.includes("image"), false);
  assert.equal(plainInit.effectiveCapabilities.steer.deliveryMethods.includes("native-inject"), false);
  assert(plainInit.effectiveCapabilities.steer.deliveryMethods.includes("interrupt-replace"));
  await plainClient.close();

  // Copilot's installed initialize has no native declaration even if a fixture
  // would advertise one: the dialect must not widen the registered bound.
  const copilot = await startBridge(root, { dialect: "copilot", fixtureEnv: { ACP_FIXTURE_NATIVE_STEER: "1" } });
  t.after(() => copilot.child.kill("SIGTERM"));
  const copilotClient = new BridgeClient(copilot);
  const copilotInit = await copilotClient.initialize();
  assert.deepEqual(copilotInit.effectiveCapabilities.steer.deliveryMethods, ["next-turn", "interrupt-replace"]);
  await copilotClient.close();
});

test("turn/start translates ACP updates into semantic deltas and applies permission/model selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-turn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, {
    mode: "full",
    model: "cheap",
    fixtureEnv: { ACP_FIXTURE_MODES: "1", ACP_FIXTURE_CONFIG: "1", ACP_FIXTURE_DELAY_MS: "20" },
  });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  await client.initialize();
  const created = await client.request("session/create", { threadId: "thread-1", cwd: root, permissionMode: "full", modelSelection: "cheap" });
  assert.equal(created.providerThreadId, "fixture-session-1");
  assert.equal(created.permission.nativeModeId, "full");
  assert.equal(created.model.configOptionId, "model");

  const startedTurn = await client.request("turn/start", {
    threadId: "thread-1",
    input: { text: "hello fixture" },
    inputId: "turn-input-1",
    clientRequestId: "client-turn-1",
  });
  assert.match(startedTurn.nativeTurnId, /^acp:/u);
  await client.waitFor(() => client.deltas("thread-1"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.close" && delta.status === "completed"));

  const deltas = client.deltas("thread-1");
  assert(deltas.some((delta) => delta.op === "turn.open" && delta.nativeTurnId === startedTurn.nativeTurnId));
  assert(deltas.some((delta) => delta.op === "item.open" && delta.shape.kind === "agentMessage"));
  assert.equal(
    deltas.filter((delta) => delta.op === "item.textDelta" && delta.channel === "agentMessage").map((delta) => delta.text).join(""),
    "fixture answer: hello fixture",
  );
  assert(deltas.some((delta) => delta.op === "item.open" && delta.shape.kind === "command" && delta.shape.command === "printf fixture"));
  assert(deltas.some((delta) => delta.op === "item.close" && delta.shape.kind === "command" && delta.shape.status === "completed"));
  assert(deltas.some((delta) => delta.op === "contextWindow" && delta.usedTokens === 10 && delta.modelContextWindow === 1000));
  const closeIndex = deltas.findIndex((delta) => delta.op === "turn.close");
  const idleIndex = deltas.findIndex((delta) => delta.op === "turn.mainRun" && delta.state === "idle");
  assert(idleIndex >= 0 && idleIndex < closeIndex);

  const identity = client.callbackFor("thread/identity", "thread-1");
  assert.equal(identity.length, 1);
  assert.equal(identity[0].params.providerThreadId, "fixture-session-1");

  const frames = (await readFile(started.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert(frames.some((frame) => frame.method === "session/set_mode" && frame.params.modeId === "full"));
  assert.equal(created.model.configOptionId, "model");
  assert.equal(created.model.value, "cheap");
  assert.equal(frames.some((frame) => frame.method === "session/set_config_option"
    && frame.params.configId === "model" && frame.params.value !== "cheap"), false);
  await client.close();
});

test("images reach the ACP prompt only when the agent declared image support", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-image-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

  const withImage = await startBridge(root, { fixtureEnv: { ACP_FIXTURE_IMAGE: "1", ACP_FIXTURE_DELAY_MS: "10" } });
  t.after(() => withImage.child.kill("SIGTERM"));
  const client = new BridgeClient(withImage);
  await client.initialize();
  await client.request("session/create", { threadId: "thread-image", cwd: root });
  await client.request("turn/start", {
    threadId: "thread-image",
    input: { text: "describe this", images: [{ mimeType: "image/png", data: png }] },
  });
  await client.waitFor(() => client.deltas("thread-image"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.close"));
  assert(client.deltas("thread-image").some((delta) =>
    delta.op === "item.textDelta" && /fixture received 1 image/u.test(delta.text)));
  const frames = (await readFile(withImage.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const prompt = frames.find((frame) => frame.method === "session/prompt");
  assert(prompt.params.prompt.some((block: any) => block.type === "image"));
  await client.close();

  const noImage = await startBridge(root, { fixtureEnv: { ACP_FIXTURE_IMAGE: "0" } });
  t.after(() => noImage.child.kill("SIGTERM"));
  const noImageClient = new BridgeClient(noImage);
  await noImageClient.initialize();
  await noImageClient.request("session/create", { threadId: "thread-no-image", cwd: root });
  await assert.rejects(
    noImageClient.request("turn/start", {
      threadId: "thread-no-image",
      input: { text: "describe this", images: [{ mimeType: "image/png", data: png }] },
    }),
    (error: any) => error.kind === "invalid" && /image prompt support/u.test(error.message),
  );
  await noImageClient.close();
});

test("permission requests use the existing approval interaction channel and are answered exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-permission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, { mode: "auto", fixtureEnv: { ACP_FIXTURE_PERMISSION: "1", ACP_FIXTURE_DELAY_MS: "10" } });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  await client.initialize();
  await client.request("session/create", { threadId: "thread-permission", cwd: root, permissionMode: "auto" });
  await client.request("turn/start", { threadId: "thread-permission", input: { text: "run a tool" } });
  const interaction = await client.waitFor(
    () => client.callbackFor("interaction/request", "thread-permission"),
    (frames) => frames.length === 1,
  );
  const request = interaction[0].params;
  assert.equal(request.kind, "approval");
  assert.equal(request.payload.method, "item/commandExecution/requestApproval");
  assert.deepEqual(request.payload.params.availableDecisions, ["accept", "decline"]);
  assert.equal(request.payload.native.permissionPolicy, "route");
  await client.request("interaction/resolve", {
    threadId: "thread-permission",
    interactionId: request.interactionId,
    result: { decision: "accept" },
  });
  await client.waitFor(() => client.deltas("thread-permission"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.close" && delta.status === "completed"));
  assert(client.deltas("thread-permission").some((delta) =>
    delta.op === "item.textDelta" && delta.text.includes("fixture permission accepted")));

  // A duplicate resolve must be a no-op, not a second native write.
  const duplicate = await client.request("interaction/resolve", {
    threadId: "thread-permission",
    interactionId: request.interactionId,
    result: { decision: "decline" },
  });
  assert.equal(duplicate.resolved, true);
  assert.equal(duplicate.duplicate, true);
  await client.close();
});

test("full and accept-edits permission modes do not ask a human for edit tools; read-only denies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [mode, expected] of [["full", "completed"], ["accept-edits", "completed"], ["read-only", "interrupted"]] as const) {
    const started = await startBridge(root, { mode, fixtureEnv: { ACP_FIXTURE_PERMISSION: "1", ACP_FIXTURE_DELAY_MS: "10" } });
    t.after(() => started.child.kill("SIGTERM"));
    const client = new BridgeClient(started);
    await client.initialize();
    const threadId = `thread-${mode}`;
    await client.request("session/create", { threadId, cwd: root, permissionMode: mode });
    await client.request("turn/start", { threadId, input: { text: "edit a file" } });
    await client.waitFor(() => client.deltas(threadId), (deltas) =>
      deltas.some((delta) => delta.op === "turn.close"));
    assert.equal(client.deltas(threadId).find((delta) => delta.op === "turn.close").status, expected, mode);
    assert.equal(client.callbackFor("interaction/request", threadId).length, 0, `${mode} must decide locally`);
    await client.close();
  }
});

test("native steering is admitted and recorded without opening a second turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-steer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, { mode: "full", fixtureEnv: { ACP_FIXTURE_NATIVE_STEER: "1", ACP_FIXTURE_DELAY_MS: "100" } });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  await client.initialize();
  await client.request("session/create", { threadId: "thread-steer", cwd: root, permissionMode: "full" });
  const turn = await client.request("turn/start", { threadId: "thread-steer", input: { text: "write a report with several words to keep the turn open" } });
  await client.waitFor(() => client.deltas("thread-steer"), (deltas) =>
    deltas.some((delta) => delta.op === "item.textDelta"));
  const answer = await client.request("turn/steer", {
    threadId: "thread-steer",
    inputId: "steer-1",
    clientRequestId: "client-steer-1",
    expectedTurnId: turn.nativeTurnId,
    delivery: "native-inject",
    input: { text: "use the blue door" },
  });
  assert.equal(answer.delivery, "native-inject");
  await client.waitFor(() => client.deltas("thread-steer"), (deltas) =>
    deltas.some((delta) => delta.op === "input.delivery" && delta.inputId === "steer-1"));
  const secondSteer = await client.request("turn/steer", {
    threadId: "thread-steer",
    inputId: "steer-2",
    clientRequestId: "client-steer-2",
    expectedTurnId: turn.nativeTurnId,
    delivery: "native-inject",
    input: { text: "also mention the red door" },
  });
  assert.equal(secondSteer.delivery, "native-inject");
  await client.waitFor(() => client.deltas("thread-steer"), (deltas) =>
    deltas.some((delta) => delta.op === "input.delivery" && delta.inputId === "steer-2"));
  await client.waitFor(() => client.deltas("thread-steer"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.close"));
  const deltas = client.deltas("thread-steer");
  assert.equal(deltas.filter((delta) => delta.op === "turn.open").length, 1);
  assert.equal(deltas.filter((delta) => delta.op === "turn.close").length, 1);
  const delivery = deltas.find((delta) => delta.op === "input.delivery" && delta.inputId === "steer-1");
  assert.equal(delivery.deliveryMethod, "native-inject");
  assert.equal(delivery.admitted, true);
  assert(deltas.some((delta) => delta.op === "input.evidence" && delta.inputId === "steer-1" && delta.evidenceKind === "admission"));
  const query = await client.request("input/query", { threadId: "thread-steer", inputIds: ["steer-1", "steer-2"] });
  assert.equal(query.inputs.length, 2);
  assert.equal(query.inputs[0].admission.value, "accepted");
  assert.equal(query.inputs[0].delivery.value, "native-inject");
  assert.equal(query.inputs[0].nativeExecutions, 1);
  assert.equal(query.inputs[1].admission.value, "accepted");
  await client.close();
});

test("a Copilot-like agent without native declaration only offers explicit next-turn/interrupt and never a fake native label", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-copilot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, {
    dialect: "copilot",
    mode: "auto",
    fixtureEnv: { ACP_FIXTURE_NATIVE_STEER: "0", ACP_FIXTURE_DELAY_MS: "40" },
  });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  const init = await client.initialize();
  assert.equal(init.effectiveCapabilities.steer.deliveryMethods.includes("native-inject"), false);
  await client.request("session/create", { threadId: "thread-copilot", cwd: root, permissionMode: "auto" });
  await client.request("turn/start", { threadId: "thread-copilot", input: { text: "first task" } });
  await client.waitFor(() => client.deltas("thread-copilot"), (deltas) =>
    deltas.some((delta) => delta.op === "item.textDelta"));

  await assert.rejects(
    client.request("turn/steer", {
      threadId: "thread-copilot",
      inputId: "fake-native",
      clientRequestId: "client-fake-native",
      input: { text: "must not be called native" },
    }),
    (error: any) => error.kind === "explicit-reject" && /next-turn or interrupt-replace/u.test(error.message),
  );
  assert.equal(client.deltas("thread-copilot").some((delta) => delta.op === "input.delivery"), false);

  const queued = await client.request("turn/steer", {
    threadId: "thread-copilot",
    inputId: "next-1",
    clientRequestId: "client-next-1",
    delivery: "next-turn",
    input: { text: "after the first task" },
  });
  assert.equal(queued.queued, true);
  await client.waitFor(() => client.deltas("thread-copilot"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.close") && deltas.some((delta) =>
      delta.op === "input.delivery" && delta.inputId === "next-1"));
  const deltas = client.deltas("thread-copilot");
  assert.equal(deltas.filter((delta) => delta.op === "turn.open").length, 2);
  assert.equal(deltas.find((delta) => delta.op === "input.delivery" && delta.inputId === "next-1").deliveryMethod, "next-turn");
  assert.equal(deltas.find((delta) => delta.op === "input.accepted" && delta.inputId === "next-1").disposition, "next-turn");
  assert.equal(deltas.some((delta) => delta.deliveryMethod === "native-inject"), false);
  await client.close();
});

test("interrupt-replace cancels the active turn before writing the replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-interrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, { mode: "auto", fixtureEnv: { ACP_FIXTURE_NATIVE_STEER: "0", ACP_FIXTURE_DELAY_MS: "500" } });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  await client.initialize();
  await client.request("session/create", { threadId: "thread-interrupt", cwd: root, permissionMode: "auto" });
  await client.request("turn/start", { threadId: "thread-interrupt", input: { text: "long task" } });
  await client.waitFor(() => client.deltas("thread-interrupt"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.open"));
  await client.request("turn/steer", {
    threadId: "thread-interrupt",
    inputId: "replace-1",
    clientRequestId: "client-replace-1",
    delivery: "interrupt-replace",
    input: { text: "replacement task" },
  });
  await client.waitFor(() => client.deltas("thread-interrupt"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.close" && delta.status === "interrupted")
    && deltas.some((delta) => delta.op === "input.delivery" && delta.inputId === "replace-1")
    && deltas.some((delta) => delta.op === "turn.open" && delta.nativeTurnId !== deltas.find((value) => value.op === "turn.open").nativeTurnId));
  const deltas = client.deltas("thread-interrupt");
  const deliveryIndex = deltas.findIndex((delta) => delta.op === "input.delivery" && delta.inputId === "replace-1");
  const cancelledIndex = deltas.findIndex((delta) => delta.op === "turn.close" && delta.status === "interrupted");
  assert(cancelledIndex >= 0 && cancelledIndex < deliveryIndex);
  assert.equal(deltas.find((delta) => delta.op === "input.delivery" && delta.inputId === "replace-1").deliveryMethod, "interrupt-replace");
  await client.close();
});

test("withdrawing a queued next-turn input prevents its dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-withdraw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, { mode: "auto", fixtureEnv: { ACP_FIXTURE_DELAY_MS: "150" } });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  await client.initialize();
  await client.request("session/create", { threadId: "thread-withdraw", cwd: root, permissionMode: "auto" });
  await client.request("turn/start", { threadId: "thread-withdraw", input: { text: "first" } });
  await client.waitFor(() => client.deltas("thread-withdraw"), (deltas) =>
    deltas.some((delta) => delta.op === "item.textDelta"));
  await client.request("turn/steer", {
    threadId: "thread-withdraw",
    inputId: "queued-1",
    clientRequestId: "client-queued-1",
    delivery: "next-turn",
    input: { text: "never runs" },
  });
  const withdrawn = await client.request("input/withdraw", { threadId: "thread-withdraw", inputId: "queued-1" });
  assert.equal(withdrawn.state, "withdrawn");
  await client.waitFor(() => client.deltas("thread-withdraw"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.close"));
  await delay(250);
  assert.equal(client.deltas("thread-withdraw").filter((delta) => delta.op === "turn.open").length, 1);
  assert.equal(client.deltas("thread-withdraw").some((delta) => delta.op === "input.delivery"), false);
  await client.close();
});

test("an agent exit keeps a pending steer unknown and never replays it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, {
    mode: "full",
    fixtureEnv: {
      ACP_FIXTURE_NATIVE_STEER: "1",
      ACP_FIXTURE_DELAY_MS: "50",
      ACP_FIXTURE_CRASH_ON_STEER_MS: "100",
      ACP_FIXTURE_STEER_NO_RESPONSE: "1",
    },
  });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  await client.initialize();
  await client.request("session/create", { threadId: "thread-crash", cwd: root, permissionMode: "full" });
  await client.request("turn/start", { threadId: "thread-crash", input: { text: "long task" } });
  await client.waitFor(() => client.deltas("thread-crash"), (deltas) =>
    deltas.some((delta) => delta.op === "item.textDelta"));
  await client.request("turn/steer", {
    threadId: "thread-crash",
    inputId: "unknown-1",
    clientRequestId: "client-unknown-1",
    delivery: "native-inject",
    input: { text: "never confirmed" },
  });
  await client.waitFor(() => client.deltas("thread-crash"), (deltas) =>
    deltas.some((delta) => delta.op === "input.outcome" && delta.inputId === "unknown-1"), 10_000);
  const outcome = client.deltas("thread-crash").find((delta) => delta.op === "input.outcome" && delta.inputId === "unknown-1");
  assert.equal(outcome.state, "unknown");
  await client.waitFor(() => client.deltas("thread-crash"), (deltas) =>
    deltas.some((delta) => delta.op === "provider.recovery" && delta.kind === "staleTurn"));
  const query = await client.request("input/query", { threadId: "thread-crash", inputIds: ["unknown-1"] });
  assert.equal(query.inputs[0].admission.value, "unknown");
  await delay(150);
  const frames = (await readFile(started.logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(frames.filter((frame) => frame.method === "session/prompt").length, 2, "main + one steer attempt, no replay");
  await client.close();
});


test("permission responses accept only advertised options and map session grants to allow_always", () => {
  const options = [
    { optionId: "once", name: "Allow once", kind: "allow_once" as const },
    { optionId: "always", name: "Always", kind: "allow_always" as const },
    { optionId: "deny", name: "Deny", kind: "reject_once" as const },
  ];
  assert.deepEqual(resolvePermission(options, { optionId: "once" }), { kind: "option", optionId: "once" });
  assert.deepEqual(resolvePermission(options, { optionId: "not-advertised" }), { kind: "cancel" });
  assert.deepEqual(resolvePermission(options, { decision: "acceptForSession" }), { kind: "option", optionId: "always" });
  assert.deepEqual(resolvePermission(options, { decision: "decline" }), { kind: "option", optionId: "deny" });
  assert.deepEqual(resolvePermission(options, { decision: "cancel" }), { kind: "cancel" });
});


test("captured ACP native transcript translates deterministically and without unhandled updates", async () => {
  const transcript = JSON.parse(await readFile(
    resolve("tests/agent-bridge/fixtures/acp-transcript.json"),
    "utf8",
  )) as { initialize: any; session: any; updates: any[]; promptResult: any };
  const run = () => {
    const translator = new AcpDeltaTranslator({
      threadId: "thread-transcript",
      nativeTurnId: "native-transcript",
      cwd: "/tmp",
    });
    const deltas = transcript.updates.flatMap((update) => translator.update(update));
    deltas.push(...translator.finish("completed"));
    return deltas;
  };
  const first = run();
  const second = run();
  assert.deepEqual(first, second);
  assert.equal(first.some((delta) => delta.op === "unhandled"), false);
  assert.equal(
    first.filter((delta) => delta.op === "item.textDelta" && delta.channel === "agentMessage")
      .map((delta) => delta.text).join(""),
    "fixture answer: hello transcript",
  );
  assert(first.some((delta) => delta.op === "item.open" && delta.shape.kind === "command"));
  assert(first.some((delta) => delta.op === "item.close" && delta.shape.kind === "command" && delta.shape.status === "completed"));
  assert(first.some((delta) => delta.op === "contextWindow" && delta.usedTokens === 10 && delta.modelContextWindow === 1000));
  assert.equal(first.at(-1)?.op, "turn.close");
  assert.equal(first.at(-1)?.status, "completed");
  assert.equal(transcript.initialize.protocolVersion, 1);
  assert.equal(transcript.session.sessionId, "fixture-session-1");
});


test("concurrent turn/start on one ACP session admits exactly one native turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, { fixtureEnv: { ACP_FIXTURE_DELAY_MS: "40" } });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  await client.initialize();
  await client.request("session/create", { threadId: "thread-concurrent", cwd: root });
  const first = client.request("turn/start", { threadId: "thread-concurrent", input: { text: "first concurrent" } });
  const second = client.request("turn/start", { threadId: "thread-concurrent", input: { text: "second concurrent" } });
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.kind, "stale-target");
  await client.waitFor(() => client.deltas("thread-concurrent"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.close"));
  assert.equal(client.deltas("thread-concurrent").filter((delta) => delta.op === "turn.open").length, 1);
  await client.close();
});


test("repeated ACP plan snapshots use distinct native keys and never reopen a settled item", () => {
  const translator = new AcpDeltaTranslator({ threadId: "thread-plan", nativeTurnId: "native-plan", cwd: "/tmp" });
  const first = translator.update({ sessionUpdate: "plan", entries: [{ content: "one", status: "pending" }] });
  const second = translator.update({ sessionUpdate: "plan", entries: [{ content: "two", status: "completed" }] });
  assert.deepEqual(first.map((delta) => delta.op), ["item.open", "item.close"]);
  assert.deepEqual(second.map((delta) => delta.op), ["item.open", "item.close"]);
  assert.notEqual(first[0]!.nativeKey, second[0]!.nativeKey);
  assert.equal(second[1]!.shape.kind, "plan");
  assert.match(second[1]!.shape.text, /two/u);
});


test("a new ACP messageId closes the previous message stream before opening the next", () => {
  const translator = new AcpDeltaTranslator({ threadId: "thread-messages", nativeTurnId: "native-messages", cwd: "/tmp" });
  const first = translator.update({ sessionUpdate: "agent_message_chunk", messageId: "a", content: { type: "text", text: "first" } });
  const second = translator.update({ sessionUpdate: "agent_message_chunk", messageId: "b", content: { type: "text", text: "second" } });
  assert.deepEqual(first.map((delta) => delta.op), ["item.open", "item.textDelta"]);
  assert.deepEqual(second.map((delta) => delta.op), ["item.textClose", "item.open", "item.textDelta"]);
  assert.equal(second[0]!.text, "first");
  assert.notEqual(first[0]!.nativeKey, second[1]!.nativeKey);
  assert.equal(second[1]!.nativeKey, second[2]!.nativeKey);
});

test("a read-only policy cancels when the agent offers no reject option", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-readonly-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, {
    mode: "read-only",
    fixtureEnv: { ACP_FIXTURE_PERMISSION: "1", ACP_FIXTURE_PERMISSION_ALLOW_ONLY: "1", ACP_FIXTURE_DELAY_MS: "10" },
  });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  await client.initialize();
  await client.request("session/create", { threadId: "thread-readonly", cwd: root, permissionMode: "read-only" });
  await client.request("turn/start", { threadId: "thread-readonly", input: { text: "edit a file" } });
  await client.waitFor(() => client.deltas("thread-readonly"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.close"));
  assert.equal(client.deltas("thread-readonly").find((delta) => delta.op === "turn.close").status, "interrupted");
  assert.equal(client.callbackFor("interaction/request", "thread-readonly").length, 0);
  await client.close();
});

test("a queued prompt that fails is unknown, never admitted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-prompt-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, {
    mode: "auto",
    fixtureEnv: {
      ACP_FIXTURE_NATIVE_STEER: "0",
      ACP_FIXTURE_PROMPT_ERROR_AFTER: "1",
      ACP_FIXTURE_DELAY_MS: "60",
    },
  });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  await client.initialize();
  await client.request("session/create", { threadId: "thread-fail", cwd: root, permissionMode: "auto" });
  await client.request("turn/start", { threadId: "thread-fail", input: { text: "one two three four five six seven eight nine ten" } });
  await client.waitFor(() => client.deltas("thread-fail"), (deltas) =>
    deltas.some((delta) => delta.op === "item.textDelta"));
  await client.request("turn/steer", {
    threadId: "thread-fail",
    inputId: "failing-next",
    clientRequestId: "client-failing-next",
    delivery: "next-turn",
    input: { text: "this prompt will fail" },
  });
  await client.waitFor(() => client.deltas("thread-fail"), (deltas) =>
    deltas.some((delta) => delta.op === "input.outcome" && delta.inputId === "failing-next"));
  const deltas = client.deltas("thread-fail");
  assert.equal(deltas.some((delta) => delta.op === "input.delivery" && delta.inputId === "failing-next" && delta.admitted), false);
  const query = await client.request("input/query", { threadId: "thread-fail", inputIds: ["failing-next"] });
  assert.equal(query.inputs[0].admission.value, "unknown");
  assert.equal(query.inputs[0].outcome, "unknown");
  await client.waitFor(() => client.deltas("thread-fail"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.close" && delta.status === "failed"));
  await client.close();
});

test("an interrupt replacement can be withdrawn or stopped before dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-replacement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const action of ["withdraw", "stop"] as const) {
    const started = await startBridge(root, {
      mode: "auto",
      fixtureEnv: {
        ACP_FIXTURE_NATIVE_STEER: "0",
        ACP_FIXTURE_DELAY_MS: "600",
        ACP_FIXTURE_CANCEL_DELAY_MS: "200",
      },
    });
    t.after(() => started.child.kill("SIGTERM"));
    const client = new BridgeClient(started);
    await client.initialize();
    const threadId = `thread-replacement-${action}`;
    await client.request("session/create", { threadId, cwd: root, permissionMode: "auto" });
    await client.request("turn/start", { threadId, input: { text: "keep this turn open long enough" } });
    await client.waitFor(() => client.deltas(threadId), (deltas) =>
      deltas.some((delta) => delta.op === "turn.open"));
    const steer = await client.request("turn/steer", {
      threadId,
      inputId: `replacement-${action}`,
      clientRequestId: `client-replacement-${action}`,
      delivery: "interrupt-replace",
      input: { text: "replacement text" },
    });
    assert.equal(steer.delivery, "interrupt-replace");
    if (action === "withdraw") {
      const withdrawn = await client.request("input/withdraw", { threadId, inputId: `replacement-${action}` });
      assert.equal(withdrawn.state, "withdrawn");
    } else {
      const stopped = await client.request("turn/stop", { threadId });
      assert.equal(stopped.cancelled, true);
    }
    await client.waitFor(() => client.deltas(threadId), (deltas) =>
      deltas.some((delta) => delta.op === "turn.close"));
    assert.equal(client.deltas(threadId).filter((delta) => delta.op === "turn.open").length, 1, action);
    assert.equal(client.deltas(threadId).some((delta) => delta.op === "input.delivery" && delta.inputId === `replacement-${action}`), false, action);
    await client.close();
  }
});

test("a permission response written after the agent exits does not crash the bridge", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-dead-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, {
    mode: "auto",
    fixtureEnv: {
      ACP_FIXTURE_PERMISSION: "1",
      ACP_FIXTURE_CRASH_AFTER_MS: "150",
      ACP_FIXTURE_DELAY_MS: "10",
    },
  });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  await client.initialize();
  await client.request("session/create", { threadId: "thread-dead", cwd: root, permissionMode: "auto" });
  await client.request("turn/start", { threadId: "thread-dead", input: { text: "ask for approval" } });
  await client.waitFor(() => client.callbacks, (callbacks) =>
    callbacks.some((frame) => frame.method === "interaction/request"));
  await client.waitFor(() => client.deltas("thread-dead"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.close" && delta.status === "failed"));
  const query = await client.request("input/query", { threadId: "thread-dead" });
  assert.deepEqual(query.inputs, []);
  await client.close();
});

test("model/list returns the ACP model catalog without creating a live Thread", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-models-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, { fixtureEnv: { ACP_FIXTURE_MODELS: "1", ACP_FIXTURE_DELAY_MS: "10" } });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  const init = await client.initialize();
  assert.equal(init.effectiveCapabilities.model, true);
  const listed = await client.request("model/list", {});
  assert.equal(listed.source, "acp-models");
  assert.deepEqual(listed.models.map((model: any) => model.id), ["cheap", "expensive"]);
  assert.equal(listed.current, "cheap");
  assert.equal(listed.models[0].current, true);
  assert.equal(client.deltas().length, 0);
  await client.close();
});

test("session/resume loads native history and pages it without live deltas", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, {
    fixtureEnv: { ACP_FIXTURE_LOAD: "1", ACP_FIXTURE_MODELS: "1", ACP_FIXTURE_CONFIG: "1", ACP_FIXTURE_DELAY_MS: "10" },
  });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  const init = await client.initialize();
  assert.equal(init.effectiveCapabilities.history, true);
  const resumed = await client.request("session/resume", {
    threadId: "thread-resume",
    providerThreadId: "fixture-session-1",
    cwd: root,
    permissionMode: "auto",
  });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.history.updates, 3);
  assert.equal(resumed.capabilities.images, true);
  assert.equal(client.callbackFor("thread/identity", "thread-resume")[0].params.sessionRestorable, true);
  assert.equal(client.deltas("thread-resume").length, 0);

  const first = await client.request("history/read", { threadId: "thread-resume", cursor: 0, limit: 2 });
  assert.equal(first.nativeSessionId, "fixture-session-1");
  assert.equal(first.total, 3);
  assert.equal(first.updates.length, 2);
  assert.equal(first.nextCursor, 2);
  assert.equal(first.updates[0].update.sessionUpdate, "user_message_chunk");
  const second = await client.request("history/read", { threadId: "thread-resume", cursor: 2, limit: 2 });
  assert.equal(second.updates.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(second.updates[0].update.sessionUpdate, "tool_call");

  await client.request("turn/start", { threadId: "thread-resume", input: { text: "after resume" } });
  await client.waitFor(() => client.deltas("thread-resume"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.close"));
  await client.close();
});

test("history replay arriving just after the load response is still history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-resume-late-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, {
    fixtureEnv: { ACP_FIXTURE_LOAD: "1", ACP_FIXTURE_LOAD_AFTER: "1", ACP_FIXTURE_DELAY_MS: "10" },
  });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  await client.initialize();
  const resumed = await client.request("session/resume", {
    threadId: "thread-resume-late",
    providerThreadId: "fixture-session-1",
    cwd: root,
    permissionMode: "auto",
  });
  assert.equal(resumed.history.updates, 3);
  assert.equal(client.deltas("thread-resume-late").length, 0);
  await client.close();
});

test("session/resume is refused when the agent does not declare load", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-no-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, { fixtureEnv: { ACP_FIXTURE_LOAD: "0" } });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  const init = await client.initialize();
  assert.equal(init.effectiveCapabilities.history, false);
  await assert.rejects(
    client.request("session/resume", { threadId: "thread-no-resume", providerThreadId: "s", cwd: root }),
    /does not declare session resume/u,
  );
  await client.close();
});


test("ACP client fs, terminal and elicitation are real and stay inside the session cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-client-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, {
    mode: "full",
    fixtureEnv: { ACP_FIXTURE_CLIENT: "1", ACP_FIXTURE_DELAY_MS: "20" },
  });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  await client.initialize();
  await client.request("session/create", { threadId: "thread-client", cwd: root, permissionMode: "full" });
  await client.request("turn/start", { threadId: "thread-client", input: { text: "exercise client services" } });
  const interaction = await client.waitFor(() => client.callbackFor("interaction/request", "thread-client"), (callbacks) =>
    callbacks.some((frame) => frame.params.kind === "elicitation"));
  const elicitation = interaction.find((frame) => frame.params.kind === "elicitation")!;
  assert.equal(elicitation.params.payload.method, "item/elicitation/request");
  await client.request("interaction/resolve", {
    threadId: "thread-client",
    interactionId: elicitation.params.interactionId,
    result: { decision: "accept", content: { answer: "blue" } },
  });
  await client.waitFor(() => client.deltas("thread-client"), (deltas) =>
    deltas.some((delta) => delta.op === "turn.close"));
  assert.equal(await readFile(join(root, "fixture-client.txt"), "utf8"), "client ok");
  const message = client.deltas("thread-client").find((delta) =>
    delta.op === "item.textClose" && delta.text?.includes("client read="));
  assert.match(message.text, /client read=client ok terminal=terminal ok/u);
  assert.match(message.text, /"action":"accept"/u);
  assert.match(message.text, /"answer":"blue"/u);
  await client.close();
});

test("read-only ACP client services reject writes, terminals and path escapes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-client-ro-"));
  const outside = await mkdtemp(join(tmpdir(), "acp-client-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const host = new AcpClientHost({ cwd: root, readOnly: true, allowWrite: false, allowTerminal: false, onElicitation: async () => ({ action: "decline" }) });
  await assert.rejects(host.handle("fs/write_text_file", { path: "x.txt", content: "x" }), /permission mode/u);
  await assert.rejects(host.handle("terminal/create", { command: process.execPath }), /permission mode/u);
  await writeFile(join(outside, "x"), "outside", "utf8");
  await assert.rejects(host.handle("fs/read_text_file", { path: join(outside, "x") }), /escapes/u);
  await host.close();
});

test("a turn permission downgrade revokes ACP client writes and terminals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-client-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = new AcpClientHost({ cwd: root, readOnly: false, allowWrite: true, allowTerminal: true, onElicitation: async () => ({ action: "decline" }) });
  await host.handle("fs/write_text_file", { path: "before.txt", content: "before" });
  await host.setPolicy({ readOnly: true, allowWrite: false, allowTerminal: false });
  await assert.rejects(host.handle("fs/write_text_file", { path: "after.txt", content: "after" }), /permission mode/u);
  await assert.rejects(host.handle("terminal/create", { command: process.execPath }), /permission mode/u);
  assert.equal(await readFile(join(root, "before.txt"), "utf8"), "before");
  await host.close();
});

test("model/list reports the applied model, not session/new's pre-selection current", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-model-current-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = await startBridge(root, { model: "expensive", fixtureEnv: { ACP_FIXTURE_MODELS: "1", ACP_FIXTURE_CONFIG: "1" } });
  t.after(() => started.child.kill("SIGTERM"));
  const client = new BridgeClient(started);
  await client.initialize();
  await client.request("session/create", { threadId: "thread-model-current", cwd: root, permissionMode: "auto" });
  const listed = await client.request("model/list", { threadId: "thread-model-current" });
  assert.equal(listed.current, "expensive");
  assert.deepEqual(listed.models.filter((model: any) => model.current).map((model: any) => model.id), ["expensive"]);
  await client.close();
});

test("a terminal spawn failure settles without an uncaught stdin error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acp-terminal-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = new AcpClientHost({ cwd: root, readOnly: false, allowWrite: true, allowTerminal: true, onElicitation: async () => ({ action: "decline" }) });
  const created = await host.handle("terminal/create", { command: join(root, "missing-executable"), args: [] }) as { terminalId: string };
  const waited = await host.handle("terminal/wait_for_exit", { terminalId: created.terminalId }) as { exitStatus: unknown };
  assert.deepEqual(waited.exitStatus, { exitCode: null, signal: null });
  const output = await host.handle("terminal/output", { terminalId: created.terminalId }) as { output: string };
  assert.match(output.output, /terminal error/u);
  await host.close();
});
