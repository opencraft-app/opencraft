import type {
  DuplexTransport,
  TransportStatus,
} from "@opencraft/appserver-client/transport";

export interface InMemoryAppServerPeer {
  send(frame: string): void;
  close(reason?: string): void;
}

export interface InMemoryAppServer {
  connected?(peer: InMemoryAppServerPeer): void | Promise<void>;
  receive(frame: string, peer: InMemoryAppServerPeer): void | Promise<void>;
  disconnected?(peer: InMemoryAppServerPeer): void | Promise<void>;
}

export interface MemoryTransportOptions {
  server: InMemoryAppServer;
  schedule?: (callback: () => void) => void;
}

export class MemoryTransport implements DuplexTransport {
  private readonly server: InMemoryAppServer;
  private readonly schedule: (callback: () => void) => void;
  private readonly messageListeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private currentStatus: TransportStatus = { state: "idle" };

  private readonly peer: InMemoryAppServerPeer = {
    send: (frame) => {
      if (this.currentStatus.state !== "open") return;
      this.schedule(() => {
        if (this.currentStatus.state !== "open") return;
        for (const listener of this.messageListeners) listener(frame);
      });
    },
    close: (reason) => {
      this.setStatus(reason === undefined ? { state: "closed" } : { state: "closed", reason });
    },
  };

  constructor(options: MemoryTransportOptions | InMemoryAppServer) {
    this.server = "server" in options ? options.server : options;
    this.schedule = "server" in options && options.schedule !== undefined
      ? options.schedule
      : (callback) => queueMicrotask(callback);
  }

  get status(): TransportStatus {
    return this.currentStatus;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("Memory transport connection was aborted");
    if (this.currentStatus.state === "open") return;
    this.setStatus({ state: "connecting" });
    try {
      await this.server.connected?.(this.peer);
      if (signal?.aborted) throw new Error("Memory transport connection was aborted");
      this.setStatus({ state: "open" });
    } catch (error) {
      this.setStatus({ state: "failed", reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async send(frame: string): Promise<void> {
    if (this.currentStatus.state !== "open") throw new Error("Memory transport is not open");
    await this.server.receive(frame, this.peer);
  }

  subscribeMessage(listener: (frame: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.currentStatus.state === "closed") return;
    this.setStatus({ state: "closing" });
    await this.server.disconnected?.(this.peer);
    this.setStatus({ state: "closed" });
  }

  private setStatus(status: TransportStatus): void {
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
