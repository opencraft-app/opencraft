import { APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol/version";
import { randomUUID } from "node:crypto";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { CodexNativeCoreTransport } from "../apps/opencraft-daemon/src/codex-native-core-transport.ts";

function catalog(result, serverId) {
  return { conversations: result.data.map(thread => ({ serverId, threadId: thread.id, title: thread.name || thread.preview || thread.id })), nextCursor: result.nextCursor ?? null };
}

/** The split deployment already owns a Core connection. A transient read client
 * uses that same native socket; it owns neither the Core process nor stores. */
export async function readTaskCoreConversations(endpoint, token, search, limit, cursor) {
  const client = new JsonRpcAppServerClient({
    hostId: "local-codex",
    transport: new CodexNativeCoreTransport(endpoint, token),
    requestTimeoutMs: 10_000,
  });
  const signal = AbortSignal.timeout(12_000);
  try {
    await client.connect({ clientInfo: { name: "opencraft-task-catalog", version: "1" }, capabilities: { experimentalApi: true } }, signal);
    return catalog(await client.request("thread/list", { limit, searchTerm: search || null, archived: false, cursor: cursor ?? null }, { signal }), "local-codex");
  } finally { await client.close(); }
}

/** Read one known Host through its normal logical-client lease. No second engine
 * or thread store, and no arbitrary method is exposed to the Tasks endpoint. */
export function readTaskCodexConversations(appHostServer, search, limit, cursor) {
  const clientId = `task-catalog:${randomUUID()}`, leaseId = randomUUID();
  const hostId = "local-codex";
  return new Promise((resolve, reject) => {
    let connection, receive, generation, finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      try { connection?.close(); } catch (closeError) { error ??= closeError; }
      error ? reject(error) : resolve(result);
    };
    const deadline = setTimeout(() => finish(new Error("Task conversation catalog timed out")), 12_000);
    const send = (id, method, params) => receive?.({ type: "host/send", requestId: `send-${id}`, hostId, leaseId, generation, frame: JSON.stringify({ id, method, params }) });
    try {
      connection = appHostServer.accept({
        subscribe(listener) { receive = listener; return () => { receive = undefined; }; },
        start() {}, close() {},
        postMessage(message) {
          if (finished) return;
          if (message.type === "ready") receive?.({ type: "host/connect", requestId: "connect", hostId, leaseId });
          else if (message.type === "response" && message.requestId === "connect") {
            if (!message.ok || !Number.isSafeInteger(message.result?.generation)) return finish(new Error("Task conversation Host is unavailable"));
            generation = message.result.generation;
            send("init", "initialize", { clientInfo: { name: "opencraft-task-catalog", version: "1" }, capabilities: { experimentalApi: true } });
          } else if (message.type === "response" && !message.ok) finish(new Error("Task catalog request was not admitted"));
          else if (message.type === "host/frame" && message.hostId === hostId && message.generation === generation) {
            try {
              const frame = JSON.parse(message.frame);
              if (frame.method || !["init", "list"].includes(frame.id)) return;
              if (frame.error) return finish(new Error("Task conversation catalog is unavailable"));
              if (frame.id === "init") send("list", "thread/list", { limit, searchTerm: search || null, archived: false, cursor: cursor ?? null });
              else finish(null, catalog(frame.result, hostId));
            } catch (error) { finish(error); }
          } else if (message.type === "fatal" || message.type === "host/status" && ["failed", "closed"].includes(message.status.state)) finish(new Error("Task conversation Host closed"));
        },
      }, clientId);
      receive?.({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: clientId });
    } catch (error) { finish(error); }
  });
}
