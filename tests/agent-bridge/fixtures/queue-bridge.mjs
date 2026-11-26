// A provider whose turns end by themselves, with native history carrying client message IDs.
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
if (process.env.BRIDGE_LAUNCHES) appendFileSync(process.env.BRIDGE_LAUNCHES, "launch\n");
if (process.env.NATIVE_UNAVAILABLE && existsSync(process.env.NATIVE_UNAVAILABLE)) process.exit(1);
const output = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
let sequence = 0,
  turns = 0;
const sessions = new Map();
const callback = (threadId, deltas) =>
  output({ id: `callback:${++sequence}`, method: "thread/delta", params: { threadId, deltas } });
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.method) return;
  const p = request.params ?? {},
    reply = (result) => output({ id: request.id, result });
  if (request.method === "initialize") {
    reply(JSON.parse(process.env.HANDSHAKE));
    return;
  }
  if (request.method === "session/create") {
    sessions.set(p.threadId, []);
    output({
      id: `identity:${++sequence}`,
      method: "thread/identity",
      params: { threadId: p.threadId, providerThreadId: `native-${p.threadId}`, sessionRestorable: true },
    });
    reply({ thread: { id: `native-${p.threadId}` } });
    return;
  }
  if (request.method === "session/adopt") {
    if (process.env.REFUSE_DUPLICATE_ADOPTION && sessions.has(p.threadId)) {
      output({ id: request.id, error: { code: -32006, message: "Session already exists" } });
      return;
    }
    // A new provider process binds the session the Host recorded before restarting.
    appendFileSync(
      process.env.EXECUTIONS,
      `adopt:${p.providerThreadId}${process.env.GENERATION ? `@${process.env.GENERATION}` : ""}\n`,
    );
    sessions.set(p.threadId, []);
    output({
      id: `identity:${++sequence}`,
      method: "thread/identity",
      params: { threadId: p.threadId, providerThreadId: p.providerThreadId, sessionRestorable: true },
    });
    // Turns the Host held open died with the previous provider process.
    if (p.openTurns?.length)
      callback(
        p.threadId,
        p.openTurns.map((nativeTurnId) => ({
          op: "turn.close",
          nativeTurnId,
          status: "interrupted",
          scope: { threadId: p.threadId },
        })),
      );
    reply({ thread: { id: p.providerThreadId } });
    return;
  }
  if (request.method === "session/release" && process.env.NO_RELEASE) {
    output({ id: request.id, error: { code: -32601, message: "Unsupported bridge method" } });
    return;
  }
  if (request.method === "session/release") {
    // Handed to another provider generation; nothing ends.
    appendFileSync(process.env.EXECUTIONS, `release:${p.threadId}@${process.env.GENERATION ?? ""}\n`);
    sessions.delete(p.threadId);
    reply({});
    return;
  }
  if (request.method === "turn/start") {
    const id = `turn-${++turns}`,
      clientId = p.native?.clientUserMessageId,
      scope = { threadId: p.threadId };
    if (process.env.DROP_NATIVE_ON_INPUT && process.env.DROP_NATIVE_ON_INPUT === clientId) {
      appendFileSync(process.env.EXECUTIONS, clientId + "\n");
      if (process.env.EXIT_WITHOUT_NATIVE_FAULT) process.exit(1);
      else process.stderr.write("codex-native-fault:unknown:connection\n", () => process.exit(1));
      return;
    }
    const turn = {
      id,
      status: "inProgress",
      items: [{ type: "userMessage", id: `user-${id}`, clientId, content: p.native?.input }],
    };
    sessions.get(p.threadId)?.push(turn);
    appendFileSync(process.env.EXECUTIONS, clientId + "\n");
    callback(p.threadId, [{ op: "turn.open", nativeTurnId: id, scope }]);
    reply({ turn: { id } });
    setTimeout(
      () => {
        turn.status = "completed";
        callback(p.threadId, [{ op: "turn.close", nativeTurnId: id, status: "completed", scope }]);
      },
      Number(process.env.TURN_MS ?? 150),
    );
    return;
  }
  if (request.method === "session/archive" || request.method === "session/unarchive") {
    reply({});
    return;
  }
  if (request.method === "history/read") {
    if (process.env.HISTORY_READS) appendFileSync(process.env.HISTORY_READS, p.threadId + "\n");
    const nativeHistory = process.env.NATIVE_HISTORY
      ? JSON.parse(readFileSync(process.env.NATIVE_HISTORY, "utf8"))[`native-${p.threadId}`]
      : undefined;
    reply({ thread: { id: `native-${p.threadId}`, turns: nativeHistory ?? sessions.get(p.threadId) ?? [] } });
    return;
  }
  output({ id: request.id, error: { code: -32601, kind: "unsupported", message: "Unsupported fixture method" } });
});
