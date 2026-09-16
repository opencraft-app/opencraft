import { Service, type Context } from "@deepseek-ai/cordis";
import { concatBytes, utf8Encode } from "../runtime/bytes.ts";
import {
  VirtualWebSocketServer,
  type VirtualWebSocketConnection,
} from "../runtime/virtual-websocket.ts";
import type { HostUserDirectoryPort } from "../types/host-policy.ts";

interface DirectIdentityParams {
  connectionId: string;
  remoteAddr?: string;
  username: string;
}

interface DirectWebSocketContext extends Context {
  userDirectory: HostUserDirectoryPort & {
    identityForDirectWebSocket(params: DirectIdentityParams): unknown | null;
  };
}

interface DirectWebSocketMetadata {
  connectionId: string;
  remoteAddr?: string;
  headers?: Record<string, string | undefined>;
  dataBytes?: ArrayLike<number>;
}

interface DirectWebSocketResult {
  allow: boolean;
  stdoutBytes: Uint8Array | number[];
  closeAfterWrite?: boolean;
  sensitive?: boolean;
}

export const webSocketVServer = new VirtualWebSocketServer();

export class DirectWebSocketTransportService extends Service {
  static inject = ["userDirectory"];

  declare protected ctx: DirectWebSocketContext;
  private readonly connections = new Map<string, VirtualWebSocketConnection>();

  constructor(ctx: DirectWebSocketContext) {
    super(ctx, "directWebSocketTransport");
  }

  open(metadata: DirectWebSocketMetadata): DirectWebSocketResult {
    const username = String(metadata.headers?.["x-hypernode-user"] ?? "root").trim() || "root";
    const identity = this.ctx.userDirectory.identityForDirectWebSocket({
      connectionId: metadata.connectionId,
      ...(metadata.remoteAddr === undefined ? {} : { remoteAddr: metadata.remoteAddr }),
      username,
    });
    if (identity == null) {
      const body = utf8Encode("Direct WebSocket authentication is disabled outside debug mode.\n");
      const head = utf8Encode([
        "HTTP/1.1 401 Unauthorized",
        "Content-Type: text/plain; charset=utf-8",
        `Content-Length: ${body.length}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
      return {
        allow: true,
        closeAfterWrite: true,
        sensitive: true,
        stdoutBytes: concatBytes(head, body),
      };
    }
    this.connections.set(metadata.connectionId, webSocketVServer.connect(
      `direct-websocket:${metadata.connectionId}`,
      { connectionId: metadata.connectionId, identity, transport: "direct-websocket" },
    ));
    return { allow: true, stdoutBytes: [] };
  }

  data(metadata: DirectWebSocketMetadata): DirectWebSocketResult {
    const connection = this.connections.get(metadata.connectionId);
    if (!connection) return { allow: false, stdoutBytes: [] };
    const stdoutBytes = connection.feed(Uint8Array.from(metadata.dataBytes ?? []));
    return { allow: true, sensitive: connection.lastOutputSensitive, stdoutBytes };
  }

  poll(metadata: DirectWebSocketMetadata): DirectWebSocketResult {
    const connection = this.connections.get(metadata.connectionId);
    if (!connection) return { allow: false, stdoutBytes: [] };
    const stdoutBytes = connection.poll();
    return { allow: true, sensitive: connection.lastOutputSensitive, stdoutBytes };
  }

  close(metadata: DirectWebSocketMetadata): DirectWebSocketResult {
    this.connections.get(metadata.connectionId)?.close();
    this.connections.delete(metadata.connectionId);
    return { allow: true, stdoutBytes: [] };
  }
}
