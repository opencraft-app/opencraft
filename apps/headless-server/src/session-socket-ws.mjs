import { createWebSocketSender } from "@opencraft/relay-protocol/websocket-sender";

/**
 * Node `ws` adapter of the runtime-neutral session socket
 * (`@opencraft/client-session`). Application frames go through the shared
 * Pong-credit sender; `bufferedAmount` is the socket's own unwritten bytes.
 * Socket-level Ping/Pong liveness stays with `trackSocketHeartbeat`.
 *
 * `accept(socket)` returns the session's handler; events are delivered to it
 * in the order `ws` emits them.
 */
export function acceptWsSessionSocket(client, accept) {
  const send = createWebSocketSender(client);
  const socket = {
    get readyState() {
      return client.readyState;
    },
    get bufferedAmount() {
      return client.bufferedAmount;
    },
    send(frame, done) {
      send(frame, done);
    },
    close(code, reason) {
      client.close(code, reason);
    },
    terminate() {
      client.terminate();
    },
  };
  const handler = accept(socket);
  // Text frames are UTF-8 validated by ws; binary frames reach the session as bytes.
  client.on("message", (raw, isBinary) => handler.message(isBinary ? raw : raw.toString(), raw.length));
  client.once("close", (code) => handler.close(code));
  client.once("error", () => handler.error());
  return handler;
}
