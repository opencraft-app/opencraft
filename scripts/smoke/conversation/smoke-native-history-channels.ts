import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { AppHostServer } from "@opencraft/app-host-server";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { WebSocketServer, WebSocket } from "ws";
import { chromium } from "playwright";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";

const root = process.env.OPENCRAFT_HISTORY_WEB_ROOT;
if (!root) throw Error("Set OPENCRAFT_HISTORY_WEB_ROOT to built or installed Web assets");
const output = process.env.OPENCRAFT_HISTORY_EVIDENCE ?? ".local/native-history-channels";
await mkdir(output, { recursive: true });
const methods: string[] = [], errors: string[] = [], responses: unknown[] = [];
let reads = 0, releaseRead: (() => void) | undefined, nativeSocket: WebSocket | undefined;
let observedRead!: () => void;
const readStarted = new Promise<void>(resolve => { observedRead = resolve; });
const thread = { id: "native-history-fixture", sessionId: "native-history-fixture", name: "Native history fixture", preview: "", cwd: "/fixture", path: "/fixture/history", createdAt: 2, updatedAt: 2, historyMode: "paginated", status: { type: "idle" }, turns: [] };
const physical = new WebSocketServer({ host: "127.0.0.1", port: 0 });
physical.on("connection", socket => socket.on("message", frame => {
  const request = JSON.parse(String(frame));
  if (request.method === undefined) { if (request.id !== undefined) responses.push(request); return; }
  if (request.id === undefined) return;
  methods.push(request.method);
  const send = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result }));
  if (request.method === "initialize") send({ codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "native-history-fixture", capabilities: { extensions: { "opencraft/read-history": { version: 1 } } } });
  else if (request.method === "thread/list") send({ data: [thread], nextCursor: null });
  else if (request.method === "thread/read") {
    reads++; nativeSocket = socket; releaseRead = () => send({ thread, initialTurnsPage: { data: [{ id: "current", status: "completed", itemsView: "full", error: null, items: [{ id: "answer", type: "agentMessage", text: "History finally available.", phase: "final_answer" }] }], nextCursor: null } }); observedRead();
  } else if (request.method === "model/list") send({ data: [{ id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true, inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: null }], nextCursor: null });
  else if (request.method === "config/read") send({ config: { model: "fixture", model_provider: "fixture" }, origins: {} });
  else send(request.method.endsWith("/list") ? { data: [], nextCursor: null } : {});
}));
await once(physical, "listening");
const url = `ws://127.0.0.1:${(physical.address() as { port: number }).port}`;
const appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server", createTransport: () => new WebSocketTransport({ url, createSocket: address => new WebSocket(address) as any }) });
const web = await createWorkbenchWebServer({ appHostServer: appHost, root, loopbackOnly: true, appServerTarget: url });
const address = await web.listen({ host: "127.0.0.1", port: 0 });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const question = (id: string, title: string) => nativeSocket!.send(JSON.stringify({ id, method: "item/tool/requestUserInput", params: { threadId: thread.id, turnId: "live", itemId: id, questions: [{ id: "choice", header: title, question: "Choose during history recovery?", isOther: false, isSecret: false, options: null }] } }));
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { (window as any).__name = (value: any) => value; localStorage.setItem("opencraft.appearance-theme", "light"); });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole("button", { name: /^Native history fixture(?:\s|$)/ }).click({ timeout: 30000 });
  await readStarted;
  question("native-question", "Recovery question");
  const card = page.getByRole("region", { name: "Recovery question" });
  await card.waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${output}/question-before-history.png` });
  await card.getByRole("textbox").fill("yes");
  await card.getByRole("button", { name: /^Submit/ }).click();
  await page.waitForFunction(() => !document.querySelector('[data-interaction-kind="question"][data-state="pending"]'), undefined, { timeout: 10000 });
  assert.equal(responses.length, 1); assert.deepEqual(responses[0], { id: "native-question", result: { answers: { choice: { answers: ["yes"] } } } });
  assert.equal(reads, 1); assert.equal(await page.getByText("History finally available.", { exact: true }).count(), 0);
  await page.screenshot({ path: `${output}/answered-before-history.png` });
  question("withdraw-question", "Withdrawal question");
  const withdrawal = page.getByRole("region", { name: "Withdrawal question" });
  await withdrawal.waitFor({ timeout: 10000 });
  nativeSocket!.send(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: thread.id, requestId: "withdraw-question" } }));
  await withdrawal.waitFor({ state: "detached", timeout: 10000 });
  assert.equal(responses.length, 1);
  releaseRead!();
  await page.getByText("History finally available.", { exact: true }).waitFor({ timeout: 10000 });
  assert.ok(!methods.some(method => ["thread/start", "thread/resume", "turn/start", "turn/steer"].includes(method)));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${output}/history-after-native-reply.png` });
  const result = { repliedBeforeHistory: true, withdrawnBeforeHistory: true, noExecutionMutation: true, reads, responses, methods, errors, boundary: "full Web app, loopback AppHost and synthetic physical native endpoint; no user engine or paid model" };
  await writeFile(`${output}/native-history.json`, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} catch (error) { await writeFile(`${output}/failure.json`, JSON.stringify({ error: String(error), reads, methods, responses, errors }, null, 2)); throw error; }
finally { await browser.close(); await web.close(); for (const socket of physical.clients) socket.terminate(); await new Promise<void>(resolve => physical.close(() => resolve())); }
