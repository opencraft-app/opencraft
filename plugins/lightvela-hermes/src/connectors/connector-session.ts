import { SidecarNotInstalled, type ConnectorInstance, type ConnectorRelease, type ConnectorState, type HermesConnectorClient } from "./connector-client";

export type ConnectorSessionPhase = "idle" | "probing" | "missing" | "installing" | "ready" | "updating" | "error";
export interface ConnectorSessionSnapshot {
  phase: ConnectorSessionPhase;
  instances: ConnectorInstance[];
  states: ConnectorState[];
  message: string | null;
}
export const initialConnectorSession: ConnectorSessionSnapshot = { phase: "idle", instances: [], states: [], message: null };
export type ConnectorSessionClient = Pick<HermesConnectorClient, "connect" | "install" | "request" | "dispose">;

/** One physical Bot's view lease. Browsing is independent; only VM work lives here. */
export class ConnectorSession {
  private generation = 0;
  private client: ConnectorSessionClient | null = null;
  private snapshot = initialConnectorSession;
  private listeners = new Set<(value: ConnectorSessionSnapshot) => void>();
  private stopWait: (() => void) | null = null;
  constructor(private readonly createClient: () => ConnectorSessionClient,
    // A cold probe includes PTY bootstrap, a second TAT session and state requests.
    // Real successful bootstrap alone takes ~12s; browsing/install remain independent.
    private readonly deadlines = { probe: 45000, install: 180000, update: 60000 }) {}
  getSnapshot = () => this.snapshot;
  subscribe(listener: (value: ConnectorSessionSnapshot) => void) {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private publish(value: ConnectorSessionSnapshot) {
    this.snapshot = value; for (const listener of this.listeners) listener(value);
  }
  private retire() {
    ++this.generation;
    this.stopWait?.(); this.stopWait = null;
    this.client?.dispose(); this.client = null;
  }
  cancel() {
    const mutation = this.snapshot.phase === "installing" || this.snapshot.phase === "updating";
    this.retire();
    this.publish({ ...initialConnectorSession, message: mutation
      ? "已停止等待。远端操作可能已生效，请检查状态后再操作。" : "已取消连接探测，可继续浏览或安装。" });
  }
  dispose() { this.retire(); this.listeners.clear(); }
  private async readState(client: ConnectorSessionClient) {
    const [instances, states] = await Promise.all([
      client.request<{ instances: ConnectorInstance[] }>("/v1/instances"),
      client.request<{ connectors: ConnectorState[] }>("/v1/state"),
    ]);
    return { instances: instances.instances, states: states.connectors };
  }
  private async execute(phase: "probing" | "installing" | "updating", timeout: number,
    work: (client: ConnectorSessionClient) => Promise<void>) {
    const client = this.client!;
    const generation = this.generation;
    this.publish({ ...this.snapshot, phase, message: null });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(phase === "probing"
        ? "连接检查超时；不影响浏览，也可直接安装。" : "等待超时，远端结果尚未确认。请检查状态，勿重复提交授权。")), timeout);
      this.stopWait = () => reject(new Error("Cancelled"));
    });
    try {
      const result = await Promise.race([work(client).then(() => this.readState(client)), deadline]);
      if (generation !== this.generation) return;
      this.publish({ ...result, phase: "ready", message: null });
    } catch (error) {
      if (generation !== this.generation) return;
      client.dispose(); this.client = null;
      this.publish({ ...initialConnectorSession, phase: error instanceof SidecarNotInstalled ? "missing" : "error",
        message: error instanceof SidecarNotInstalled ? "当前 Bot 尚未安装连接器运行服务。可以先浏览，使用时再安装。"
          : error instanceof Error ? error.message : "连接失败，请重试" });
    } finally {
      clearTimeout(timer);
      if (generation === this.generation) this.stopWait = null;
    }
  }
  probe() {
    this.retire(); this.client = this.createClient();
    return this.execute("probing", this.deadlines.probe, (client) => client.connect());
  }
  install(release: ConnectorRelease) {
    // Explicit install supersedes a read-only probe. Never queue it behind probe completion.
    this.retire(); this.client = this.createClient();
    return this.execute("installing", this.deadlines.install, (client) => client.install(release));
  }
  update(work: (client: ConnectorSessionClient) => Promise<void>) {
    if (this.snapshot.phase !== "ready" || !this.client) return Promise.resolve();
    ++this.generation;
    return this.execute("updating", this.deadlines.update, work);
  }
}
