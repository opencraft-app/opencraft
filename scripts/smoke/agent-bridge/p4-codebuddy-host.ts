/** Opt-in real-account P4 acceptance. No retry, model fallback or default-route change. */
import assert from "node:assert/strict";
import { publicP4Frame } from "./p4-recording.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { BridgeHost, type Generation } from "../../../apps/agent-bridge-host/src/index.js";
import { declarationFor, profileFromEnv } from "../../../packages/agent-bridge-acp/src/index.js";
import { localTestBackend } from "../../../tests/agent-bridge/fixtures/local-backend.js";

const model = process.argv[2];
if (!model) throw new Error("Pass the cheapest usable model id from the installed account catalog; no default model is assumed");
const out = resolve(process.argv[3] ?? "design/agent-bridge/recordings/p4/codebuddy-host.json");
const root = await mkdtemp(join(tmpdir(), "p4-task-"));
const hostRoot = await mkdtemp(join(tmpdir(), "p4-host-"));
const artifact = join(hostRoot, "bridge.mjs");
const trace = join(hostRoot, "wire.ndjson");
const env = {
  PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
  AGENT_BRIDGE_ACP_DIALECT: "codebuddy", AGENT_BRIDGE_ACP_COMMAND: "codebuddy",
  AGENT_BRIDGE_ACP_ARGS: JSON.stringify(["--acp", "--model", model, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "Bash"]),
  AGENT_BRIDGE_ACP_CWD: root, AGENT_BRIDGE_ACP_PERMISSION_MODE: "full",
  AGENT_BRIDGE_ACP_TRACE: trace,
};
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
let host: BridgeHost | undefined;
let cursor = 0;
let stage = "prepare";
const events: any[] = [];
const receipts: Record<string, any> = {};
const report: Record<string, any> = {
  schemaVersion: 1, recordedAt: new Date().toISOString(), provider: "codebuddy", model: /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(model) ? model : "custom-model",
  host: "apps/agent-bridge-host", backend: "local test process backend; no production sandbox claim",
  evidenceTier: "unverified-external-blocker", receipts,
};
async function wire(): Promise<any[]> {
  return (await readFile(trace, "utf8").catch(() => "")).split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
async function pump() {
  const batch = await host!.events(cursor, 256);
  for (const entry of batch) { cursor = entry.seq; if (entry.payload.kind === "canonical") events.push(entry.payload.event); }
  if (batch.length) await host!.ack(cursor);
}
async function send(id: string, method: string, params: Record<string, unknown> = {}) {
  await host!.accept({ commandId: id, serverId: "p4-real", threadId: "p4-codebuddy", method, params });
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const receipt = await host!.query(id);
    if (receipt && ["accepted", "rejected", "unknown", "failed", "not-sent"].includes(receipt.state)) {
      receipts[id] = { state: receipt.state };
      return receipt;
    }
    await wait(25);
  }
  throw new Error(`${method} receipt timed out; no replay`);
}
async function until(accept: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) { await pump(); if (await accept()) return; await wait(50); }
  throw new Error(`${label} timed out; no replay`);
}
try {
  await build({ entryPoints: [resolve("packages/agent-bridge-acp/src/main.ts")], outfile: artifact, bundle: true, platform: "node", format: "esm" });
  const config: Generation = {
    id: "p4-codebuddy", artifact, digest: createHash("sha256").update(await readFile(artifact)).digest("hex"),
    provider: declarationFor(profileFromEnv(env)), launch: { command: [process.execPath, artifact], cwd: root, env },
  };
  report.artifactSha256 = config.digest;
  host = await BridgeHost.open({ path: join(hostRoot, "host.db"), backend: localTestBackend(),
    policy: { id: "p4-smoke", capacity: { cpuMillis: 16_000, memoryBytes: 32 * 1024 ** 3 } } });
  stage = "activation";
  await host.add(config); await host.activate(config.id, "");
  stage = "session-create";
  const created = await send("create", "session/create", { cwd: root, permissionMode: "full" });
  if (created.state !== "accepted") throw new Error(`session/create ${created.state}; no model task started`);
  stage = "turn-start";
  const task = await send("task", "turn/start", { input: {
    text: "Run exactly one harmless Bash command: sleep 8. Then answer ORIGINAL. Do not use other tools.",
  } });
  assert.equal(task.state, "accepted");
  const nativeTurnId = task.response && "result" in task.response
    ? (task.response.result as Record<string, unknown>).nativeTurnId : undefined;
  assert.equal(typeof nativeTurnId, "string");
  await until(async () => (await wire()).some((f) => f.direction === "in" && f.frame?.params?.update?.sessionUpdate === "tool_call"
    && f.frame.params.update.status === "in_progress"), "active tool");
  stage = "steer";
  const steer = await send("steer", "turn/steer", {
    expectedTurnId: nativeTurnId, inputId: "p4-steer", clientRequestId: "p4-client-steer", delivery: "native-inject",
    input: { text: "Replace your final answer with STEER_P4. Do not run another tool." },
  });
  assert.equal(steer.state, "accepted");
  await until(async () => events.some((event) => event.kind === "turn.completed"), "task end");
  stage = "double-receipt";
  const frames = await wire();
  const request = frames.find((f) => f.direction === "out" && f.frame?.method === "session/steer" && f.frame.params?.sessionId)?.frame;
  assert(request);
  const admission = frames.find((f) => f.direction === "in" && f.frame?.id === request.id && f.frame?.result?.steered === true)?.frame;
  assert.equal(admission?.result.ownerRequestId, request.params.expectedRequestId);
  const insertion = frames.find((f) => {
    const p = f.frame?.params; const u = p?.update;
    return f.direction === "in" && p?.sessionId === request.params.sessionId && u?.sessionUpdate === "user_message_chunk"
      && u?._meta?.["codebuddy.ai/conversationRequestId"] === request.params.expectedRequestId
      && (u.messageId ?? u._meta?.["codebuddy.ai/messageId"]) === request.params.clientUserMessageId;
  })?.frame;
  assert(insertion, "same-run insertion receipt required");
  const status = await send("status", "input/query", { inputIds: ["p4-steer"] });
  const statusResult = status.response && "result" in status.response
    ? status.response.result as { inputs?: readonly { outcome?: string }[] } : undefined;
  assert.equal(statusResult?.inputs?.[0]?.outcome, "delivered");
  assert.equal(frames.filter((f) => f.direction === "out" && f.frame?.method === "session/prompt").length, 1);
  assert.equal(frames.filter((f) => f.direction === "out" && f.frame?.method === "session/cancel").length, 0);
  const steerIndex = frames.findIndex((f) => f.frame === request);
  const toolIndex = frames.findIndex((f) => f.direction === "in" && f.frame?.params?.update?.sessionUpdate === "tool_call"
    && f.frame.params.update.status === "in_progress");
  const tool = frames[toolIndex]?.frame;
  const completedIndex = frames.findIndex((f, i) => i > toolIndex && f.direction === "in"
    && f.frame?.params?.update?.toolCallId === tool?.params.update.toolCallId
    && f.frame.params.update.status === "completed");
  assert(toolIndex >= 0 && steerIndex > toolIndex && completedIndex > steerIndex,
    "steer must be written strictly inside the tool execution window");
  report.doubleReceipt = { request: publicP4Frame(request), admission: publicP4Frame(admission), insertion: publicP4Frame(insertion) };
  report.toolWindow = { started: publicP4Frame(tool), completed: publicP4Frame(frames[completedIndex].frame),
    wireOrder: { started: toolIndex, steer: steerIndex, completed: completedIndex } };
  report.turnCount = events.filter((e) => e.kind === "turn.started").length;
  assert.equal(report.turnCount, 1);
  const canonical = events.filter((e) => e.kind === "input.state" && e.status?.inputId === "p4-steer").at(-1)?.status;
  assert.equal(canonical?.outcome, "context-confirmed");
  assert.equal(canonical?.evidence?.nativeInputId, request.params.clientUserMessageId);
  assert.equal(canonical?.evidence?.runId, request.params.expectedRequestId);
  report.canonicalProjectionVerified = true;
  report.evidenceTier = "native-input-id";
} catch (error) {
  report.stage = stage;
  report.error = "P4 acceptance failed; see stage and native error categories";
  process.exitCode = 1;
} finally {
  // Keep only control-plane proof on a failed run; no provider stderr or account/config contents.
  report.probes = (await wire()).filter((f) => f.frame?.method === "initialize" ||
    (f.direction === "out" && f.frame?.method === "session/steer" && !f.frame.params?.sessionId) ||
    (f.direction === "in" && f.frame?.error)).map((f) => ({ direction: f.direction, frame: publicP4Frame(f.frame) }));
  await host?.close().catch(() => {});
  await mkdir(dirname(out), { recursive: true });
  const sanitized = JSON.stringify(report, null, 2);
  await writeFile(out, sanitized + "\n");
  await rm(root, { recursive: true, force: true }); await rm(hostRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ out, evidenceTier: report.evidenceTier, error: report.error }));
}
