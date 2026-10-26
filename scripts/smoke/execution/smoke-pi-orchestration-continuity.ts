import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Every user, model response, directory and input belongs to this isolated run.
const root = await mkdtemp(join(tmpdir(), "pi-orchestration-drill-")), children = new Set<ChildProcess>();
const productionRoute = process.argv.includes("--production-route");
const report: Record<string, any> = { root, passed: false, native: "Pi durable in a dedicated Host process", model: "synthetic local provider",
  controlRoute: productionRoute ? "AppHostServer / AgentDriverTransport / WebSocketTransport / startEngineHost" : "isolated HTTP control proxy", scenarios: [] };
async function wait(read: () => Promise<unknown>, label: string, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await read()) return; await delay(25); }
  throw new Error(`Timed out: ${label}`);
}
async function start(kind: "host" | "gateway", blockAfterReceipt = false) {
  const config = join(root, `${kind}.json`); await writeFile(config, JSON.stringify({ root, blockAfterReceipt, productionRoute }), { mode: 0o600 });
  const child = fork(resolve("tests/fixtures/pi-orchestration-process.ts"), [kind, config], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.add(child);
  let ready = false, output = "", sequence = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { output += chunk; });
  child.on("message", (message: any) => {
    if (message.ready) { ready = true; return; }
    const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry?.reject(new Error(message.error)) : entry?.resolve(message.result);
  });
  child.on("exit", () => { children.delete(child); for (const entry of pending.values()) entry.reject(new Error(`${kind} exited`)); void writeFile(join(root, `${kind}-${child.pid}.log`), output); });
  await wait(async () => { if (child.exitCode !== null) throw new Error(`${kind} failed: ${output}`); return ready; }, `${kind} ready`);
  return { child, rpc: (command: string, params: unknown = {}) => new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, command, params }); }) };
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill(signal);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000); await exited; clearTimeout(timeout);
}
let host: Awaited<ReturnType<typeof start>> | undefined, gateway: Awaited<ReturnType<typeof start>> | undefined;
try {
  host = await start("host");
  const descriptor = JSON.parse(await readFile(join(root, "pi-host.json"), "utf8"));
  const call = async (command: string, params: unknown = {}) => {
    const response = await fetch(descriptor.controlUrl, { method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" }, body: JSON.stringify({ command, params }) });
    const body = await response.json() as any; if (!response.ok) throw new Error(body.error); return body.result;
  };
  const rpc = (method: string, args: unknown = {}) => productionRoute
    ? gateway!.rpc("rpc", { method, arguments: args }) : call("rpc", { method, arguments: args });
  const before = await call("identity"); let targetThread: string | undefined;
  for (const name of ["thread_spawn", "thread_tell"]) {
    gateway = await start("gateway", true);
    if (productionRoute) {
      await assert.rejects(rpc("opencraft/orchestration/prepare", { operationId: "untrusted", driver: "pi", arguments: {} }));
      report.rendererCannotForgeTrustedControl = true;
    }
    const created = await rpc("thread/start", { cwd: root, model: "pi:faux:faux-1" }), inputId = `human-${name}`;
    await gateway.rpc("authorize", { threadId: created.thread.id, inputId });
    await call("model", { name, callId: `native-${name}`, arguments: name === "thread_spawn" ? { driver: "pi", prompt: "Complete the isolated Pi child" } : { threadId: targetThread, message: "Complete this isolated follow-up" } });
    const started = await rpc("turn/start", { threadId: created.thread.id, clientUserMessageId: inputId, input: [{ type: "text", text: "Run the authorized isolated orchestration tool" }] });
    await wait(() => readFile(join(root, "crash-marker.json"), "utf8").then(value => JSON.parse(value).name === name, () => false), "durable tool receipt before response");
    const marker = JSON.parse(await readFile(join(root, "crash-marker.json"), "utf8"));
    if (name === "thread_spawn") targetThread = marker.result.threadId;
    const firstState = await gateway.rpc("state"); assert.equal(firstState.operations.filter((row: any) => row.tool_call_key === marker.toolCallKey).length, 1);
    const acceptedOperation = firstState.operations.find((row: any) => row.tool_call_key === marker.toolCallKey);
    // This drill kills the response owner while the native tool is pending.
    // Keep the separate input-admission ambiguity outside this scenario.
    await wait(async () => (await gateway!.rpc("state")).requests.some((request: any) => `actor-input:${request.id}` === acceptedOperation.client_message_id && request.state === "submitted"), "target accepted before response owner is killed");
    await stop(gateway.child, "SIGKILL"); gateway = undefined;
    const restartedAt = Date.now(); gateway = await start("gateway");
    await wait(async () => {
      const history = await rpc("thread/read", { threadId: created.thread.id, includeTurns: true });
      return history.thread.turns.some((turn: any) => turn.id === started.turn.id && turn.status === "completed");
    }, "same native Turn completion after Gateway replacement");
    const after = await call("identity"); assert.deepEqual(after, before);
    const state = await gateway.rpc("state"), operations = state.operations.filter((row: any) => row.tool_call_key === marker.toolCallKey);
    assert.equal(operations.length, 1); assert.ok(operations[0].result_json);
    if (name === "thread_spawn") assert.equal(state.threads.filter((thread: any) => thread.parentThreadId === created.thread.id).length, 1);
    await wait(async () => (await gateway!.rpc("state")).requests.some((request: any) => `actor-input:${request.id}` === operations[0].client_message_id && request.state === "submitted"), "native target input acceptance");
    const final = await gateway.rpc("state");
    const origin = final.origins.find((row: any) => row.input_id === operations[0].client_message_id);
    assert.equal(JSON.parse(origin.origin_json).usageSourceKind, "system");
    report.scenarios.push({ name, threadId: created.thread.id, turnId: started.turn.id, toolCallKey: marker.toolCallKey,
      operationCount: 1, hostPidUnchanged: after.pid === before.pid, originalTurnCompleted: true, systemInputRecorded: true, reconnectMs: Date.now() - restartedAt });
    await stop(gateway.child); gateway = undefined;
  }
  report.passed = true;
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  if (gateway) await stop(gateway.child); if (host) await stop(host.child);
  for (const child of children) await stop(child, "SIGKILL");
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
