import { createServer } from "node:http";
import { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { execFileSync } from "node:child_process";
import { mkdir, lstat, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Authentication precedes the proxy marker, just as in actual OpenSSH. This
// avoids racing a synthetic askpass child against WebSocket-open cleanup.
if (process.env.FIXTURE_ASKPASS === "1") {
  const password = execFileSync(process.env.SSH_ASKPASS, [], { encoding: "utf8" });
  if (password !== "synthetic-password\n") process.exit(3);
}

const command = process.env.SSH_ORIGINAL_COMMAND ?? process.argv.at(-1) ?? "";
const marker = command.match(/(?:\\[0-7]{3}){8}/u)?.[0];
if (!marker) process.exit(2);
const bytes = Buffer.from([...marker.matchAll(/\\([0-7]{3})/gu)].map(match => parseInt(match[1], 8)));
process.stdout.write("synthetic login banner\n");
process.stdout.write(bytes.subarray(0, 3));
// Complete the sentinel before any HTTP response. Login output and upgrade
// bytes may share a chunk but cannot interleave inside the sentinel itself.
setTimeout(() => { process.stdout.write(bytes.subarray(3)); server.emit("connection", stream); }, 2);
const stream = new Duplex({
  read() { process.stdin.resume(); },
  write(data, _encoding, done) { process.stdout.write(data, done); },
  final(done) { done(); },
});
process.stdin.on("data", chunk => { if (!stream.push(chunk)) process.stdin.pause(); });
process.stdin.on("end", () => { stream.push(null); process.exit(0); });
stream.setTimeout = stream.setNoDelay = stream.setKeepAlive = () => stream;
const server = createServer();
const sockets = new WebSocketServer({ noServer: true, autoPong: process.env.FIXTURE_NO_PONG !== "1" });
const workbenchFixture = process.env.FIXTURE_WORKBENCH_UI === "1";
const activeFixture = process.env.FIXTURE_WORKBENCH_UI_ACTIVE === "1";
// Explicit OpenCraft Host fixture, distinct from native Codex capability projection.
const queueCapability = process.env.FIXTURE_WORKBENCH_QUEUE;
let queued = [];
let queueSequence = 0;
let releaseQueueAdd;
process.on("message", message => {
  if (message?.fixtureAction === "release-queue-add") releaseQueueAdd?.();
});
async function queueResult(message, ws) {
  if (!queueCapability) return undefined;
  const params = message.params ?? {};
  const changed = () => ws.send(JSON.stringify({ method: "thread/queue/changed", params: { threadId: "ssh-ui-thread" } }));
  switch (message.method) {
    case "initialize": return { userAgent: "fixture-opencraft-host", capabilities: { extensions: {
      "opencraft/method-access": { version: 1, methods: [
        "runtime/machine/read", "model/list", "thread/list", "threadSection/list", "thread/read", "thread/resume",
        "thread/turns/list", "thread/items/list", "thread/unsubscribe", "thread/loaded/list", "skills/list",
        "config/batchWrite", "config/read", "configRequirements/read", "permissionProfile/list",
        "fs/readDirectory", "fs/getMetadata", "turn/steer", "thread/queue/list", "thread/queue/add",
        "thread/queue/delete", ...(queueCapability === "v2" ? ["thread/queue/steer"] : []),
      ] },
      "opencraft/thread-queue": queueCapability === "v2"
        ? { version: 2, reorder: false, atomicSteer: true, perItemPause: false }
        : { version: 1, reorder: false },
    } } };
    case "thread/queue/list": return { data: queued, nextCursor: null };
    case "thread/queue/add": {
      const row = { id: `fixture-queue-${++queueSequence}`, input: params.input,
        clientUserMessageId: params.clientUserMessageId, createdAt: Date.now(), pausedReason: null };
      await new Promise(resolve => { releaseQueueAdd = resolve; });
      releaseQueueAdd = undefined;
      queued.push(row); changed();
      return { queuedSubmission: row };
    }
    case "thread/queue/delete": {
      const before = queued.length;
      queued = queued.filter(row => row.id !== params.queuedSubmissionId); changed();
      return { deleted: before !== queued.length };
    }
    case "thread/queue/steer": {
      if (queueCapability !== "v2" || params.expectedTurnId !== "fixture-turn"
        || !queued.some(row => row.id === params.queuedSubmissionId)) throw new Error("Invalid atomic queue command");
      queued = queued.filter(row => row.id !== params.queuedSubmissionId); changed();
      return { turnId: "fixture-turn" };
    }
    default: return undefined;
  }
}
const nativeGoals = process.env.FIXTURE_NATIVE_GOALS;
let nativeGoal = { threadId: "ssh-ui-thread", objective: "Existing remote goal", status: "active",
  tokenBudget: null, tokensUsed: 731, timeUsedSeconds: 82,
  createdAt: Math.floor(Date.now() / 1000) - 82, updatedAt: Math.floor(Date.now() / 1000) };
const attachmentRoot = process.env.FIXTURE_ATTACHMENT_ROOT;
const attachmentHistoryFile = attachmentRoot ? join(attachmentRoot, "fixture-history.json") : null;
const attachmentHistory = new Map(attachmentHistoryFile && existsSync(attachmentHistoryFile) ? JSON.parse(readFileSync(attachmentHistoryFile, "utf8")) : []);
async function attachmentResult(message) {
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize": return { userAgent: "fixture-codex", codexHome: attachmentRoot, platformFamily: "unix", platformOs: "linux" };
    case "fs/createDirectory": await mkdir(params.path, { recursive: params.recursive !== false }); return {};
    case "fs/getMetadata": {
      const info = await lstat(params.path);
      return { isFile: info.isFile(), isDirectory: info.isDirectory(), isSymlink: info.isSymbolicLink(), createdAtMs: 0, modifiedAtMs: 0 };
    }
    case "fs/writeFile":
      if (params.dataBase64.length > 14 * 1024 * 1024) throw new Error("Fixture RPC file too large");
      await writeFile(params.path, Buffer.from(params.dataBase64, "base64")); return {};
    case "fs/readFile": return { dataBase64: (await readFile(params.path)).toString("base64") };
    case "fs/remove": await rm(params.path, { recursive: params.recursive !== false, force: params.force !== false }); return {};
    case "thread/start": return { thread: { ...fixtureThread, id: "attachment-thread" }, model: "fixture-model", modelProvider: "openai" };
    case "turn/start": {
      const item = { type: "userMessage", id: `user-${params.clientUserMessageId}`, clientId: params.clientUserMessageId, content: params.input };
      const rows = attachmentHistory.get(params.threadId) ?? [];
      rows.push({ turnId: "attachment-turn", item }); attachmentHistory.set(params.threadId, rows);
      await writeFile(attachmentHistoryFile, JSON.stringify([...attachmentHistory]));
      return { turn: { id: "attachment-turn", status: "inProgress", items: [item] } };
    }
    case "thread/items/list": return { data: attachmentHistory.get(params.threadId) ?? [], nextCursor: null, backwardsCursor: null };
    case "thread/fork": {
      attachmentHistory.set("attachment-fork", attachmentHistory.get(params.threadId) ?? []);
      await writeFile(attachmentHistoryFile, JSON.stringify([...attachmentHistory]));
      return { thread: { ...fixtureThread, id: "attachment-fork" } };
    }
    default: return undefined;
  }
}
const fixtureThread = {
  id: "ssh-ui-thread", sessionId: "ssh-ui-thread", name: "Remote history fixture",
  preview: "Remote history fixture", modelProvider: "openai", model: "fixture-model",
  cwd: "/remote", createdAt: 1_800_000_000, updatedAt: 1_800_000_001,
  status: activeFixture ? { type: "active", activeFlags: [] } : { type: "idle" }, turns: [], source: "appServer", cliVersion: "fixture",
  historyMode: "paginated",
};
const fixtureHistory = { ...fixtureThread, turns: [{
  id: "fixture-turn", status: activeFixture ? "inProgress" : "completed", error: null, startedAt: 1_800_000_000,
  completedAt: activeFixture ? null : 1_800_000_001, durationMs: activeFixture ? null : 1000,
  itemsView: "full",
  items: [
    { type: "userMessage", id: "fixture-user", clientId: null, content: [{ type: "text", text: "Historical remote question", text_elements: [] }] },
    { type: "agentMessage", id: "fixture-answer", text: "Historical remote answer", phase: activeFixture ? "commentary" : "final_answer", memoryCitation: null, delivery: null, questions: null },
  ],
}] };
const olderTurn = { ...fixtureHistory.turns[0], id: "fixture-older-turn", status: "completed", startedAt: 1_799_999_998,
  completedAt: 1_799_999_999, durationMs: 1000, items: [
    { ...fixtureHistory.turns[0].items[0], id: "fixture-older-user", content: [{ type: "text", text: "Older remote question", text_elements: [] }] },
    { ...fixtureHistory.turns[0].items[1], id: "fixture-older-answer", text: "Older remote answer", phase: "final_answer" },
  ] };
function workbenchResult(message) {
  switch (message.method) {
    case "runtime/machine/read": return { machine: {
      machineId: process.env.FIXTURE_WORKBENCH_MACHINE === "ssh:fixture"
        ? "22345678-1234-4123-8123-123456789abc" : "12345678-1234-4123-8123-123456789abc",
      name: process.env.FIXTURE_WORKBENCH_MACHINE === "ssh:fixture" ? "Remote UI fixture" : "Local UI fixture",
      platform: "linux",
    }, agent: "Codex" };
    case "model/list": return { data: [{
      id: "fixture-model", model: "fixture-model", displayName: "Remote model fixture",
      description: "Synthetic model; never invokes inference", hidden: false, isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Fixture" }],
      defaultReasoningEffort: "medium", inputModalities: ["text"], supportsPersonality: false,
      additionalSpeedTiers: [], serviceTiers: [],
    }], nextCursor: null };
    case "thread/search": return { data: [{ thread: fixtureThread, snippet: "Historical remote answer" }], nextCursor: null, backwardsCursor: null };
    case "thread/searchOccurrences": return { data: [{ turnId: "fixture-turn", itemId: "fixture-answer", snippet: "Historical remote answer", snippetMatchRange: { start: 0, end: 10 }, turnCursor: "fixture-latest" }], nextCursor: null };
    case "thread/list": return { data: process.env.FIXTURE_WORKBENCH_UI_EMPTY_HISTORY === "1" ? [] : [fixtureThread], nextCursor: null };
    case "threadSection/list": return { data: [], nextCursor: null };
    case "thread/read": return { thread: fixtureHistory };
    case "thread/resume": return { thread: { ...fixtureThread, turns: [] }, model: "fixture-model", modelProvider: "openai",
      cwd: "/remote", runtimeWorkspaceRoots: ["/remote"], instructionSources: [],
      serviceTier: null, disabledPluginIds: [], approvalPolicy: "never", approvalsReviewer: "user",
      sandbox: { type: "readOnly" }, activePermissionProfile: null, reasoningEffort: "medium",
      collaborationMode: null, multiAgentMode: "explicitRequestOnly", initialTurnsPage: null,
      turnsBackwardsCursor: "fixture-latest", itemsBackwardsCursor: null };
    case "thread/turns/list": return { data: [(message.params.cursor === "fixture-older" ? olderTurn : fixtureHistory.turns[0])].map(turn => ({ ...turn, items: [], itemsView: "notLoaded" })),
      nextCursor: message.params.cursor === "fixture-older" ? null : "fixture-older", backwardsCursor: null };
    case "thread/items/list": {
      const turn = message.params.turnId === olderTurn.id ? olderTurn : fixtureHistory.turns[0];
      return { data: (message.params.sortDirection === "desc" ? [...turn.items].reverse() : turn.items).map(item => ({ turnId: turn.id, item })), nextCursor: null, backwardsCursor: null };
    }
    case "skills/list": return { data: [{ cwd: "/remote", skills: [], errors: [] }] };
    case "turn/steer": return activeFixture ? { turnId: "fixture-turn" } : undefined;
    case "config/batchWrite": return { status: "ok", version: "fixture-version", filePath: "/synthetic/config.toml", overriddenMetadata: null };
    case "thread/loaded/list": return { data: [] };
    case "config/read": return { config: { model: "fixture-model", model_provider: "openai" }, origins: {}, layers: null };
    case "configRequirements/read": return { requirements: null };
    case "permissionProfile/list": return { data: [] };
    case "fs/readDirectory": return { entries: [{ fileName: "project", isDirectory: true, isFile: false }] };
    case "fs/getMetadata": return { isDirectory: true, isFile: false, isSymlink: false, createdAtMs: 0, modifiedAtMs: 0 };
    default: return undefined;
  }
}
server.on("upgrade", (request, socket, head) => {
  if (process.env.FIXTURE_BAD_UPGRADE === "1") { socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"); return; }
  sockets.handleUpgrade(request, socket, head, ws => sockets.emit("connection", ws));
});
sockets.on("connection", ws => {
  if (process.env.FIXTURE_LARGE_HISTORY === "1") ws.send(JSON.stringify({ data: "x".repeat(17 * 1024 * 1024) }));
  if (process.env.FIXTURE_OVERSIZED_RPC === "1") ws.send(JSON.stringify({ data: "x".repeat(1024) }));
  ws.on("message", async data => {
    const message = JSON.parse(data.toString());
    if (!message.method || message.id === undefined) return;
    const reply = payload => ws.send(JSON.stringify({ ...payload,
      ...(queueCapability ? { __opencraftClient: message.__opencraftClient } : {}),
    }));
    if (workbenchFixture || attachmentRoot) process.send?.({ method: message.method, params: message.params });
    if (workbenchFixture && message.method.startsWith("project/")) {
      reply({ id: message.id, error: { code: -32601, message: "Fixture has directories, not the Project API" } });
      return;
    }
    if (process.env.FIXTURE_PARTICIPANT_HISTORY === "1" && message.method === "thread/items/list") {
      process.send?.({ method: message.method, params: message.params });
      if (message.params.threadId === "hung") return;
      if (message.params.threadId === "rejected") {
        ws.send(JSON.stringify({ id: message.id, error: { code: -32601, message: "Fixture history rejected" } })); return;
      }
      ws.send(JSON.stringify({ id: message.id, result: {
        data: [{ item: { type: "userMessage", clientId: message.params.cursor ? "m2" : "m1" } }],
        nextCursor: message.params.cursor ? null : "second-page",
      } })); return;
    }
    try {
    if (message.method === "experimentalFeature/list" && nativeGoals) {
      if (nativeGoals === "unsupported") {
        ws.send(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unknown method" } })); return;
      }
      if (nativeGoals === "delayed") await new Promise(resolve => setTimeout(resolve, 300));
      ws.send(JSON.stringify({ id: message.id, result: { data: [{ name: "goals", enabled: nativeGoals !== "disabled" }], nextCursor: null } })); return;
    }
    if (nativeGoals && message.method.startsWith("thread/goal/")) {
      if (message.method === "thread/goal/get") {
        ws.send(JSON.stringify({ id: message.id, result: { goal: nativeGoal } }));
        // Reproduce a native completion after hydration: the bridge must not
        // add a second autonomous Goal continuation on the remote Server.
        ws.send(JSON.stringify({ method: "turn/completed", params: { threadId: "ssh-ui-thread",
          turn: { id: "native-goal-turn", status: "completed", items: [], error: null } } }));
      } else if (message.method === "thread/goal/set") {
        nativeGoal = { ...nativeGoal, ...message.params };
        ws.send(JSON.stringify({ id: message.id, result: { goal: nativeGoal } }));
        ws.send(JSON.stringify({ method: "thread/goal/updated", params: { threadId: "ssh-ui-thread", goal: nativeGoal } }));
      } else {
        nativeGoal = null;
        ws.send(JSON.stringify({ id: message.id, result: { cleared: true } }));
        ws.send(JSON.stringify({ method: "thread/goal/cleared", params: { threadId: "ssh-ui-thread" } }));
      }
      return;
    }
    const result = await queueResult(message, ws) ?? (attachmentRoot ? await attachmentResult(message) : undefined) ?? (workbenchFixture ? workbenchResult(message) : undefined) ?? (message.method === "initialize" ? { userAgent: "fixture-codex", platform: "linux", codexHome: "/synthetic" }
      : message.method === "thread/resume" ? { thread: { id: message.params.threadId, status: { type: "idle" } } }
      : message.method === "thread/read" ? { thread: { id: message.params.threadId, status: { type: "idle" } } }
      : message.method === "thread/unsubscribe" ? { status: "unsubscribed" }
      : message.method === "thread/list" || message.method === "model/list" ? { data: [], nextCursor: null }
      : { echo: message.params });
    reply({ id: message.id, result });
    } catch (error) { reply({ id: message.id, error: { code: -32000, message: error.message } }); }
  });
});
