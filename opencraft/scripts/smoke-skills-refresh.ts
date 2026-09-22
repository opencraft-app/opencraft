import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import WebSocket from "ws";
import { startLocalAgentHost } from "../apps/local-agent-host/src/main.js";

// The only model is this loopback fixture; every installation lives under root.
const root = await mkdtemp(join(tmpdir(), "oc-skills-refresh-"));
const previousAgentsHome = process.env.DSH_AGENTS_HOME;
process.env.DSH_AGENTS_HOME = join(root, "agents-home");
const captured: any[] = [], frames: any[] = [];
let invokeSkill = false;
let beforeToolResult: (() => Promise<void>) | undefined;
const endpoint = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (body.stream) captured.push(body);
  const invoke = body.stream && invokeSkill;
  if (invoke) invokeSkill = false;
  if (invoke && beforeToolResult) {
    const action = beforeToolResult; beforeToolResult = undefined;
    await action();
  }
  const message = invoke
    ? { role: "assistant", tool_calls: [{ index: 0, id: "load-skill", type: "function", function: { name: "skill", arguments: JSON.stringify({ name: "refresh-fixture" }) } }] }
    : { role: "assistant", content: "Fixture completed" };
  const base = { id: "fixture", created: 1, model: "fixture" };
  if (!body.stream) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: "stop" }] }));
    return;
  }
  const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.setHeader("content-type", "text/event-stream");
  res.end(chunk(message, null) + chunk({}, invoke ? "tool_calls" : "stop") + "data: [DONE]\n\n");
});
let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined;
let socket: WebSocket | undefined;
let secondSocket: WebSocket | undefined;
const secondFrames: any[] = [];
let nextId = 1;
async function request(method: string, params: any = {}) {
  const id = nextId++, ws = socket!;
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", receive); reject(new Error("Timed out: " + method)); }, 20000);
    const receive = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString());
      if (frame.id !== id) return;
      clearTimeout(timer); ws.off("message", receive);
      frame.error ? reject(new Error(method + ": " + frame.error.message)) : resolve(frame.result);
    };
    ws.on("message", receive); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}
async function connect() {
  socket = new WebSocket(host!.websocketUrl);
  socket.on("message", data => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
  await request("initialize");
}
async function turn(threadId: string) {
  const from = frames.length, requestsFrom = captured.length;
  await request("turn/start", { threadId, input: [{ type: "text", text: "Continue the fixture" }] });
  const deadline = Date.now() + 20000;
  while (!frames.slice(from).some(f => f.method === "turn/completed" && f.params.threadId === threadId)) {
    if (Date.now() > deadline) throw new Error("Turn did not settle");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const done = frames.slice(from).find(f => f.method === "turn/completed" && f.params.threadId === threadId);
  assert.equal(done.params.turn.status, "completed", JSON.stringify(done.params.turn.error));
  return captured.slice(requestsFrom);
}
function latestCatalog(body: any) {
  return body.messages.filter((m: any) => JSON.stringify(m.content).includes("<available_skills>") || JSON.stringify(m.content).includes("No skills are currently available")).at(-1);
}
const markdown = "---\nname: refresh-fixture\ndescription: Refresh fixture\n---\nSKILL_BODY_FRESH_SENTINEL\n";
try {
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const packaging = JSON.parse(await readFile("apps/workbench-electron/package.json", "utf8"));
  for (const resource of packaging.build.extraResources) {
    if (!resource.from?.endsWith(".mjs")) continue;
    const target = join(root, "packaged", resource.to);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve("apps/workbench-electron", resource.from), target);
  }
  const options = { dshExecutable: resolve("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    dshCapabilityPlugin: join(root, "packaged/runtime/dsh/opencraft-capability-plugin.mjs"),
    dataDirectory: join(root, "runtime"), modelStorageDirectory: join(root, "models"), skillsDirectory: join(root, "user-skills") };
  host = await startLocalAgentHost(options); await connect();
  const catalog = await request("runtime/providers/list");
  const saved = await request("runtime/providers/apply", { target: { kind: "create", id: "refresh-local" }, expectedRevision: catalog.creation.revision,
    displayName: "Fixture", baseURL: `http://127.0.0.1:${(endpoint.address() as {port: number}).port}/v1`, api: "openai-completions",
    models: [{ id: "fixture", input: ["text"], contextWindow: 32768, maxTokens: 1024 }], credential: { kind: "replace", value: "synthetic" } });
  await request("runtime/providers/setEnabled", { provider: "refresh-local", enabled: true, expectedRevision: saved.revision });
  const model = (await request("model/list")).data.find((m: any) => m.model.includes("refresh-local")).model;
  const threadId = (await request("thread/start", { cwd: workspace, model })).thread.id;
  await turn(threadId); // Prime the native catalog before installation.
  secondSocket = new WebSocket(host.websocketUrl);
  secondSocket.on("message", data => secondFrames.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { secondSocket!.once("open", resolve); secondSocket!.once("error", reject); });
  secondSocket.send(JSON.stringify({ jsonrpc: "2.0", id: "second-init", method: "initialize", params: {} }));
  const readyDeadline = Date.now() + 5000;
  while (!secondFrames.some(f => f.id === "second-init")) {
    if (Date.now() > readyDeadline) throw new Error("Second client did not initialize");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const notificationsFrom = frames.length, secondFrom = secondFrames.length;
  const scope = { type: "local-dsh", root: "user" };
  await request("skills/install", { scope, operationId: "install-fixture", artifact: { name: "refresh-fixture", files: [{ path: "SKILL.md", content: markdown }] } });
  invokeSkill = true;
  const after = await turn(threadId); // No UI directory query or forceReload.
  assert.match(JSON.stringify(latestCatalog(after[0])), /refresh-fixture/, "installed Skill must reach the existing Agent model catalog");
  assert.ok(after.some(body => body.messages.some((m: any) => m.role === "tool" && JSON.stringify(m.content).includes("SKILL_BODY_FRESH_SENTINEL"))), "native skill tool reads installed body");
  assert.ok(frames.slice(notificationsFrom).some(f => f.method === "skills/changed"), "mutation publishes the standard invalidation notification");
  assert.ok(secondFrames.slice(secondFrom).some(f => f.method === "skills/changed"), "another logical client also receives invalidation");
  secondSocket.close(); secondSocket = undefined;
  await request("skills/uninstall", { scope, operationId: "remove-fixture", name: "refresh-fixture" });
  const removed = await turn(threadId);
  assert.ok(!JSON.stringify(latestCatalog(removed[0])).includes("refresh-fixture"), "replacement catalog revokes removed Skill");
  const projectSkill = join(workspace, ".opencraft", "skills", "project-fixture");
  await mkdir(projectSkill, { recursive: true });
  await writeFile(join(projectSkill, "SKILL.md"), markdown.replaceAll("refresh-fixture", "project-fixture"));
  const external = await turn(threadId);
  assert.match(JSON.stringify(latestCatalog(external[0])), /project-fixture/, "external edit is reconciled at the next model step without UI");
  const nativeProject = join(workspace, ".agents", "skills", "priority-fixture");
  const userPriority = join(options.skillsDirectory, "priority-fixture");
  for (const path of [nativeProject, userPriority]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), markdown.replaceAll("refresh-fixture", "priority-fixture"));
  }
  const priority = await request("skills/list", { cwds: [workspace], forceReload: true });
  assert.equal(priority.data[0].skills.find((s: any) => s.name === "priority-fixture").path, join(nativeProject, "SKILL.md"), "native project Skill outranks a managed user Skill");
  const workspacePriority = join(workspace, ".opencraft", "skills", "priority-fixture");
  await mkdir(workspacePriority, { recursive: true });
  await writeFile(join(workspacePriority, "SKILL.md"), markdown.replaceAll("refresh-fixture", "priority-fixture"));
  const higher = await request("skills/list", { cwds: [workspace], forceReload: true });
  assert.equal(higher.data[0].skills.find((s: any) => s.name === "priority-fixture").path, join(workspacePriority, "SKILL.md"), "workspace OpenCraft root wins within native rank rules");
  const elsewhere = join(root, "elsewhere"); await mkdir(elsewhere);
  const isolated = await request("skills/list", { cwds: [elsewhere], forceReload: true });
  assert.ok(!isolated.data[0].skills.some((s: any) => s.name === "project-fixture"), "cwd roots do not leak between workspaces");
  assert.equal(isolated.data[0].skills.find((s: any) => s.name === "priority-fixture").scope, "user");
  const child = (await request("thread/fork", { threadId })).thread.id;
  await turn(child);
  // The first request is already in flight. Add a Skill before returning a
  // tool call; the continuation within THIS Turn must publish the new catalog.
  invokeSkill = true;
  beforeToolResult = async () => {
    const path = join(workspace, ".opencraft", "skills", "mid-step-fixture");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), markdown.replaceAll("refresh-fixture", "mid-step-fixture"));
  };
  const midStep = await turn(threadId);
  assert.ok(midStep.length >= 2);
  assert.ok(!JSON.stringify(latestCatalog(midStep[0])).includes("mid-step-fixture"));
  assert.match(JSON.stringify(latestCatalog(midStep[1])), /mid-step-fixture/, "automatic tool continuation uses the next native pre-step, not only turn/start");
  socket!.close(); socket = undefined; await host.close();
  host = await startLocalAgentHost(options); await connect();
  await request("thread/resume", { threadId });
  const cold = await request("skills/list", { cwds: [workspace], forceReload: true });
  assert.ok(cold.data[0].skills.some((s: any) => s.name === "project-fixture"), "cold display lookup does not require a loaded Agent");
  await turn(threadId);
  console.log("PASS: packaged module closure; real DSH existing-session install/read/remove, mid-turn edit, rank/cwd isolation, fork, notification and cold restart; synthetic model only");
} finally {
  socket?.close(); secondSocket?.close(); await host?.close();
  endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve()));
  if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME; else process.env.DSH_AGENTS_HOME = previousAgentsHome;
  await rm(root, { recursive: true, force: true });
}
