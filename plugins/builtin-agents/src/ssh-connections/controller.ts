import { parseSshConnectionViews, parseSshServerDescriptors, parseSshManagementSessionView, type SshManagementAccessMode, type SshServerDescriptor, type SshConnectionView, type SshConnectionEdit } from "@opencraft/app-host-protocol";
import { combineAbortSignals } from "@opencraft/appserver-client/transport";

export type SshConnectionSnapshot = {
  available: boolean | null; authenticated: boolean; items: readonly SshConnectionView[];
  refreshing: boolean; error: string | null;
  legacyServers: readonly SshServerDescriptor[];
  accessMode: SshManagementAccessMode | null;
};
const messages: Record<string, string> = {
  invalid: "请检查连接信息。", locked: "请先解锁远程连接。", conflict: "连接已被修改，请刷新后重新编辑。",
  missing: "连接已被移除，请刷新列表。", trust: "请重新核对服务器身份。", unavailable: "暂时无法连接，请稍后重试。",
  sessionExpired: "连接已失效，请刷新后重试。",
};

/** The Application supplies platform wake events and timers, never a View. */
export interface SshDiscoveryLifecycle {
  isActive(): boolean;
  subscribeWake(listener: () => void): () => void;
  schedule(listener: () => void, delayMs: number): () => void;
}

/** Application-owned backend projection. View drafts and credentials are not retained here. */
export class SshConnectionsController {
  private snapshot: SshConnectionSnapshot = { available: null, authenticated: false, items: [], legacyServers: [], refreshing: false, error: null, accessMode: null };
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private authEpoch = 0;
  private closed = false;
  private readAbort: AbortController | null = null;
  private refreshOperation: Promise<void> | null = null;
  private stopDiscovery: (() => void) | null = null;
  private readFailures = 0;
  private authorizationChanges = 0;
  private readonly operations = new Set<AbortController>();
  constructor(private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init), private readonly admissionOrigin?: string) {}
  getSnapshot = () => this.snapshot;
  /** Process-local authorization incarnation; never a credential or a lease. */
  getAuthorizationEpoch = () => this.authEpoch;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  /** Socket recovery must not depend on a visible page's discovery timer. */
  async prepareConnection(): Promise<void> {
    await this.refresh();
    if (this.closed || !this.snapshot.authenticated) {
      throw new Error(this.snapshot.accessMode === "shared" ? messages.sessionExpired : messages.locked);
    }
  }
  startDiscovery(lifecycle: SshDiscoveryLifecycle): Promise<void> {
    if (this.closed || this.stopDiscovery) return this.refreshOperation ?? Promise.resolve();
    let stopped = false;
    let cancelScheduled: (() => void) | null = null;
    const poll = (): Promise<void> => {
      cancelScheduled?.(); cancelScheduled = null;
      if (stopped || this.closed || !lifecycle.isActive() || this.snapshot.available === false) return Promise.resolve();
      return this.refresh().then(() => {
        if (stopped || this.closed || !lifecycle.isActive() || this.snapshot.available === false) return;
        cancelScheduled?.();
        // Completion-based polling cannot interrupt a slow read. Temporary
        // failures back off, but a foreground/online hint can probe sooner.
        const delayMs = Math.min(5000 * 2 ** Math.min(this.readFailures, 3), 30000);
        cancelScheduled = lifecycle.schedule(() => { void poll(); }, delayMs);
      });
    };
    const unsubscribe = lifecycle.subscribeWake(() => { void poll(); });
    this.stopDiscovery = () => { stopped = true; cancelScheduled?.(); unsubscribe(); };
    return poll();
  }
  refresh(): Promise<void> {
    if (this.closed || this.authorizationChanges > 0) return Promise.resolve();
    if (this.refreshOperation) return this.refreshOperation;
    const epoch = ++this.epoch;
    this.readAbort?.abort(); const abort = new AbortController(); this.readAbort = abort;
    const operation = Promise.resolve().then(() => this.readSnapshot(epoch, abort)).finally(() => {
      if (this.refreshOperation === operation) this.refreshOperation = null;
    });
    this.refreshOperation = operation;
    return operation;
  }
  private async readSnapshot(epoch: number, abort: AbortController): Promise<void> {
    if (epoch !== this.epoch || this.closed) return;
    this.publish({ ...this.snapshot, refreshing: true });
    try {
      // The session read owns a five-second budget; keep it active through
      // the response body parse and release it before later request budgets.
      const sessionSignal = combineAbortSignals([abort.signal, AbortSignal.timeout(5000)]);
      let session: ReturnType<typeof parseSshManagementSessionView>;
      try {
        const response = await this.fetcher("/__opencraft_ssh/session", { credentials: "same-origin", cache: "no-store", signal: sessionSignal.signal });
        if (response.status === 404) {
          if (epoch === this.epoch && !this.closed) {
            if (this.snapshot.authenticated) ++this.authEpoch;
            this.readFailures = 0;
            this.publish({ available: false, authenticated: false, items: [], legacyServers: [], refreshing: false, error: null, accessMode: null });
          }
          return;
        }
        if (!response.ok) throw new Error("bad-session");
        session = parseSshManagementSessionView(await response.json());
      } finally { sessionSignal.dispose(); }
      if (epoch !== this.epoch || this.closed) return;
      if (this.admissionOrigin && session.authenticatedOrigin && session.authenticatedOrigin !== this.admissionOrigin) {
        session = { ...session, authenticated: false };
      }
      if (!session.authenticated) {
        if (this.snapshot.authenticated) ++this.authEpoch;
        this.publish({ ...this.snapshot, available: true, authenticated: false, items: [], legacyServers: [], accessMode: session.accessMode });
      }
      let renewed = false;
      if (!session.authenticated && session.accessMode === "shared") {
        // This is a server-issued installation session, not an execution or
        // connection command. Renew it automatically after expiry/restart.
        const grant = await this.request("session", "POST", {}, abort.signal);
        if (epoch !== this.epoch || this.closed) return;
        if (!grant || typeof grant !== "object" || !("authenticated" in grant) || grant.authenticated !== true) throw new Error("bad-session");
        ++this.authEpoch;
        renewed = true;
        session = { ...session, authenticated: true };
      }
      const [records, legacy] = session.authenticated ? await Promise.all([this.request("connections", "GET", undefined, abort.signal), this.request("legacy-connections", "GET", undefined, abort.signal)]) : [[], []];
      const items = parseSshConnectionViews(records), legacyServers = parseSshServerDescriptors(legacy);
      if (epoch === this.epoch && !this.closed) {
        if (!renewed && this.snapshot.authenticated !== session.authenticated) ++this.authEpoch;
        this.readFailures = 0;
        this.publish({ available: true, authenticated: session.authenticated, items, legacyServers, refreshing: false, error: null, accessMode: session.accessMode });
      }
    } catch {
      if (epoch === this.epoch && !this.closed) {
        ++this.readFailures;
        this.publish({ ...this.snapshot, refreshing: false, error: "无法刷新连接，请稍后重试。" });
      }
    }
  }
  private invalidateReads() { ++this.epoch; this.readAbort?.abort(); this.refreshOperation = null; }
  private refreshAfterMutation() { this.invalidateReads(); return this.refresh(); }
  async unlock(accessKey: string) {
    const authEpoch = ++this.authEpoch; this.invalidateReads(); ++this.authorizationChanges;
    try { await this.request("session", "POST", { accessKey }); }
    finally { --this.authorizationChanges; }
    if (authEpoch === this.authEpoch && !this.closed) await this.refresh();
  }
  async lock() {
    if (this.snapshot.accessMode === "shared") return;
    const authEpoch = ++this.authEpoch; this.invalidateReads(); ++this.authorizationChanges;
    try { await this.request("session", "DELETE"); }
    finally { --this.authorizationChanges; }
    if (authEpoch !== this.authEpoch || this.closed) return;
    this.invalidateReads();
    this.publish({ ...this.snapshot, authenticated: false, items: [], legacyServers: [], refreshing: false, error: null });
  }
  async probe(hostname: string, port: number): Promise<{ challengeId: string; fingerprint: string }> {
    const result = await this.request("trust", "POST", { hostname, port });
    if (!result || typeof result !== "object" || !("challengeId" in result) || typeof result.challengeId !== "string" || !("fingerprint" in result) || typeof result.fingerprint !== "string") throw new Error("无法核对服务器身份。");
    return { challengeId: result.challengeId, fingerprint: result.fingerprint };
  }
  async save(row: SshConnectionView | null, input: SshConnectionEdit, trust?: { challengeId: string; fingerprint: string }) {
    await this.request(`connections${row ? `/${row.serverId}` : ""}`, row ? "PUT" : "POST", { revision: row?.revision ?? 0, input, ...trust });
    await this.refreshAfterMutation();
  }
  async toggle(row: SshConnectionView, enabled: boolean) {
    const { displayName, hostname, port, username, workspaceBrowseRoots } = row;
    await this.save(row, { displayName, hostname, port, username, workspaceBrowseRoots, enabled });
  }
  async reconnect(row: SshConnectionView) {
    try { await this.request(`connections/${row.serverId}/reconnect`, "POST", { revision: row.revision }); }
    finally { await this.refreshAfterMutation(); }
  }
  async connect(row: SshConnectionView) {
    try { await this.request(`connections/${row.serverId}/connect`, "POST", { revision: row.revision }); }
    finally { await this.refreshAfterMutation(); }
  }
  async remove(row: SshConnectionView) { await this.request(`connections/${row.serverId}`, "DELETE", { revision: row.revision }); await this.refreshAfterMutation(); }
  dispose() { this.closed = true; this.stopDiscovery?.(); this.stopDiscovery = null; this.invalidateReads(); for (const abort of this.operations) abort.abort(); this.operations.clear(); this.listeners.clear(); }
  private async request(path: string, method: string, data?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error("连接页面已关闭。");
    const authEpoch = this.authEpoch;
    const abort = new AbortController(); this.operations.add(abort);
    const combined = combineAbortSignals([abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(12000)]);
    try {
      const response = await this.fetcher(`/__opencraft_ssh/${path}`, { method, credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(data ?? {}) }),
        signal: combined.signal });
      const result: unknown = await response.json();
      if (!response.ok) {
        if (response.status === 401 && authEpoch === this.authEpoch) { ++this.authEpoch; this.invalidateReads(); this.publish({ ...this.snapshot, authenticated: false, items: [], legacyServers: [], refreshing: false, error: null }); }
        const code = result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : "unavailable";
        throw new Error(code === "locked" && this.snapshot.accessMode === "shared" ? messages.sessionExpired : messages[code] ?? messages.unavailable);
      }
      return result;
    } catch (error) {
      if (error instanceof Error && Object.values(messages).includes(error.message)) throw error;
      // Mutations are not replayed: a lost acknowledgement is not rejection.
      throw new Error(method === "GET" ? "无法刷新连接。" : "结果尚未确认，请刷新列表核对后再操作。");
    } finally { combined.dispose(); this.operations.delete(abort); }
  }
  private publish(value: SshConnectionSnapshot) { if (this.closed) return; this.snapshot = value; for (const listener of this.listeners) listener(); }
}
