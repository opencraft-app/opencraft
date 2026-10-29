const seededHistory = new Set();
const unsupportedItemHistory = new Set();
const legacyItems = new Set();
const smallHistoryBudgets = new Set();
const systemErrorThreads = new Set();
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
let initialized = 0;
let nextServerRequestId = 901;
let nextTurnId = 1;
const turns = new Map();
const threadTurns = new Map();
const threadPaths = new Map();
const methodCounts = {};
const history = new Map();
const acceptedInputs = [];
const permissionRequests = [];
const testTools = new Map();
const toolResults = [];
const deferredSteerHistory = new Map();
const loadedThreads = new Set();
// stdio is one physical AppServer connection even when OpenCraft has many logical Clients.
const subscribedThreads = new Set();
const archivedThreads = new Set();
const threadNames = new Map();
const titleThreads = new Set();
let nextTitleThread = 0;
let threadReadsPaused = false;
const heldThreadReads = [];
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
function readThread(message) {
  const active = turns.get(message.params.threadId);
  const type = !loadedThreads.has(message.params.threadId) ? "notLoaded" : active ? "active" : systemErrorThreads.has(message.params.threadId) ? "systemError" : "idle";
  send({ id: message.id, result: { thread: { id: message.params.threadId, path: threadPaths.get(message.params.threadId) ?? (loadedThreads.has(message.params.threadId) ? `/synthetic/${message.params.threadId}.jsonl` : null), createdAt: 123, name: threadNames.get(message.params.threadId) ?? null, status: { type, ...(active ? { activeFlags: [] } : {}) }, turns: message.params.includeTurns ? threadTurns.get(message.params.threadId) ?? [] : [] } } });
}
input.on("line", line => {
  const message = JSON.parse(line);
  if (typeof message.params?.permissions === "string") permissionRequests.push({ method: message.method, params: message.params });
  if (message.method === "test/readPermissionRequests") { send({ id: message.id, result: { data: permissionRequests } }); return; }
  if (message.method) methodCounts[message.method] = (methodCounts[message.method] ?? 0) + 1;
  if (message.method === "test/readMethodCounts") { send({ id: message.id, result: methodCounts }); return; }
  if (message.method === undefined && testTools.has(String(message.id))) {
    toolResults.push({id:message.id,...testTools.get(String(message.id)),result:message.result,error:message.error});testTools.delete(String(message.id));return;
  }
  if (message.method === "test/readToolResults") {send({id:message.id,result:{data:toolResults}});return;}
  if (message.method === "test/pauseThreadReads") {
    threadReadsPaused = message.params.paused;
    if (!threadReadsPaused) for (const read of heldThreadReads.splice(0)) readThread(read);
    send({ id: message.id, result: {} }); return;
  }
  if (message.method === "test/setHistory") {seededHistory.add(message.params.threadId);if(message.params.unsupportedItems)unsupportedItemHistory.add(message.params.threadId);threadTurns.set(message.params.threadId,message.params.turns);if(message.params.path)threadPaths.set(message.params.threadId,message.params.path);if(message.params.legacyItems)legacyItems.add(message.params.threadId);if(message.params.smallHistoryBudget)smallHistoryBudgets.add(message.params.threadId);send({id:message.id,result:{}});return;}
  if (message.method === "test/emitTool") {
    const id=nextServerRequestId++;testTools.set(String(id),message.params);send({id,method:"item/tool/call",params:{...message.params,callId:String(id)}});send({id:message.id,result:{requestId:id}});return;
  }
  if (message.method === "initialize") {
    initialized += 1;
    send({ id: message.id, result: { codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "darwin", userAgent: "fake", serverInfo: { name: "fake-codex", version: String(initialized) }, ...(process.env.OPENCRAFT_TEST_NATIVE_QUEUE_STEER ? { opencraftQueueSteerVersion: Number(process.env.OPENCRAFT_TEST_NATIVE_QUEUE_STEER) } : {}) } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "account/login/start" && process.env.OPENCRAFT_TEST_REJECT_POOL_AUTH) {
    send({ id: message.id, error: { code: -32000, message: "Native external auth rejected" } }); return;
  }
  if (message.method === "model/list" && process.env.OPENCRAFT_TEST_AUTO_TITLES) {
    send({ id: message.id, result: { data: [{ model: "gpt-6-luna" }], nextCursor: null } });
    return;
  }
  if (message.method === "thread/name/set") {
    if (!loadedThreads.has(message.params.threadId)) {
      send({ id: message.id, error: { code: -32600, message: "thread not found" } });
      return;
    }
    threadNames.set(message.params.threadId, message.params.name);
    send({ id: message.id, result: {} });
    if (process.env.OPENCRAFT_TEST_AUTO_TITLES) send({ method: "thread/name/updated", params: { threadId: message.params.threadId, threadName: message.params.name } });
    return;
  }
  if (message.method === "thread/archive") {
    archivedThreads.add(message.params.threadId);
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/unarchive") {
    archivedThreads.delete(message.params.threadId);
    send({ id: message.id, result: { thread: { id: message.params.threadId, preview: "", ephemeral: false, turns: [] } } });
    return;
  }
  if (message.method === "thread/list") {
    const thread = { id: "fixture-thread-1", name: threadNames.get("fixture-thread-1") ?? null, preview: "", ephemeral: false, turns: [] };
    const matchesArchiveFilter = message.params?.archived === true ? archivedThreads.has(thread.id) : !archivedThreads.has(thread.id);
    send({ id: message.id, result: { data: loadedThreads.has(thread.id) && matchesArchiveFilter ? [thread] : [], nextCursor: null } });
    return;
  }
  if (message.method === "permissionProfile/list") {
    send({ id: message.id, result: { data: [
      { id: ":read-only", description: "Inspect files", allowed: true },
      { id: ":workspace", description: "Edit workspace", allowed: true },
      { id: ":danger-full-access", description: "Unrestricted", allowed: true },
      { id: "team-custom", description: "Team policy", allowed: true },
    ], nextCursor: null } });
    return;
  }
  if (message.method === "thread/read") {
    if (threadReadsPaused) heldThreadReads.push(message);
    else readThread(message);
    return;
  }
  if (message.method === "thread/turns/list") {
    if (smallHistoryBudgets.has(message.params.threadId) && message.params.itemsView === "full"
      && (!unsupportedItemHistory.has(message.params.threadId) || message.params.limit > 2)) {
      send({id:message.id,error:{code:-32072,message:"budget exceeded",data:{code:"HISTORY_RESPONSE_TOO_LARGE"}}});return;
    }
    const rows = [...(threadTurns.get(message.params.threadId) ?? [])];
    if (message.params.sortDirection !== "asc") rows.reverse();
    const offset = Number(message.params.cursor ?? 0), limit = message.params.limit ?? 100;
    send({ id: message.id, result: { data: rows.slice(offset, offset + limit).map(turn => ({ ...(message.params.itemsView === "notLoaded" && systemErrorThreads.has(message.params.threadId) ? { id: turn.id, status: turn.status } : turn), items: message.params.itemsView === "full" && !legacyItems.has(message.params.threadId) ? turn.items : [], ...(legacyItems.has(message.params.threadId) ? {itemsView:"notLoaded"} : {}) })),
      nextCursor: offset + limit < rows.length ? String(offset + limit) : null } }); return;
  }
  if (message.method === "thread/items/list") {
    if (unsupportedItemHistory.has(message.params.threadId)) {send({id:message.id,error:{code:-32601,message:"Item pagination unsupported"}});return;}
    if (smallHistoryBudgets.has(message.params.threadId) && message.params.limit > 1) {
      send({id:message.id,error:{code:-32072,message:"budget exceeded",data:{code:"HISTORY_RESPONSE_TOO_LARGE"}}});return;
    }
    const items = (seededHistory.has(message.params.threadId) ? threadTurns.get(message.params.threadId).flatMap(turn => turn.items.map(item => ({turnId:turn.id,item}))) : history.get(message.params.threadId) ?? []).filter(entry => !message.params.turnId || entry.turnId === message.params.turnId);
    const offset = message.params.cursor ? Number(message.params.cursor) : 0;
    const limit = message.params.limit ?? 100;
    send({ id: message.id, result: { data: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null } });
    return;
  }
  if (message.method === "turn/start") {
    acceptedInputs.push({ method: message.method, params: message.params });
    const threadId = message.params.threadId;
    if (turns.has(threadId)) {
      send({ id: message.id, error: { code: -32600, message: "thread already has an active or pending turn" } });
      return;
    }
    const turnId = `turn-${nextTurnId++}`;
    systemErrorThreads.delete(threadId);
    turns.set(threadId, turnId);
    threadTurns.set(threadId, [...(threadTurns.get(threadId) ?? []), { id: turnId, status: "inProgress", items: [] }]);
    subscribedThreads.add(threadId);
    if (message.params.clientUserMessageId) {
      const entries = history.get(threadId) ?? [];
      entries.push({ turnId, item: { type: "userMessage", id: `user-${entries.length}`, clientId: message.params.clientUserMessageId, content: message.params.input } });
      history.set(threadId, entries);
    }
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
    if (titleThreads.has(threadId)) setTimeout(() => {
      send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "title-output", text: '{"title":"修复自动会话标题"}' } } });
      turns.delete(threadId);
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
    }, 40);
    return;
  }
  if (message.method === "turn/steer") {
    acceptedInputs.push({ method: message.method, params: message.params });
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
      const targetHistory = process.env.OPENCRAFT_TEST_STEER_RESPONSE === "defer-history"
        ? deferredSteerHistory : history;
      const entries = targetHistory.get(threadId) ?? [];
      entries.push({ turnId, item: { type: "userMessage", id: `user-${entries.length}`, clientId: message.params.clientUserMessageId, content: message.params.input } });
      targetHistory.set(threadId, entries);
    }
    send({ id: message.id, result: { turnId } });
    return;
  }
  if (message.method === "test/completeTurn") {
    const threadId = message.params.threadId;
    const turnId = turns.get(threadId);
    turns.delete(threadId);
    if (message.params.testSystemError) systemErrorThreads.add(threadId);
    const completed = { id: turnId, status: message.params.codexErrorInfo ? "failed" : "completed", items: [], ...(message.params.codexErrorInfo ? { error: { message: "Selected model is at capacity.", codexErrorInfo: message.params.codexErrorInfo } } : {}) };
    threadTurns.set(threadId, (threadTurns.get(threadId) ?? []).map(turn => turn.id === turnId ? completed : turn));
    const deferred = deferredSteerHistory.get(threadId) ?? [];
    if (deferred.length > 0) {
      history.set(threadId, [...(history.get(threadId) ?? []), ...deferred]);
      deferredSteerHistory.delete(threadId);
    }
    send({ id: message.id, result: {} });
    if (turnId && subscribedThreads.has(threadId)) {
      send({ method: "turn/completed", params: { threadId, turn: completed } });
      send({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
    }
    return;
  }
  if (message.method === "test/emitThreadNotification") {
    const threadId = message.params.threadId;
    send({ id: message.id, result: { nativeSubscribed: subscribedThreads.has(threadId) } });
    if (message.params.method) send({ method: message.params.method, params: {threadId} });
    if (subscribedThreads.has(threadId)) send({ method: "thread/status/changed", params: { threadId, status: { type: "active" } } });
    return;
  }
  if (typeof message.method === "string" && message.method.startsWith("thread/queue/")) {
    send({ id: message.id, error: { code: -32601, message: "native queue must not receive Host queue requests" } });
    return;
  }
  if (message.method === "thread/resume") {
    loadedThreads.add(message.params.threadId);
    subscribedThreads.add(message.params.threadId);
    const respond = () => {
      send({ id: message.id, result: {
        thread: { id: message.params.testWrongThreadId ? "different-thread" : message.params.threadId, preview: "", ephemeral: false, turns: [] },
      } });
      if (message.params.testDelayMs) send({ method: "test/delayedResponseSent", params: { requestId: message.id } });
    };
    if (message.params.testDelayMs) setTimeout(respond, message.params.testDelayMs);
    else respond();
    return;
  }
  if (message.method === "thread/unsubscribe") {
    const threadId = message.params.threadId;
    const status = !loadedThreads.has(threadId) ? "notLoaded"
      : subscribedThreads.delete(threadId) ? "unsubscribed" : "notSubscribed";
    send({ id: message.id, result: { status } });
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
      const thread = { id: message.params.testDelayMs ? "fixture-fork-late" : "fixture-fork-1", forkedFromId: message.params.threadId, preview: "", ephemeral: message.params.ephemeral === true, turns: [] };
      loadedThreads.add(thread.id);
      subscribedThreads.add(thread.id);
      send({ id: message.id, result: { thread, model: "gpt-test", modelProvider: "opencraft-account-pool", cwd: process.cwd() } });
      send({ method: "thread/started", params: { thread } });
      if (message.params.testDelayMs) send({ method: "test/delayedResponseSent", params: { requestId: message.id } });
    };
    if (message.params.testDelayMs) setTimeout(respond, message.params.testDelayMs);
    else respond();
    return;
  }
  if (message.method === "thread/start") {
    const respond = () => {
      const title = process.env.OPENCRAFT_TEST_AUTO_TITLES && message.params.threadSource === "thread_title";
      const thread = { id: title ? `title-thread-${++nextTitleThread}` : "fixture-thread-1", preview: "", ephemeral: message.params.ephemeral === true, modelProvider: "opencraft-account-pool", createdAt: 1, updatedAt: 1, status: { type: "idle" }, turns: [] };
      if (title) titleThreads.add(thread.id);
      loadedThreads.add(thread.id);
      subscribedThreads.add(thread.id);
      send({ id: message.id, result: { thread, model: "gpt-test", modelProvider: "opencraft-account-pool", cwd: message.params.cwd, approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, serviceTier: null, testNativePermission: message.params.permissions ?? null } });
      send({ method: "thread/started", params: { thread } });
      if (!title && !message.params.testNoServerRequest) send({ id: 900, method: "item/tool/requestUserInput", params: { threadId: thread.id, turnId: null, itemId: "question-1", questions: [] } });
      if (message.params.testDelayMs) send({ method: "test/delayedResponseSent", params: { requestId: message.id } });
    };
    if (message.params.testDelayMs) setTimeout(respond, message.params.testDelayMs);
    else respond();
    return;
  }
  if (typeof message.id === "number" && (message.result || message.error)) {
    send({ method: "serverRequest/resolved", params: { threadId: "fixture-thread-1", requestId: message.id } });
    return;
  }
  if (message.method === "test/readAcceptedInputs") { send({ id: message.id, result: { data: acceptedInputs } }); return; }
  send({ id: message.id, result: {} });
});
