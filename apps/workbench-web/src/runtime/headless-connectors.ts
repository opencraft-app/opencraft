import { serverFetch } from "./server-context";
import { ConnectorApprovalQueue, type ConnectorApprovalPresentation, type ConnectorApproval, type ConnectorManagementClient, type HeadlessConnectorPort, type HeadlessConnectorState } from "@opencraft/workbench-runtime";

/** HTTP is management only. Model calls go directly through Headless session capabilities. */
export class BrowserHeadlessConnectors implements HeadlessConnectorPort {
  private readonly states = new Map<string, HeadlessConnectorState>();
  private readonly listeners = new Set<() => void>();
  private readonly managementListeners = new Map<string, Set<(available: boolean) => void>>();
  private readonly clients = new Map<string, ConnectorManagementClient>();
  private readonly generations = new Map<string, number>();
  private readonly controllers = new Map<AbortController, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private disposed = false;
  private polling = false;
  private epoch = 0;
  private requestSequence = 0;
  private lastSuccess = 0;
  private failures = 0;
  private retryAt = 0;
  private readonly hostEpochs = new Map<string, number>();
  private readonly backgroundHosts = new Set<string>();
  private readonly blockedHosts = new Set<string>();
  private constructor(private readonly hosts: Readonly<Record<string, string>>) {
    this.timer = setInterval(() => {
      if (this.polling || this.disposed || Date.now() < this.retryAt) return;
      this.polling = true;
      const hosts = this.hostIds().filter(hostId => !this.blockedHosts.has(hostId) && (
        (this.managementListeners.get(hostId)?.size ?? 0) > 0 || this.needsBackgroundSync(hostId)));
      void Promise.allSettled(hosts.map(hostId => this.refresh(hostId))).finally(() => { this.polling = false; });
    }, 2000);
  }
  static async open(): Promise<BrowserHeadlessConnectors> {
    if (globalThis.location && !["http:", "https:"].includes(globalThis.location.protocol)) return new BrowserHeadlessConnectors({});
    let response: Response;
    try { response = await serverFetch("/__opencraft_connectors", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(5000) }); }
    catch { return new BrowserHeadlessConnectors({ "local-codex": "unavailable", "opencraft-server": "unavailable" }); }
    if (response.status === 404) return new BrowserHeadlessConnectors({});
    if (!response.ok) return new BrowserHeadlessConnectors({ "local-codex": "unavailable", "opencraft-server": "unavailable" });
    if (!response.headers.get("content-type")?.includes("application/json")) return new BrowserHeadlessConnectors({});
    const value = await response.json();
    if (value.protocolVersion !== 1 || !value.hosts || typeof value.hosts !== "object" || Array.isArray(value.hosts)) throw new Error("Invalid connector owner");
    return new BrowserHeadlessConnectors(value.hosts);
  }
  hostIds() { return Object.keys(this.hosts); }
  owns(hostId: string) { return Object.hasOwn(this.hosts, hostId); }
  state(hostId: string) { return this.states.get(hostId) ?? null; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private needsBackgroundSync(hostId: string) { return this.backgroundHosts.has(hostId); }
  private commit(hostId: string, state: HeadlessConnectorState) {
    const previous = this.states.get(hostId);
    if (state.approvals.length || state.selections.length || state.connections.some(c => !["disconnected", "failed"].includes(c.phase))) this.backgroundHosts.add(hostId);
    else this.backgroundHosts.delete(hostId);
    const configuration = (s: HeadlessConnectorState) => JSON.stringify([s.supportedDefinitions, s.instances]);
    this.states.set(hostId, state);
    this.publish(!previous || configuration(previous) !== configuration(state) ? hostId : undefined);
  }
  private unavailable(hostId?: string) {
    for (const id of this.hostIds()) if (hostId === undefined || id === hostId) {
      this.hostEpochs.set(id, (this.hostEpochs.get(id) ?? 0) + 1);
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    }
    for (const [controller, id] of this.controllers) if (hostId === undefined || id === hostId) controller.abort();
    if (hostId === undefined) this.states.clear(); else this.states.delete(hostId);
    this.publish();
    for (const [id, listeners] of this.managementListeners) if (hostId === undefined || id === hostId)
      for (const listener of listeners) listener(false);
  }
  private publish(hostId?: string) {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
    // Presentation invalidation (including failed reads) is not a managed
    // configuration change: announcing it as one would trigger another read.
    if (hostId !== undefined) for (const listener of this.managementListeners.get(hostId) ?? []) listener(true);
  }
  private async request<T>(hostId: string, method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.disposed || !this.owns(hostId)) throw new Error("Connector owner unavailable");
    const epoch = this.epoch, hostEpoch = this.hostEpochs.get(hostId), sequence = ++this.requestSequence;
    const controller = new AbortController(); this.controllers.set(controller, hostId);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
    try {
      const response = await serverFetch("/__opencraft_connectors", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId, method, params }), signal: controller.signal });
      if (this.disposed || this.epoch !== epoch || this.hostEpochs.get(hostId) !== hostEpoch || controller.signal.aborted) throw new Error("Connector request retired");
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: string } | null;
        if (this.epoch !== epoch || this.hostEpochs.get(hostId) !== hostEpoch || controller.signal.aborted) throw new Error("Connector request retired");
        // A late rejection cannot revoke a more recent successful recovery.
        if (sequence >= this.lastSuccess) {
          if (response.status === 401) {
            this.epoch++;
            this.retryAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(this.failures++, 4));
            this.unavailable();
          } else if (response.status === 403) {
            // Protocol/origin and resource authorization errors are local to this Host.
            this.blockedHosts.add(hostId); this.unavailable(hostId);
          }
        }
        throw new Error(error?.error === "same_origin_json_required" ? "Connector origin unavailable" : "Connector request unavailable; refresh state before retrying a mutation");
      }
      const value = await response.json();
      if (this.disposed || this.epoch !== epoch || this.hostEpochs.get(hostId) !== hostEpoch || controller.signal.aborted) throw new Error("Connector request retired");
      this.lastSuccess = Math.max(this.lastSuccess, sequence);
      this.failures = 0; this.retryAt = 0; this.blockedHosts.delete(hostId);
      return value as T;
    } catch (error) {
      if (this.epoch === epoch && this.hostEpochs.get(hostId) === hostEpoch && (!controller.signal.aborted || timedOut) && sequence >= this.lastSuccess)
        this.retryAt = Math.max(this.retryAt, Date.now() + Math.min(60000, 2000 * 2 ** Math.min(this.failures++, 5)));
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.controllers.delete(controller); }
  }
  client(hostId: string): ConnectorManagementClient {
    if (!this.owns(hostId)) throw new Error("Connector owner unavailable");
    let client = this.clients.get(hostId);
    if (!client) {
      client = { hostId, requestRaw: async <T>(method: string, params: unknown, options?: { signal?: AbortSignal }) => {
        const result = await this.request<T>(hostId, method, params, options?.signal);
        if (method !== "connectors/managed/list") void this.refresh(hostId).catch(() => undefined);
        return result;
      }, subscribeNotification: listener => {
        let listeners = this.managementListeners.get(hostId);
        if (!listeners) { listeners = new Set(); this.managementListeners.set(hostId, listeners); }
        const notify = (available: boolean) => listener({ method: available ? "connectors/managed/changed" : "connectors/managed/unavailable" });
        listeners.add(notify);
        return () => { listeners.delete(notify); };
      } };
      this.clients.set(hostId, client);
    }
    return client;
  }
  async refresh(hostId: string) {
    const generation = (this.generations.get(hostId) ?? 0) + 1; this.generations.set(hostId, generation);
    const state = await this.request<HeadlessConnectorState>(hostId, "state", {});
    if (this.generations.get(hostId) === generation) this.commit(hostId, state);
  }
  async command(hostId: string, method: string, params: unknown) {
    const generation = (this.generations.get(hostId) ?? 0) + 1; this.generations.set(hostId, generation);
    const state = await this.request<HeadlessConnectorState>(hostId, method, params);
    if (this.generations.get(hostId) === generation) { this.commit(hostId, state); }
  }
  approvals() { return [...this.states.values()].flatMap(s => s.approvals); }
  respond(id: string, allow: boolean) {
    const entry = [...this.states.entries()].find(([, state]) => state.approvals.some(a => a.id === id));
    if (entry) void this.command(entry[0], "approval", { id, allow }).catch(() => { void this.refresh(entry[0]).catch(() => undefined); });
  }
  dispose() { this.disposed = true; clearInterval(this.timer); for (const controller of this.controllers.keys()) controller.abort(); this.controllers.clear(); this.backgroundHosts.clear(); this.states.clear(); this.listeners.clear(); this.managementListeners.clear(); }
}

/** Existing modal consumes one projection of local legacy and Headless-owned decisions. */
export function connectorApprovals(remote: BrowserHeadlessConnectors): ConnectorApprovalPresentation & Pick<ConnectorApprovalQueue, "request" | "dispose"> {
  const local = new ConnectorApprovalQueue(), listeners = new Set<() => void>();
  let snapshot: readonly ConnectorApproval[] = [];
  const publish = () => { snapshot = [...local.getSnapshot(), ...remote.approvals()]; for (const listener of listeners) listener(); };
  const stopLocal = local.subscribe(publish), stopRemote = remote.subscribe(publish);
  return { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    request: (input, signal) => local.request(input, signal),
    respond: (id, allow) => { if (local.getSnapshot().some(a => a.id === id)) local.respond(id, allow); else remote.respond(id, allow); },
    dispose: () => { stopLocal(); stopRemote(); local.dispose(); listeners.clear(); } };
}
