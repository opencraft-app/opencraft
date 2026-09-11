import type { AppServerClientConfig } from "./client";
import { JsonRpcAppServerClient, type AppServerClient } from "./client";
import { AppServerClientError } from "./errors";

export type AppServerClientRegistryEvent =
  | { type: "added"; hostId: string; client: AppServerClient }
  | { type: "removed"; hostId: string };

export interface AppServerClientRegistrySnapshot {
  readonly revision: number;
  readonly hostIds: readonly string[];
}

/**
 * Owns exactly one protocol client per logical host. Physical transports may
 * be local WebSockets, SSH-backed Electron bridges, memory servers, or replay
 * fixtures; host identity stays above that transport choice.
 */
export class AppServerClientRegistry {
  private readonly clients = new Map<string, AppServerClient>();
  private readonly eventListeners = new Set<(event: AppServerClientRegistryEvent) => void>();
  private readonly snapshotListeners = new Set<() => void>();
  private revision = 0;
  private snapshot: AppServerClientRegistrySnapshot = { revision: 0, hostIds: [] };
  private closed = false;

  getSnapshot = (): AppServerClientRegistrySnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  };

  subscribeEvent(listener: (event: AppServerClientRegistryEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  create(config: AppServerClientConfig): AppServerClient {
    this.ensureOpen();
    if (this.clients.has(config.hostId)) {
      throw new AppServerClientError(
        "HOST_EXISTS",
        `An AppServer client is already registered for host ${config.hostId}`,
      );
    }
    const client = new JsonRpcAppServerClient(config);
    this.clients.set(config.hostId, client);
    this.publish({ type: "added", hostId: config.hostId, client });
    return client;
  }

  get(hostId: string): AppServerClient | null {
    return this.clients.get(hostId) ?? null;
  }

  getOrThrow(hostId: string): AppServerClient {
    const client = this.get(hostId);
    if (client !== null) return client;
    throw new AppServerClientError(
      "HOST_NOT_FOUND",
      `No AppServer client is registered for host ${hostId}`,
    );
  }

  getAll(): readonly AppServerClient[] {
    return [...this.clients.values()];
  }

  async remove(hostId: string): Promise<boolean> {
    const client = this.clients.get(hostId);
    if (client === undefined) return false;
    this.clients.delete(hostId);
    try {
      await client.close();
    } finally {
      this.publish({ type: "removed", hostId });
    }
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const entries = [...this.clients.entries()];
    this.clients.clear();
    const results = await Promise.allSettled(entries.map(([, client]) => client.close()));
    for (const [hostId] of entries) this.emitEvent({ type: "removed", hostId });
    this.refreshSnapshot();
    this.eventListeners.clear();
    this.snapshotListeners.clear();
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Failed to close one or more AppServer clients");
  }

  private ensureOpen(): void {
    if (this.closed) throw new AppServerClientError("CLOSED", "AppServer client registry is closed");
  }

  private publish(event: AppServerClientRegistryEvent): void {
    this.emitEvent(event);
    this.refreshSnapshot();
  }

  private emitEvent(event: AppServerClientRegistryEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Registry observers do not participate in ownership semantics.
      }
    }
  }

  private refreshSnapshot(): void {
    this.snapshot = {
      revision: ++this.revision,
      hostIds: [...this.clients.keys()],
    };
    for (const listener of this.snapshotListeners) {
      try {
        listener();
      } catch {
        // A view subscriber cannot block host registration or disposal.
      }
    }
  }
}
