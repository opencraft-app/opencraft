import type { AppServerClient } from "@opencraft/appserver-client";
import type { AuthenticationService } from "../authentication/authentication-service";
import type { ConversationBindingStore } from "../conversation-binding";
import type { ConnectorRuntime } from "./runtime";
import { createAppServerMcpConnectorProvider } from "./appserver-mcp-provider";
import { McpOAuthAuthenticationProvider, readMcpInventory, type McpInventoryRow } from "./oauth";
import { createManagedConnectorProvider } from "./managed-provider";
import { ManagedConnectorController } from "./managed-controller";
import { connectorErrorMessage, type ConnectorOperation } from "./feedback";
import { emptyConnectorConfiguration, parseConnectorConfiguration, type ConnectorConfiguration, type ConnectorConfigurationRecord, type ConnectorConfigurationStore, type SavedConnector } from "./configuration";

interface Registration { readonly config: SavedConnector; readonly client: AppServerClient; readonly auth?: McpOAuthAuthenticationProvider; readonly stopAuth: () => void; readonly stopProvider: () => Promise<void> }
interface Operation { readonly id: string; readonly owner: string; readonly abort: AbortController }
export interface ConnectorManagerSnapshot {
  readonly revision: number;
  readonly loaded: boolean;
  readonly configuration: ConnectorConfiguration;
  readonly states: Readonly<Record<string, { readonly phase: string; readonly error?: string; readonly authorizationUrl?: string }>>;
  readonly error: string | null;
}
const key = (hostId: string, scopeId: string) => JSON.stringify([hostId, scopeId]);
const providerId = (id: string) => `opencraft.connector.${id}`;

/** Product intent/configuration. No tokens or ephemeral connection handles are persisted. */
export class ConnectorManager {
  readonly managed: ManagedConnectorController;
  private record: ConnectorConfigurationRecord = { revision: 0, value: emptyConnectorConfiguration() };
  private loaded = false;
  private error: string | null = null;
  private disposed = false;
  private saving = false;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly registrations = new Map<string, Registration>();
  private readonly registrationTasks = new Map<string, Promise<Registration>>();
  private readonly selectionIntents = new Map<string, symbol>();
  private readonly operations = new Map<string, Operation>();
  private readonly states = new Map<string, { phase: string; error?: string; authorizationUrl?: string }>();
  private readonly confirmedScopes = new Map<string, Set<string>>();
  private readonly applied = new Map<string, { hostId: string; threadId: string; signature: string }>();
  private readonly listeners = new Set<() => void>();
  private readonly stops: Array<() => void> = [];
  private syncing = false;
  private snapshot: ConnectorManagerSnapshot = { revision: 0, loaded: false, configuration: emptyConnectorConfiguration(), states: {}, error: null };

  private constructor(readonly runtime: ConnectorRuntime, private readonly authService: AuthenticationService,
    private readonly bindings: ConversationBindingStore, private readonly store: ConnectorConfigurationStore,
    private readonly resolveClient: (hostId: string) => Promise<AppServerClient>) {
    this.managed = new ManagedConnectorController(this, resolveClient);
    this.stops.push(runtime.subscribe(() => {
      for (const c of runtime.getSnapshot().connections) if (["authorization-required", "refresh-required", "disconnected", "failed"].includes(c.phase)) {
        const config = this.record.value.connectors.find(row => providerId(row.id) === c.connectorId);
        if (config) for (const selected of this.confirmedScopes.values()) selected.delete(config.id);
      }
      this.syncSelections(); this.publish();
    }), bindings.subscribe(() => this.syncSelections()));
    if (store.subscribe) this.stops.push(store.subscribe(() => { if (!this.saving) void this.reload(); }));
  }
  static async open(runtime: ConnectorRuntime, auth: AuthenticationService, bindings: ConversationBindingStore, store: ConnectorConfigurationStore, resolveClient: (hostId: string) => Promise<AppServerClient>) {
    const manager = new ConnectorManager(runtime, auth, bindings, store, resolveClient); await manager.reload(); return manager;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  async reload(): Promise<void> {
    try {
      const record = await this.store.load();
      if (this.disposed || this.saving) return;
      if (!Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error();
      if (record.revision < this.record.revision) return;
      this.record = { revision: record.revision, value: parseConnectorConfiguration(record.value) };
      this.loaded = true; this.error = null; await this.retireMissing(); this.syncSelections();
    } catch { if (!this.disposed) { this.loaded = false; this.error = "无法读取连接器配置，请重试。"; } }
    if (!this.disposed) this.publish();
  }
  async discover(hostId: string): Promise<readonly McpInventoryRow[]> {
    const client = await this.resolveClient(hostId);
    if (client.hostId !== hostId) throw new Error("Host identity mismatch");
    return readMcpInventory(client);
  }
  async add(hostId: string, server: string): Promise<void> {
    const available = await this.discover(hostId);
    if (!available.some(row => row.name === server)) throw new Error("所选服务已不可用");
    await this.save(value => ({ ...value, connectors: [...value.connectors, { id: crypto.randomUUID(), hostId, server, title: server }] }));
  }
  async attachManaged(hostId: string, instanceId: string, title: string): Promise<string> {
    const existing = this.record.value.connectors.find(c => c.hostId === hostId && c.kind === "managed" && c.server === instanceId);
    if (existing) {
      if (existing.title !== title) await this.save(value => ({ ...value, connectors: value.connectors.map(c => c.id === existing.id ? { ...c, title } : c) }));
      return existing.id;
    }
    const id = crypto.randomUUID();
    await this.save(value => ({ ...value, connectors: [...value.connectors, { id, hostId, server: instanceId, title, kind: "managed" }] }));
    return id;
  }
  savedSelection(hostId: string, scopeId: string, id: string): boolean {
    return this.record.value.selections.find(s => s.hostId === hostId && s.scopeId === scopeId)?.connectorIds.includes(id) === true;
  }
  selectionConfirmed(hostId: string, scopeId: string, id: string): boolean { return this.confirmedScopes.get(key(hostId, scopeId))?.has(id) === true; }
  async select(hostId: string, scopeId: string, id: string, enabled: boolean): Promise<void> {
    const binding = this.bindings.getSnapshot().bindings.find(b => b.scopeId === scopeId && b.hostId === hostId);
    if (!binding) throw new Error("会话目标已失效");
    const scopeKey = key(hostId, scopeId);
    const connection = this.runtime.getSnapshot().connections.find(c => c.connectorId === providerId(id) && c.hostId === hostId && ["ready", "partial"].includes(c.phase));
    if (enabled && !connection) throw new Error("请先连接服务，再为本会话确认使用");
    const intentKey = JSON.stringify([hostId, scopeId, id]), intent = Symbol();
    this.selectionIntents.set(intentKey, intent);
    if (!enabled) { this.confirmedScopes.get(scopeKey)?.delete(id); this.syncSelections(); this.publish(); }
    await this.save(value => {
      const previous = value.selections.find(s => s.hostId === hostId && s.scopeId === scopeId)?.connectorIds ?? [];
      const ids = enabled ? [...new Set([...previous, id])] : previous.filter(value => value !== id);
      return { ...value, selections: [...value.selections.filter(s => s.hostId !== hostId || s.scopeId !== scopeId), { hostId, scopeId, connectorIds: ids }] };
    });
    if (this.disposed || this.selectionIntents.get(intentKey) !== intent) return;
    this.selectionIntents.delete(intentKey);
    if (enabled && (!this.bindings.getSnapshot().bindings.some(b => b.scopeId === scopeId && b.hostId === hostId)
      || !this.runtime.getSnapshot().connections.some(c => c.connectionId === connection!.connectionId && ["ready", "partial"].includes(c.phase)))) {
      throw new Error("保存期间连接已变化，请重新连接并确认本会话使用");
    }
    const confirmed = this.confirmedScopes.get(scopeKey) ?? new Set<string>();
    if (enabled) confirmed.add(id); else confirmed.delete(id);
    this.confirmedScopes.set(scopeKey, confirmed); this.syncSelections(); this.publish();
  }
  async connect(id: string, owner: string): Promise<void> {
    const config = this.config(id); this.cancel(id);
    const operation: Operation = { id: crypto.randomUUID(), owner, abort: new AbortController() };
    this.operations.set(id, operation); this.setState(id, { phase: "connecting" });
    let stage: ConnectorOperation = "connect";
    try {
      const registration = await this.ensureRegistration(config);
      this.ensureOperation(id, operation);
      await registration.auth?.refresh(); this.ensureOperation(id, operation);
      if (registration.auth && registration.auth.getSession().status !== "authenticated") {
        stage = "authorize";
        this.setState(id, { phase: "authorizing" });
        const result = await this.authService.signIn(registration.auth.id);
        this.ensureOperation(id, operation);
        if (result.status === "cancelled") { this.setState(id, { phase: "cancelled" }); return; }
        if (result.status !== "authenticated") throw new Error("Authorization did not complete");
        // Native completion is keyed only by server, not by our operation.
        // Never turn that notification into a grant without a fresh user action.
        this.setState(id, { phase: "authorization-ready" });
        return;
      }
      this.setState(id, { phase: "connecting" });
      const result = await this.runtime.connect(providerId(id), config.hostId, operation.id);
      this.ensureOperation(id, operation);
      this.setState(id, { phase: result.phase }); this.syncSelections();
      if (!["ready", "partial"].includes(result.phase)) throw new Error("Connector not ready");
    } catch (error) {
      if (this.operations.get(id) === operation && !operation.abort.signal.aborted) this.setState(id, { phase: "error", error: connectorErrorMessage(stage, error) });
    } finally { if (this.operations.get(id) === operation) this.operations.delete(id); }
  }
  cancel(id: string): void {
    const operation = this.operations.get(id); if (!operation) return;
    operation.abort.abort(); this.operations.delete(id);
    const registration = this.registrations.get(id);
    if (registration?.auth) void this.authService.cancel(registration.auth.id).catch(() => undefined);
    for (const c of this.runtime.getSnapshot().connections) if (c.operationId === operation.id) void this.runtime.disconnect(c.connectionId);
    this.setState(id, { phase: "cancelled" });
  }
  cancelOwner(owner: string): void { for (const [id, op] of this.operations) if (op.owner === owner) this.cancel(id); }
  async disconnect(id: string): Promise<void> {
    this.cancel(id);
    for (const c of this.runtime.getSnapshot().connections) if (c.connectorId === providerId(id)) await this.runtime.disconnect(c.connectionId);
    this.setState(id, { phase: "disconnected" }); this.syncSelections();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.managed.dispose();
    for (const stop of this.stops) stop();
    for (const id of this.operations.keys()) this.cancel(id);
    await this.tail.catch(() => undefined);
    for (const registration of this.registrations.values()) { await registration.stopProvider(); registration.stopAuth(); registration.auth?.dispose(); }
    this.registrations.clear(); this.listeners.clear(); await this.store.close?.();
  }
  private ensureRegistration(config: SavedConnector): Promise<Registration> {
    const pending = this.registrationTasks.get(config.id);
    if (pending) return pending;
    const task = this.prepareRegistration(config).finally(() => { if (this.registrationTasks.get(config.id) === task) this.registrationTasks.delete(config.id); });
    this.registrationTasks.set(config.id, task); return task;
  }
  private async prepareRegistration(config: SavedConnector): Promise<Registration> {
    const client = await this.resolveClient(config.hostId);
    const existing = this.registrations.get(config.id);
    if (existing?.client === client && existing.config.title === config.title) return existing;
    if (existing) { await existing.stopProvider(); existing.stopAuth(); existing.auth?.dispose(); this.registrations.delete(config.id); }
    if (this.disposed || client.hostId !== config.hostId || !this.record.value.connectors.some(c => c.id === config.id && c.hostId === config.hostId && c.server === config.server)) throw new Error("Retired connector");
    if (config.kind === "managed") {
      const stopProvider = this.runtime.register(`connector:${config.id}`, createManagedConnectorProvider(providerId(config.id), config.title, config.server, this.resolveClient));
      const registration = { config, client, stopAuth() {}, stopProvider }; this.registrations.set(config.id, registration); return registration;
    }
    const auth = new McpOAuthAuthenticationProvider(`connector-auth:${config.id}`, client, config.server, url => {
      if (this.operations.has(config.id)) this.setState(config.id, { phase: "authorizing", ...(url ? { authorizationUrl: url } : {}) });
    });
    const stopAuth = this.authService.register(`connector:${config.id}`, auth);
    try {
      const stopProvider = this.runtime.register(`connector:${config.id}`, createAppServerMcpConnectorProvider({ id: providerId(config.id), title: config.title,
        server: config.server, authenticationProviderId: auth.id, resolveClient: this.resolveClient }));
      const registration = { config, client, auth, stopAuth, stopProvider }; this.registrations.set(config.id, registration); return registration;
    } catch (error) { stopAuth(); auth.dispose(); throw error; }
  }
  private save(change: (value: ConnectorConfiguration) => ConnectorConfiguration): Promise<void> {
    const operation = this.tail.catch(() => undefined).then(async () => {
      if (!this.loaded || this.disposed) throw new Error("配置尚不可写");
      this.saving = true;
      try {
        const result = await this.store.compareAndSet(this.record.revision, parseConnectorConfiguration(change(this.record.value)));
        this.record = { revision: result.record.revision, value: parseConnectorConfiguration(result.record.value) };
        if (!result.updated) throw new Error("配置已在其他窗口改变，请重试");
        this.error = null;
      } finally { this.saving = false; await this.reload(); }
    });
    this.tail = operation; return operation;
  }
  private async retireMissing(): Promise<void> {
    for (const [id, registration] of this.registrations) if (!this.record.value.connectors.some(c => c.id === id && c.hostId === registration.config.hostId && c.server === registration.config.server)) {
      this.cancel(id); await registration.stopProvider(); registration.stopAuth(); registration.auth?.dispose(); this.registrations.delete(id);
    }
  }
  private config(id: string) { const c = this.record.value.connectors.find(c => c.id === id); if (!this.loaded || !c) throw new Error("连接器不存在"); return c; }
  private ensureOperation(id: string, operation: Operation) { if (this.disposed || this.operations.get(id) !== operation || operation.abort.signal.aborted) throw new Error("Cancelled"); this.config(id); }
  private setState(id: string, state: { phase: string; error?: string; authorizationUrl?: string }) { this.states.set(id, state); this.publish(); }
  private syncSelections(): void {
    if (this.syncing || this.disposed) return; this.syncing = true;
    try {
      const wanted = new Set<string>();
      for (const selection of this.record.value.selections) {
        const confirmed = this.confirmedScopes.get(key(selection.hostId, selection.scopeId));
        if (!confirmed?.size) continue;
        const binding = this.bindings.getSnapshot().bindings.find(b => b.scopeId === selection.scopeId && b.hostId === selection.hostId);
        if (!binding?.conversationKey) continue;
        const scope = { hostId: selection.hostId, threadId: binding.conversationKey.threadId }, scopeKey = key(scope.hostId, scope.threadId); wanted.add(scopeKey);
        const ids = this.runtime.getSnapshot().connections.filter(c => c.hostId === scope.hostId && selection.connectorIds.some(id => confirmed.has(id) && providerId(id) === c.connectorId) && ["ready", "partial"].includes(c.phase)).map(c => c.connectionId).sort();
        const signature = JSON.stringify(ids); if (this.applied.get(scopeKey)?.signature === signature) continue;
        this.applied.set(scopeKey, { ...scope, signature }); this.runtime.select(scope, ids);
      }
      for (const [scopeKey, applied] of this.applied) if (!wanted.has(scopeKey)) { this.applied.delete(scopeKey); this.runtime.releaseScope(applied); }
    } finally { this.syncing = false; }
  }
  private publish() {
    const states = Object.fromEntries(this.states);
    for (const c of this.runtime.getSnapshot().connections) {
      const config = this.record.value.connectors.find(row => providerId(row.id) === c.connectorId);
      if (config && !this.operations.has(config.id) && states[config.id]?.phase !== "authorization-ready") states[config.id] = { ...states[config.id], phase: c.phase, authorizationUrl: undefined };
    }
    this.snapshot = Object.freeze({ revision: this.snapshot.revision + 1, loaded: this.loaded, configuration: structuredClone(this.record.value), states, error: this.error });
    for (const listener of this.listeners) listener();
  }
}
