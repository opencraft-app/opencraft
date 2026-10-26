import type {
  DuplexTransport,
  TransportStatus,
} from "@opencraft/appserver-client/transport";
import { TransportStatusObservers } from "@opencraft/appserver-client/transport";

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

interface MemoryConnection {
  readonly peer: InMemoryAppServerPeer;
  phase: "connecting" | "open" | "retired";
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
  detach(): void;
  started: boolean;
  admissionDone: boolean;
  cleanup?: Promise<void>;
  closing?: Promise<void>;
}

export class MemoryTransport implements DuplexTransport {
  private readonly server: InMemoryAppServer;
  private readonly schedule: (callback: () => void) => void;
  private readonly messageListeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new TransportStatusObservers();
  private currentStatus: TransportStatus = { state: "idle" };

  private connection: MemoryConnection | null = null;

  constructor(options: MemoryTransportOptions | InMemoryAppServer) {
    this.server = "server" in options ? options.server : options;
    this.schedule = "server" in options && options.schedule !== undefined
      ? options.schedule
      : (callback) => queueMicrotask(callback);
  }

  get status(): TransportStatus {
    return this.currentStatus;
  }

  connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("Memory transport connection was aborted"));
    if (this.connection?.phase === "open") return Promise.resolve();
    if (this.connection?.phase === "connecting") return this.connection.promise;
    let resolve!: () => void, reject!: (cause: unknown) => void;
    const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
    const owner: MemoryConnection = {
      phase: "connecting", promise, resolve, reject, started: false, admissionDone: false,
      detach: () => signal?.removeEventListener("abort", abort),
      peer: {
        send: frame => {
          if (!this.isOpen(owner)) return;
          this.schedule(() => {
            for (const listener of this.messageListeners) {
              if (!this.isOpen(owner)) return;
              listener(frame);
            }
          });
        },
        close: reason => {
          if (!this.isCurrent(owner)) return;
          this.revoke(owner, new Error(reason ?? "Memory peer closed"));
          this.setStatus(reason === undefined ? { state: "closed" } : { state: "closed", reason });
          this.cleanupRetired(owner);
        },
      },
    };
    const abort = () => {
      if (!this.isCurrent(owner) || owner.phase !== "connecting") return;
      this.revoke(owner, new Error("Memory transport connection was aborted"));
      this.setStatus({ state: "closed" });
      this.cleanupRetired(owner);
    };
    this.connection = owner;
    signal?.addEventListener("abort", abort, { once: true });
    this.setStatus({ state: "connecting" });
    if (!this.isCurrent(owner)) return promise;
    if (signal?.aborted) { abort(); return promise; }
    owner.started = true;
    const admitted = () => {
      owner.admissionDone = true;
      if (!this.isCurrent(owner)) { this.cleanupRetired(owner); return; }
      owner.phase = "open";
      owner.detach();
      resolve();
      this.setStatus({ state: "open" });
    };
    const failed = (cause: unknown) => {
      owner.admissionDone = true;
      if (this.isCurrent(owner)) {
        this.revoke(owner, cause);
        this.setStatus({ state: "failed", reason: cause instanceof Error ? cause.message : String(cause) });
      }
      this.cleanupRetired(owner);
    };
    try {
      void Promise.resolve(this.server.connected?.(owner.peer)).then(admitted, failed);
    } catch (cause) { failed(cause); }
    return promise;
  }

  async send(frame: string): Promise<void> {
    const owner = this.connection;
    if (owner === null || !this.isOpen(owner)) throw new Error("Memory transport is not open");
    await this.server.receive(frame, owner.peer);
  }

  subscribeMessage(listener: (frame: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    return this.statusListeners.subscribe(listener, this.currentStatus);
  }

  close(): Promise<void> {
    const owner = this.connection;
    if (owner?.closing !== undefined) return owner.closing;
    if (owner === null || owner.phase === "retired") {
      if (this.currentStatus.state !== "closed") this.setStatus({ state: "closed" });
      return Promise.resolve();
    }
    let resolve!: () => void, reject!: (cause: unknown) => void;
    owner.closing = new Promise<void>((a, b) => { resolve = a; reject = b; });
    this.revoke(owner, new Error("Memory transport closed before opening"));
    this.setStatus({ state: "closing" });
    const complete = () => {
      if (this.connection === owner) this.setStatus({ state: "closed" });
      resolve();
    };
    const cleanup = this.cleanup(owner);
    // Pending admission is not a local close barrier. Its eventual completion
    // starts cleanup for its own peer; it cannot publish through a successor.
    if (cleanup === null) complete();
    else void cleanup.then(complete, cause => {
      if (this.connection === owner) this.setStatus({ state: "failed", reason: cause instanceof Error ? cause.message : String(cause) });
      reject(cause);
    });
    return owner.closing;
  }

  private isCurrent(owner: MemoryConnection): boolean { return this.connection === owner && owner.phase !== "retired"; }
  private isOpen(owner: MemoryConnection): boolean { return this.connection === owner && owner.phase === "open"; }
  private revoke(owner: MemoryConnection, cause: unknown): void {
    owner.phase = "retired";
    owner.detach();
    owner.reject(cause);
  }
  private cleanup(owner: MemoryConnection): Promise<void> | null {
    if (!owner.started || !owner.admissionDone) return null;
    return owner.cleanup ??= Promise.resolve().then(() => this.server.disconnected?.(owner.peer));
  }
  private cleanupRetired(owner: MemoryConnection): void {
    if (owner.phase === "retired") void this.cleanup(owner)?.catch(() => {});
  }

  private setStatus(status: TransportStatus): void {
    this.currentStatus = status;
    this.statusListeners.emit(status, () => this.currentStatus === status);
  }
}
