/**
 * Opt-in real-account smoke for the Pi bridge (P2d).
 *
 * This is not part of CI and spends one minimal task on the cheapest available
 * Pi model. It proves the bridge protocol path and the native owner boundary;
 * it does not prove that a model understood a steer (evidence stops at native
 * admission plus the inbox/entry transition).
 *
 *   PI_BRIDGE_AGENT_DIR="$HOME/.pi/agent" \
 *     node --import tsx scripts/smoke/execution/smoke-pi-bridge.ts
 *
 * Build the artifact first: `node scripts/build-pi-bridge.mjs`.
 * Set PI_BRIDGE_MODEL to override the cheapest-model choice and
 * PI_BRIDGE_KEEP=1 to keep the temporary native session for inspection.
 */

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Frame = { jsonrpc: "2.0"; id?: string; method?: string; params?: any; result?: any; error?: any };
type Delta = Record<string, any>;

const root = process.cwd();
const artifact = join(root, "plugins/pi-bridge/dist/main.mjs");
await access(artifact).catch(() => {
  throw new Error("Missing bridge artifact; run `node scripts/build-pi-bridge.mjs` first");
});
const agentDirectory = process.env.PI_BRIDGE_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
await access(join(agentDirectory, "auth.json")).catch(() => {
  throw new Error("PI_BRIDGE_AGENT_DIR must point at a Pi agent directory with auth.json/models.json");
});
const dataDirectory = await mkdtemp(join(tmpdir(), "opencraft-pi-bridge-smoke-"));
const taskDirectory = join(dataDirectory, "task");
await mkdir(taskDirectory, { recursive: true, mode: 0o700 });

const child = spawn(process.execPath, [artifact], {
  cwd: root,
  env: { ...process.env, PI_BRIDGE_DATA_DIR: dataDirectory, PI_BRIDGE_AGENT_DIR: agentDirectory },
  stdio: ["pipe", "pipe", "pipe"],
});
const diagnostics: string[] = [];
child.stderr!.on("data", chunk => diagnostics.push(String(chunk)));
const pending = new Map<string, (frame: Frame) => void>();
const deltas: Delta[] = [];
const callbacks: Frame[] = [];
let sequence = 0;
let closedTurns = 0;
const lines = createInterface({ input: child.stdout! });
lines.on("line", line => {
  const frame = JSON.parse(line) as Frame;
  if (frame.method) {
    callbacks.push(frame);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { durable: true } }) + "\n");
    if (frame.method === "thread/delta") for (const delta of frame.params?.deltas ?? []) {
      deltas.push(delta);
      if (delta.op === "turn.close") closedTurns++;
      if (delta.op === "input.evidence" || delta.op === "input.outcome") {
        console.log("evidence", JSON.stringify({ op: delta.op, inputId: delta.inputId, kind: delta.evidenceKind, state: delta.state, reason: delta.reason }));
      }
    }
    return;
  }
  if (frame.id && pending.has(frame.id)) { pending.get(frame.id)!(frame); pending.delete(frame.id); }
});

function request(method: string, params: unknown, timeoutMs = 30_000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const id = `smoke-${++sequence}`;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`Timed out: ${method}`));
    }, timeoutMs);
    timer.unref();
  });
}

async function waitFor(predicate: (delta: Delta) => boolean, label: string, timeoutMs = 90_000): Promise<Delta> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = deltas.find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function stopAndClose(route: string): Promise<void> {
  await request("turn/stop", { threadId: route }).catch(() => {});
  await request("session/close", { threadId: route }).catch(() => {});
}

let failure: unknown;
const route = JSON.stringify(["smoke", "pi-bridge"]);
try {
  const initialized = await request("initialize", { protocolVersion: 1, grammarRange: { min: 1, max: 1 } });
  assert.equal(initialized.result?.grammarVersion, 1);
  const models = (await request("model/list", {})).result.data as Array<Record<string, any>>;
  const ranked = [...models].sort((left, right) => {
    const cost = (model: Record<string, any>) => Number(model.cost?.input ?? 0) + Number(model.cost?.output ?? 0);
    return cost(left) - cost(right) || String(left.id).localeCompare(String(right.id));
  });
  const preferred = process.env.PI_BRIDGE_MODEL;
  const selected = preferred
    ? ranked.find(model => model.id === preferred)
    : ranked.find(model => model.id === "pi:ollama-cloud:deepseek-v4.1-flash") ?? ranked[0];
  if (!selected) throw new Error("No Pi model is available");
  console.log("model", selected.id, JSON.stringify(selected.cost));

  const created = (await request("session/create", { threadId: route, cwd: taskDirectory, model: selected.id })).result;
  const metadataFiles = (await readdir(join(dataDirectory, "sessions"))).filter(name => name.endsWith(".json"));
  const metadata = JSON.parse(await readFile(join(dataDirectory, "sessions", metadataFiles[0]!), "utf8")) as { file: string };
  const holders = execFileSync("lsof", ["-t", metadata.file], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
  console.log("native-owner", created.providerThreadId, "sqlite-holders", holders.join(","), "bridge-pid", child.pid);
  assert.deepEqual(holders, [String(child.pid)], "only the bridge process may hold the native session writer");

  const started = (await request("turn/start", {
    threadId: route,
    inputId: "turn-1",
    clientRequestId: "client-turn-1",
    input: "Use the bash tool exactly once to run: printf 'alpha\\n' > tool.txt; sleep 6; printf beta. Then reply with one short line containing the file contents. Do not run any other command.",
  })).result;
  assert.equal(started.accepted, true);
  const tool = await waitFor(delta => delta.op === "item.open"
    && (delta.shape?.kind === "tool" || delta.shape?.kind === "command")
    && delta.shape?.status === "inProgress", "a running tool");
  console.log("tool", tool.nativeKey, tool.shape?.kind);

  const steerText = "Before you finish, append the exact line STEER-OK to tool.txt using a tool. Keep the reply short.";
  const firstSteer = (await request("turn/steer", {
    threadId: route, inputId: "steer-1", clientRequestId: "client-steer-1", expectedTurnId: "turn-1", input: steerText,
  })).result;
  const secondSteer = (await request("turn/steer", {
    threadId: route, inputId: "steer-2", clientRequestId: "client-steer-2", expectedTurnId: "turn-1", input: steerText,
  })).result;
  assert.equal(firstSteer.accepted, true);
  assert.equal(secondSteer.accepted, true);
  await waitFor(delta => delta.op === "turn.close" && delta.nativeTurnId === "turn-1", "first turn close", 120_000);

  const steerEvidence = (inputId: string) => deltas.filter(delta => delta.inputId === inputId);
  for (const inputId of ["steer-1", "steer-2"]) {
    const records = steerEvidence(inputId);
    assert.ok(records.some(delta => delta.op === "input.accepted"), `${inputId} must be registered`);
    assert.ok(records.some(delta => delta.op === "input.delivery" && delta.admitted === true), `${inputId} must record a native injection attempt`);
    assert.ok(records.some(delta => delta.op === "input.evidence" && delta.evidenceKind === "admission"), `${inputId} must record native admission`);
    assert.ok(records.some(delta => delta.op === "input.evidence" && delta.evidenceKind === "queue-change"), `${inputId} must record the inbox/entry transition`);
  }
  assert.ok(!deltas.some(delta => delta.op === "input.evidence" && delta.evidenceKind === "context-confirmed"), "queue removal must not become context confirmation");
  const toolText = await readFile(join(taskDirectory, "tool.txt"), "utf8");
  console.log("tool.txt", JSON.stringify(toolText));
  assert.match(toolText, /STEER-OK/u, "the model followed at least one steer (model evidence, not protocol proof)");

  // Real attempt at the accepted-but-unconsumed race. A no-tool answer often
  // places the steer at the final boundary instead; the deterministic mapper
  // test is the authoritative coverage when this race does not trigger.
  deltas.length = 0;
  await request("turn/start", { threadId: route, inputId: "turn-2", clientRequestId: "client-turn-2", input: "Reply with exactly: ok" });
  await waitFor(delta => delta.op === "turn.open" && delta.nativeTurnId === "turn-2", "second turn open");
  const late = await request("turn/steer", {
    threadId: route, inputId: "steer-late", clientRequestId: "client-steer-late", expectedTurnId: "turn-2",
    input: "This steer arrives too late and must not be reported as consumed.",
  }).then(frame => frame.result).catch(error => ({ error: String(error) }));
  console.log("late-steer-result", JSON.stringify(late));
  await waitFor(delta => delta.op === "turn.close" && delta.nativeTurnId === "turn-2", "second turn close", 90_000);
  const lateOutcome = deltas.find(delta => delta.op === "input.outcome" && delta.inputId === "steer-late");
  const latePlaced = deltas.some(delta => delta.op === "input.evidence" && delta.inputId === "steer-late" && delta.evidenceKind === "queue-change");
  console.log("late-steer", lateOutcome ? `outcome=${lateOutcome.state} reason=${lateOutcome.reason}` : latePlaced ? "placed before the boundary" : "not triggered in this run");
  if (lateOutcome) assert.equal(lateOutcome.state, "failed", "an unconsumed steer is reported failed, never delivered");
  if (latePlaced) assert.ok(!deltas.some(delta => delta.inputId === "steer-late" && delta.evidenceKind === "context-confirmed"));

  console.log("P2d smoke passed", JSON.stringify({
    providerThreadId: created.providerThreadId,
    callbacks: callbacks.length,
    deltas: deltas.length,
    closedTurns,
    evidenceTier: "native admission + queue-change (not context-confirmed)",
  }));
} catch (error) {
  failure = error;
  console.error("P2d smoke failed:", error instanceof Error ? error.message : String(error));
} finally {
  await stopAndClose(route);
  child.stdin!.end();
  await new Promise(resolve => child.on("exit", resolve));
  if (diagnostics.length) console.error("bridge diagnostics:", diagnostics.join("").trim());
  if (process.env.PI_BRIDGE_KEEP === "1") console.error("kept", dataDirectory);
  else await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
if (failure) process.exitCode = 1;
