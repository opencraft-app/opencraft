import type { Socket } from "node:net";

export const OPENCRAFT_DAEMON_PROTOCOL_VERSION = 1 as const;
// Stable handshake identity; branding alone does not change the wire contract.
export const OPENCRAFT_DAEMON_BUILD_ID = "opencraft-daemon-v2" as const;
export const MAX_DAEMON_FRAME_BYTES = 64 * 1024 * 1024;

export type DaemonClientMessage =
  | {
      readonly type: "daemon/hello";
      readonly protocolVersion: typeof OPENCRAFT_DAEMON_PROTOCOL_VERSION;
      readonly buildId: typeof OPENCRAFT_DAEMON_BUILD_ID;
      readonly authToken: string;
      readonly connectionId: string;
      readonly role: "app-host" | "control";
    }
  | { readonly type: "app-host/message"; readonly payload: unknown }
  | { readonly type: "daemon/shutdown" };

export type DaemonServerMessage =
  | {
      readonly type: "daemon/ready";
      readonly protocolVersion: typeof OPENCRAFT_DAEMON_PROTOCOL_VERSION;
      readonly buildId: typeof OPENCRAFT_DAEMON_BUILD_ID;
      readonly pid: number;
    }
  | { readonly type: "app-host/message"; readonly payload: unknown }
  | {
      readonly type: "daemon/fatal";
      readonly code: string;
      readonly message: string;
    }
  | { readonly type: "daemon/shutting-down" };

export function isDaemonClientHello(value: unknown): value is Extract<DaemonClientMessage, { type: "daemon/hello" }> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === "daemon/hello"
    && record.protocolVersion === OPENCRAFT_DAEMON_PROTOCOL_VERSION
    && record.buildId === OPENCRAFT_DAEMON_BUILD_ID
    && typeof record.authToken === "string"
    && record.authToken.length >= 32
    && typeof record.connectionId === "string"
    && record.connectionId.length > 0
    && (record.role === "app-host" || record.role === "control");
}

export class DaemonJsonLineChannel {
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<(error: Error | null) => void>();
  private buffer = "";
  private closed = false;

  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", this.receiveData);
    socket.once("error", this.receiveError);
    socket.once("close", this.receiveClose);
  }

  send(message: DaemonClientMessage | DaemonServerMessage): void {
    if (this.closed || this.socket.destroyed) throw new Error("OpenCraft Daemon IPC channel is closed");
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > MAX_DAEMON_FRAME_BYTES) {
      throw new Error("OpenCraft Daemon IPC frame exceeds the maximum size");
    }
    this.socket.write(frame);
  }

  subscribeMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribeClose(listener: (error: Error | null) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.socket.end();
    this.messageListeners.clear();
    this.closeListeners.clear();
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.socket.destroy();
    this.messageListeners.clear();
    this.closeListeners.clear();
  }

  private readonly receiveData = (chunk: string) => {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_DAEMON_FRAME_BYTES) {
      this.fail(new Error("OpenCraft Daemon IPC receive buffer exceeds the maximum size"));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const source = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (source.length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(source);
      } catch {
        this.fail(new Error("OpenCraft Daemon IPC received invalid JSON"));
        return;
      }
      for (const listener of this.messageListeners) listener(message);
    }
  };

  private readonly receiveError = (error: Error) => {
    if (!this.closed) this.notifyClose(error);
  };

  private readonly receiveClose = () => {
    if (!this.closed) this.notifyClose(null);
  };

  private fail(error: Error): void {
    this.notifyClose(error);
    this.socket.destroy(error);
  }

  private notifyClose(error: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    for (const listener of this.closeListeners) listener(error);
    this.messageListeners.clear();
    this.closeListeners.clear();
  }

  private detach(): void {
    this.socket.off("data", this.receiveData);
    this.socket.off("error", this.receiveError);
    this.socket.off("close", this.receiveClose);
  }
}
