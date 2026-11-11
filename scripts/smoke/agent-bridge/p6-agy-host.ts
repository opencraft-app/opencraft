/** Opt-in real-account P6 acceptance. No retry, model fallback or default-route change. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile, copyFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { AgyTraceReader } from "../../../packages/agent-bridge-acp/src/agy.js";
import { build } from "esbuild";
import { BridgeHost, type Generation } from "../../../apps/agent-bridge-host/src/index.js";
import { declarationFor, profileFromEnv } from "../../../packages/agent-bridge-acp/src/index.js";
import { localTestBackend } from "../../../tests/agent-bridge/fixtures/local-backend.js";

const model = process.argv[2];
if (!model) throw new Error("Pass the cheapest usable model id from the installed account catalog; no default model is assumed");
const out = resolve(process.argv[3] ?? "design/agent-bridge/recordings/p6/agy-host.json");
const root = await mkdtemp(join(tmpdir(), "p6-task-"));
const hostRoot = await mkdtemp(join(tmpdir(), "p6-host-"));
const artifact = join(hostRoot, "bridge.mjs");
const trace = join(hostRoot, "wire.ndjson");
const env = {
  PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
  AGENT_BRIDGE_ACP_DIALECT: "agy", AGENT_BRIDGE_ACP_COMMAND: "agy",
  AGENT_BRIDGE_ACP_ARGS: JSON.stringify(["acp"]),
  AGENT_BRIDGE_ACP_MODEL: model,
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
  schemaVersion: 1, recordedAt: new Date().toISOString(), provider: "agy", model: /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(model) ? model : "custom-model",
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
  await host!.accept({ commandId: id, serverId: "p6-real", threadId: "p6-agy", method, params });
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
  const plugins = JSON.parse((await promisify(execFile)("agy", ["plugin","list","--json"], {timeout:5000,maxBuffer:256*1024})).stdout);
  const plugin = plugins.find((p:any)=>p.name === "agy-acp-steer" && p.enabled === true);
  report.provenance = { bridgeProtocolVersion:1, grammarVersion:1,
    nativePlugin:{ name:"agy-acp-steer",
      hookSha256:createHash("sha256").update(await readFile(join(plugin.path,"steer-hook.ts"))).digest("hex"),
      hooksManifestSha256:createHash("sha256").update(await readFile(join(plugin.path,"hooks.json"))).digest("hex") },
    traceSchema:"steps: idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB; raw user protobuf field 19" };
  await copyFile(resolve("packages/agent-bridge-acp/src/agy-trace.worker.mjs"), join(hostRoot,"agy-trace.worker.mjs"));
  await build({ entryPoints: [resolve("packages/agent-bridge-acp/src/main.ts")], outfile: artifact, bundle: true, platform: "node", format: "esm" });
  const config: Generation = {
    id: "p6-agy", artifact, digest: createHash("sha256").update(await readFile(artifact)).digest("hex"),
    provider: declarationFor(profileFromEnv(env)), launch: { command: [process.execPath, artifact], cwd: root, env },
  };
  report.artifactSha256 = config.digest;
  host = await BridgeHost.open({ path: join(hostRoot, "host.db"), backend: localTestBackend(),
    policy: { id: "p6-smoke", capacity: { cpuMillis: 16_000, memoryBytes: 32 * 1024 ** 3 } } });
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
    expectedTurnId: nativeTurnId, inputId: "p6-steer", clientRequestId: "p6-client-steer", delivery: "native-inject",
    input: { text: "Replace your final answer with STEER_P6. Do not run another tool." },
  });
  assert.equal(steer.state, "accepted");
  await until(async () => events.some((event) => event.kind === "turn.completed"), "task end");
  stage = "raw-user-proof";
  const frames = await wire();
  const status = await send("status", "input/query", { inputIds: ["p6-steer"] });
  const result = status.response && "result" in status.response ? status.response.result as any : undefined;
  report.inputOutcome = result?.inputs?.[0]?.outcome;
  assert.equal(result?.inputs?.[0]?.outcome,"delivered");
  assert.equal(result?.inputs?.[0]?.evidence?.kind,"native-input-id");
  const injectionIndex = frames.findIndex(f => f.frame?.method === "opencraft/agy/steer");
  const claim = frames.find(f => f.frame?.method === "opencraft/agy/claimed")?.frame.params;
  const raw = frames.find(f => f.frame?.method === "opencraft/agy/raw-user")?.frame.params;
  assert(claim && raw && raw.idx >= claim.floor && raw.idx > claim.baseline);
  const toolIndex = frames.findIndex(f=> f.frame?.params?.update?.sessionUpdate === "tool_call" && f.frame.params.update.status === "in_progress");
  const toolId = frames[toolIndex]?.frame.params.update.toolCallId;
  const completedIndex = frames.findIndex((f,i)=>i>toolIndex && f.frame?.params?.update?.toolCallId === toolId && f.frame.params.update.status === "completed");
  assert(toolIndex>=0 && injectionIndex>toolIndex && completedIndex>injectionIndex);
  assert.equal(frames.filter(f=>f.direction === "out" && f.frame?.method === "session/prompt").length,1);
  assert.equal(frames.filter(f=>f.direction === "out" && f.frame?.method === "session/cancel").length,0);
  report.proof = { floor:claim.floor, baseline:claim.baseline, newRawUserIdx:raw.idx, textMatched:true,
    toolWindow:{started:toolIndex,steer:injectionIndex,completed:completedIndex} };
  const canonical=events.filter(e=>e.kind === "input.state" && e.status?.inputId === "p6-steer").at(-1)?.status;
  assert.equal(canonical?.outcome,"context-confirmed");
  const reader = new AgyTraceReader(join(homedir(),".gemini","antigravity-cli","conversations"));
  try {
    const trace = await reader.read(raw.conversationId);
    const expected = "Replace your final answer with STEER_P6. Do not run another tool.";
    const matches = trace.rows.filter(r=>r.text === expected);
    assert.equal(matches.length,1); assert.equal(matches[0]!.idx,raw.idx);
    const hash = (text:string)=>createHash("sha256").update(text).digest("hex");
    const opaque = "id:"+hash(raw.conversationId).slice(0,20);
    report.traceExcerpt = { captured:"post-run readonly Worker query; no new model invocation", runId:opaque,
      inputTextSha256:hash(expected), rawUserRows:trace.rows.map(r=>({idx:r.idx,stepType:14,textSha256:hash(r.text)})),
      canonicalInput:{inputId:"p6-steer",outcome:canonical.outcome,evidence:{kind:"native-input-id",nativeInputId:String(raw.idx),runId:opaque}} };
  } finally { await reader.close(); }
  report.canonicalProjectionVerified = true;
  report.evidenceTier = "native-input-id";
} catch (error) {
  report.stage = stage;
  report.error = "P6 acceptance failed; see stage and native error categories";
  process.exitCode = 1;
} finally {
  // Keep only control-plane proof on a failed run; no provider stderr or account/config contents.
  const recorded = await wire();
  report.native = { version:recorded.find(f=>/^\d+\.\d+\.\d+$/.test(f.frame?.result?.agentInfo?.version ?? ""))?.frame.result.agentInfo.version ?? "unobserved", acpInitializeObserved:recorded.some(f=>f.frame?.result?.agentInfo?.version),
    hookCalls:recorded.filter(f=>f.frame?.method === "opencraft/agy/hook").length,
    steerWrites:recorded.filter(f=>f.frame?.method === "opencraft/agy/steer").length,
    claims:recorded.filter(f=>f.frame?.method === "opencraft/agy/claimed").length,
    unavailableTraces:recorded.filter(f=>f.frame?.method === "opencraft/agy/trace-unavailable").length,
    rawUserProofs:recorded.filter(f=>f.frame?.method === "opencraft/agy/raw-user").length,
    promptWrites:recorded.filter(f=>f.direction === "out" && f.frame?.method === "session/prompt").length,
    nativeErrorCodes:recorded.filter(f=>typeof f.frame?.error?.code === "number").map(f=>f.frame.error.code) };
  await host?.close().catch(() => {});
  await mkdir(dirname(out), { recursive: true });
  const sanitized = JSON.stringify(report, null, 2);
  await writeFile(out, sanitized + "\n");
  await rm(root, { recursive: true, force: true }); await rm(hostRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ out, evidenceTier: report.evidenceTier, error: report.error }));
}
