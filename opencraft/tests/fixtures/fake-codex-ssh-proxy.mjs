import { createServer } from "node:http";
import { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { execFileSync } from "node:child_process";

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
    case "model/list": return { data: [{
      id: "fixture-model", model: "fixture-model", displayName: "Remote model fixture",
      description: "Synthetic model; never invokes inference", hidden: false, isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Fixture" }],
      defaultReasoningEffort: "medium", inputModalities: ["text"], supportsPersonality: false,
      additionalSpeedTiers: [], serviceTiers: [],
    }], nextCursor: null };
    case "thread/list": return { data: process.env.FIXTURE_WORKBENCH_UI_EMPTY_HISTORY === "1" ? [] : [fixtureThread], nextCursor: null };
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
  ws.on("message", data => {
    const message = JSON.parse(data.toString());
    if (!message.method || message.id === undefined) return;
    if (workbenchFixture) process.send?.({ method: message.method, params: message.params });
    const result = (workbenchFixture ? workbenchResult(message) : undefined) ?? (message.method === "initialize" ? { userAgent: "fixture-codex", platform: "linux", codexHome: "/synthetic" }
      : message.method === "thread/resume" ? { thread: { id: message.params.threadId, status: { type: "idle" } } }
      : message.method === "thread/read" ? { thread: { id: message.params.threadId, status: { type: "idle" } } }
      : message.method === "thread/unsubscribe" ? { status: "unsubscribed" }
      : message.method === "thread/list" || message.method === "model/list" ? { data: [], nextCursor: null }
      : { echo: message.params });
    ws.send(JSON.stringify({ id: message.id, result }));
  });
});
