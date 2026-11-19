import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const endpoint = process.argv[2];
const server = createServer();
const sockets = new WebSocketServer({ server });
const subscriptions = new Map();
const threads = new Map();
// Opt in to the observed Native empty-allocation/index boundary. Legacy tests
// retain their missing-history behavior and do not gain settings simulation.
const paginatedEmptyIndex = process.env.FAKE_PAGINATED_EMPTY_INDEX === "1";
const nativeStates = new Map();
const materialize = thread => {
  mkdirSync(dirname(thread.path), { recursive: true });
  if (!existsSync(thread.path)) writeFileSync(thread.path, JSON.stringify({ type: "session_meta", payload: { id: thread.id } }) + "\n");
  nativeStates.get(thread.id).metadataMaterialized = true;
};
const applySettings = (settings, params) => {
  for (const key of ["model", "modelProvider", "serviceTier", "cwd", "runtimeWorkspaceRoots", "approvalPolicy", "approvalsReviewer", "collaborationMode"])
    if (Object.hasOwn(params, key)) settings[key] = structuredClone(params[key]);
  if (Object.hasOwn(params, "effort")) settings.reasoningEffort = params.effort;
  if (Object.hasOwn(params, "permissions")) settings.activePermissionProfile = { id: params.permissions };
  if (Object.hasOwn(params, "sandboxPolicy")) settings.sandbox = structuredClone(params.sandboxPolicy);
  if (typeof params.sandbox === "string") settings.sandbox = {
    type: { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" }[params.sandbox],
  };
};
let sequence = 0;
let holdNextRead = 0;
let pendingReads = 0;
let holdNextTurn = false;
const heldReads = [], heldTurns = [];
sockets.on("connection", socket => {
  const subscribed = new Set();
  subscriptions.set(socket, subscribed);
  socket.on("close", () => subscriptions.delete(socket));
  const send = value => socket.send(JSON.stringify(value));
  socket.on("message", raw => {
    const { id, method, params = {} } = JSON.parse(String(raw));
    if (method === "initialized") return;
    if (method === "initialize") { send({ id, result: { serverInfo: { name: "fake", version: "1" } } }); return; }
    if (method === "thread/start") {
      const thread = { id: `${process.env.FAKE_CODEX_THREAD_PREFIX ?? "thread"}-${++sequence}`, createdAt: 1, updatedAt: 1, cwd: params.cwd ?? "/synthetic", historyMode: "legacy", status: { type: "idle" }, turns: [] };
      if (process.env.FAKE_EMPTY_HISTORY_UNSUPPORTED) thread.path = join(process.cwd(), "native-fixture-rollouts", `${thread.id}.jsonl`);
      if (paginatedEmptyIndex) {
        Object.assign(thread, { historyMode: "paginated", ephemeral: params.ephemeral ?? false, projectId: params.projectId || null,
          path: join(process.cwd(), "native-fixture-rollouts", `${thread.id}.jsonl`) });
        const settings = { model: "fixture-model", modelProvider: "fixture", serviceTier: null, cwd: thread.cwd,
          runtimeWorkspaceRoots: [thread.cwd], approvalPolicy: "never", approvalsReviewer: "user",
          sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: null,
          reasoningEffort: null, collaborationMode: null };
        applySettings(settings, params);
        nativeStates.set(thread.id, { metadataMaterialized: false, indexConfirmed: false,
          configuration: structuredClone(params.config ?? {}), settings, events: [] });
      }
      threads.set(thread.id, thread); subscribed.add(thread.id);
      send({ id, result: { thread, ...(paginatedEmptyIndex ? nativeStates.get(thread.id).settings : {}) } }); return;
    }
    if (paginatedEmptyIndex && ["thread/resume", "thread/turns/list"].includes(method)) {
      const state = nativeStates.get(params.threadId);
      if (!state?.indexConfirmed) {
        send({ id, error: state?.metadataMaterialized
          ? { code: -32601, message: "list_turns is not supported yet" }
          : { code: -32600, message: "history_missing: no rollout exists before first Turn" } }); return;
      }
    }
    if (!paginatedEmptyIndex && method === "thread/resume" && process.env.FAKE_REQUIRE_DURABLE_RESUME && !threads.get(params.threadId)?.turns.length) {
      send({ id, error: { code: -32600, message: "history_missing: no rollout exists before first Turn" } }); return;
    }
    if (paginatedEmptyIndex && method === "fixture/nativeState") { send({ id, result: nativeStates.get(params.threadId) }); return; }
    if (paginatedEmptyIndex && method === "thread/metadata/update") {
      const thread = threads.get(params.threadId), state = nativeStates.get(params.threadId);
      if (!state || !state.metadataMaterialized || !Object.hasOwn(params, "projectId") || (params.projectId || null) !== thread.projectId) {
        send({ id, error: { code: -32600, message: "Empty index requires materialized metadata and the same project" } }); return;
      }
      state.indexConfirmed = true; state.events.push({ method, projectId: thread.projectId });
      send({ id, result: { thread } }); return;
    }
    if (paginatedEmptyIndex && method === "thread/turns/list") {
      const rows = [...threads.get(params.threadId).turns];
      if (params.sortDirection !== "asc") rows.reverse();
      const offset = Number(params.cursor ?? 0), limit = params.limit ?? 100;
      send({ id, result: { data: rows.slice(offset, offset + limit).map(turn => ({ ...turn, items: params.itemsView === "full" ? turn.items : [] })),
        nextCursor: offset + limit < rows.length ? String(offset + limit) : null, backwardsCursor: null } }); return;
    }
    if (paginatedEmptyIndex && method === "thread/settings/update") {
      const state = nativeStates.get(params.threadId);
      applySettings(state.settings, params);
      state.events.push({ method, settings: structuredClone(state.settings) });
      send({ id, result: structuredClone(state.settings) }); return;
    }
    if (method === "fixture/readPending") { send({ id, result: { count: pendingReads } }); return; }
    if (method === "fixture/holdNextRead") { holdNextRead = params.untilRelease ? -1 : params.delay; send({ id, result: {} }); return; }
    if (method === "fixture/holdNextTurn") { holdNextTurn = true; send({ id, result: {} }); return; }
    if (method === "fixture/releaseReads") { for (const reply of heldReads.splice(0)) reply(); send({ id, result: {} }); return; }
    if (method === "fixture/releaseTurns") { for (const reply of heldTurns.splice(0)) reply(); send({ id, result: {} }); return; }
    if (paginatedEmptyIndex && method === "thread/read" && params.includeTurns === true) {
      const thread = threads.get(params.threadId), state = nativeStates.get(params.threadId);
      if (state && !state.metadataMaterialized) materialize(thread);
      if (!state?.indexConfirmed) {
        send({ id, error: { code: -32601, message: "list_turns is not supported yet" } }); return;
      }
    }
    if (!paginatedEmptyIndex && method === "thread/read" && params.includeTurns === true && process.env.FAKE_EMPTY_HISTORY_UNSUPPORTED && !threads.get(params.threadId)?.turns.length) {
      // Stock 0.162 writes its own session_meta before reporting unsupported
      // list_turns. Keep this fixture at the observed native boundary.
      const thread = threads.get(params.threadId);
      mkdirSync(dirname(thread.path), { recursive: true });
      if (!existsSync(thread.path)) writeFileSync(thread.path, JSON.stringify({ type: "session_meta", payload: { id: thread.id } }) + "\n");
      send({ id, error: { code: -32601, message: "list_turns is not supported yet" } }); return;
    }
    if (method === "thread/read") { const wait = holdNextRead; holdNextRead = 0; const reply = () => { if (wait) pendingReads--; send({ id, result: { thread: threads.get(params.threadId) } }); }; if (wait === -1) { pendingReads++; heldReads.push(reply); } else if (wait) { pendingReads++; setTimeout(reply, wait); } else reply(); return; }
    if (paginatedEmptyIndex && method === "thread/items/list") {
      const rows = (threads.get(params.threadId)?.turns ?? []).filter(turn => !params.turnId || turn.id === params.turnId)
        .flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item })));
      if (params.sortDirection === "desc") rows.reverse();
      const offset = Number(params.cursor ?? 0), limit = params.limit ?? 100;
      send({ id, result: { data: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? String(offset + limit) : null } }); return;
    }
    if (method === "thread/items/list") { send({ id, result: { data: (threads.get(params.threadId)?.turns ?? []).flatMap(turn => turn.items.map(item => ({ item }))), nextCursor: null } }); return; }
    if (method === "thread/list") { send({ id, result: { data: [...threads.values()].filter(t => paginatedEmptyIndex
      ? nativeStates.get(t.id).indexConfirmed : !process.env.FAKE_REQUIRE_DURABLE_RESUME || t.turns.length), nextCursor: null } }); return; }
    if (method === "thread/loaded/list") { send({ id, result: { data: [...threads.keys()] } }); return; }
    if (method === "thread/goal/get") { send({ id, result: { goal: threads.get(params.threadId)?.goal ?? null } }); return; }
    if (method === "thread/goal/set") {
      const thread = threads.get(params.threadId); thread.goal = { status: params.status ?? "active", objective: params.objective ?? "synthetic goal" };
      thread.goalSetCount = (thread.goalSetCount ?? 0) + 1;
      send({ id, result: { goal: thread.goal } }); return;
    }
    if (method === "fixture/goalSetCount") { send({ id, result: { count: threads.get(params.threadId)?.goalSetCount ?? 0 } }); return; }
    if (method === "turn/start") {
      const thread = threads.get(params.threadId);
      if (paginatedEmptyIndex) {
        const state = nativeStates.get(thread.id);
        state.events.push({ method, inputId: params.clientUserMessageId,
          configuration: structuredClone(state.configuration), settings: structuredClone(state.settings) });
      }
      const turn = { id: `turn-${++sequence}`, status: "inProgress", items: [{ id: `user-${sequence}`, type: "userMessage", content: params.input, clientId: params.clientUserMessageId }] };
      if (thread.path && existsSync(thread.path)) appendFileSync(thread.path,
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: params.input } }) + "\n");
      thread.turns.push(turn); thread.status = { type: "active", activeFlags: [] };
      const reply = () => send({ id, result: { turn } });
      const wait = holdNextTurn; holdNextTurn = false;
      if (wait) heldTurns.push(reply); else reply();
      for (const [client, ids] of subscriptions) if (ids.has(thread.id)) client.send(JSON.stringify({ method: "turn/started", params: { threadId: thread.id, turn } }));
      return;
    }
    if (method === "fixture/complete") {
      const thread = threads.get(params.threadId), turn = thread.turns.at(-1); turn.status = "completed"; thread.status = { type: "idle" };
      for (const [client, ids] of subscriptions) if (ids.has(thread.id)) client.send(JSON.stringify({ method: "turn/completed", params: { threadId: thread.id, turn } }));
      send({ id, result: {} }); return;
    }
    if (method === "thread/resume") {
      if (params.fixtureReject) {
        setTimeout(() => send({ id, error: { code: -1, message: "Resume rejected" } }), 100); return;
      }
      if (!threads.has(params.threadId)) { send({ id, error: { code: -1, message: "Missing thread" } }); return; }
      subscribed.add(params.threadId);
      if (process.env.FAKE_UNLOAD_ON_UNSUBSCRIBE) threads.get(params.threadId).status = { type: "idle" };
      if (paginatedEmptyIndex) {
        const state = nativeStates.get(params.threadId);
        applySettings(state.settings, params);
        if (params.config) {
          state.configuration = { ...state.configuration, ...structuredClone(params.config) };
          // Loading applies coarse sandbox mode; settings/update must restore
          // the full policy, reasoning and collaboration choices afterwards.
          state.settings.reasoningEffort = null; state.settings.collaborationMode = null;
          state.events.push({ method, configuration: structuredClone(state.configuration) });
        }
      }
      const reply = () => send({ id, result: { thread: threads.get(params.threadId), ...(paginatedEmptyIndex ? nativeStates.get(params.threadId).settings : {}) } });
      if (params.fixtureDelay) setTimeout(reply, 100); else reply();
      return;
    }
    if (method === "thread/unsubscribe") {
      const removed = subscribed.delete(params.threadId);
      if (process.env.FAKE_UNLOAD_ON_UNSUBSCRIBE && ![...subscriptions.values()].some(ids => ids.has(params.threadId))) threads.get(params.threadId).status = { type: "notLoaded" };
      send({ id, result: { status: removed ? "unsubscribed" : "notSubscribed" } }); return;
    }
    if (method === "fixture/publish") {
      for (const [client, ids] of subscriptions) if (ids.has(params.threadId)) {
        client.send(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: params.threadId, delta: params.delta } }));
      }
      send({ id, result: {} }); return;
    }
    if (method === "fixture/subscribers") {
      send({ id, result: { count: [...subscriptions.values()].filter(ids => ids.has(params.threadId)).length } }); return;
    }
    send({ id, result: {} });
  });
});
server.listen(endpoint);
