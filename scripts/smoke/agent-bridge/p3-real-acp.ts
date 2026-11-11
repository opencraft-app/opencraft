/**
 * Opt-in real-account smoke test for the generic ACP bridge (P3).
 *
 * It launches the bridge against one installed ACP agent, records the actual
 * `initialize` exchange, runs one minimal task in a throwaway directory and
 * sends one steer. It uses the bridge protocol directly; the P1b Host
 * composition is covered by `tests/agent-bridge/acp-host.test.ts`.
 *
 * Usage:
 *   npx tsx scripts/smoke/agent-bridge/p3-real-acp.ts --agent copilot --out /tmp/copilot.json
 *   npx tsx scripts/smoke/agent-bridge/p3-real-acp.ts --agent amp --out /tmp/amp.json
 *
 * This consumes real model quota. It never retries with a more expensive
 * model and never reruns a task automatically.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type Json = Record<string, any>;

const args = process.argv.slice(2);
function option(name: string, fallback?: string): string {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] !== undefined) return args[index + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing ${name}`);
}

const agentName = option("--agent");
const output = resolve(option("--out"));
const timeoutMs = Number(option("--timeout-ms", "240000"));
const workspace = await mkdtemp(join(tmpdir(), `acp-p3-${agentName}-`));
const bridgeMain = resolve("packages/agent-bridge-acp/src/main.ts");

const profiles: Record<string, { command: string; args: string[]; dialect: string; mode: string; model?: string; cliVersion: string }> = {
  copilot: {
    command: "copilot",
    args: ["--acp"],
    dialect: "copilot",
    mode: "auto",
    // Copilot 1.0.102 offers claude-haiku-4.5 at 0.33x, the lowest observed
    // price category. If it disappears the session fails explicitly.
    model: "claude-haiku-4.5",
    cliVersion: "1.0.102",
  },
  amp: {
    command: "amp-acp",
    args: [],
    dialect: "amp",
    mode: "accept-edits",
    model: "low",
    cliVersion: "amp-acp 0.10.0 (installed snapshot 8ef5b5ab)",
  },
};

const profile = profiles[agentName];
if (profile === undefined) throw new Error(`unknown --agent ${agentName}; expected copilot or amp`);

const redactions = new Map<string, string>([
  [workspace, "<workspace>"],
  [resolve("."), "<repo>"],
  [process.env.HOME ?? "", "<home>"],
]);
function redact(value: unknown): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const [from, to] of redactions) {
      if (from.length > 1) result = result.split(from).join(to);
    }
    if (result === value && value.startsWith("/")) {
      const leaf = basename(value);
      return `<path:${leaf}>`;
    }
    return result;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Json).map(([key, entry]) => [key, redact(entry)]));
  }
  return value;
}

const env: NodeJS.ProcessEnv = {
  ...process.env,
  AGENT_BRIDGE_ACP_PROVIDER: agentName,
  AGENT_BRIDGE_ACP_DIALECT: profile.dialect,
  AGENT_BRIDGE_ACP_COMMAND: profile.command,
  AGENT_BRIDGE_ACP_ARGS: JSON.stringify(profile.args),
  AGENT_BRIDGE_ACP_CWD: workspace,
  AGENT_BRIDGE_ACP_PERMISSION_MODE: profile.mode,
  ...(profile.model === undefined ? {} : { AGENT_BRIDGE_ACP_MODEL: profile.model }),
  AGENT_BRIDGE_ACP_MIN_VERSION: profile.cliVersion,
  AGENT_BRIDGE_ACP_TRACE: join(workspace, "acp-trace.ndjson"),
};

const child = spawn(process.execPath, ["--import", "tsx", bridgeMain], {
  cwd: resolve("."),
  env,
  stdio: ["pipe", "pipe", "pipe"],
});
const stderrLines: string[] = [];
child.stderr.on("data", (chunk: Buffer) => {
  const text = chunk.toString("utf8");
  for (const line of text.split(/\r?\n/u)) if (line.length > 0) stderrLines.push(line);
});

interface Callback {
  id: string;
  method: string;
  params: Json;
}
const frames: Json[] = [];
const callbacks: Callback[] = [];
const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
let sequence = 0;

const client = {
  request(method: string, params: Json, requestTimeout = 60_000): Promise<any> {
    const id = `smoke:${++sequence}`;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`${method} timed out after ${requestTimeout}ms`));
      }, requestTimeout);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  },
  async steer(params: Json): Promise<any> {
    return this.request("turn/steer", params);
  },
};

createInterface({ input: child.stdout }).on("line", (line) => {
  let frame: Json;
  try { frame = JSON.parse(line); } catch { return; }
  frames.push(frame);
  if (typeof frame.method === "string" && frame.id !== undefined) {
    const callback: Callback = { id: String(frame.id), method: frame.method, params: frame.params ?? {} };
    callbacks.push(callback);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { durable: true } }) + "\n");
    if (frame.method === "interaction/request") {
      // The smoke test stands in for the human UI: approve the throwaway tool.
      void client.request("interaction/resolve", {
        threadId: callback.params.threadId,
        interactionId: callback.params.interactionId,
        result: { decision: "accept" },
      }).catch(() => {});
    }
    return;
  }
  if (frame.id !== undefined && pending.has(String(frame.id))) {
    const waiter = pending.get(String(frame.id))!;
    pending.delete(String(frame.id));
    clearTimeout(waiter.timer);
    if (frame.error) waiter.reject(Object.assign(new Error(frame.error.message), { kind: frame.error.kind, code: frame.error.code }));
    else waiter.resolve(frame.result);
  }
});

function deltas(threadId: string): Json[] {
  return callbacks.filter((callback) => callback.method === "thread/delta")
    .flatMap((callback) => callback.params.deltas ?? [])
    .filter((delta: Json) => delta.scope?.threadId === threadId);
}
const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, label: string, timeout = timeoutMs): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`${label} timed out; stderr=${stderrLines.slice(-20).join(" | ")}`);
    await delay(50);
  }
}
const textFor = (turn: string) => deltas("thread-1")
  .filter((delta) => delta.nativeTurnId === turn && delta.op === "item.textDelta")
  .map((delta) => delta.text).join("");

const evidence: Json = {
  agent: agentName,
  profile: redact(profile),
  recordedAt: new Date().toISOString(),
  workspace: "<workspace>",
  initialize: {},
  session: {},
  task: {},
  steer: {},
  gaps: [],
  stderrTail: [],
};

let exitCode = 0;
try {
  const initializeRequest = {
    protocolVersion: 1,
    grammarRange: { min: 1, max: 1 },
    hostCapabilities: ["smoke"],
  };
  const initialize = await client.request("initialize", initializeRequest);
  const probe = await client.request("maintenance/probe", {});
  evidence.initialize = {
    request: initializeRequest,
    response: redact(initialize),
    acpInitialize: redact(probe.initialize ?? null),
    acpEffectiveCapabilities: redact(probe.effectiveCapabilities ?? null),
  };
  process.stderr.write(`[p3] ${agentName} initialize: ${JSON.stringify(redact(initialize.agentInfo ?? initialize.agentCapabilities))}\n`);

  const created = await client.request("session/create", {
    threadId: "thread-1",
    cwd: workspace,
    permissionMode: profile.mode,
    ...(profile.model === undefined ? {} : { modelSelection: profile.model }),
  });
  evidence.session = redact(created);

  const taskPrompt = [
    "You are running an automated bridge smoke test in the current directory.",
    "Create a file named p3-accept.txt containing exactly \"ok\" using one non-destructive shell command.",
    "Do not modify anything else. Then reply with exactly DONE.",
  ].join(" ");
  const first = await client.request("turn/start", {
    threadId: "thread-1",
    input: { text: taskPrompt },
    inputId: "task-1",
    clientRequestId: "task-1",
  });
  await waitFor(() => deltas("thread-1"), (value) =>
    value.some((delta) => delta.op === "turn.close" && delta.nativeTurnId === first.nativeTurnId), "first task");
  let answer = "";
  try {
    answer = (await readFile(join(workspace, "p3-accept.txt"), "utf8")).trim();
  } catch (error) {
    evidence.gaps.push(`p3-accept.txt was not created: ${String(error)}`);
  }
  evidence.task = {
    nativeTurnId: first.nativeTurnId,
    finalText: textFor(first.nativeTurnId).slice(-2_000),
    fileContent: answer,
    toolItems: deltas("thread-1").filter((delta) => delta.nativeTurnId === first.nativeTurnId
      && (delta.op === "item.open" || delta.op === "item.close")
      && (delta.shape?.kind === "tool" || delta.shape?.kind === "command")).length,
  };

  const longPrompt = "Run the shell command `sleep 8` in the current directory, then reply with exactly WAITED.";
  const second = await client.request("turn/start", {
    threadId: "thread-1",
    input: { text: longPrompt },
    inputId: "task-2",
    clientRequestId: "task-2",
  });
  await delay(1_500);
  const steerDelivery = agentName === "amp" ? "native-inject" : "next-turn";
  let steerResponse: Json | null = null;
  try {
    steerResponse = await client.steer({
      threadId: "thread-1",
      inputId: "steer-1",
      clientRequestId: "steer-1",
      expectedTurnId: second.nativeTurnId,
      delivery: steerDelivery,
      input: { text: "Also include the word STEERED in your final answer." },
    });
  } catch (error) {
    evidence.gaps.push(`steer command failed: ${String(error)}`);
  }
  await waitFor(() => deltas("thread-1"), (value) =>
    value.some((delta) => delta.op === "turn.close" && delta.nativeTurnId === second.nativeTurnId), "second task");
  if (steerResponse !== null) {
    await waitFor(() => deltas("thread-1"), (value) =>
      value.some((delta) => delta.op === "input.delivery" && delta.inputId === "steer-1"), "steer delivery", 60_000);
  }
  const steerDeltas = deltas("thread-1").filter((delta) => delta.inputId === "steer-1");
  evidence.steer = {
    requestedDelivery: steerDelivery,
    response: redact(steerResponse),
    delivery: redact(steerDeltas.filter((delta) => delta.op === "input.delivery").at(-1) ?? null),
    evidence: redact(steerDeltas.filter((delta) => delta.op === "input.evidence").at(-1) ?? null),
    outcome: redact(steerDeltas.filter((delta) => delta.op === "input.outcome").at(-1) ?? null),
    turnsOpened: deltas("thread-1").filter((delta) => delta.op === "turn.open").length,
    steerTurnText: "",
  };
  const steerTurn = deltas("thread-1").filter((delta) => delta.op === "turn.open").at(-1)?.nativeTurnId;
  if (typeof steerTurn === "string") {
    await waitFor(() => deltas("thread-1"), (value) =>
      value.some((delta) => delta.op === "turn.close" && delta.nativeTurnId === steerTurn), "steer turn", 120_000);
    evidence.steer.steerTurnText = textFor(steerTurn).slice(-2_000);
    evidence.steer.query = redact(await client.request("input/query", { threadId: "thread-1", inputIds: ["steer-1"] }));
  }
  if (steerResponse !== null && evidence.steer.delivery === null) {
    evidence.gaps.push("steer was accepted but no delivery delta was observed before the timeout");
  }
} catch (error) {
  exitCode = 1;
  evidence.error = String(error);
  evidence.stderrTail = stderrLines.slice(-40).map((line) => redact(line));
} finally {
  evidence.stderrTail = stderrLines.slice(-20).map((line) => redact(line));
  let traceFrames: Json[] = [];
  try {
    traceFrames = (await readFile(join(workspace, "acp-trace.ndjson"), "utf8")).trim().split("\n")
      .filter((line) => line.length > 0).map((line) => JSON.parse(line));
  } catch {
    evidence.gaps.push("ACP wire trace was not written; initialize recording is the bridge handshake only");
  }
  const initializeOut = traceFrames.find((frame) => frame.direction === "out" && frame.frame?.method === "initialize");
  const initializeIn = initializeOut === undefined ? undefined : traceFrames.find((frame) =>
    frame.direction === "in" && frame.frame?.id === initializeOut.frame.id);
  evidence.wire = {
    initializeRequest: initializeOut === undefined ? null : redact(initializeOut.frame),
    initializeResponse: initializeIn === undefined ? null : redact(initializeIn.frame),
    frameCount: traceFrames.length,
  };
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  if (child.exitCode === null) child.kill("SIGTERM");
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
  process.stdout.write(JSON.stringify({ out: output, exitCode, gaps: evidence.gaps }) + "\n");
  process.exit(exitCode);
}
