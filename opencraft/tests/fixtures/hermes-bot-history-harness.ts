import { createCordisAppServerRegistry } from "@opencraft/appserver-client";
import { encodeJsonRpcMessage, isJsonRpcRequest, parseJsonRpcMessage } from "@opencraft/appserver-protocol";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { AppServerBotConversationResolver, AppServerBotConversationSource, createCordisBotConversationRuntime } from "@opencraft/bot-conversation-appserver";
import { createConversationKey } from "@opencraft/chat-core";
import { HermesAppServerAdapter } from "../../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter";
import { HermesBotAppServerHandler } from "../../plugins/lightvela-hermes/src/hermes-appserver-bridge/bot-protocol-handler";
import { dispatchAppServerRequest } from "../../plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol";
import type { HermesMessage } from "../../plugins/lightvela-hermes/src/hermes-appserver-bridge/types";

/** Only native Hermes RPC/REST is simulated; every OpenCraft layer is real. */
export async function createHermesBotHistoryHarness(rows: HermesMessage[]) {
  const requests: number[] = [];
  let failNextOlder = false;
  let peer: InMemoryAppServerPeer;
  const summary = { id: "history", title: "history fixture", preview: "", profile: "default", started_at: 1 };
  const adapter = new HermesAppServerAdapter({
    onEvent() { return () => {}; },
    async call<T>(name: string): Promise<T> {
      if (name === "profiles.list") return { profiles: [{ name: "default" }] } as T;
      if (name === "session.list") return { sessions: [summary] } as T;
      if (name === "session.resume" || name === "session.activate") {
        return { session_id: "live-history", stored_session_id: "history", messages: [], running: false, message_count: rows.length } as T;
      }
      throw new Error(`Unexpected Hermes RPC ${name}`);
    },
  }, "/", {
    async readMessages(sessionId, request) {
      requests.push(request.offset);
      if (request.offset > 0 && failNextOlder) {
        failNextOlder = false;
        throw new Error("Fixture history read failed");
      }
      const end = Math.max(0, rows.length - request.offset);
      const messages = rows.slice(Math.max(0, end - request.limit), end);
      return { session_id: sessionId, messages, pagination: {
        limit: request.limit, offset: request.offset, order: request.order, returned: messages.length,
      } };
    }, dispose() {},
  });
  const handler = new HermesBotAppServerHandler(adapter, event => peer.send(encodeJsonRpcMessage(event)));
  adapter.subscribeNotification((method, params) => handler.observeAppServerNotification(method, params));
  const transport = new MemoryTransport({
    connected(value) { peer = value; },
    receive(frame, connected) {
      const request = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(request)) return;
      void dispatchAppServerRequest(adapter, request, { bots: handler }).then(
        result => connected.send(encodeJsonRpcMessage({ id: request.id, result })),
        error => connected.send(encodeJsonRpcMessage({ id: request.id, error: { code: -32000, message: String(error) } })),
      );
    },
  });
  const registry = await createCordisAppServerRegistry();
  const runtime = await createCordisBotConversationRuntime(registry.context);
  const source = new AppServerBotConversationSource(runtime.service, { initialPageSize: 1 });
  const key = createConversationKey("hermes-history", "history");
  const client = registry.clients.create({ hostId: key.hostId, transport });
  await client.connect({ clientInfo: { name: "hermes-history-fixture", version: "1" } });
  return {
    source, key, rows, requests, resolver: new AppServerBotConversationResolver(runtime.service),
    failNextOlder() { failNextOlder = true; },
    async resync() {
      const read = await runtime.service.readConversation(key.hostId, { conversationId: key.threadId });
      const revision = source.getSnapshot(key).revision;
      const settled = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { stop(); reject(new Error("Fixture resync did not settle")); }, 3000);
        const stop = source.subscribe(key, () => {
          const snapshot = source.getSnapshot(key);
          if (snapshot.revision <= revision || snapshot.phase === "loading") return;
          clearTimeout(timeout); stop();
          if (snapshot.phase === "error") reject(new Error(snapshot.error ?? "Fixture resync failed"));
          else resolve();
        });
      });
      // A missed live event is a real source resync trigger, not source internals.
      peer.send(encodeJsonRpcMessage({ method: "bot/presence/updated", params: {
        conversationId: key.threadId, participantId: "bot:hermes-default", presence: null,
        stamp: { epoch: read.liveCursor.epoch, seq: read.liveCursor.nextSeq + 1 },
      } }));
      await settled;
    },
    async dispose() { source.dispose(); handler.dispose(); adapter.dispose(); await runtime.dispose(); await registry.dispose(); },
  };
}

export function toolHistory(pairs: number, finalText?: string): HermesMessage[] {
  const rows: HermesMessage[] = [{ id: 1, role: "user", content: "Original history question" }];
  for (let index = 0; index < pairs; index++) {
    rows.push({ id: rows.length + 1, role: "assistant", content: "", tool_calls: [{
      id: `tool-${index}`, function: { name: "terminal", arguments: '{"command":"pwd"}' },
    }] });
    rows.push({ id: rows.length + 1, role: "tool", tool_call_id: `tool-${index}`, content: '{"output":"/fixture","exit_code":0}' });
  }
  if (finalText !== undefined) rows.push({ id: rows.length + 1, role: "assistant", content: finalText });
  return rows;
}
