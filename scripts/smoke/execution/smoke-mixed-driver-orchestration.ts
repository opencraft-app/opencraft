import assert from "node:assert/strict";
import { spawn, fork, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { AccountPoolStore, CodexCoreControlClient } from "@opencraft/account-pool-host";

const executable = process.env.OPENCRAFT_CODEX_EXECUTABLE, dshEntry = process.env.OPENCRAFT_DSH_ACP_ENTRY;
if (!executable || !dshEntry) throw new Error("Set fixed OPENCRAFT_CODEX_EXECUTABLE and OPENCRAFT_DSH_ACP_ENTRY for isolated real-engine validation");
const root = await mkdtemp(join(tmpdir(), "mixed-driver-drill-")), home = join(root, "home"), children = new Set<ChildProcess>();
const dshNativeToolOnly = process.argv.includes("--dsh-native-tool-only");
await mkdir(home, { mode: 0o700 });
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: root, LANG: "C.UTF-8", RUST_LOG: "error" };
const authToken = "synthetic-mixed-control-token-".repeat(3), coreEndpoint = join(root, "core/control.sock"), appServerEndpoint = join(root, "app/control.sock");
const report: Record<string, any> = { root, passed: false, cliVersion: execFileSync(executable, ["--version"], { encoding: "utf8" }).trim(),
  delegation: dshNativeToolOnly ? "native DSH ACP MCP tool with a transport-generated human input identity" : "trusted real Broker invocation after a real authenticated native source Turn",
  model: "local synthetic providers only", matrix: [] };
const modelRecords: Array<{ user: string; held: boolean }> = []; let release = false;
const event = (response: ServerResponse, data: any) => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
const model = createServer((request, response) => { void (async () => {
  if (request.url === "/usage") { response.end('{"plan_type":"pro"}'); return; }
  if (request.url?.endsWith("/models")) { response.end('{"data":[]}'); return; }
  if (request.url !== "/responses") { response.writeHead(404); response.end(); return; }
  const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part)); const raw = Buffer.concat(parts);
  const bytes = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
  const body = JSON.parse(bytes.toString()), user = JSON.stringify((body.input ?? []).filter((item: any) => item.role === "user").at(-1) ?? "");
  const held = user.includes("HOLD-MIXED-NATIVE"), id = `response-${modelRecords.length}`, itemId = `message-${modelRecords.length}`; modelRecords.push({ user, held });
  response.writeHead(200, { "content-type": "text/event-stream" });
  event(response, { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
  event(response, { type: "response.output_item.added", output_index: 0, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } });
  while (held && !release && !response.destroyed) {
    event(response, { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: "tick " }); await delay(100);
  }
  if (response.destroyed) return;
  const item = { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic Codex native done.", annotations: [] }] };
  event(response, { type: "response.output_item.done", output_index: 0, item });
  event(response, { type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }); response.end();
})().catch(error => { if (!response.headersSent) response.writeHead(500); response.end(); void appendFile(join(root, "model-errors.log"), String(error) + "\n"); }); });
async function listen(server: ReturnType<typeof createServer>) { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return (server.address() as any).port; }
const modelPort = await listen(model), reservation = createServer(), proxyPort = await listen(reservation); await new Promise<void>(resolve => reservation.close(() => resolve()));
const dshPlugin = join(root, "synthetic-dsh-model.mjs"), dshPatch = join(root, "synthetic-dsh.patch.yml"), released = join(root, "release-native");
const llmModule = pathToFileURL(resolve(dirname(dshEntry), "../../dsh-llm/lib/index.js")).href;
await writeFile(dshPlugin, `import {LlmAdapter} from ${JSON.stringify(llmModule)};
import {access,appendFile} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';
class Synthetic extends LlmAdapter {
 async *stream(options){const user=JSON.stringify(options.messages.filter(m=>m.role==='user'&&m.source?.kind==='user').at(-1)??{});const hold=user.includes('HOLD-MIXED-NATIVE');const hasResult=options.messages.some(m=>m.role==='tool');await appendFile(${JSON.stringify(join(root, "dsh-model.ndjson"))},JSON.stringify({user,hold,hasResult})+'\\n');
 if(user.includes('DSH-NATIVE-SPAWN')&&!hasResult){const tool=options.tools?.find(t=>t.name.includes('thread_spawn'));if(!tool)throw Error('Native DSH must advertise the MCP orchestration tool');const args='{"driver":"pi","cwd":"child","prompt":"NATIVE-DSH-TO-PI-CHILD"}';yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'tool-call-delta',index:0,id:'native-dsh-spawn',name:tool.name,argumentsDelta:args};yield{type:'block-end',index:0,block:{type:'tool-call',id:'native-dsh-spawn',name:tool.name,arguments:args}};yield{type:'usage',usage:{inputTokens:10,outputTokens:5}};yield{type:'finish',reason:{kind:'tool-calls'}};return;}
 yield {type:'block-start',index:0,blockType:'text'};let text='';
 while(hold&&!options.signal?.aborted){try{await access(${JSON.stringify(released)});break;}catch{}text+='tick ';yield{type:'text-delta',index:0,text:'tick '};await delay(100);}
 text+='Synthetic DSH ACP native done.';yield{type:'text-delta',index:0,text:'Synthetic DSH ACP native done.'};yield{type:'block-end',index:0,block:{type:'text',text}};yield{type:'usage',usage:{inputTokens:10,outputTokens:5}};yield{type:'finish',reason:{kind:'stop'}};
 }}
export const inject=['llm'];export function apply(ctx){ctx.llm.registerAdapter(['synthetic-mixed'],new Synthetic());}
`, { mode: 0o600 });
await writeFile(dshPatch, `- id: llm-deepseek\n  disabled: true\n- id: acp\n  config:\n    provider: synthetic-mixed\n    model: fixture\n- insert:\n    - id: synthetic-mixed-model\n      name: ${JSON.stringify(dshPlugin)}\n`, { mode: 0o600 });
const accountData = join(root, "accounts"), store = new AccountPoolStore({ databasePath: join(accountData, "account-pool.sqlite"), secretsDirectory: join(accountData, "secrets") });
store.addAccount({ id: "synthetic", provider: "codex", label: "Synthetic", upstreamAccountId: "synthetic", enabled: true, priority: 0 }, { accessToken: "synthetic-no-upstream-access", refreshToken: null, expiresAt: null }); store.close();
const common = { root, executable, dshEntry, dshPatch, authToken, coreEndpoint };
async function wait(check: () => Promise<unknown> | unknown, label: string, timeout = 25000) {
  const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await delay(25); } throw new Error("Timed out: " + label);
}
async function owner(kind: "core" | "runtime") {
  const file = join(root, `${kind}.json`); await writeFile(file, JSON.stringify({ authToken, executable, endpoint: kind === "core" ? coreEndpoint : appServerEndpoint,
    appServerEndpoint, coreEndpoint, dataDirectory: accountData, runtimeDirectory: root, nativeCodexHomeDirectory: join(accountData, "runtime"),
    upstreamBaseUrl: `http://127.0.0.1:${modelPort}`, proxyPort, waitForCore: true }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/split-codex-owner.ts", kind, file], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
  let stdout = "", stderr = ""; child.stdout!.on("data", chunk => { stdout += chunk; }); child.stderr!.on("data", chunk => { stderr += chunk; });
  child.on("exit", () => { children.delete(child); void writeFile(join(root, `${kind}-${child.pid}.log`), stderr); });
  await wait(() => { if (child.exitCode !== null) throw new Error(`${kind} startup failed: ${stderr}`); return stdout.includes("ready\n"); }, `${kind} ready`); return child;
}
async function start(kind: "pi" | "dsh-acp" | "gateway") {
  const file = join(root, `${kind}.json`); await writeFile(file, JSON.stringify(common), { mode: 0o600 });
  const child = fork(resolve("tests/fixtures/mixed-driver-process.ts"), [kind, file], { cwd: process.cwd(), env, execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.add(child);
  let ready = false, output = "", sequence = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { output += chunk; });
  child.on("message", (message: any) => { if (message.ready) { ready = true; return; } const entry = pending.get(message.id); pending.delete(message.id);
    message.error ? entry?.reject(Object.assign(new Error(message.error), { stack: message.stack })) : entry?.resolve(message.result); });
  child.on("exit", () => { children.delete(child); for (const entry of pending.values()) entry.reject(new Error(`${kind} exited`)); void writeFile(join(root, `${kind}-${child.pid}.log`), output); });
  await wait(() => { if (child.exitCode !== null) throw new Error(`${kind} startup failed: ${output}`); return ready; }, `${kind} ready`);
  return { child, rpc: (command: string, params: unknown = {}) => new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, command, params }); }) };
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") { if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill(signal); const timeout = setTimeout(() => child.kill("SIGKILL"), 5000); await done; clearTimeout(timeout); }
let core: ChildProcess | undefined, app: ChildProcess | undefined, pi: Awaited<ReturnType<typeof start>> | undefined, dsh: Awaited<ReturnType<typeof start>> | undefined, gateway: Awaited<ReturnType<typeof start>> | undefined;
const nativeControl = new CodexCoreControlClient(coreEndpoint, authToken);
try {
  core = await owner("core"); app = await owner("runtime"); pi = await start("pi"); dsh = await start("dsh-acp"); gateway = await start("gateway");
  const nativeCall = async (id: "pi" | "dsh-acp", command: string) => { const descriptor = JSON.parse(await readFile(join(root, `${id}-host.json`), "utf8"));
    const response = await fetch(descriptor.controlUrl, { method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" }, body: JSON.stringify({ command }) });
    const body = await response.json() as any; if (!response.ok) throw new Error(body.error); return body.result; };
  const drivers = ["codex", "pi", "dsh-acp"] as const, sources = new Map<string, { threadId: string; turnId: string; inputId: string }>();
  const rpc = (driver: string, method: string, args: unknown) => gateway!.rpc("rpc", { driver, method, arguments: args });
  async function create(driver: string, input: string) {
    const { thread } = await rpc(driver, "thread/start", { cwd: root, ...(driver === "codex" ? { model: "gpt-test", approvalPolicy: "never", sandbox: "danger-full-access" } : driver === "pi" ? { model: "pi:faux:faux-1" } : { model: `dsh-acp:${JSON.stringify(["synthetic-mixed", "fixture"])}` }) });
    if (driver === "codex") assert.match(thread.id, /^[0-9a-f-]{36}$/u);
    else assert.ok(thread.id.startsWith(driver === "pi" ? "pi_" : "dsh_acp_"), `Source ${driver} must use its own native engine`);
    const inputId = `human-${driver}-${Math.random().toString(36).slice(2)}`;
    const { turn } = await rpc(driver, "turn/start", { threadId: thread.id, clientUserMessageId: inputId, input: [{ type: "text", text: input }] });
    return { threadId: thread.id, turnId: turn.id, inputId };
  }
  if (dshNativeToolOnly) {
    await mkdir(join(root, "child"), { mode: 0o700 });
    const { thread } = await rpc("dsh-acp", "thread/start", { cwd: root, model: `dsh-acp:${JSON.stringify(["synthetic-mixed", "fixture"])}` });
    assert.ok(thread.id.startsWith("dsh_acp_"));
    // Omit clientUserMessageId deliberately. AgentDriverTransport must allocate
    // the authenticated human input, and only the real native callback binds it.
    const { turn } = await rpc("dsh-acp", "turn/start", { threadId: thread.id, input: [{ type: "text", text: "DSH-NATIVE-SPAWN" }] });
    await wait(async () => (await gateway!.rpc("status", { threadId: thread.id })).state === "completed", "DSH native tool source completed");
    const state = await gateway.rpc("state"), operations = state.operations.filter((row: any) => row.kind === "spawn");
    assert.equal(operations.length, 1, "The real native callback must reach Broker once");
    const operation = operations[0], spawned = JSON.parse(operation.result_json); assert.ok(spawned.threadId.startsWith("pi_"));
    await wait(async () => (await gateway!.rpc("status", { threadId: spawned.threadId })).state === "completed", "native-spawned Pi child completed");
    await wait(async () => (await gateway!.rpc("state")).requests.some((row: any) => `actor-input:${row.id}` === operation.client_message_id && row.state === "submitted"), "native child input receipt committed");
    const final = await gateway.rpc("state"), callbacks = (await readFile(join(root, "native-callbacks.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const received = callbacks.filter(row => row.event === "received"); assert.equal(received.length, 1);
    assert.equal(received[0].threadId, thread.id); assert.equal(received[0].turnId, turn.id);
    assert.match(received[0].inputId, /^human-input:[a-f0-9-]{36}$/u);
    const humanOrigin = final.origins.find((row: any) => row.thread_id === thread.id && row.input_id === received[0].inputId);
    assert.equal(JSON.parse(humanOrigin.origin_json).usageSourceKind, "human");
    assert.equal(final.authorities.find((row: any) => row.thread_id === thread.id && row.turn_id === turn.id).input_id, received[0].inputId);
    assert.equal(final.requests.filter((row: any) => `actor-input:${row.id}` === operation.client_message_id && row.state === "submitted").length, 1);
    const childHistory = await rpc("pi", "thread/read", { threadId: spawned.threadId, includeTurns: true });
    assert.equal(childHistory.thread.cwd, join(root, "child"), "The source-approved relative workspace must be resolved exactly once");
    assert.ok(JSON.stringify(childHistory).includes("NATIVE-DSH-TO-PI-CHILD"));
    const modelCalls = (await readFile(join(root, "dsh-model.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line)); assert.ok(modelCalls.some(call => call.hasResult));
    report.nativeDshToolSource = { threadId: thread.id, turnId: turn.id, childThreadId: spawned.threadId,
      generatedHumanInputId: received[0].inputId, callbackBoundOriginalHumanInput: true, manualExecutionStarted: false, manualBrokerInvoke: false,
      realNativeMcpToolCalls: 1, childNativePromptObserved: true, childCompleted: true, productionEnvelopeValidationMirrored: true,
      requestedRelativeCwd: "child", childCwd: childHistory.thread.cwd, relativeCwdResolvedOnce: true };
  } else {
  for (const driver of drivers) {
    const source = await create(driver, `Source session for ${driver}`); sources.set(driver, source);
    await wait(async () => (await gateway!.rpc("status", { threadId: source.threadId })).state === "completed", `${driver} source completed`);
  }
  report.sources = Object.fromEntries([...sources].map(([driver, source]) => [driver, source.threadId]));
  for (const sourceDriver of drivers) for (const destination of drivers) {
    const source = sources.get(sourceDriver)!, spawnKey = `mixed:${sourceDriver}:${destination}:spawn`, tellKey = `mixed:${sourceDriver}:${destination}:tell`;
    report.current = `${sourceDriver} -> ${destination}`;
    const spawned = await gateway.rpc("invoke", { ...source, key: spawnKey, name: "thread_spawn", arguments: { driver: destination === "dsh-acp" ? "dsh" : destination, prompt: `Spawned ${sourceDriver} to ${destination}`, title: "Synthetic mixed child" } });
    const operation = async (key: string) => (await gateway!.rpc("state")).operations.find((row: any) => row.tool_call_key === key);
    const accepted = async (key: string) => { const op = await operation(key); return (await gateway!.rpc("state")).requests.find((row: any) => `actor-input:${row.id}` === op.client_message_id && row.state === "submitted"); };
    await wait(() => accepted(spawnKey), "real spawned input accepted");
    await wait(async () => (await gateway!.rpc("status", { threadId: spawned.threadId })).state === "completed", "spawn destination native completion");
    const first = await gateway.rpc("status", { threadId: spawned.threadId });
    await gateway.rpc("invoke", { ...source, key: tellKey, name: "thread_tell", arguments: { threadId: spawned.threadId, message: `Tell ${sourceDriver} to ${destination}` } });
    await wait(() => accepted(tellKey), "real tell accepted");
    await wait(async () => { const state = await gateway!.rpc("status", { threadId: spawned.threadId }); return state.state === "completed" && state.turnId !== first.turnId; }, "tell destination native completion");
    const state = await gateway.rpc("state"), relevant = state.operations.filter((row: any) => [spawnKey, tellKey].includes(row.tool_call_key));
    assert.equal(relevant.length, 2); assert.ok(relevant.every((row: any) => row.result_json));
    assert.equal(state.threads.filter((thread: any) => thread.threadId === spawned.threadId && thread.parentThreadId === source.threadId).length, 1);
    for (const row of relevant) assert.equal(JSON.parse(state.origins.find((origin: any) => origin.input_id === row.client_message_id).origin_json).usageSourceKind, "system");
    const nativeText = destination === "dsh-acp" ? await readFile(join(root, "dsh-model.ndjson"), "utf8")
      : JSON.stringify(await rpc(destination, "thread/read", { threadId: spawned.threadId, includeTurns: true }));
    assert.ok(nativeText.includes(`Spawned ${sourceDriver} to ${destination}`)); assert.ok(nativeText.includes(`Tell ${sourceDriver} to ${destination}`));
    report.matrix.push({ source: sourceDriver, destination, childThreadId: spawned.threadId, spawnAccepted: true, tellAccepted: true,
      twoDistinctNativeTurnsCompleted: true, nativePromptsObserved: true, oneChild: true, systemOrigins: true });
  }
  const identity = { codex: await nativeControl.health(), pi: await nativeCall("pi", "identity"), dsh: await nativeCall("dsh-acp", "identity") };
  await nativeCall("pi", "hold");
  const held = new Map<string, Awaited<ReturnType<typeof create>>>();
  for (const driver of drivers) held.set(driver, await create(driver, "HOLD-MIXED-NATIVE"));
  report.current = "all three native tasks held before Gateway SIGKILL";
  await wait(async () => modelRecords.some(record => record.held) && (await readFile(join(root, "dsh-model.ndjson"), "utf8")).includes('"hold":true'), "real Codex and DSH streams active");
  for (const source of held.values()) assert.equal((await gateway.rpc("status", { threadId: source.threadId })).state, "active");
  await stop(gateway.child, "SIGKILL"); gateway = await start("gateway");
  const after = { codex: await nativeControl.health(), pi: await nativeCall("pi", "identity"), dsh: await nativeCall("dsh-acp", "identity") };
  assert.equal(after.codex.codexPid, identity.codex.codexPid); assert.equal(after.codex.appServerPid, identity.codex.appServerPid);
  assert.deepEqual(after.pi, identity.pi); assert.deepEqual(after.dsh, identity.dsh);
  for (const source of held.values()) { const active = await gateway.rpc("status", { threadId: source.threadId }); assert.equal(active.turnId, source.turnId); assert.equal(active.state, "active"); }
  report.gatewayRestart = { nativePidsUnchanged: true, originalTurnsActiveAfterRestart: true, allThreeOriginalTurnsCompleted: false,
    nativePids: { codex: after.codex.codexPid, codexApp: after.codex.appServerPid, pi: after.pi.nativePid, dshAcp: after.dsh.nativePid },
    turns: Object.fromEntries([...held].map(([driver, source]) => [driver, source.turnId])) };
  await writeFile(join(root, "progress.json"), JSON.stringify(report, null, 2));
  release = true; await writeFile(released, "release isolated tasks\n", { mode: 0o600 });
  for (const [driver, source] of held) await wait(async () => { const state = await gateway!.rpc("status", { threadId: source.threadId }); return state.state === "completed" && state.turnId === source.turnId; }, `${driver} original held Turn completion`, 45000);
  report.gatewayRestart.allThreeOriginalTurnsCompleted = true;
  }
  delete report.current; report.passed = true;
} catch (error) { report.error = String(error); report.stack = (error as Error).stack; process.exitCode = 1; }
finally {
  release = true; await writeFile(released, "release isolated cleanup\n", { mode: 0o600 });
  if (gateway) await stop(gateway.child); if (pi) await stop(pi.child); if (dsh) await stop(dsh.child); if (app) await stop(app); if (core) await stop(core);
  for (const child of children) await stop(child, "SIGKILL"); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
  await writeFile(join(root, "model-records.json"), JSON.stringify(modelRecords, null, 2)); await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
