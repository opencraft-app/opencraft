import type { ConnectorManagementClient } from "./headless-port";
import type { ConnectorHostSnapshot, ConnectorInstance, ConnectorOAuthProgress, ConnectorProbe, ConnectorSave } from "@opencraft/connector-core";
import type { ConnectorManager } from "./manager";
import { managedSnapshot } from "./managed-provider";
import { connectorErrorMessage } from "./feedback";

export interface ManagedHostState { readonly phase: "idle" | "loading" | "ready" | "error"; readonly data: ConnectorHostSnapshot | null; readonly error: string | null }
const EMPTY: ManagedHostState = Object.freeze({ phase: "idle", data: null, error: null });

/** Application-owned query/mutation port. Secret form drafts are never retained here. */
export class ManagedConnectorController {
  private readonly hosts = new Map<string, ManagedHostState>();
  private readonly revisions = new Map<string, number>();
  private readonly subscriptions = new Map<string, { client: ConnectorManagementClient; stop(): void }>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  private readonly observedHosts = new Set<string>();
  private readonly consumers = new Map<string, number>();
  private readonly loads = new Map<string, { abort: AbortController; promise: Promise<void>; dirty: boolean }>();
  /** View lifetime is separate from application lifetime and background approvals. */
  observe(hostId: string): () => void {
    this.observedHosts.add(hostId);
    this.consumers.set(hostId, (this.consumers.get(hostId) ?? 0) + 1);
    void this.load(hostId);
    let stopped = false;
    return () => {
      if (stopped) return; stopped = true;
      const remaining = (this.consumers.get(hostId) ?? 1) - 1;
      if (remaining > 0) { this.consumers.set(hostId, remaining); return; }
      this.consumers.delete(hostId);
      this.subscriptions.get(hostId)?.stop(); this.subscriptions.delete(hostId);
      this.revisions.set(hostId, (this.revisions.get(hostId) ?? 0) + 1);
      this.loads.get(hostId)?.abort.abort(); this.loads.delete(hostId);
    };
  }
  constructor(private readonly manager: ConnectorManager, private readonly resolve: (hostId: string) => Promise<ConnectorManagementClient>) {}
  snapshot = (hostId: string) => this.hosts.get(hostId) ?? EMPTY;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(hostId: string, state: ManagedHostState) { if (this.disposed) return; this.hosts.set(hostId, state); for (const listener of this.listeners) listener(); }
  private async client(hostId: string, signal?: AbortSignal) {
    const client = await this.resolve(hostId);
    if (this.disposed || client.hostId !== hostId || signal?.aborted) throw new Error("Host unavailable");
    if (this.observedHosts.has(hostId) && !this.consumers.has(hostId)) return client;
    const previous = this.subscriptions.get(hostId);
    if (previous?.client !== client) {
      previous?.stop();
      const stop = client.subscribeNotification(event => {
        if (event.method === "connectors/managed/changed") void this.load(hostId, true);
        else if (event.method === "connectors/managed/unavailable") {
          this.revisions.set(hostId, (this.revisions.get(hostId) ?? 0) + 1);
          this.loads.get(hostId)?.abort.abort(); this.loads.delete(hostId);
          this.publish(hostId, { phase: "error", data: null, error: connectorErrorMessage("load", new Error("Connector authorization-required")) });
        }
      });
      this.subscriptions.set(hostId, { client, stop });
    }
    return client;
  }
  load(hostId: string, changed = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const existing = this.loads.get(hostId);
    if (existing) { existing.dirty ||= changed; return existing.promise; }
    const revision = (this.revisions.get(hostId) ?? 0) + 1; this.revisions.set(hostId, revision);
    const load = { abort: new AbortController(), dirty: false, promise: Promise.resolve() };
    this.loads.set(hostId, load);
    load.promise = Promise.resolve().then(async () => {
      if (load.abort.signal.aborted) return;
      this.publish(hostId, { ...this.snapshot(hostId), phase: "loading", error: null });
      try {
        const client = await this.client(hostId, load.abort.signal);
        if (load.abort.signal.aborted) return;
        const data = managedSnapshot(await client.requestRaw("connectors/managed/list", {}, { signal: load.abort.signal }));
        if (this.revisions.get(hostId) === revision) this.publish(hostId, { phase: "ready", data, error: null });
      } catch (error) { if (this.revisions.get(hostId) === revision) this.publish(hostId, { phase: "error", data: null, error: connectorErrorMessage("load", error) }); }
      finally {
        if (this.loads.get(hostId) === load) {
          this.loads.delete(hostId);
          if (load.dirty && !this.disposed) void this.load(hostId);
        }
      }
    });
    return load.promise;
  }
  async save(hostId: string, input: ConnectorSave): Promise<ConnectorInstance> {
    const client = await this.client(hostId);
    const row = await client.requestRaw<ConnectorInstance>("connectors/managed/save", input);
    await this.manager.attachManaged(hostId, row.id, row.title); await this.load(hostId, true); return row;
  }
  async remove(hostId: string, row: ConnectorInstance) { await (await this.client(hostId)).requestRaw("connectors/managed/delete", { id: row.id, revision: row.revision }); await this.load(hostId, true); }
  async enable(hostId: string, row: ConnectorInstance, enabled: boolean) { await (await this.client(hostId)).requestRaw("connectors/managed/setEnabled", { id: row.id, revision: row.revision, enabled }); await this.load(hostId, true); }
  async probe(hostId: string, id: string): Promise<ConnectorProbe> { return (await this.client(hostId)).requestRaw("connectors/managed/probe", { id }); }
  async startOAuth(hostId: string, id: string): Promise<ConnectorOAuthProgress> { return (await this.client(hostId)).requestRaw("connectors/managed/oauth/start", { id }); }
  async oauthStatus(hostId: string, id: string): Promise<ConnectorOAuthProgress> { return (await this.client(hostId)).requestRaw("connectors/managed/oauth/status", { id }); }
  async cancelOAuth(hostId: string, id: string) { await (await this.client(hostId)).requestRaw("connectors/managed/oauth/cancel", { id }); }
  async link(hostId: string, row: ConnectorInstance): Promise<string> { return this.manager.attachManaged(hostId, row.id, row.title); }
  dispose() { this.disposed = true; for (const load of this.loads.values()) load.abort.abort(); this.loads.clear(); this.consumers.clear(); for (const row of this.subscriptions.values()) row.stop(); this.subscriptions.clear(); this.listeners.clear(); }
}
