import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DshSupervisor } from "../apps/local-agent-host/src/dsh-supervisor.js";
import { DshClient } from "../apps/local-agent-host/src/dsh-client.js";
import { createServer } from "node:http";
import { DshModelEngineAdapter } from "../apps/local-agent-host/src/model-config/dsh-adapter.js";
import { OPENCRAFT_BROWSER_DYNAMIC_TOOLS } from "../packages/browser-appserver/src/dynamic-tools.js";
import { OPENCRAFT_TERMINAL_DYNAMIC_TOOLS } from "../packages/workbench-runtime/src/conversation-terminal-tools.js";
import { OPENCRAFT_CONNECTOR_DYNAMIC_TOOLS } from "../packages/workbench-runtime/src/connectors/dynamic-tools.js";
import { DshCapabilityBroker } from "../apps/local-agent-host/src/dsh-capability-broker.js";
const root = await mkdtemp(join(tmpdir(), "dsh-capability-plugin-"));
const originalNodeOptions = process.env.NODE_OPTIONS;
if (process.env.OPENCRAFT_DSH_CRASH_CHECKPOINT === "1") {
  process.env.NODE_OPTIONS = [originalNodeOptions, "--import=" + pathToFileURL(resolve("tests/fixtures/dsh-checkpoint-crash.cjs")).href].filter(Boolean).join(" ");
  process.env.OPENCRAFT_TEST_CHECKPOINT_ROOT = join(root, "checkpoints");
  process.env.OPENCRAFT_TEST_CHECKPOINT_ARM = join(root, "arm-checkpoint-crash");
}
const token = randomBytes(32).toString("hex");
const patch = join(root, "capability-patch.json");
await writeFile(patch, JSON.stringify([{ insert: [{ id: "opencraft-capability", name: resolve("apps/local-agent-host/src/dsh-capability-plugin.mjs"), config: {
  token, skillsRoot: join(root, "skills"), checkpointRoot: join(root, "checkpoints"), toolsModuleUrl: pathToFileURL(resolve("runtime/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js")).href,
} }] }]), { mode: 0o600 });
let bridge: string | undefined;
let modelCalls = 0;
let enforcementRequested = false;
let enforcementResult = false;
const model = createServer(async (req, res) => {
  let raw = ""; for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  const base = { id: "fixture", created: 1, model: "fixture" };
  if (!body.stream) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }] }));
    return;
  }
  const isAgent = Array.isArray(body.tools) && body.tools.length > 0;
  if (isAgent && JSON.stringify(body.messages).includes("ENFORCE_READ_ONLY")) {
    const invoke = !enforcementRequested;
    enforcementRequested = true;
    if (!invoke) enforcementResult = true;
    const value = invoke ? { role: "assistant", tool_calls: [{ index: 0, id: "readonly-call", type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: `printf forbidden > '${join(root, "must-not-write.txt")}'` }) } }] }
      : { role: "assistant", content: "read-only-check-done" };
    res.setHeader("content-type", "text/event-stream");
    const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.end(chunk(value) + chunk({}, invoke ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    return;
  }
  if (isAgent) modelCalls++;
  const invoke = isAgent && modelCalls === 1;
  if (invoke) assert.ok(body.tools.some((tool: any) => tool.function?.name === "fixture_capability"), "registered tool reaches actual model schema");
  res.setHeader("content-type", "text/event-stream");
  const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.end(chunk(invoke ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: "fixture_capability", arguments: "{}" } }] } : { role: "assistant", content: "fixture done" }) + chunk({}, invoke ? "tool_calls" : "stop") + "data: [DONE]\n\n");
});
await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
const supervisor = new DshSupervisor({ executable: resolve("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"), dataDirectory: join(root, "runtime"),
  patches: [patch], onCapabilityBridge: url => { bridge = url; } });
try {
  const url = await supervisor.start();
  const deadline = Date.now() + 10000;
  while (!bridge && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(bridge, "capability plugin starts in the real DSH loader");
  const client = new DshClient(url);
  const querySkills = async (sessionId?: string, forceReload = false) => {
    const response = await fetch(bridge + "/skills", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ sessionId, cwd: root, forceReload }) });
    assert.equal(response.status, 200);
    return await response.json() as any;
  };
  const emptyCatalog = await querySkills(undefined, true);
  assert.equal(emptyCatalog.cwd, root);
  assert.ok(Array.isArray(emptyCatalog.skills));
  await new DshModelEngineAdapter(client).apply({ schemaVersion: 1, revision: 0,
    providers: [{ id: "fixture-provider", name: "Fixture", protocol: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as {port:number}).port}/v1`, credentialRef: "FIXTURE", enabled: true, models: [{ id: "fixture", enabled: true }] }],
    defaultModel: { providerId: "fixture-provider", modelId: "fixture" },
  }, { resolve: async () => "synthetic-key" });
  const createWithCapabilities = async (sessionId: string, capabilities: unknown[]) => {
    const response = await fetch(bridge + "/thread/create", {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ sessionId, cwd: root, provider: "fixture-provider", model: "fixture", capabilities }),
    });
    return { status: response.status, result: await response.json() };
  };
  const invalidCreation = await createWithCapabilities("invalid-capability-creation", [{
    id: "invalid", name: "invalid", description: "invalid", inputSchema: { type: "not-a-type" },
  }]);
  assert.equal(invalidCreation.status, 400);
  const afterFailure = await client.call<{ items: Array<{ sessionId: string }> }>("session.list");
  assert.equal(afterFailure.items.some(item => item.sessionId === "invalid-capability-creation"), false,
    "failed setup must not publish a native session");
  const initialCapability = { id: "initial", name: "initial_tool", description: "initial", inputSchema: { type: "object", properties: {} } };
  const createdWithCapabilities = await createWithCapabilities("prepared-capability-creation", [initialCapability]);
  assert.equal(createdWithCapabilities.status, 200, JSON.stringify(createdWithCapabilities.result));
  const reattach = await fetch(bridge + "/register", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "prepared-capability-creation", capabilities: [initialCapability] }),
  });
  assert.equal(reattach.status, 200, "initial setup mount is idempotent on attachment");
  const session = await client.call<{sessionId: string}>("session.create", { cwd: root });
  await querySkills(session.sessionId);
  const localSkill = join(root, ".agents", "skills", "fresh-skill");
  await mkdir(localSkill, { recursive: true });
  await writeFile(join(localSkill, "SKILL.md"), "---\nname: fresh-skill\ndescription: Synthetic refresh fixture\n---\nFresh instructions.", { mode: 0o600 });
  const refreshed = await querySkills(session.sessionId, true);
  assert.ok(refreshed.skills.some((skill: any) => skill.name === "fresh-skill" && skill.scope === "repo"), "forceReload discovers a newly written real project skill");
  const beforeConversation = await querySkills(undefined, true);
  assert.ok(beforeConversation.skills.some((skill: any) => skill.name === "fresh-skill"), "cwd skill discovery does not require a conversation");
  const modelCatalog = await client.call<{skills: Array<{name:string}>}>("skill.list", { sessionId: session.sessionId });
  assert.ok(modelCatalog.skills.some(skill => skill.name === "fresh-skill"), "native model skill catalog observes the same project skill");
  const denied = await fetch(bridge + "/events");
  assert.equal(denied.status, 401);
  const workbenchCapabilities = new DshCapabilityBroker().register(session.sessionId, { connectionId: "fixture", identity: { id: "fixture", username: "fixture" } }, [
    ...OPENCRAFT_BROWSER_DYNAMIC_TOOLS,
    ...OPENCRAFT_TERMINAL_DYNAMIC_TOOLS,
    ...OPENCRAFT_CONNECTOR_DYNAMIC_TOOLS,
  ], () => {});
  const registerBody = JSON.stringify({ sessionId: session.sessionId, capabilities: [...workbenchCapabilities, { id: "fixture", name: "fixture_capability", description: "Fixture capability", inputSchema: { type: "object", properties: {} } }] });
  const registrations = await Promise.all([1, 2].map(() => fetch(bridge + "/register", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: registerBody,
  })));
  assert.deepEqual(
    registrations.map(response => response.status),
    [200, 200],
    `same-session registration must be idempotent: ${await Promise.all(registrations.map(response => response.text()))}`,
  );
  const skills = await fetch(bridge + "/skills", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: session.sessionId, cwd: root }) }).then(response => response.json()) as any;
  assert.ok(skills.skills.some((skill: any) => skill.name === "opencraft-host-tools" && skill.path.endsWith("/SKILL.md")));
  const nativeSkills = await client.call<{skills: Array<{name:string}>}>("skill.list", { sessionId: session.sessionId });
  assert.ok(nativeSkills.skills.some(skill => skill.name === "opencraft-host-tools"), "skill enters native model-facing catalog");
  await client.call("session.prompt", { sessionId: session.sessionId, mode: "queue", content: [{ type: "text", text: "Use fixture_capability." }] });
  let capabilityCalled = false;
  const until = Date.now() + 15000;
  while (Date.now() < until && modelCalls < 2) {
    const response = await fetch(bridge + "/events", { headers: { authorization: "Bearer " + token } });
    const batch = await response.json() as {events: any[]};
    for (const event of batch.events) if (event.type === "capability-request") {
      assert.equal(event.sessionId, session.sessionId);
      assert.equal(event.capabilityId, "fixture");
      capabilityCalled = true;
      const result = await fetch(bridge + "/respond", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ id: event.id, sessionId: event.sessionId, result: { success: true, contentItems: [{ type: "inputText", text: "host capability completed" }] } }) });
      assert.equal(result.status, 200);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(capabilityCalled, "real DSH invoked host capability");
  assert.ok(modelCalls >= 2, "tool result continued through the model loop");
  await new Promise(resolve => setTimeout(resolve, 150));
  const control = async (path: string, body: unknown) => {
    const response = await fetch(bridge + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  const checkpoint = await control("/checkpoint", { sessionId: session.sessionId });
  assert.ok(checkpoint.capturedThroughSeq >= 0);
  const generation = await control("/generation", { logicalSessionId: session.sessionId, sourceSessionId: session.sessionId, cwd: root, provider: "fixture-provider", model: "fixture" });
  assert.equal(generation.sessionId, session.sessionId + ".g1");
  const restored = await client.call<any>("session.history", { sessionId: generation.sessionId, maxMessages: 100 });
  assert.ok(restored.events.some((entry: any) => entry.event.type === "tool/result"));
  assert.ok(restored.events.some((entry: any) => entry.event.type === "assistant/message"));
  const raced = await Promise.all([1, 2].map(() => fetch(bridge + "/generation", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ logicalSessionId: session.sessionId, sourceSessionId: generation.sessionId, cwd: root, provider: "fixture-provider", model: "fixture" }),
  }).then(async response => ({ status: response.status, body: await response.json() as any }))));
  assert.deepEqual(raced.map(result => result.status).sort(), [200, 400], "only one concurrent transition may publish a new generation");
  assert.equal(raced.find(result => result.status === 200)!.body.sessionId, session.sessionId + ".g2");
  await fetch(bridge + "/unregister", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: session.sessionId }) });
  const after = await client.call<{skills: Array<{name:string}>}>("skill.list", { sessionId: session.sessionId });
  assert.equal(after.skills.some(skill => skill.name === "opencraft-host-tools"), false, "unregister revokes scoped skill");
  await supervisor.stop();
  bridge = undefined;
  const restartedUrl = await supervisor.start();
  const recoveryDeadline = Date.now() + 10000;
  while (!bridge && Date.now() < recoveryDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(bridge);
  const resolved = await control("/resolve-generation", { logicalSessionId: session.sessionId });
  assert.equal(resolved.sessionId, session.sessionId + ".g2");
  assert.equal(resolved.generation, 2);
  const recovered = await new DshClient(restartedUrl).call<any>("session.history", { sessionId: resolved.sessionId, maxMessages: 100 });
  assert.ok(recovered.events.some((entry: any) => entry.event.type === "tool/result"), "published generation survives actual engine restart");
  await new DshClient(restartedUrl).call("session.models", { sessionId: resolved.sessionId });
  const policy = await control("/permissions", { sessionId: resolved.sessionId });
  assert.ok(["ask", "never"].includes(policy.approval));
  assert.ok(policy.presets.some((preset: any) => preset.id === policy.preset));
  const alternate = policy.presets.find((preset: any) => preset.id !== policy.preset);
  assert.ok(alternate);
  const changed = await control("/permissions", { sessionId: resolved.sessionId, preset: alternate.id });
  assert.equal(changed.preset, alternate.id);
  assert.equal(changed.sandbox.mode, alternate.sandbox);
  assert.equal(changed.approval, alternate.approval);
  await control("/permissions", { sessionId: resolved.sessionId, preset: policy.preset });
  const custom = await control("/permissions", { sessionId: resolved.sessionId, policy: { mode: "read-only", approval: "never" } });
  assert.equal(custom.sandbox.mode, "read-only");
  assert.equal(custom.approval, "never");
  await control("/checkpoint", { sessionId: resolved.sessionId });
  const nextGeneration = await control("/generation", { logicalSessionId: session.sessionId, sourceSessionId: resolved.sessionId, cwd: root, provider: "fixture-provider", model: "fixture" });
  const restoredCustom = await control("/permissions", { sessionId: nextGeneration.sessionId });
  assert.equal(restoredCustom.sandbox.mode, "read-only");
  assert.equal(restoredCustom.approval, "never");
  await new DshClient(restartedUrl).call("session.prompt", { sessionId: nextGeneration.sessionId, mode: "queue", content: [{ type: "text", text: "ENFORCE_READ_ONLY" }] });
  const policyDeadline = Date.now() + 15000;
  while (!enforcementResult && Date.now() < policyDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (!enforcementResult) {
    const diagnostic = await new DshClient(restartedUrl).call<any>("session.history", { sessionId: nextGeneration.sessionId, maxMessages: 100 });
    console.log("Readonly diagnostic", { enforcementRequested, events: diagnostic.events.slice(-8).map((entry: any) => ({ type: entry.event.type, reason: entry.event.data?.reason })) });
  }
  assert.ok(enforcementResult, "model received the actual sandboxed tool result");
  await assert.rejects(access(join(root, "must-not-write.txt")), "read-only effective policy prevents a real write in the test workspace");
  if (process.env.OPENCRAFT_DSH_CRASH_CHECKPOINT === "1") {
    await control("/checkpoint", { sessionId: nextGeneration.sessionId });
    await writeFile(join(root, "arm-checkpoint-crash"), "armed", { mode: 0o600 });
    const killedPid = supervisor.processId;
    await assert.rejects(control("/generation", { logicalSessionId: session.sessionId, sourceSessionId: nextGeneration.sessionId,
      cwd: root, provider: "fixture-provider", model: "fixture" }), /fetch|socket|closed/i);
    const exitDeadline = Date.now() + 5000;
    while (supervisor.processId !== null && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(supervisor.processId, null);
    bridge = undefined;
    const restoredUrl = await supervisor.start();
    assert.notEqual(supervisor.processId, killedPid);
    const readyDeadline = Date.now() + 10000;
    while (!bridge && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    const recoveredIntent = await control("/resolve-generation", { logicalSessionId: session.sessionId });
    assert.equal(recoveredIntent.generation, nextGeneration.generation + 1);
    const restoredHistory = await new DshClient(restoredUrl).call<any>("session.history", { sessionId: recoveredIntent.sessionId, maxMessages: 100 });
    assert.ok(restoredHistory.events.some((entry: any) => entry.event.type === "tool/result"));
    console.log("Actual SIGKILL between native flush and checkpoint commit: persisted intent recovered one generation and its tool history.");
  }
  console.log("Real DSH loader: auth enforced; scoped tool schema reaches model; actual Agent capability request/host return resumes the model loop.");
} finally {
  await supervisor.stop();
  if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalNodeOptions;
  delete process.env.OPENCRAFT_TEST_CHECKPOINT_ROOT; delete process.env.OPENCRAFT_TEST_CHECKPOINT_ARM;
  model.closeAllConnections(); await new Promise<void>(resolve => model.close(()=>resolve())); await rm(root, { recursive: true, force: true });
}
