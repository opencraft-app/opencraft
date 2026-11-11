/** One opt-in real-account task. A failure never selects another model or replays. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { BridgeHost } from "../../../apps/agent-bridge-host/src/index.js";
import { CURSOR_DECLARATION } from "../../../apps/cursor-bridge/src/declaration.js";
import { localTestBackend } from "../../../tests/agent-bridge/fixtures/local-backend.js";

const model = process.argv[2];
if (!model || !/^[a-z0-9.-]+$/.test(model)) throw Error("Pass the current cheapest available Cursor SDK model id");
const output = resolve(process.argv[3] ?? "design/agent-bridge/recordings/p5/cursor-host.json");
const root = await mkdtemp(join(tmpdir(), "p5-cursor-task-"));
const hostRoot = await mkdtemp(join(tmpdir(), "p5-cursor-host-"));
const trace = join(hostRoot, "sdk.ndjson");
const artifact = resolve("apps/cursor-bridge/dist/main.mjs");
const report: Record<string, any> = { schemaVersion: 1, provider: "cursor-sdk", sdk: "1.0.32", model,
  recordedAt: new Date().toISOString(), protocolVersion: 1, grammarVersion: 1, mapperVersion: 1,
  permissionMode: "full", backend: "Host test process backend; no production isolation claim",
  evidenceTier: "unknown-outcome", receipts: {}, nativeToDelta: [], deltaToEvent: [] };
let host: BridgeHost | undefined, stage = "activation", cursor = 0;
const events: any[] = [];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pump() { for (const e of await host!.events(cursor)) { cursor = e.seq; if ((e.payload as any).kind === "canonical") events.push((e.payload as any).event); } }
async function send(commandId: string, method: string, params: Record<string, unknown> = {}) {
  await host!.accept({ commandId, method, params, serverId: "p5-real", threadId: "p5-cursor" });
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const receipt = await host!.query(commandId);
    if (receipt && ["accepted", "rejected", "unknown"].includes(receipt.state)) {
      report.receipts[commandId] = { state: receipt.state };
      if (receipt.response && "error" in receipt.response && receipt.response.error?.kind === "auth") {
        report.requiredUserAction = "Create a Cursor User API key at https://cursor.com/dashboard/api and set CURSOR_API_KEY in the Engine Host environment, or authenticate the Cursor SDK credential store.";
      }
      return receipt;
    }
    await delay(25);
  }
  throw Error("Host receipt timed out; no replay");
}
async function native(): Promise<any[]> {
  return (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
async function until(predicate: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) { await pump(); if (await predicate()) return; await delay(50); }
  throw Error(`${label} timed out; no replay`);
}
try {
  report.artifactSha256 = createHash("sha256").update(await readFile(artifact)).digest("hex");
  report.workerSha256 = createHash("sha256").update(await readFile(resolve("apps/cursor-bridge/dist/sdk-worker.mjs"))).digest("hex");
  host = await BridgeHost.open({ path: join(hostRoot, "host.db"), backend: localTestBackend(),
    policy: { id: "p5-local-smoke", capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 } } });
  await host.add({ id: "cursor-p5", artifact, digest: report.artifactSha256, provider: CURSOR_DECLARATION,
    launch: { command: [process.execPath, artifact], cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CURSOR_BRIDGE_TRACE: trace,
        ...(process.env.CURSOR_API_KEY ? { CURSOR_API_KEY: process.env.CURSOR_API_KEY } : {}) } } });
  await host.activate("cursor-p5", "");
  stage = "session-create";
  assert.equal((await send("create", "session/create", { cwd: root, stateDirectory: join(hostRoot, "native"), model, permissionMode: "full" })).state, "accepted");
  stage = "turn-start";
  const started = await send("task", "turn/start", { input: { text: "Run exactly one harmless shell command: sleep 4. Then answer PROOF_BASELINE. Do not use other tools." } });
  assert.equal(started.state, "accepted");
  const turnId = started.response && "result" in started.response ? (started.response.result as any).nativeTurnId : undefined;
  stage = "wait-tool";
  await until(async () => (await native()).some((r) => r.type === "tool_call" && r.status === "running"), "active tool");
  stage = "steer";
  const steered = await send("steer", "turn/steer", { expectedTurnId: turnId, inputId: "p5-steer", clientRequestId: "p5-client",
    delivery: "native-inject", input: { text: "Replace your final answer with SDK_PROOF_FINAL. Do not run another tool." } });
  assert.equal(steered.state, "accepted");
  const nativeResult = steered.response && "result" in steered.response ? steered.response.result as any : {};
  if (nativeResult.state === "rejected") { report.evidenceTier = "explicitly-not-inserted"; throw Error("steer was not inserted into the current turn"); }
  stage = "task-complete";
  await until(async () => events.some((e) => e.kind === "input.state" && e.status.delivery?.value === "native-inject")
    && events.some((e) => e.kind === "turn.completed"), "delivered task completion");
  const records = await native();
  const ack = records.find((r) => r.operation === "steer");
  assert(ack && ack.outcome === "complete_delivered");
  const dispatchIndex = records.findIndex((r) => r.operation === "steer-dispatch" && r.runId === ack.runId);
  const runningIndex = records.findIndex((r) => r.type === "tool_call" && r.status === "running" && r.runId === ack.runId);
  const completedIndex = records.findIndex((r) => r.type === "tool_call" && r.status === "completed" && r.runId === ack.runId);
  assert(runningIndex >= 0 && dispatchIndex > runningIndex && completedIndex > dispatchIndex, "SDK invocation must be recorded during the tool");
  report.steerDispatchedDuringTool = true;
  report.evidenceTier = ack.outcome === "complete_delivered" ? "sdk-delivered-only" : "explicitly-not-inserted";
  report.result = "passed-at-recorded-tier";
} catch (error) {
  report.result = "blocked";
  report.blocker = { stage, reason: error instanceof assert.AssertionError ? "Host command did not succeed" : "SDK or task boundary unconfirmed; no replay" };
} finally {
  if (host) {
    await pump().catch(() => {});
    await send("close", "session/close").catch(() => {});
    await host.close();
  }
  // Only schema-selected facts leave the private task. Never serialize raw errors, tool args or text.
  const aliases = new Map<string, string>();
  const alias = (value: string) => { if (!aliases.has(value)) aliases.set(value, `opaque-${aliases.size + 1}`); return aliases.get(value); };
  report.nativeToDelta = (await native()).map((r) => ({ operation: r.operation,
    ...(r.runId ? { runId: alias(r.runId) } : {}), ...(r.agentId ? { agentId: alias(r.agentId) } : {}),
    ...(r.callId ? { callId: alias(r.callId) } : {}),
    ...(r.type ? { type: r.type } : {}), ...(r.status ? { status: r.status } : {}),
    ...(r.outcome ? { outcome: r.outcome } : {}), ...(r.error ? { error: r.error } : {}) }));
  report.deltaToEvent = events.map((e) => ({ kind: e.kind,
    ...(e.kind === "input.state" ? { inputId: "p5-steer", admission: e.status.admission?.value,
      deliveryMethod: e.status.delivery?.value, evidence: e.status.evidence?.value, disposition: e.status.disposition } : {}) }));
  report.nativeSendCount = report.nativeToDelta.filter((r: any) => r.operation === "send").length;
  report.nativeSteerCount = report.nativeToDelta.filter((r: any) => r.operation === "steer").length;
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  await rm(root, { recursive: true, force: true }); await rm(hostRoot, { recursive: true, force: true });
}
console.log(JSON.stringify({ result: report.result, evidenceTier: report.evidenceTier, stage }));
