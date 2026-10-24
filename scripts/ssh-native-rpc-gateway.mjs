import { APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol/version";
// OpenCraft native gateway; Host remains the logical routing owner.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
async function createSshNativeRpcGateway(appHostServer, { connectTimeoutMs = 3e4 } = {}) {
  const http = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const sockets = /* @__PURE__ */ new Set();
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  http.on("upgrade", (request, socket, head) => {
    if (request.url !== "/rpc") {
      socket.destroy();
      return;
    }
    ws.handleUpgrade(request, socket, head, (client) => ws.emit("connection", client));
  });
  ws.on("connection", (socket) => {
    const id = `ssh-native:${randomUUID()}`;
    const leaseId = randomUUID();
    let receive;
    let connection;
    let generation;
    let closed = false;
    let sequence = 0;
    let pendingBytes = 0;
    const pending = [];
    const sends = /* @__PURE__ */ new Map();
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      pending.length = 0;
      sends.clear();
      connection?.close();
      socket.terminate();
    };
    const deadline = setTimeout(close, connectTimeoutMs);
    const write = (frame) => {
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 16 * 1024 * 1024) {
        close();
        return;
      }
      socket.send(frame, (error) => {
        if (error) close();
      });
    };
    const send = (frame) => {
      const requestId = `send:${++sequence}`;
      if (sends.size >= 256) {
        close();
        return;
      }
      sends.set(requestId, frame);
      receive?.({ type: "host/send", requestId, hostId: "local-codex", leaseId, generation, frame });
    };
    socket.on("error", close);
    socket.once("close", close);
    socket.on("message", (data, binary) => {
      if (closed) return;
      if (binary) {
        close();
        return;
      }
      const frame = data.toString();
      try {
        const value = JSON.parse(frame);
        if (!value || typeof value !== "object" || Array.isArray(value) || "__opencraftClient" in value) {
          close();
          return;
        }
      } catch {
        close();
        return;
      }
      if (generation === void 0) {
        pendingBytes += Buffer.byteLength(frame);
        if (pending.length >= 256 || pendingBytes > 16 * 1024 * 1024) {
          close();
          return;
        }
        pending.push(frame);
      } else send(frame);
    });
    try {
      connection = appHostServer.accept({
        subscribe(listener) {
          receive = listener;
          return () => {
            receive = void 0;
          };
        },
        start() {
        },
        close() {
        },
        postMessage(message) {
          if (closed) return;
          if (message.type === "ready") {
            receive?.({ type: "host/connect", requestId: "connect", hostId: "local-codex", leaseId });
          } else if (message.type === "response" && message.requestId === "connect") {
            if (!message.ok || !Number.isSafeInteger(message.result?.generation)) {
              close();
              return;
            }
            generation = message.result.generation;
            clearTimeout(deadline);
            for (const frame of pending.splice(0)) send(frame);
            pendingBytes = 0;
          } else if (message.type === "response" && sends.has(message.requestId)) {
            const frame = sends.get(message.requestId);
            sends.delete(message.requestId);
            if (!message.ok) {
              const request = JSON.parse(frame);
              if (request.id !== void 0 && typeof request.method === "string") write(JSON.stringify({ id: request.id, error: { code: -32e3, message: "Host delivery failed; outcome is unknown" } }));
              else close();
            }
          } else if (message.type === "host/frame") {
            if (message.hostId === "local-codex" && message.generation === generation) write(message.frame);
          } else if (message.type === "fatal" || message.type === "host/status" && ["failed", "closed"].includes(message.status.state)) close();
        }
      }, id);
      receive?.({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: id });
    } catch {
      close();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => {
        http.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    ws.close();
    throw error;
  }
  return {
    port: http.address().port,
    async close() {
      for (const client of ws.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise((resolve) => ws.close(resolve)), new Promise((resolve) => http.close(resolve))]);
    }
  };
}
export {
  createSshNativeRpcGateway
};
