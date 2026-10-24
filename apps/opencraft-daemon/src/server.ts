import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";

import {
  type AppHostServer,
  type AppHostServerConnection,
  type AppHostServerPort,
} from "@opencraft/app-host-server";
import {
  DaemonJsonLineChannel,
  OPENCRAFT_DAEMON_BUILD_ID,
  OPENCRAFT_DAEMON_PROTOCOL_VERSION,
  isDaemonClientHello,
  type DaemonClientMessage,
  type DaemonStorageSummary,
} from "@opencraft/daemon-ipc";

export interface OpenCraftDaemonServerOptions {
  readonly storage?: readonly DaemonStorageSummary[];
  readonly endpoint: string;
  readonly authToken: string;
  readonly appHost: AppHostServer;
  readonly onShutdownRequested: () => void;
}

function isNamedPipe(endpoint: string): boolean {
  return endpoint.startsWith("\\\\.\\pipe\\");
}

function sameSecret(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

class SocketAppHostPort implements AppHostServerPort {
  private readonly listeners = new Set<(message: unknown) => void>();

  constructor(private readonly channel: DaemonJsonLineChannel) {}

  postMessage(message: Parameters<AppHostServerPort["postMessage"]>[0]): void {
    this.channel.send({ type: "app-host/message", payload: message });
  }

  subscribe(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  receive(message: unknown): void {
    for (const listener of this.listeners) listener(message);
  }

  start(): void {}
  close(): void { this.listeners.clear(); }
}

export interface OpenCraftDaemonServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

export async function startOpenCraftDaemonServer(options: OpenCraftDaemonServerOptions): Promise<OpenCraftDaemonServer> {
  const sockets = new Set<Socket>();
  const connections = new Set<AppHostServerConnection>();
  let closed = false;
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const channel = new DaemonJsonLineChannel(socket);
    let authenticated = false;
    let role: "app-host" | "control" | null = null;
    let appHostConnection: AppHostServerConnection | null = null;
    let appHostPort: SocketAppHostPort | null = null;
    const handshakeTimeout = setTimeout(() => {
      if (!authenticated) channel.destroy();
    }, 5_000);
    handshakeTimeout.unref();

    const unsubscribeMessage = channel.subscribeMessage((value) => {
      if (!authenticated) {
        if (!isDaemonClientHello(value) || !sameSecret(value.authToken, options.authToken)) {
          channel.send({ type: "daemon/fatal", code: "UNAUTHORIZED", message: "Invalid OpenCraft Daemon handshake" });
          channel.close();
          return;
        }
        authenticated = true;
        role = value.role;
        clearTimeout(handshakeTimeout);
        if (role === "app-host") {
          appHostPort = new SocketAppHostPort(channel);
          appHostConnection = options.appHost.accept(appHostPort, value.connectionId);
          connections.add(appHostConnection);
        }
        channel.send({
          type: "daemon/ready",
          ...(options.storage === undefined ? {} : {
            // Older clients validate a closed five-name list. Preserve that wire projection.
            storage: options.storage.filter(row => row.hostId === undefined && ["session-routing", "threads", "executions", "host-documents", "managed-connectors"].includes(row.name)),
            storageOutcomes: options.storage,
          }),
          protocolVersion: OPENCRAFT_DAEMON_PROTOCOL_VERSION,
          buildId: OPENCRAFT_DAEMON_BUILD_ID,
          pid: process.pid,
        });
        return;
      }
      const message = value as DaemonClientMessage;
      if (role === "app-host" && message.type === "app-host/message") {
        appHostPort?.receive(message.payload);
        return;
      }
      if (role === "control" && message.type === "daemon/shutdown") {
        channel.send({ type: "daemon/shutting-down" });
        // Let the acknowledgement reach Electron before shutdown destroys all
        // accepted sockets. A microtask runs before the socket write flushes.
        setImmediate(options.onShutdownRequested);
      }
    });
    channel.subscribeClose(() => {
      clearTimeout(handshakeTimeout);
      unsubscribeMessage();
      if (appHostConnection !== null) {
        connections.delete(appHostConnection);
        appHostConnection.close();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (!isNamedPipe(options.endpoint)) await chmod(options.endpoint, 0o600);

  return {
    endpoint: options.endpoint,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const connection of connections) connection.close();
      connections.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!isNamedPipe(options.endpoint)) await unlink(options.endpoint).catch(() => undefined);
    },
  };
}
