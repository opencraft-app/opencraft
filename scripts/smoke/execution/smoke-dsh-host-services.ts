import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { startLocalAgentHost } from "../../../apps/local-agent-host/src/main.js";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../../../apps/local-agent-host/src/model-config/repository.js";

// Real locked native engine and Host; inference uses this isolated local fixture.
const root = await mkdtemp(join(tmpdir(), "opencraft-host-services-"));
let host: any, socket: WebSocket | undefined, seq = 0, backgroundStarted = false, planAsked = false, reviewAsked = false;
let calls = 0, scheduledInputs = 0, backgroundWake = false;
const notes: any[] = [], pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const endpoint = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); calls++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta = (value: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
  const tool = (name: string, args: unknown) => {
    assert.ok(body.tools?.some((item: any) => item.function.name === name), `Missing native tool ${name}`);
    delta({ role: "assistant", tool_calls: [{ index: 0, id: `call-${calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }); delta({}, "tool_calls");
  };
  const text = JSON.stringify(body.messages.filter((item: any) => item.role === "user").map((item: any) => item.content));
  if (body.tools?.length && text.includes("BACKGROUND_FIXTURE") && !backgroundStarted) {
    backgroundStarted = true; tool("bash", { description: "Complete the isolated background fixture command", command: "sleep 2; printf 'fixture-background-complete'", run_in_background: true });
  } else if (body.tools?.length && text.includes("PLAN_FIXTURE") && !planAsked) {
    planAsked = true; tool("ask_user_question", { questions: [{ id: "selection", question: "Choose fixture steps", multi_select: true, options: [{ label: "Verify", description: "Check the result" }, { label: "Deliver", description: "Finish" }] }] });
  } else if (body.tools?.length && text.includes("REVIEW_FIXTURE") && !reviewAsked) {
    reviewAsked = true; tool("exit_plan_mode", { plan: "# Complete fixture plan\n\nFirst **verify**, then deliver." });
  } else {
    if (body.tools?.length && text.includes("[Scheduled task]")) scheduledInputs++;
    if (text.includes("background job") && text.includes("completed")) backgroundWake = true;
    delta({ role: "assistant", content: "fixture verified" }, "stop");
  }
  res.end("data: [DONE]\n\n");
});
const call = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
  const id = String(++seq), timer = setTimeout(() => { pending.delete(id); reject(Error(`Timed out: ${method}`)); }, 30000);
  pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
});
const wait = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 30000;
  while (!predicate()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 25)); }
};
const packaged = process.env.OPENCRAFT_DSH_FIXTURE_HOST_MODULE;
// The locked API package documents slash commands but its shipped prompt path
// does not dispatch them. A fixture-only composition seeds native plan state;
// production plugin bytes remain untouched, including when testing a fixed bundle.
const pluginSource = packaged ? join(dirname(resolve(packaged)), "dsh-capability-plugin.mjs") : resolve("apps/local-agent-host/src/dsh-capability-plugin.mjs");
const fixturePlugin = join(root, "fixture-plugin.mjs");
await writeFile(fixturePlugin, `import { apply as ownedApply, inject as ownedInject } from ${JSON.stringify(pathToFileURL(pluginSource).href)};
export const inject = ownedInject;
export async function apply(ctx, config) {
  ctx.on("agent/created", ({agent}) => agent.session.append("plan/mode", {active: true}));
  return ownedApply(ctx, config);
}
`);
for (const file of ["dsh-thread-persistence-plugin.mjs", "dsh-thread-projection-plugin.mjs"])
  await symlink(join(dirname(pluginSource), file), join(root, file));
const launch = packaged ? (await import(pathToFileURL(resolve(packaged)).href)).startIndependentDshHost : startLocalAgentHost;
const start = async () => {
  host = await launch({ dataDirectory: join(root, "runtime"), modelStorageDirectory: join(root, "models"),
    descriptorPath: join(root, "connection.json"),
    dshExecutable: resolve("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    dshCapabilityPlugin: fixturePlugin });
  socket = new WebSocket(host.websocketUrl);
  socket.on("message", raw => {
    const frame = JSON.parse(String(raw)), handler = pending.get(String(frame.id));
    if (handler) { pending.delete(String(frame.id)); clearTimeout(handler.timer); frame.error ? handler.reject(Error(frame.error.message)) : handler.resolve(frame.result); }
    else notes.push(frame);
  });
  await new Promise<void>(resolve => socket!.once("open", resolve));
  const init = await call("initialize", { clientInfo: { name: "host-services-fixture", version: "1" }, capabilities: {} });
  assert.equal(init.capabilities.extensions["opencraft/conversation-schedules"].version, 1);
  assert.equal(init.capabilities.extensions["opencraft/conversation-schedules"].summary, true);
};
try {
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  await new ModelCredentialRepository(join(root, "models")).set("FIXTURE", "synthetic");
  await new ModelConfigurationRepository(join(root, "models")).initialize({ schemaVersion: 1, revision: 0, providers: [{ id: "fixture", name: "Fixture", protocol: "openai-completions",
    baseUrl: `http://127.0.0.1:${(endpoint.address() as any).port}/v1`, credentialRef: "FIXTURE", enabled: true, models: [{ id: "fixture", enabled: true, input: ["text"] }] }], defaultModel: { providerId: "fixture", modelId: "fixture" } });
  await start(); const model = (await call("model/list")).data[0].model;
  const create = async () => (await call("thread/start", { cwd: root, model, permissions: "opencraft:permission-mode:full" })).thread.id;
  const threadId = await create();
  await call("opencraft/schedules/save", { threadId, expectedRevision: 0, prompt: "SCHEDULE_FIXTURE", nextRunAt: Date.now() + 1200, intervalMinutes: null, timeZone: "UTC" });
  // Browser disconnect and Host cold restart must retain the scheduled occurrence.
  socket!.terminate(); await host.close(); await start();
  await wait(() => scheduledInputs === 1, "cold scheduled execution");
  let view: any;
  const deadline = Date.now() + 25000;
  do { view = await call("opencraft/schedules/read", { threadId }); if (view.runs[0]?.state === "completed") break; assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 250)); } while (true);
  assert.equal(view.schedule.status, "completed"); assert.equal(view.runs.length, 1);
  socket!.terminate(); await host.close(); await start(); await new Promise(resolve => setTimeout(resolve, 2200)); assert.equal(scheduledInputs, 1);
  const background = await create();
  await call("turn/start", { threadId: background, model, input: [{ type: "text", text: "BACKGROUND_FIXTURE" }] });
  try { await wait(() => notes.filter(frame => frame.method === "turn/completed" && frame.params.threadId === background).length >= 2, "native background wake published"); }
  catch (error) {
    console.log(JSON.stringify({ fixtureDiagnostic: true, calls, backgroundStarted, backgroundWake,
      notifications: notes.filter(frame => frame.params?.threadId === background), history: await call("thread/read", { threadId: background, includeTurns: true }) }));
    throw error;
  }
  assert.equal(backgroundWake, true);
  const plan = await create();
  await call("turn/start", { threadId: plan, model, input: [{ type: "text", text: "PLAN_FIXTURE" }] });
  await wait(() => notes.some(frame => frame.method === "item/tool/requestUserInput" && frame.params.threadId === plan), "full native question");
  const question = notes.find(frame => frame.method === "item/tool/requestUserInput" && frame.params.threadId === plan);
  assert.equal(question.params.questions[0].multiSelect, true);
  socket!.send(JSON.stringify({ id: question.id, result: { answers: { selection: { answers: ["Verify", "Deliver"] } } } }));
  await wait(() => notes.some(frame => frame.method === "turn/completed" && frame.params.threadId === plan), "question response completes");
  const review = await create();
  await call("turn/start", { threadId: review, model, input: [{ type: "text", text: "REVIEW_FIXTURE" }] });
  try { await wait(() => notes.some(frame => frame.method === "item/tool/requestUserInput" && frame.params.threadId === review), "native plan review"); }
  catch (error) { console.log(JSON.stringify({ fixtureReviewDiagnostic: true, calls, reviewAsked,
    notifications: notes.filter(frame => frame.params?.threadId === review), history: await call("thread/read", { threadId: review, includeTurns: true }) })); throw error; }
  const decision = notes.find(frame => frame.method === "item/tool/requestUserInput" && frame.params.threadId === review);
  const item = decision.params.questions[0];
  assert.match(item.detail, /Complete fixture plan/); assert.equal(item.intent.kind, "plan-review");
  socket!.send(JSON.stringify({ id: decision.id, result: { answers: { [item.id]: { answers: [item.intent.approve] } } } }));
  await wait(() => notes.some(frame => frame.method === "turn/completed" && frame.params.threadId === review), "plan approval completes");
  console.log(JSON.stringify({ result: "passed", realLockedDsh: true, syntheticLocalInference: true, calls, coldSchedules: true, noDuplicateAfterRestart: true, backgroundWake: true, nativeMultiSelectDetail: true, planModeSetup: "fixture-only-native-session-event" }));
} finally {
  socket?.terminate(); for (const handler of pending.values()) clearTimeout(handler.timer);
  await host?.close(); await new Promise<void>(resolve => endpoint.close(() => resolve())); await rm(root, { recursive: true, force: true });
}
