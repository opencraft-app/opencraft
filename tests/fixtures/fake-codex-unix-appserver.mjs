import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const endpoint = process.argv[2];
const server = createServer();
const sockets = new WebSocketServer({ server });
const subscriptions = new Map();
const threads = new Map();
let sequence = 0;
let holdNextRead = 0;
let pendingReads = 0;
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
      const thread = { id: `thread-${++sequence}`, createdAt: 1, updatedAt: 1, cwd: params.cwd ?? "/synthetic", historyMode: "legacy", status: { type: "idle" }, turns: [] };
      threads.set(thread.id, thread); subscribed.add(thread.id);
      send({ id, result: { thread } }); return;
    }
    if (method === "fixture/readPending") { send({ id, result: { count: pendingReads } }); return; }
    if (method === "fixture/holdNextRead") { holdNextRead = params.delay; send({ id, result: {} }); return; }
    if (method === "thread/read") { const wait = holdNextRead; holdNextRead = 0; const reply = () => { if (wait) pendingReads--; send({ id, result: { thread: threads.get(params.threadId) } }); }; if (wait) { pendingReads++; setTimeout(reply, wait); } else reply(); return; }
    if (method === "thread/items/list") { send({ id, result: { data: (threads.get(params.threadId)?.turns ?? []).flatMap(turn => turn.items.map(item => ({ item }))), nextCursor: null } }); return; }
    if (method === "thread/list") { send({ id, result: { data: [...threads.values()], nextCursor: null } }); return; }
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
      const turn = { id: `turn-${++sequence}`, status: "inProgress", items: [{ id: `user-${sequence}`, type: "userMessage", content: params.input, clientId: params.clientUserMessageId }] };
      thread.turns.push(turn); thread.status = { type: "active", activeFlags: [] };
      send({ id, result: { turn } });
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
      const reply = () => send({ id, result: { thread: threads.get(params.threadId) } });
      if (params.fixtureDelay) setTimeout(reply, 100); else reply();
      return;
    }
    if (method === "thread/unsubscribe") {
      send({ id, result: { status: subscribed.delete(params.threadId) ? "unsubscribed" : "notSubscribed" } }); return;
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
