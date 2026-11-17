import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { AcpEngine } from "../../../plugins/acp-engine/src/index.js";
import { ConnectedAgentHistory } from "../../../apps/local-agent-host/src/connected-agent-history.js";
import { resolveExecutable, createOnboardingDeps } from "../../../apps/local-agent-host/src/agent-onboarding.js";

// Real installed Pi and native tools; inference/auth are isolated local fixtures.
const command = process.env.OPENCRAFT_PI_CLI ?? await resolveExecutable(["pi"], createOnboardingDeps());
if (!command) throw new Error("An installed Pi CLI is required");
const root = await mkdtemp(join(tmpdir(), "opencraft-native-pi-")), home = join(root, "agent"), sessions = join(root, "sessions");
await mkdir(home); await mkdir(sessions);
const calls: any[] = [];
const server = createServer(async (req, res) => {
  if (req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
  let body = ""; for await (const bytes of req) body += bytes;
  const input = JSON.parse(body); calls.push(input);
  const messages = input.messages ?? [], user = messages.filter((m: any) => m.role === "user").at(-1);
  const text = typeof user?.content === "string" ? user.content : user?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") ?? "";
  const afterTool = messages.at(-1)?.role === "tool";
  const tool = !afterTool && text.includes("native tool");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (delta: unknown, finish: string | null) => res.write("data: " + JSON.stringify({ id: "local-response", object: "chat.completion.chunk", created: 1, model: "vision", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n");
  if (tool) send({ role: "assistant", tool_calls: [{ index: 0, id: "local-bash", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: text.includes("cancel native tool") ? "printf '%s' \"$$\" > native-shell.pid; sleep 30" : "printf PI_SHELL_OK" }) } }] }, null);
  else send({ role: "assistant", content: afterTool ? "PI_TOOL_OK" : "PI_NATIVE_OK" }, null);
  send({}, tool ? "tool_calls" : "stop"); res.end("data: [DONE]\n\n");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
await writeFile(join(home, "models.json"), JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "synthetic-local-only",
  models: [{ id: "vision", name: "Local Pi Vision", reasoning: false, input: ["text", "image"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
await writeFile(join(home, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "vision", defaultThinkingLevel: "off", packages: [], quietStartup: true }));
const options = { id: "pi-cli" as const, protocol: "pi-rpc" as const, threadNamespace: "picli_", label: "Pi", permission: "allow-once" as const, command,
  args: ["--mode", "rpc", "--offline", "--approve", "--session-dir", sessions], env: { PI_CODING_AGENT_DIR: home }, cwd: root, dataDirectory: join(root, "metadata") };
const create = () => new AcpEngine({ ...options, history: new ConnectedAgentHistory("pi-cli", sessions) });
const engine = create(), client = { notify() {}, async request() { throw new Error("Unexpected platform tool"); } };
const chunk = (kind: string, data: Buffer) => { const type = Buffer.from(kind), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data]))); return Buffer.concat([size, type, data, crc]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(32, 0); ihdr.writeUInt32BE(32, 4); ihdr[8] = 8; ihdr[9] = 6;
const pixels = Buffer.alloc(32 * (1 + 32 * 4)); for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const offset = y * 129 + 1 + x * 4; pixels[offset] = 255; pixels[offset + 3] = 255; }
const imageUrl = "data:image/png;base64," + Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
const evidence: any = { cli: command, syntheticInference: true, stages: [] };
try {
  const created = await engine.request("thread/start", { model: "pi-cli:local:vision" }, client), id = created.thread.id;
  const submit = async (text: string, image = false) => {
    let done!: (value: any) => void; const completed = new Promise<any>(resolve => { done = resolve; });
    const unsubscribe = engine.subscribe((method, params) => { if (method === "turn/completed" && params.threadId === id) done(params.turn); });
    try {
      await engine.request("turn/start", { threadId: id, model: "pi-cli:local:vision", input: [{ type: "text", text }, ...(image ? [{ type: "image", url: imageUrl }] : [])] }, client);
      const turn = await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new Error("Native Pi did not settle")), 20000).unref())]);
      assert.equal(turn.status, "completed"); return turn;
    } finally { unsubscribe(); }
  };
  const first = await submit("Check this synthetic image", true);
  assert.ok(first.items.some((item: any) => item.type === "agentMessage" && item.text === "PI_NATIVE_OK"));
  console.log("native-request-shapes", JSON.stringify(calls.map(call => call.messages.map((message: any) => ({ role: message.role, types: Array.isArray(message.content) ? message.content.map((block: any) => block.type) : typeof message.content })))));
  assert.ok(calls.some(call => call.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "image_url"))));
  evidence.stages.push("image-reached-native-model");
  const tool = await submit("Run the native tool once");
  assert.ok(tool.items.some((item: any) => item.type === "dynamicToolCall" && item.status === "completed"));
  assert.ok(calls.some(call => call.messages.some((m: any) => m.role === "tool" && JSON.stringify(m.content).includes("PI_SHELL_OK"))));
  evidence.stages.push("native-bash-tool-completed");
  let cancelled!: (turn: any) => void; const cancellation = new Promise<any>(resolve => { cancelled = resolve; });
  const remove = engine.subscribe((method, params) => { if (method === "turn/completed" && params.threadId === id) cancelled(params.turn); });
  try {
    await engine.request("turn/start", { threadId: id, input: [{ type: "text", text: "cancel native tool" }] }, client);
    let pid = 0;
    for (let attempt = 0; attempt < 200 && !pid; attempt++) {
      pid = Number(await readFile(join(root, "native-shell.pid"), "utf8").catch(() => ""));
      if (!pid) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(pid > 1, "native Bash child started");
    await engine.request("turn/interrupt", { threadId: id }, client);
    const turn = await Promise.race([cancellation, new Promise((_, reject) => setTimeout(() => reject(new Error("Native Pi cancellation did not settle")), 10000).unref())]);
    assert.equal(turn.status, "interrupted");
    let exists = true;
    for (let attempt = 0; attempt < 100 && exists; attempt++) {
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") exists = false; else throw error; }
      if (exists) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(exists, false, "Stop cleans up the real native Bash child"); evidence.stages.push("native-bash-stop-confirmed");
  } finally { remove(); }
  await engine.close();
  const cold = create();
  try {
    const read = await cold.request("thread/read", { threadId: id, initialTurnsPage: { limit: 2, itemsView: "full", sortDirection: "desc" } }, client);
    assert.equal(cold.processId, null); assert.equal(read.initialTurnsPage.data.length, 2);
    assert.ok(read.initialTurnsPage.data.some((turn: any) => turn.items.some((item: any) => item.type === "agentMessage" && item.text === "PI_TOOL_OK")));
    evidence.stages.push("cold-native-history-without-process");
  } finally { await cold.close(); }
  await writeFile("/tmp/opencraft-connected-pi-native.json", JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} finally { await engine.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
