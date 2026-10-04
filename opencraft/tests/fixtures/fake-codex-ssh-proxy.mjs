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
const fixtureThread = {
  id: "ssh-ui-thread", sessionId: "ssh-ui-thread", name: "Remote history fixture",
  preview: "Remote history fixture", modelProvider: "openai", model: "fixture-model",
  cwd: "/remote", createdAt: 1_800_000_000, updatedAt: 1_800_000_001,
  status: { type: "idle" }, turns: [], source: "appServer", cliVersion: "fixture",
};
const fixtureHistory = { ...fixtureThread, turns: [{
  id: "fixture-turn", status: "completed", error: null, startedAt: 1_800_000_000,
  completedAt: 1_800_000_001, durationMs: 1000,
  itemsView: "full",
  items: [
    { type: "userMessage", id: "fixture-user", clientId: null, content: [{ type: "text", text: "Historical remote question", text_elements: [] }] },
    { type: "agentMessage", id: "fixture-answer", text: "Historical remote answer", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
  ],
}] };
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
    case "thread/resume": return { thread: fixtureHistory, model: "fixture-model", modelProvider: "openai",
      cwd: "/remote", runtimeWorkspaceRoots: ["/remote"], instructionSources: [],
      serviceTier: null, disabledPluginIds: [], approvalPolicy: "never", approvalsReviewer: "user",
      sandbox: { type: "readOnly" }, activePermissionProfile: null, reasoningEffort: "medium",
      collaborationMode: null, multiAgentMode: "explicitRequestOnly", initialTurnsPage: null,
      turnsBackwardsCursor: null, itemsBackwardsCursor: null };
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
