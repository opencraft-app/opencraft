import { parseSshConnectionViews, parseSshCodexServerDescriptors, type SshCodexServerDescriptor, type SshConnectionView, type SshConnectionEdit } from "@opencraft/app-host-protocol";

export type SshConnectionSnapshot = {
  available: boolean | null; authenticated: boolean; items: readonly SshConnectionView[];
  refreshing: boolean; error: string | null;
  legacyServers: readonly SshCodexServerDescriptor[];
};
const messages: Record<string, string> = {
  invalid: "请检查连接信息。", locked: "请先解锁远程连接。", conflict: "连接已被修改，请刷新后重新编辑。",
  missing: "连接已被移除，请刷新列表。", trust: "请重新核对服务器身份。", unavailable: "暂时无法连接，请稍后重试。",
};

/** Application-owned backend projection. View drafts and credentials are not retained here. */
export class SshConnectionsController {
  private snapshot: SshConnectionSnapshot = { available: null, authenticated: false, items: [], legacyServers: [], refreshing: false, error: null };
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private authEpoch = 0;
  private closed = false;
  private readAbort: AbortController | null = null;
  private readonly operations = new Set<AbortController>();
  constructor(private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}
  getSnapshot = () => this.snapshot;
  /** Process-local authorization incarnation; never a credential or a lease. */
  getAuthorizationEpoch = () => this.authEpoch;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  async refresh(): Promise<void> {
    const epoch = ++this.epoch;
    this.readAbort?.abort(); const abort = new AbortController(); this.readAbort = abort;
    this.publish({ ...this.snapshot, refreshing: true });
    try {
      const response = await this.fetcher("/__opencraft_ssh/session", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
      if (response.status === 404) { if (epoch === this.epoch && !this.closed) this.publish({ available: false, authenticated: false, items: [], legacyServers: [], refreshing: false, error: null }); return; }
      const session: unknown = await response.json();
      if (!response.ok || !session || typeof session !== "object" || !("available" in session) || session.available !== true || !("authenticated" in session) || typeof session.authenticated !== "boolean") throw new Error("bad-session");
      const [records, legacy] = session.authenticated ? await Promise.all([this.request("connections", "GET", undefined, abort.signal), this.request("legacy-connections", "GET", undefined, abort.signal)]) : [[], []];
      const items = parseSshConnectionViews(records), legacyServers = parseSshCodexServerDescriptors(legacy);
      if (epoch === this.epoch && !this.closed) this.publish({ available: true, authenticated: session.authenticated, items, legacyServers, refreshing: false, error: null });
    } catch {
      if (epoch === this.epoch && !this.closed) this.publish({ ...this.snapshot, refreshing: false, error: "无法刷新连接，请稍后重试。" });
    }
  }
  async unlock(accessKey: string) { ++this.authEpoch; ++this.epoch; this.readAbort?.abort(); await this.request("session", "POST", { accessKey }); await this.refresh(); }
  async lock() {
    ++this.authEpoch; ++this.epoch; this.readAbort?.abort();
    await this.request("session", "DELETE"); ++this.epoch; this.readAbort?.abort();
    this.publish({ ...this.snapshot, authenticated: false, items: [], legacyServers: [], refreshing: false, error: null });
  }
  async probe(hostname: string, port: number): Promise<{ challengeId: string; fingerprint: string }> {
    const result = await this.request("trust", "POST", { hostname, port });
    if (!result || typeof result !== "object" || !("challengeId" in result) || typeof result.challengeId !== "string" || !("fingerprint" in result) || typeof result.fingerprint !== "string") throw new Error("无法核对服务器身份。");
    return { challengeId: result.challengeId, fingerprint: result.fingerprint };
  }
  async save(row: SshConnectionView | null, input: SshConnectionEdit, trust?: { challengeId: string; fingerprint: string }) {
    await this.request(`connections${row ? `/${row.serverId}` : ""}`, row ? "PUT" : "POST", { revision: row?.revision ?? 0, input, ...trust });
    await this.refresh();
  }
  async toggle(row: SshConnectionView, enabled: boolean) {
    const { displayName, hostname, port, username, workspaceBrowseRoots } = row;
    await this.save(row, { displayName, hostname, port, username, workspaceBrowseRoots, enabled });
  }
  async reconnect(row: SshConnectionView) {
    try { await this.request(`connections/${row.serverId}/reconnect`, "POST", { revision: row.revision }); }
    finally { await this.refresh(); }
  }
  async connect(row: SshConnectionView) {
    try { await this.request(`connections/${row.serverId}/connect`, "POST", { revision: row.revision }); }
    finally { await this.refresh(); }
  }
  async remove(row: SshConnectionView) { await this.request(`connections/${row.serverId}`, "DELETE", { revision: row.revision }); await this.refresh(); }
  dispose() { this.closed = true; ++this.epoch; this.readAbort?.abort(); for (const abort of this.operations) abort.abort(); this.operations.clear(); this.listeners.clear(); }
  private async request(path: string, method: string, data?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error("连接页面已关闭。");
    const authEpoch = this.authEpoch;
    const abort = new AbortController(); this.operations.add(abort);
    try {
      const response = await this.fetcher(`/__opencraft_ssh/${path}`, { method, credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(data ?? {}) }),
        signal: AbortSignal.any([abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(12000)]) });
      const result: unknown = await response.json();
      if (!response.ok) {
        if (response.status === 401 && authEpoch === this.authEpoch) { ++this.authEpoch; ++this.epoch; this.readAbort?.abort(); this.publish({ ...this.snapshot, authenticated: false, items: [], legacyServers: [], refreshing: false }); }
        const code = result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : "unavailable";
        throw new Error(messages[code] ?? messages.unavailable);
      }
      return result;
    } catch (error) {
      if (error instanceof Error && Object.values(messages).includes(error.message)) throw error;
      // Mutations are not replayed: a lost acknowledgement is not rejection.
      throw new Error(method === "GET" ? "无法刷新连接。" : "结果尚未确认，请刷新列表核对后再操作。");
    } finally { this.operations.delete(abort); }
  }
  private publish(value: SshConnectionSnapshot) { if (this.closed) return; this.snapshot = value; for (const listener of this.listeners) listener(); }
}
