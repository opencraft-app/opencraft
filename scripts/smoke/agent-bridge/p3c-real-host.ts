/**
 * Opt-in real Copilot/Amp acceptance through apps/agent-bridge-host.
 *
 * This consumes real account quota. It creates a temporary workspace, asks for
 * one non-destructive file write, sends one explicit steer, then closes and
 * resumes the native session to read native history. It never falls back to a
 * different model or retries a failed prompt.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BridgeHost, type Generation } from "../../../apps/agent-bridge-host/src/index.js";
import { declarationFor, profileFromEnv } from "../../../packages/agent-bridge-acp/src/index.js";
import { localTestBackend } from "../../../tests/agent-bridge/fixtures/local-backend.js";

type AgentName = "copilot" | "amp";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const agent = (arg("agent") ?? "copilot") as AgentName;
if (agent !== "copilot" && agent !== "amp") throw new Error("--agent must be copilot or amp");
const out = resolve(arg("out") ?? `design/agent-bridge/recordings/p3c/${agent}-host.json`);
const artifact = resolve("packages/agent-bridge-acp/src/main.ts");
const root = await mkdtemp(join(tmpdir(), `p3c-${agent}-`));
const hostRoot = await mkdtemp(join(tmpdir(), `p3c-host-${agent}-`));
const tracePath = join(hostRoot, "wire.ndjson");
const serverId = "p3c-real";
const threadId = `p3c-${agent}`;

const profileEnv: Record<string, string> = agent === "copilot"
  ? {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      AGENT_BRIDGE_ACP_PROVIDER: "copilot",
      AGENT_BRIDGE_ACP_DIALECT: "copilot",
      AGENT_BRIDGE_ACP_COMMAND: "copilot",
      AGENT_BRIDGE_ACP_ARGS: JSON.stringify(["--acp"]),
      AGENT_BRIDGE_ACP_CWD: root,
      AGENT_BRIDGE_ACP_PERMISSION_MODE: "auto",
      AGENT_BRIDGE_ACP_MODEL: "claude-haiku-4.5",
      AGENT_BRIDGE_ACP_MIN_VERSION: "1.0.0",
      AGENT_BRIDGE_ACP_PROBE_BASIS: "initialize",
      AGENT_BRIDGE_ACP_TRACE: tracePath,
    }
  : {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      AGENT_BRIDGE_ACP_PROVIDER: "amp",
      AGENT_BRIDGE_ACP_DIALECT: "amp",
      AGENT_BRIDGE_ACP_COMMAND: "amp-acp",
      AGENT_BRIDGE_ACP_ARGS: JSON.stringify([]),
      AGENT_BRIDGE_ACP_CWD: root,
      AGENT_BRIDGE_ACP_PERMISSION_MODE: "accept-edits",
      AGENT_BRIDGE_ACP_MODEL: "low",
      AGENT_BRIDGE_ACP_MIN_VERSION: "0.10.0",
      AGENT_BRIDGE_ACP_PROBE_BASIS: "initialize",
      AGENT_BRIDGE_ACP_TRACE: tracePath,
    };

const profile = profileFromEnv(profileEnv);
const config: Generation = {
  id: `p3c-${agent}`,
  artifact,
  digest: createHash("sha256").update(await readFile(artifact)).digest("hex"),
  provider: declarationFor(profile),
  launch: {
    command: [process.execPath, "--import", "tsx", artifact],
    cwd: resolve("."),
    env: profileEnv,
  },
};
const host = await BridgeHost.open({
  path: join(hostRoot, "host.db"),
  policy: { id: `p3c-${agent}`, capacity: { cpuMillis: 16_000, memoryBytes: 32 * 1024 ** 3 } },
  backend: localTestBackend(),
});

function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function command(commandId: string, method: string, params: Record<string, unknown> = {}) {
  return { commandId, serverId, threadId, method, params };
}
function redact(value: unknown): unknown {
  const text = JSON.stringify(value);
  return JSON.parse(text
    .split(root).join("<workspace>")
    .split(hostRoot).join("<host>")
    .split(process.env.HOME ?? "/home/user").join("<home>"));
}

const collected: any[] = [];
let cursor = 0;
let nativeSessionId: string | null = null;
let interactionCount = 0;

async function settle(commandId: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await host.query(commandId);
    if (receipt !== null && ["accepted", "rejected", "unknown", "failed", "not-sent"].includes(receipt.state)) {
      return receipt;
    }
    if (Date.now() > deadline) throw new Error(`command ${commandId} did not settle`);
    await wait(50);
  }
}

async function pump(): Promise<void> {
  const events = await host.events(cursor, 256);
  for (const event of events) {
    cursor = event.seq;
    const payload = event.payload;
    if (payload.kind === "canonical") {
      collected.push(payload.event);
      continue;
    }
    if (payload.method === "thread/identity" && typeof payload.params.providerThreadId === "string") {
      nativeSessionId = payload.params.providerThreadId;
    }
    if (payload.method === "interaction/request") {
      interactionCount += 1;
      const params = payload.params;
      const result = params.kind === "approval"
        ? { decision: "accept" }
        : { decision: "accept", content: {} };
      const commandId = `resolve-${params.interactionId}`;
      await host.accept(command(commandId, "interaction/resolve", { interactionId: params.interactionId, result }));
      const receipt = await settle(commandId);
      if (receipt.state !== "accepted") throw new Error(`interaction resolve ${receipt.state}`);
    }
  }
  if (events.length > 0) await host.ack(cursor);
}

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`${label} timed out`);
    await wait(100);
  }
}

async function send(commandId: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  await host.accept(command(commandId, method, params));
  return settle(commandId);
}

function turns(): any[] { return collected.filter((event) => event.kind === "turn.completed"); }
function messages(): any[] {
  return collected.filter((event) => event.kind === "item.completed" && event.item?.shape?.kind === "agentMessage");
}
function lastText(): string { return messages().at(-1)?.item?.shape?.text ?? ""; }

try {
  await host.add(config);
  await host.activate(config.id, "");
  const create = await send("create", "session/create", { cwd: root, permissionMode: agent === "copilot" ? "auto" : "accept-edits" });
  if (create.state !== "accepted") throw new Error(`session/create ${create.state}`);
  await pump();
  const models = await send("models", "model/list");
  if (models.state !== "accepted") throw new Error(`model/list ${models.state}`);

  await send("task", "turn/start", {
    input: {
      text: "Create a file named p3c-accept.txt in the current directory containing exactly ok, using one shell command. Then answer DONE.",
    },
  });
  await until(() => pump().then(() => turns().length), (count) => count >= 1, "first turn");
  const taskText = await readFile(join(root, "p3c-accept.txt"), "utf8").catch(() => null);

  const steerTurn = await send("steer-turn", "turn/start", {
    input: { text: "Wait for a follow-up. Do not use tools. Keep this turn open for a moment." },
  });
  const nativeTurn = steerTurn.response?.result?.nativeTurnId;
  await until(() => pump().then(() => collected.filter((event) => event.kind === "turn.started").length),
    (count) => count >= 2, "steer target turn");
  await wait(100);
  const steer = await send("steer", "turn/steer", {
    inputId: `steer-${agent}`,
    clientRequestId: `client-steer-${agent}`,
    expectedTurnId: nativeTurn,
    delivery: agent === "copilot" ? "next-turn" : "native-inject",
    input: { text: "Answer with the single word STEERED." },
  });
  if (steer.state !== "accepted") {
    console.error("steer response", JSON.stringify(steer.response));
    console.error("nativeTurn", nativeTurn, "started", collected.filter((event) => event.kind === "turn.started").map((event) => event.turnId));
    throw new Error(`turn/steer ${steer.state}`);
  }
  const expectedTurns = agent === "copilot" ? 3 : 2;
  await until(() => pump().then(() => turns().length), (count) => count >= expectedTurns, "steer completion");

  const steerStates = collected.filter((event) => event.kind === "input.state" && event.status?.inputId === `steer-${agent}`);
  const steerDelivery = collected.find((event) => event.kind === "input.state"
    && event.status?.inputId === `steer-${agent}` && event.status?.delivery?.value !== "none");
  const close = await send("close", "session/close");
  if (close.state !== "accepted") throw new Error(`session/close ${close.state}`);
  await pump();

  const resume = await send("resume", "session/resume", {
    providerThreadId: nativeSessionId,
    cwd: root,
    permissionMode: agent === "copilot" ? "auto" : "accept-edits",
  });
  if (resume.state !== "accepted") {
    console.error("resume response", JSON.stringify(resume.response), "native", nativeSessionId);
    throw new Error(`session/resume ${resume.state}`);
  }
  await pump();
  const history = await send("history", "history/read", { cursor: 0, limit: 100 });
  if (history.state !== "accepted") throw new Error(`history/read ${history.state}`);
  const close2 = await send("close-2", "session/close");
  if (close2.state !== "accepted") throw new Error(`second session/close ${close2.state}`);
  await pump();
  await host.releaseThread(serverId, threadId);

  const wire = (await readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const initResponse = wire.find((frame: any) => frame.direction === "in" && frame.frame?.id !== undefined && frame.frame?.result?.agentInfo)?.frame;
  const sessionNew = wire.find((frame: any) => frame.direction === "in" && frame.frame?.id !== undefined && frame.frame?.result?.sessionId)?.frame;
  const evidence = {
    schemaVersion: 1,
    agent,
    recordedAt: new Date().toISOString(),
    workspace: "<workspace>",
    profile: {
      providerId: profile.providerId,
      dialect: profile.dialect,
      command: profile.agent.command,
      args: profile.agent.args,
      permissionMode: profile.defaultPermissionMode,
      modelSelection: profile.modelSelection,
    },
    initialize: initResponse?.result ?? null,
    session: sessionNew?.result ?? null,
    modelList: models.response?.result ?? null,
    task: {
      file: taskText,
      turns: turns().length,
      interactionCount,
      text: lastText(),
    },
    steer: {
      request: steer.response?.result ?? null,
      delivery: steerDelivery?.status?.delivery ?? null,
      disposition: steerDelivery?.status?.disposition ?? null,
      states: steerStates.map((event) => event.status),
      finalText: lastText(),
      turnsOpened: collected.filter((event) => event.kind === "turn.started").length,
    },
    resume: {
      result: resume.response?.result ?? null,
      historyUpdates: history.response?.result?.updates?.length ?? null,
      historyTotal: history.response?.result?.total ?? null,
    },
    notes: [
      "Real account run through apps/agent-bridge-host; one temporary file write and one explicit steer.",
      "Steer evidence is admission only; no context-confirmed claim.",
      "Copilot has no native steering declaration; Amp native-inject is used only for Amp.",
    ],
    gaps: [
      "History replay is not yet projected into AppServer/Web history.",
      "Elicitation and model/list have no Web UI.",
      "The real agents did not call ACP fs/terminal/elicitation in this task; those paths are covered by the deterministic fixture and unit tests.",
    ],
  };
  await writeFile(out, JSON.stringify(redact(evidence), null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ out, task: evidence.task, steer: evidence.steer, resume: evidence.resume }, null, 2));
} finally {
  await host.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
  await rm(hostRoot, { recursive: true, force: true });
}
