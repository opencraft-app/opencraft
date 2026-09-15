import type { PlatformViewHost, ProvisionHostInput } from "@opencraft/extension-react";
import { LightVelaApiError, type LightVelaAccountService } from "../account/lightvela-account-service";
import { LIGHTVELA_REGIONS, type LightVelaRegion } from "../account/lightvela-account-contract";

type Phase = "idle" | "checking" | "ready" | "blocked" | "submitting" | "creating" | "waiting" | "failed" | "unknown" | "complete" | "error";
interface Instance { instance_id: string; name?: string; status: string }
interface CreationRecord { hostId: string; instanceId: string | null; name: string; region: LightVelaRegion; accountId: string }
export interface EnvironmentCreationSnapshot {
  readonly revision: number;
  readonly phase: Phase;
  readonly message: string | null;
  readonly websiteUrl: string | null;
  readonly request: CreationRecord | null;
}
interface Pass { status: string; expired_time: string; agent_quota_available: number }
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type EnvironmentHost = Pick<PlatformViewHost, "provisionHost"> & Partial<Pick<PlatformViewHost, "profiles" | "removeHost">>;
const STORAGE_PREFIX = "opencraft.lightvela.environment-request.v1:";

/** Preflight is read-only. CTL remains authoritative at POST time. Model credits are not VM quota. */
export function creationBlock(passes: readonly Pass[], now = Date.now()): string | null {
  if (passes.some(pass => ["isolating", "isolated", "renewing", "deleting", "terminating", "modifying"].includes(pass.status))) return "当前套餐暂不可用于添加环境，请前往官网查看处理状态。";
  const active = passes.filter(pass => pass.status === "active" && Date.parse(pass.expired_time) > now);
  if (!active.length) return "当前账号没有可用套餐，请先前往官网开通。";
  if (!active.some(pass => Number.isFinite(pass.agent_quota_available) && pass.agent_quota_available >= 1)) return "当前账号暂无可用的云环境额度。";
  return null;
}

export function createdEnvironmentProfile(record: CreationRecord): ProvisionHostInput {
  if (!record.instanceId) throw new Error("An accepted instance ID is required");
  return {
    hostId: record.hostId, displayName: record.name, providerId: "lightvela.hermes",
    providerConfig: { instanceId: record.instanceId, region: record.region },
    hostKind: "remote-control", autoConnect: false, includeInSidebar: true,
    credentialRef: "lightvela.browser-session", transportEndpoint: "LightVela",
    executionLocation: "LightVela", workspaceBrowseRoots: [],
  };
}

/** Extension-lifetime operation owner. Closing its View never cancels a cloud create or resends POST. */
export class LightVelaEnvironmentService {
  private snapshot: EnvironmentCreationSnapshot = Object.freeze({ revision: 0, phase: "idle", message: null, websiteUrl: null, request: null });
  private readonly listeners = new Set<() => void>();
  private operation: Promise<void> | null = null;
  private generation = 0;
  private authGeneration: number;
  private readonly unsubscribe: () => void;
  private readonly storage?: StoragePort;
  private stop = new AbortController();
  constructor(private readonly account: LightVelaAccountService, private readonly options: {
    storage?: StoragePort; pollMs?: number; maxPolls?: number; onInstanceReady?: (instanceId: string) => Promise<void>;
  } = {}) {
    this.storage = options.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    this.authGeneration = account.getSnapshot().authGeneration;
    this.unsubscribe = account.subscribe(() => {
      const next = account.getSnapshot().authGeneration;
      if (next === this.authGeneration) return;
      this.authGeneration = next; this.generation++; this.stop.abort(); this.stop = new AbortController(); this.operation = null;
      this.publish("idle", null, null, null);
    });
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(phase: Phase, message: string | null = null, websiteUrl: string | null = null, request = this.snapshot.request) {
    this.snapshot = Object.freeze({ revision: this.snapshot.revision + 1, phase, message, websiteUrl, request });
    for (const listener of this.listeners) listener();
  }
  private website(path = "/agents") { return new URL(path, LIGHTVELA_REGIONS[this.account.getSnapshot().region].frontendBase).toString(); }
  private key(record: Pick<CreationRecord, "region" | "accountId">) { return `${STORAGE_PREFIX}${record.region}:${record.accountId}`; }
  private save(record: CreationRecord) { this.storage?.setItem(this.key(record), JSON.stringify(record)); }
  private load(accountId: string, region: LightVelaRegion): CreationRecord | null {
    const raw = this.storage?.getItem(this.key({ accountId, region }));
    if (!raw) return null;
    const value = JSON.parse(raw) as CreationRecord;
    if (value.accountId !== accountId || value.region !== region || !/^lightvela-env-[a-zA-Z0-9-]+$/.test(value.hostId)
      || typeof value.name !== "string" || (value.instanceId !== null && !/^[a-zA-Z0-9_-]+$/.test(value.instanceId))) throw new Error("Invalid pending environment record");
    return value;
  }
  private assertCurrent(generation: number) { if (generation !== this.generation) throw new Error("Account changed"); }
  private run(task: (generation: number) => Promise<void>): Promise<void> {
    if (this.operation) return this.operation;
    const generation = this.generation;
    const operation = task(generation).catch(() => {
      if (generation === this.generation) this.publish("error", "暂时无法检查环境，请重试。", this.website());
    }).finally(() => { if (this.operation === operation) this.operation = null; });
    this.operation = operation;
    return operation;
  }
  private async prerequisites(generation: number) {
    this.publish("checking");
    // CTL has an unregistered create-prerequisites handler (404 in production).
    // Read the published quota contract; CreateInstance atomically enforces
    // shadow binding and entitlement before allocation. Never infer shadow status.
    const [result, details] = await Promise.all([
      this.account.request<{ passes: Pass[] }>("/v1/passes"),
      this.account.refreshAccountDetails(),
    ]);
    this.assertCurrent(generation);
    if (!details.profile?.id) throw new Error("Account identity unavailable");
    const region = this.account.getSnapshot().region;
    const existing = this.load(details.profile.id, region);
    if (existing) return { existing, accountId: details.profile.id, region, blocked: null };
    const blocked = creationBlock(result.passes);
    this.publish(blocked ? "blocked" : "ready", blocked, blocked ? this.website("/account?tab=billing") : null, null);
    return { existing: null, accountId: details.profile.id, region, blocked };
  }
  check(host: EnvironmentHost): Promise<void> {
    return this.run(async generation => {
      const check = await this.prerequisites(generation);
      if (check.existing) await this.track(check.existing, host, generation);
    });
  }
  create(name: string, host: EnvironmentHost): Promise<void> {
    if (this.operation || this.snapshot.phase !== "ready") return this.operation ?? Promise.resolve();
    const normalized = name.trim();
    if (!normalized || [...normalized].length > 64) return Promise.reject(new Error("环境名称需为 1–64 个字符。"));
    return this.run(async generation => {
      const check = await this.prerequisites(generation);
      if (check.existing) { await this.track(check.existing, host, generation); return; }
      if (check.blocked) return;
      const record: CreationRecord = { hostId: `lightvela-env-${crypto.randomUUID()}`, instanceId: null, name: normalized, region: check.region, accountId: check.accountId };
      // Persist BEFORE dispatch. A crash/lost response must not turn reopening into a second POST.
      this.save(record);
      this.publish("submitting", "正在提交创建请求…", null, record);
      let response: Instance;
      try {
        response = await this.account.request<Instance>("/v1/instances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: normalized, timeout: 3600 }), signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        this.assertCurrent(generation);
        if (error instanceof LightVelaApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
          this.storage?.removeItem(this.key(record));
          const blocked = error.status === 403 || error.status === 402;
          const message = error.code === "INSTANCE_SHADOW_BINDING_REQUIRED" ? "请先在官网完成账号开通或验证。"
            : error.code === "INSTANCE_QUOTA_EXCEEDED" ? "当前账号暂无可用的云环境额度。"
            : error.code === "INSTANCE_NO_ACTIVE_PASS" ? "当前账号没有可用套餐，请先前往官网开通。"
            : error.status === 401 ? "登录已过期，请重新登录。" : blocked ? "当前账号不满足创建条件，请前往官网查看。"
            : error.status === 429 ? "创建过于频繁，请稍后重新检查。" : "请求未被接受，请重新检查后重试。";
          this.publish(blocked ? "blocked" : "error", message, blocked ? this.website(error.code === "INSTANCE_SHADOW_BINDING_REQUIRED" ? "/agents" : "/account?tab=billing") : null, null);
        } else this.publish("unknown", "请求结果尚未确认。为避免重复创建，请先前往官网检查。", this.website(), record);
        return;
      }
      this.assertCurrent(generation);
      if (!response?.instance_id || !/^[a-zA-Z0-9_-]+$/.test(response.instance_id)) {
        this.publish("unknown", "请求结果尚未确认，请前往官网检查。", this.website(), record); return;
      }
      const accepted = { ...record, instanceId: response.instance_id };
      this.save(accepted);
      await this.track(accepted, host, generation);
    });
  }
  private async track(record: CreationRecord, host: EnvironmentHost, generation: number) {
    this.assertCurrent(generation);
    if (!record.instanceId) { this.publish("unknown", "上次请求的结果尚未确认。请前往官网检查，避免重复创建。", this.website(), record); return; }
    this.publish("creating", "正在创建…", null, record);
    for (let attempt = 0; attempt < (this.options.maxPolls ?? 200); attempt++) {
      let instance: Instance;
      try {
        instance = await this.account.request<Instance>(`/v1/instances/${encodeURIComponent(record.instanceId)}`, { signal: AbortSignal.timeout(30_000) });
      } catch {
        this.assertCurrent(generation);
        this.publish("waiting", "暂时无法读取进度。可重新检查，不会重复创建。", this.website(), record); return;
      }
      this.assertCurrent(generation);
      if (instance.instance_id !== record.instanceId) throw new Error("Instance identity mismatch");
      const status = instance.status.toLowerCase();
      if (status === "running") {
        try {
          // Never selectBot, activate a Host, or navigate the current conversation here.
          await this.account.refreshBots();
          this.assertCurrent(generation);
          if (this.options.onInstanceReady) {
            await this.options.onInstanceReady(record.instanceId);
            this.assertCurrent(generation);
            this.storage?.removeItem(this.key(record));
            this.publish("complete", "环境已添加，当前聊天保持不变。", null, record);
            return;
          }
          const existing = host.profiles?.find(profile => profile.hostId === record.hostId);
          if (!existing) {
            await host.provisionHost(createdEnvironmentProfile(record));
            if (generation !== this.generation) {
              // Roll back only the local profile created by this operation, never the cloud VM.
              await host.removeHost?.(record.hostId);
              this.assertCurrent(generation);
            }
          }
          else if (existing.providerId !== "lightvela.hermes" || (existing.providerConfig as Record<string, unknown>).instanceId !== record.instanceId) throw new Error("Host identity mismatch");
          this.assertCurrent(generation);
          this.storage?.removeItem(this.key(record));
          this.publish("complete", "环境已添加，当前聊天保持不变。", null, record);
        } catch {
          this.assertCurrent(generation);
          this.publish("waiting", "实例已就绪，但添加到环境列表失败。请重新检查。", null, record);
        }
        return;
      }
      if (!["creating", "pending", "starting"].includes(status)) {
        this.publish("failed", "实例未能就绪，请前往官网查看状态。", this.website(), record); return;
      }
      const signal = this.stop.signal;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, this.options.pollMs ?? 3000);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
      this.assertCurrent(generation);
    }
    this.publish("waiting", "创建仍在进行。稍后重新检查即可，无需再次添加。", this.website(), record);
  }
  dispose() { this.generation++; this.stop.abort(); this.unsubscribe(); this.listeners.clear(); }
}
