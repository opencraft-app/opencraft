import type { AppServerClient } from "@opencraft/appserver-client";
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
  private readonly subscriptions = new Map<string, { client: AppServerClient; stop(): void }>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  constructor(private readonly manager: ConnectorManager, private readonly resolve: (hostId: string) => Promise<AppServerClient>) {}
  snapshot = (hostId: string) => this.hosts.get(hostId) ?? EMPTY;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(hostId: string, state: ManagedHostState) { if (this.disposed) return; this.hosts.set(hostId, state); for (const listener of this.listeners) listener(); }
  private async client(hostId: string) {
    const client = await this.resolve(hostId);
    if (this.disposed || client.hostId !== hostId) throw new Error("Host unavailable");
    const previous = this.subscriptions.get(hostId);
    if (previous?.client !== client) {
      previous?.stop();
      const stop = client.subscribeNotification(event => { if (event.method === "connectors/managed/changed") void this.load(hostId); });
      this.subscriptions.set(hostId, { client, stop });
    }
    return client;
  }
  async load(hostId: string): Promise<void> {
    const revision = (this.revisions.get(hostId) ?? 0) + 1; this.revisions.set(hostId, revision);
    this.publish(hostId, { ...this.snapshot(hostId), phase: "loading", error: null });
    try {
      const client = await this.client(hostId), data = managedSnapshot(await client.requestRaw("connectors/managed/list", {}));
      if (this.revisions.get(hostId) === revision) this.publish(hostId, { phase: "ready", data, error: null });
    } catch (error) { if (this.revisions.get(hostId) === revision) this.publish(hostId, { phase: "error", data: null, error: connectorErrorMessage("load", error) }); }
  }
  async save(hostId: string, input: ConnectorSave): Promise<ConnectorInstance> {
    const client = await this.client(hostId);
    const row = await client.requestRaw<ConnectorInstance>("connectors/managed/save", input);
    await this.manager.attachManaged(hostId, row.id, row.title); await this.load(hostId); return row;
  }
  async remove(hostId: string, row: ConnectorInstance) { await (await this.client(hostId)).requestRaw("connectors/managed/delete", { id: row.id, revision: row.revision }); await this.load(hostId); }
  async enable(hostId: string, row: ConnectorInstance, enabled: boolean) { await (await this.client(hostId)).requestRaw("connectors/managed/setEnabled", { id: row.id, revision: row.revision, enabled }); await this.load(hostId); }
  async probe(hostId: string, id: string): Promise<ConnectorProbe> { return (await this.client(hostId)).requestRaw("connectors/managed/probe", { id }); }
  async startOAuth(hostId: string, id: string): Promise<ConnectorOAuthProgress> { return (await this.client(hostId)).requestRaw("connectors/managed/oauth/start", { id }); }
  async oauthStatus(hostId: string, id: string): Promise<ConnectorOAuthProgress> { return (await this.client(hostId)).requestRaw("connectors/managed/oauth/status", { id }); }
  async cancelOAuth(hostId: string, id: string) { await (await this.client(hostId)).requestRaw("connectors/managed/oauth/cancel", { id }); }
  async link(hostId: string, row: ConnectorInstance): Promise<string> { return this.manager.attachManaged(hostId, row.id, row.title); }
  dispose() { this.disposed = true; for (const row of this.subscriptions.values()) row.stop(); this.subscriptions.clear(); this.listeners.clear(); }
}
