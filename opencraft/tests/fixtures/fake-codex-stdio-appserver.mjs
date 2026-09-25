import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
let initialized = 0;
let nextServerRequestId = 901;
let nextTurnId = 1;
const turns = new Map();
const history = new Map();
const loadedThreads = new Set();
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
input.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    initialized += 1;
    send({ id: message.id, result: { codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "darwin", userAgent: "fake", serverInfo: { name: "fake-codex", version: String(initialized) }, ...(process.env.OPENCRAFT_TEST_NATIVE_QUEUE_STEER ? { opencraftQueueSteerVersion: Number(process.env.OPENCRAFT_TEST_NATIVE_QUEUE_STEER) } : {}) } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/read") {
    const active = turns.get(message.params.threadId);
    const type = !loadedThreads.has(message.params.threadId) ? "notLoaded" : active ? "active" : "idle";
    send({ id: message.id, result: { thread: { id: message.params.threadId, status: { type, ...(active ? { activeFlags: [] } : {}) }, turns: [] } } });
    return;
  }
  if (message.method === "thread/items/list") {
    const items = (history.get(message.params.threadId) ?? []).filter(entry => !message.params.turnId || entry.turnId === message.params.turnId);
    const offset = message.params.cursor ? Number(message.params.cursor) : 0;
    const limit = message.params.limit ?? 100;
    send({ id: message.id, result: { data: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null } });
    return;
  }
  if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    if (turns.has(threadId)) {
      send({ id: message.id, error: { code: -32600, message: "thread already has an active or pending turn" } });
      return;
    }
    const turnId = `turn-${nextTurnId++}`;
    turns.set(threadId, turnId);
    if (message.params.clientUserMessageId) {
      const entries = history.get(threadId) ?? [];
      entries.push({ turnId, item: { type: "userMessage", id: `user-${entries.length}`, clientId: message.params.clientUserMessageId, content: message.params.input } });
      history.set(threadId, entries);
    }
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
    return;
  }
  if (message.method === "turn/steer") {
    const threadId = message.params.threadId;
    const turnId = turns.get(threadId);
    if (!turnId) {
      send({ id: message.id, error: { code: -32600, message: "no active turn to steer" } });
      return;
    }
    if (turnId !== message.params.expectedTurnId) {
      send({ id: message.id, error: { code: -32600, message: `expected active turn id \`${message.params.expectedTurnId}\` but found \`${turnId}\`` } });
      return;
    }
    if (process.env.OPENCRAFT_TEST_STEER_RESPONSE === "ambiguous") {
      send({ id: message.id, error: { code: -32000, message: "connection lost after input might have been accepted" } });
      return;
    }
    if (message.params.clientUserMessageId) {
      const entries = history.get(threadId) ?? [];
      entries.push({ turnId, item: { type: "userMessage", id: `user-${entries.length}`, clientId: message.params.clientUserMessageId, content: message.params.input } });
      history.set(threadId, entries);
    }
    send({ id: message.id, result: { turnId } });
    return;
  }
  if (message.method === "test/completeTurn") {
    const threadId = message.params.threadId;
    const turnId = turns.get(threadId);
    turns.delete(threadId);
    send({ id: message.id, result: {} });
    if (turnId) {
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
      send({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
    }
    return;
  }
  if (typeof message.method === "string" && message.method.startsWith("thread/queue/")) {
    send({ id: message.id, error: { code: -32601, message: "native queue must not receive Host queue requests" } });
    return;
  }
  if (message.method === "thread/resume") {
    loadedThreads.add(message.params.threadId);
    const respond = () => send({ id: message.id, result: {
      thread: { id: message.params.testWrongThreadId ? "different-thread" : message.params.threadId, preview: "", ephemeral: false, turns: [] },
    } });
    if (message.params.testDelayMs) setTimeout(respond, message.params.testDelayMs);
    else respond();
    return;
  }
  if (message.method === "test/emitServerRequest") {
    const requestId = nextServerRequestId++;
    send({ id: requestId, method: "item/tool/requestUserInput", params: {
      threadId: message.params.threadId, turnId: null, itemId: `question-${requestId}`, questions: [],
    } });
    send({ id: message.id, result: { requestId } });
    return;
  }
  if (message.method === "thread/fork") {
    if (message.params.testFail) {
      send({ id: message.id, error: { code: -32000, message: "fixture fork rejected" } });
      return;
    }
    const respond = () => {
      const thread = { id: message.params.testDelayMs ? "codex-fork-late" : "codex-fork-1", forkedFromId: message.params.threadId, preview: "", ephemeral: message.params.ephemeral === true, turns: [] };
      send({ id: message.id, result: { thread, model: "gpt-test", modelProvider: "opencraft-account-pool", cwd: process.cwd() } });
      send({ method: "thread/started", params: { thread } });
    };
    if (message.params.testDelayMs) setTimeout(respond, message.params.testDelayMs);
    else respond();
    return;
  }
  if (message.method === "thread/start") {
    const thread = { id: "codex-thread-1", preview: "", ephemeral: false, modelProvider: "opencraft-account-pool", createdAt: 1, updatedAt: 1, status: { type: "idle" }, turns: [] };
    loadedThreads.add(thread.id);
    send({ id: message.id, result: { thread, model: "gpt-test", modelProvider: "opencraft-account-pool", cwd: message.params.cwd, approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, serviceTier: null } });
    send({ method: "thread/started", params: { thread } });
    send({ id: 900, method: "item/tool/requestUserInput", params: { threadId: thread.id, turnId: null, itemId: "question-1", questions: [] } });
    return;
  }
  if (typeof message.id === "number" && (message.result || message.error)) {
    send({ method: "serverRequest/resolved", params: { threadId: "codex-thread-1", requestId: message.id } });
    return;
  }
  send({ id: message.id, result: {} });
});
