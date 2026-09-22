import type { ConnectorAuthorizationPort, ConnectorCapabilityIdentity, ConnectorCapabilityView, ConnectorContribution, ConnectorDiscoveredTool, ConnectorProvider, ConnectorResource, ConnectorScope, ConnectorSkillResource, ConnectorSnapshot, ConnectorTool, ConnectorToolResource } from "./contract";
import { cancellable, ConnectorError, objectInput } from "./lifetime";
import type { ConnectorApprovalPort } from "./approvals";

interface Registration { readonly owner: string; readonly provider: ConnectorProvider }
interface ToolSet { readonly contributionId: string; readonly resource: ConnectorToolResource; readonly tools: readonly ConnectorTool[] }
interface Connection {
  readonly registration: Registration;
  readonly epoch: number | null;
  readonly abort: AbortController;
  snapshot: ConnectorSnapshot;
  readonly resources: ConnectorResource[];
  readonly toolSets: ToolSet[];
  readonly subscriptions: Array<() => void>;
  operation?: Promise<ConnectorSnapshot>;
}
interface Handle { readonly connection: Connection; readonly scope: ConnectorScope; readonly set: ToolSet; readonly tool: ConnectorTool }
const scopeKey = (scope: ConnectorScope) => JSON.stringify([scope.hostId, scope.threadId]);
const connectionKey = (id: string, hostId: string) => JSON.stringify([id, hostId]);
const digestText = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};
const schemaDigest = (tool: ConnectorTool) => digestText(JSON.stringify(tool.inputSchema));

/** Application-lifetime coordinator. Providers still own credentials, installation and transports. */
export class ConnectorRuntime {
  private readonly providers = new Map<string, Registration>();
  private readonly connections = new Map<string, Connection>();
  private readonly selections = new Map<string, Set<string>>();
  private readonly selectionGenerations = new Map<string, number>();
  private readonly handles = new Map<string, Handle>();
  private readonly listeners = new Set<() => void>();
  private readonly activeCalls = new Map<AbortController, Handle>();
  private readonly unsubscribeAuth: () => void;
  private disposed = false;
  private revision = 0;
  private snapshot: { readonly revision: number; readonly connections: readonly ConnectorSnapshot[] } = Object.freeze({ revision: 0, connections: Object.freeze([]) });

  constructor(private readonly authentication: ConnectorAuthorizationPort, private readonly timeoutMs = 30000,
    private readonly options: { readonly approvals?: ConnectorApprovalPort; readonly invocationTimeoutMs?: number } = {}) {
    this.unsubscribeAuth = authentication.subscribe(() => {
      for (const connection of this.connections.values()) if (!connection.abort.signal.aborted && !this.authorized(connection)) {
        void this.retire(connection, "authorization-required");
      }
    });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  getSnapshot = () => this.snapshot;
  listProviders() { return [...this.providers.values()].map(({ provider: p }) => ({ id: p.id, title: p.title, authenticationProviderId: p.authenticationProviderId ?? null, contributions: p.contributions.map(c => ({ id: c.id, kind: c.kind })) })); }

  register(owner: string, provider: ConnectorProvider): () => Promise<void> {
    if (this.disposed || this.providers.has(provider.id)) throw new ConnectorError("unavailable");
    if (!provider.id || !provider.title || provider.contributions.length === 0 || provider.contributions.length > 32
      || new Set(provider.contributions.map(c => c.id)).size !== provider.contributions.length) throw new ConnectorError("invalid-input");
    const registration: Registration = { owner, provider: { ...provider, contributions: provider.contributions.map(c => ({ ...c })) } };
    this.providers.set(provider.id, registration); this.publish();
    return async () => {
      if (this.providers.get(provider.id) !== registration) return;
      this.providers.delete(provider.id);
      await Promise.all([...this.connections.values()].filter(c => c.registration === registration).map(c => this.retire(c, "disconnected")));
      this.publish();
    };
  }

  connect(connectorId: string, hostId: string, operationId: string): Promise<ConnectorSnapshot> {
    const registration = this.providers.get(connectorId);
    if (this.disposed || !registration || !hostId || !operationId) return Promise.reject(new ConnectorError("unavailable"));
    const key = connectionKey(connectorId, hostId), previous = this.connections.get(key);
    if (previous?.registration === registration && previous.snapshot.operationId === operationId) return previous.operation ?? Promise.resolve(structuredClone(previous.snapshot));
    if (this.connections.size >= 128 && !previous) return Promise.reject(new ConnectorError("unavailable"));
    if (previous) void this.retire(previous, "disconnected");
    const authId = registration.provider.authenticationProviderId;
    const auth = authId ? this.authentication.getSession(authId) : null;
    const connection: Connection = {
      registration, epoch: auth?.status === "authenticated" ? auth.epoch : null,
      abort: new AbortController(), resources: [], toolSets: [], subscriptions: [],
      snapshot: { connectionId: crypto.randomUUID(), connectorId, hostId, operationId,
        phase: authId && auth?.status !== "authenticated" ? "authorization-required" : "preparing", contributions: [] },
    };
    this.connections.set(key, connection); this.publish();
    if (connection.snapshot.phase === "authorization-required") return Promise.resolve(structuredClone(connection.snapshot));
    const timer = setTimeout(() => connection.abort.abort(), this.timeoutMs);
    connection.operation = (async () => {
      const results = await Promise.all(registration.provider.contributions.map(c => this.prepare(connection, c)));
      if (this.current(connection) && !connection.abort.signal.aborted && this.authorized(connection)) {
        const ready = results.filter(c => c.phase === "ready").length;
        connection.snapshot = { ...connection.snapshot, phase: ready === results.length ? "ready" : ready > 0 ? "partial" : "failed", contributions: results };
        this.publish();
      } else if (this.current(connection) && connection.snapshot.phase === "preparing") await this.retire(connection, "failed");
      return structuredClone(connection.snapshot);
    })().finally(() => { clearTimeout(timer); connection.operation = undefined; });
    return connection.operation;
  }

  disconnect(connectionId: string): Promise<void> {
    const c = [...this.connections.values()].find(c => c.snapshot.connectionId === connectionId);
    return c ? this.retire(c, "disconnected") : Promise.resolve();
  }
  select(scope: ConnectorScope, connectionIds: readonly string[]): void {
    if (this.disposed || !scope.hostId || !scope.threadId) throw new ConnectorError("unavailable");
    if (!this.selections.has(scopeKey(scope)) && this.selections.size >= 4096) throw new ConnectorError("unavailable");
    for (const id of connectionIds) if (![...this.connections.values()].some(c => c.snapshot.connectionId === id && c.snapshot.hostId === scope.hostId)) throw new ConnectorError("invalid-input");
    this.releaseScope(scope);
    const key = scopeKey(scope);
    this.selections.set(key, new Set(connectionIds));
    this.selectionGenerations.set(key, (this.selectionGenerations.get(key) ?? 0) + 1);
    this.publish();
  }
  releaseScope(scope: ConnectorScope): void {
    const key = scopeKey(scope); this.selections.delete(key);
    this.selectionGenerations.set(key, (this.selectionGenerations.get(key) ?? 0) + 1);
    for (const [id, h] of this.handles) if (scopeKey(h.scope) === key) this.handles.delete(id);
    for (const [abort, h] of this.activeCalls) if (scopeKey(h.scope) === key) abort.abort();
  }
  /**
   * Read the current scoped catalog without issuing invocation handles. This is
   * the sole Connector -> AgentCapabilityRuntime projection seam.
   */
  async inspectCapabilities(scope: ConnectorScope, signal: AbortSignal): Promise<ConnectorCapabilityView> {
    if (signal.aborted) throw new ConnectorError("cancelled");
    const key = scopeKey(scope), selected = this.selections.get(key);
    if (!selected || this.disposed) return { revision: `connector-v1-${this.selectionGenerations.get(key) ?? 0}-empty`, entries: [] };
    const generation = this.selectionGenerations.get(key) ?? 0;
    const entries: Array<ConnectorCapabilityView["entries"][number]> = [];
    for (const connection of this.connections.values()) {
      if (!selected.has(connection.snapshot.connectionId) || connection.snapshot.hostId !== scope.hostId || !this.usable(connection)) continue;
      for (const set of connection.toolSets) {
        const accessSignal = AbortSignal.any([signal, connection.abort.signal, AbortSignal.timeout(this.timeoutMs)]);
        const allowed = await cancellable(Promise.resolve().then(() => set.resource.checkAccess({ ...scope, signal: accessSignal })), accessSignal);
        if (!allowed) {
          if (this.usable(connection)) await this.retire(connection, "refresh-required");
          throw new ConnectorError("unavailable");
        }
        if (!this.usable(connection) || this.selections.get(key) !== selected || (this.selectionGenerations.get(key) ?? 0) !== generation) throw new ConnectorError("stale-cursor");
        for (const tool of set.tools) {
          if (!tool.readOnly && !this.options.approvals) continue;
          entries.push({
            ...tool,
            connectorId: connection.snapshot.connectorId,
            connectorTitle: connection.registration.provider.title,
            identity: {
              connectionId: connection.snapshot.connectionId,
              contributionId: set.contributionId,
              toolName: tool.name,
              schemaDigest: schemaDigest(tool),
            },
          });
        }
      }
    }
    const digest = digestText(JSON.stringify(entries.map(entry => [entry.identity, entry.connectorId, entry.description, entry.readOnly])));
    return { revision: `connector-v1-${generation}-${digest}`, entries };
  }

  /** Resolve one exact capability into a short-lived invocation handle. */
  async openCapability(scope: ConnectorScope, identity: ConnectorCapabilityIdentity, signal: AbortSignal): Promise<ConnectorDiscoveredTool> {
    if (signal.aborted) throw new ConnectorError("cancelled");
    const connection = [...this.connections.values()].find(candidate => candidate.snapshot.connectionId === identity.connectionId);
    const selected = this.selections.get(scopeKey(scope));
    if (!connection || !selected?.has(identity.connectionId) || connection.snapshot.hostId !== scope.hostId || !this.usable(connection)) throw new ConnectorError("stale-handle");
    const set = connection.toolSets.find(candidate => candidate.contributionId === identity.contributionId);
    const tool = set?.tools.find(candidate => candidate.name === identity.toolName);
    if (!set || !tool || schemaDigest(tool) !== identity.schemaDigest || (!tool.readOnly && !this.options.approvals)) throw new ConnectorError("stale-handle");
    const accessSignal = AbortSignal.any([signal, connection.abort.signal, AbortSignal.timeout(this.timeoutMs)]);
    if (!await cancellable(Promise.resolve().then(() => set.resource.checkAccess({ ...scope, signal: accessSignal })), accessSignal)) {
      if (this.usable(connection)) await this.retire(connection, "refresh-required");
      throw new ConnectorError("unavailable");
    }
    if (!this.usable(connection) || this.selections.get(scopeKey(scope)) !== selected) throw new ConnectorError("stale-handle");
    const handle = crypto.randomUUID();
    this.handles.set(handle, { connection, scope: { ...scope }, set, tool });
    while (this.handles.size > 4096) this.handles.delete(this.handles.keys().next().value!);
    return { ...structuredClone(tool), connectorId: connection.snapshot.connectorId, handle };
  }
  releaseCapabilityHandle(scope: ConnectorScope, handle: string): void {
    const current = this.handles.get(handle);
    if (current && scopeKey(current.scope) === scopeKey(scope) && ![...this.activeCalls.values()].includes(current)) this.handles.delete(handle);
  }
  async discover(scope: ConnectorScope, signal: AbortSignal): Promise<readonly ConnectorDiscoveredTool[]> {
    if (signal.aborted) throw new ConnectorError("cancelled");
    const selected = this.selections.get(scopeKey(scope));
    if (!selected || this.disposed) return [];
    const result: ConnectorDiscoveredTool[] = [];
    for (const c of this.connections.values()) {
      if (!selected.has(c.snapshot.connectionId) || c.snapshot.hostId !== scope.hostId || !this.usable(c)) continue;
      for (const set of c.toolSets) {
        const accessSignal = AbortSignal.any([signal, c.abort.signal, AbortSignal.timeout(this.timeoutMs)]);
        const allowed = await cancellable(Promise.resolve().then(() => set.resource.checkAccess({ ...scope, signal: accessSignal })), accessSignal);
        if (!allowed) { if (this.usable(c)) await this.retire(c, "refresh-required"); break; }
        if (!this.usable(c) || this.selections.get(scopeKey(scope)) !== selected) continue;
        for (const tool of set.tools) {
          if (!tool.readOnly && !this.options.approvals) continue;
          const handle = crypto.randomUUID();
          this.handles.set(handle, { connection: c, scope: { ...scope }, set, tool });
          result.push({ ...structuredClone(tool), connectorId: c.snapshot.connectorId, handle });
        }
      }
    }
    while (this.handles.size > 4096) this.handles.delete(this.handles.keys().next().value!);
    return result;
  }
  async invoke(scope: ConnectorScope, handle: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    const h = this.handles.get(handle);
    if (!h || scopeKey(h.scope) !== scopeKey(scope) || !this.selected(h) || !this.usable(h.connection)) throw new ConnectorError("stale-handle");
    const args = objectInput(input), abort = new AbortController();
    const combined = AbortSignal.any([signal, abort.signal, h.connection.abort.signal]);
    const timer = setTimeout(() => abort.abort(), this.options.invocationTimeoutMs ?? (this.options.approvals ? 120000 : this.timeoutMs));
    this.activeCalls.set(abort, h);
    try {
      if (combined.aborted) throw new ConnectorError("cancelled");
      if (!await cancellable(Promise.resolve().then(() => h.set.resource.checkAccess({ ...scope, signal: combined })), combined)) {
        await this.retire(h.connection, "refresh-required");
        throw new ConnectorError("unavailable");
      }
      if (!this.usable(h.connection) || !this.selected(h)) throw new ConnectorError("stale-handle");
      if (!h.tool.readOnly) {
        const approvals = this.options.approvals;
        if (!approvals || !await cancellable(approvals.request({ ...scope, connectionId: h.connection.snapshot.connectionId,
          connectorId: h.connection.snapshot.connectorId, connectorTitle: h.connection.registration.provider.title,
          tool: h.tool.name, description: h.tool.description, arguments: args }, combined), combined)) throw new ConnectorError("approval-denied");
        if (!this.usable(h.connection) || !this.selected(h) || combined.aborted) throw new ConnectorError("stale-handle");
        if (!await cancellable(Promise.resolve().then(() => h.set.resource.checkAccess({ ...scope, signal: combined })), combined)) {
          await this.retire(h.connection, "refresh-required");
          throw new ConnectorError("unavailable");
        }
      }
      if (combined.aborted) throw new ConnectorError("cancelled");
      const value = await cancellable(Promise.resolve().then(() => {
        if (combined.aborted) throw new ConnectorError("cancelled");
        if (!this.usable(h.connection) || !this.selected(h)) throw new ConnectorError("stale-handle");
        return h.set.resource.call(h.tool.name, args, { ...scope, signal: combined });
      }), combined);
      if (!this.usable(h.connection) || !this.selected(h)) throw new ConnectorError("stale-handle");
      return value;
    } finally { clearTimeout(timer); this.activeCalls.delete(abort); }
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.unsubscribeAuth();
    await Promise.all([...this.connections.values()].map(c => this.retire(c, "disconnected")));
    this.providers.clear(); this.connections.clear(); this.selections.clear(); this.selectionGenerations.clear(); this.handles.clear(); this.listeners.clear();
  }
  private async prepare(c: Connection, contribution: ConnectorContribution): Promise<ConnectorSnapshot["contributions"][number]> {
    const base = { id: contribution.id, kind: contribution.kind };
    let acquired: ConnectorResource | undefined;
    try {
      const authId = c.registration.provider.authenticationProviderId;
      const resource = await cancellable<ConnectorToolResource | ConnectorSkillResource>(Promise.resolve().then<ConnectorToolResource | ConnectorSkillResource>(() => {
        if (c.abort.signal.aborted) throw new ConnectorError("cancelled");
        return contribution.prepare({ target: { hostId: c.snapshot.hostId }, signal: c.abort.signal,
          authorization: authId && c.epoch !== null ? { providerId: authId, epoch: c.epoch } : null });
      }), c.abort.signal, resource => resource.dispose());
      if (!resource || typeof resource.dispose !== "function") throw new ConnectorError("invalid-input");
      const dispose = resource.dispose.bind(resource);
      let disposal: Promise<void> | undefined;
      acquired = { dispose: () => disposal ??= Promise.resolve().then(dispose) };
      if (!this.usable(c)) { await acquired.dispose(); return { ...base, phase: "failed" }; }
      c.resources.push(acquired);
      if (contribution.kind === "skills") {
        const receipt = (resource as ConnectorSkillResource).receipt;
        if (!receipt?.installationId || !["applied", "pending", "unsupported"].includes(receipt.refresh)) throw new ConnectorError("invalid-input");
        return { ...base, phase: receipt.refresh === "applied" ? "ready" : receipt.refresh };
      }
      const toolResource = resource as ConnectorToolResource;
      if (!Array.isArray(toolResource.tools) || toolResource.tools.length > 256 || typeof toolResource.checkAccess !== "function" || typeof toolResource.call !== "function") throw new ConnectorError("invalid-input");
      const tools = toolResource.tools.map(tool => {
        if (!tool.name || typeof tool.description !== "string" || typeof tool.readOnly !== "boolean") throw new ConnectorError("invalid-input");
        return { name: tool.name, description: tool.description, readOnly: tool.readOnly, inputSchema: objectInput(tool.inputSchema) };
      });
      if (new Set(tools.map(t => t.name)).size !== tools.length) throw new ConnectorError("invalid-input");
      c.toolSets.push({ contributionId: contribution.id, resource: { tools, checkAccess: toolResource.checkAccess.bind(toolResource), call: toolResource.call.bind(toolResource), dispose: acquired.dispose }, tools });
      if (toolResource.subscribeInvalidated) {
        const stop = toolResource.subscribeInvalidated(() => { if (this.usable(c)) void this.retire(c, "refresh-required"); });
        if (this.usable(c)) c.subscriptions.push(stop); else stop();
      }
      return { ...base, phase: "ready" };
    } catch {
      if (acquired) {
        const index = c.resources.indexOf(acquired);
        if (index >= 0) c.resources.splice(index, 1);
        await Promise.resolve().then(() => acquired!.dispose()).catch(() => undefined);
      }
      return { ...base, phase: "failed" };
    }
  }
  private current(c: Connection) { return this.connections.get(connectionKey(c.snapshot.connectorId, c.snapshot.hostId)) === c && this.providers.get(c.snapshot.connectorId) === c.registration; }
  private authorized(c: Connection) { const id = c.registration.provider.authenticationProviderId; if (!id) return true; const s = this.authentication.getSession(id); return s?.status === "authenticated" && s.epoch === c.epoch; }
  private usable(c: Connection) { return !this.disposed && this.current(c) && !c.abort.signal.aborted && this.authorized(c); }
  private selected(h: Handle) { return this.selections.get(scopeKey(h.scope))?.has(h.connection.snapshot.connectionId) === true; }
  private async retire(c: Connection, phase: ConnectorSnapshot["phase"]): Promise<void> {
    c.abort.abort(); c.snapshot = { ...c.snapshot, phase, contributions: [] }; c.toolSets.length = 0;
    for (const [id, h] of this.handles) if (h.connection === c) this.handles.delete(id);
    for (const stop of c.subscriptions.splice(0)) { try { stop(); } catch { /* Revocation still takes effect. */ } }
    const resources = c.resources.splice(0); this.publish();
    await Promise.allSettled(resources.map(r => Promise.resolve().then(() => r.dispose())));
  }
  private publish() {
    this.snapshot = Object.freeze({ revision: ++this.revision, connections: Object.freeze([...this.connections.values()].map(c => Object.freeze({ ...c.snapshot, contributions: Object.freeze(c.snapshot.contributions.map(item => Object.freeze({ ...item }))) }))) });
    for (const listener of this.listeners) { try { listener(); } catch { /* View failure cannot stop revocation. */ } }
  }
}
