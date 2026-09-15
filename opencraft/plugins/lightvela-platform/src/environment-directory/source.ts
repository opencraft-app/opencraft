import { environmentIdentity, type EnvironmentEntry, type EnvironmentSource, type EnvironmentSourceSnapshot, type HostConnectionProfile } from "@opencraft/workbench-runtime";
import type { LightVelaAccountService, LightVelaRegion } from "../account/lightvela-account-service";

export function lightVelaEnvironmentHostId(region: LightVelaRegion, accountId: string, instanceId: string) {
  return `lightvela-env:${region}:${encodeURIComponent(accountId)}:${encodeURIComponent(instanceId)}`;
}
interface Instance { instance_id: string; name?: string; status: string }
type AccountPort = Pick<LightVelaAccountService, "subscribe" | "getSnapshot" | "hasStoredSession" | "refreshAccountDetails" | "request">;

/** Account-owned discovery; never provisions a VM, selects a Host or opens a connection. */
export class LightVelaEnvironmentSource implements EnvironmentSource {
  readonly id = "lightvela.hermes";
  readonly label = "LightVela";
  readonly providerIds = ["lightvela.hermes"];
  private snapshot: EnvironmentSourceSnapshot = {revision: 0, phase: "signed-out", entries: [], error: null};
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private scope = "";
  private accountId: string | null = null;
  private region: LightVelaRegion = "intl";
  private botsSignature = "";
  private generation = 0;
  private operation: Promise<void> | null = null;
  private abort = new AbortController();
  private closed = false;
  constructor(private readonly account: AccountPort) {
    this.unsubscribe = account.subscribe(() => this.reconcile());
    this.reconcile();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private reconcile() {
    if (this.closed) return;
    const state = this.account.getSnapshot();
    const id = state.details.profile?.id ?? null;
    const authenticated = state.session.status === "authenticated";
    const scope = authenticated ? `${state.authGeneration}:${state.region}:${id ?? ""}` : "";
    const bots = state.bots.map(bot => bot.instanceId).sort().join("|");
    if (scope !== this.scope) {
      this.scope = scope; this.generation++; this.abort.abort(); this.abort = new AbortController(); this.operation = null;
      this.accountId = authenticated ? id : null; this.region = state.region;
      this.publish(authenticated ? "loading" : "signed-out", [], null);
      this.botsSignature = bots;
      if (this.accountId) void this.refresh();
    } else if (this.accountId && bots !== this.botsSignature) {
      this.botsSignature = bots; void this.refresh();
    }
    if (authenticated && !id && state.details.phase === "error") this.publish("error", [], "无法读取账户身份，请重试。");
  }
  refresh = (): Promise<void> => {
    if (this.closed) return Promise.resolve();
    if (this.operation) return this.operation;
    if (!this.accountId) {
      if (!this.account.hasStoredSession()) return Promise.resolve();
      const generation = this.generation;
      return this.account.refreshAccountDetails().then(() => this.operation ?? Promise.resolve()).then(() => {}).catch(() => {
        if (!this.closed && generation === this.generation) this.publish("error", this.snapshot.entries, "无法读取账户身份，请重试。");
      });
    }
    const generation = this.generation, accountId = this.accountId, region = this.region;
    const signal = this.abort.signal;
    this.publish("loading", this.snapshot.entries, null);
    const operation = (async () => {
      try {
        const details = await this.account.refreshAccountDetails();
        if (generation !== this.generation || this.closed || details.profile?.id !== accountId) return;
        const instances = new Map<string, Instance>();
        for (let page = 1; page <= 100; page++) {
          const result = await this.account.request<{items: Instance[]}>(`/v1/instances?page=${page}&page_size=100`, {signal});
          if (generation !== this.generation || this.closed) return;
          if (!Array.isArray(result.items)) throw new Error("Invalid instance list");
          for (const instance of result.items) {
            if (typeof instance.instance_id !== "string" || !instance.instance_id || typeof instance.status !== "string") throw new Error("Invalid instance");
            instances.set(instance.instance_id, instance);
          }
          if (result.items.length < 100) break;
          if (page === 100) throw new Error("Instance pagination limit reached");
        }
        const entries: EnvironmentEntry[] = [...instances.values()].filter(instance => instance.status.toLowerCase() !== "deleted").map(instance => {
          const lifecycle = instance.status.trim().toLowerCase();
          const name = instance.name?.trim() || "LightVela 环境";
          return {id: environmentIdentity(this.id, region, accountId, instance.instance_id), sourceId: this.id,
            name, location: region === "cn" ? "LightVela · 国内站" : "LightVela · 国际站", lifecycle, connectable: lifecycle === "running",
            profile: {hostId: lightVelaEnvironmentHostId(region, accountId, instance.instance_id), displayName: name,
              providerId: this.id, providerConfig: {instanceId: instance.instance_id, region, accountId}, providerConfigVersion: 1,
              hostKind: "remote-control", enabled: lifecycle === "running", autoConnect: false, includeInSidebar: true,
              credentialRef: "lightvela.browser-session", transportEndpoint: "LightVela", executionLocation: "LightVela", workspaceBrowseRoots: [], revision: 1}};
        });
        this.publish("ready", entries, null);
      } catch {
        if (generation === this.generation && !this.closed) this.publish("error", this.snapshot.entries, "环境列表刷新失败，显示上次结果。");
      }
    })().finally(() => { if (this.operation === operation) this.operation = null; });
    this.operation = operation;
    return operation;
  };
  matchProfile(profile: HostConnectionProfile): string | null {
    const config = profile.providerConfig;
    if (!config || typeof config !== "object" || Array.isArray(config)) return null;
    const binding = config as Record<string, unknown>;
    if (binding.region !== this.region || (binding.accountId !== undefined && binding.accountId !== this.accountId)) return null;
    return this.snapshot.entries.find(entry => (entry.profile.providerConfig as Record<string, unknown>).instanceId === binding.instanceId)?.id ?? null;
  }
  dispose() { this.closed = true; this.generation++; this.abort.abort(); this.unsubscribe(); this.listeners.clear(); }
  private publish(phase: EnvironmentSourceSnapshot["phase"], entries: readonly EnvironmentEntry[], error: string | null) {
    this.snapshot = Object.freeze({revision: this.snapshot.revision + 1, phase, entries: Object.freeze([...entries]), error});
    for (const listener of this.listeners) listener();
  }
}
