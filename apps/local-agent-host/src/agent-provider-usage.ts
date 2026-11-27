import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AgentProviderUsage, AgentUsageWindow } from "@opencraft/appserver-protocol";
import type { OnboardingDeps } from "./agent-onboarding.js";

type Value = Record<string, unknown>;
const object = (v: unknown): Value => v && typeof v === "object" && !Array.isArray(v) ? v as Value : {};
const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const amount = (v: unknown): number | null => typeof v === "string" && /^\d+$/u.test(v) ? number(Number(v)) : number(v);
const date = (v: unknown): number | null => typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : number(v);
const empty = (id: "codex" | "cursor", status: AgentProviderUsage["status"], account: string | null = null): AgentProviderUsage => ({
  id,
  status,
  plan: null,
  ...(account ? { account } : {}),
  windows: [],
  observedAt: null,
});
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
function extractEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return EMAIL.exec(value)?.[0] ?? null;
}
function decodeJwtEmail(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { email?: unknown };
    return extractEmail(payload?.email);
  } catch {
    return null;
  }
}
async function jsonFile(path: string): Promise<Value> {
  const value = await readFile(path, "utf8"); if (value.length > 1024 * 1024) throw new Error("Invalid native credentials");
  return object(JSON.parse(value));
}
export function isNativeOpenAiCodexRoute(configToml: string): boolean {
  for (const rawLine of configToml.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;
    const providerMatch = /^model_provider\s*=\s*["']([^"']+)["']/u.exec(line);
    if (providerMatch?.[1] && providerMatch[1].trim().toLowerCase() !== "openai") {
      return false;
    }
    const baseUrlMatch = /^openai_base_url\s*=\s*["']([^"']+)["']/u.exec(line);
    if (baseUrlMatch?.[1]?.trim()) {
      try {
        const host = new URL(baseUrlMatch[1].trim()).hostname.toLowerCase();
        if (host !== "api.openai.com" && !host.endsWith(".openai.com") && host !== "chatgpt.com" && !host.endsWith(".chatgpt.com")) {
          return false;
        }
      } catch {
        return false;
      }
    }
  }
  return true;
}

export function codexQuota(value: unknown, now: number): Omit<AgentProviderUsage, "id"> {
  const data = object(value), rate = object(data.rate_limit), windows: AgentUsageWindow[] = [];
  for (const raw of [rate.primary_window, rate.secondary_window]) {
    const w = object(raw), used = number(w.used_percent); if (used === null) continue;
    const reset = number(w.reset_at), after = number(w.reset_after_seconds), duration = number(w.limit_window_seconds);
    windows.push({ kind: "rateLimit", durationMinutes: duration === null ? null : duration / 60,
      usedPercent: used, resetsAt: reset !== null ? reset * 1000 : after !== null ? now + after * 1000 : null, cost: null });
  }
  if (!Object.hasOwn(data, "rate_limit")) throw new Error("Invalid native usage response");
  const email = extractEmail(data.email);
  return { status: "ok", plan: typeof data.plan_type === "string" ? data.plan_type : null, ...(email ? { account: email } : {}), observedAt: now, windows };
}
export function cursorQuota(value: unknown, planValue: unknown, now: number): Omit<AgentProviderUsage, "id"> {
  const data = object(value), planRoot = object(planValue), plan = object(planRoot.planInfo), windows: AgentUsageWindow[] = [];
  if (!Object.hasOwn(data, "planUsage") && !Object.hasOwn(data, "spendLimitUsage")) throw new Error("Invalid native usage response");
  const usage = number(object(data.planUsage).totalPercentUsed), resetsAt = date(typeof data.billingCycleEnd === "string" && /^\d+$/u.test(data.billingCycleEnd) ? Number(data.billingCycleEnd) : data.billingCycleEnd);
  if (usage !== null) windows.push({ kind: "plan", durationMinutes: null, usedPercent: usage, resetsAt, cost: null });
  const spend = object(data.spendLimitUsage);
  for (const key of ["overall", "individual", "pooled"]) {
    const limit = amount(spend[`${key}Limit`]), used = amount(spend[`${key}Used`]);
    if (limit !== null && limit > 0 && used !== null) {
      const scope = spend.limitType === "team" ? "team" : spend.limitType === "individual" ? "account" : undefined;
      windows.push({ kind: "spend", durationMinutes: null, usedPercent: used / limit * 100, resetsAt, ...(scope ? { scope } : {}), cost: { usedCents: used, limitCents: limit, currency: "USD" } }); break;
    }
  }
  const email = extractEmail(planRoot.email ?? plan.email);
  return { status: "ok", plan: typeof plan.planName === "string" ? plan.planName : null, ...(email ? { account: email } : {}), observedAt: now, windows };
}

/** Borrows the CLI's credentials without refreshing, copying or persisting them. */
export class AgentProviderUsageService {
  private readonly cache = new Map<string, { at: number; value: AgentProviderUsage }>();
  private readonly flights = new Map<string, Promise<AgentProviderUsage>>();
  private readonly abort = new AbortController();
  private closed = false;
  constructor(private readonly deps: OnboardingDeps, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {}
  private async readCursorEmail(): Promise<string | null> {
    for (const candidate of [
      join(this.deps.env.XDG_CONFIG_HOME || join(this.deps.homedir, ".config"), "cursor", "auth.json"),
      join(this.deps.env.CURSOR_CONFIG_DIR || join(this.deps.homedir, ".cursor"), "cli-config.json"),
    ]) {
      try {
        const parsed = await jsonFile(candidate);
        const email = extractEmail(parsed.email) ?? extractEmail(object(parsed.authInfo).email);
        if (email) return email;
      } catch { /* Ignore missing config. */ }
    }
    return null;
  }
  private async credential(id: "codex" | "cursor"): Promise<{ token: string; account: string | null; email: string | null } | null> {
    if (id === "codex") {
      const codexHome = this.deps.env.CODEX_HOME || join(this.deps.homedir, ".codex");
      const configToml = await readFile(join(codexHome, "config.toml"), "utf8").catch(() => "");
      if (configToml && !isNativeOpenAiCodexRoute(configToml)) return null;
      const auth = await jsonFile(join(codexHome, "auth.json"));
      const tokens = object(auth.tokens);
      const email = decodeJwtEmail(tokens.id_token) ?? decodeJwtEmail(tokens.access_token);
      return typeof tokens.access_token === "string" && typeof tokens.account_id === "string" && (!auth.auth_mode || auth.auth_mode === "chatgpt")
        ? { token: tokens.access_token, account: tokens.account_id, email } : null;
    }
    const configEmail = await this.readCursorEmail();
    if (process.platform === "darwin") {
      const result = await this.deps.exec("/usr/bin/security", ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"], 8000, this.deps.env);
      if (result.code === 0 && result.stdout.trim()) {
        const token = result.stdout.trim();
        return { token, account: null, email: configEmail ?? decodeJwtEmail(token) };
      }
    }
    const auth = await jsonFile(join(this.deps.env.XDG_CONFIG_HOME || join(this.deps.homedir, ".config"), "cursor", "auth.json"));
    return typeof auth.accessToken === "string"
      ? { token: auth.accessToken, account: null, email: configEmail ?? extractEmail(auth.email) ?? decodeJwtEmail(auth.accessToken) } : null;
  }
  async read(id: "codex" | "cursor", force = false): Promise<AgentProviderUsage> {
    if (this.closed) return empty(id, "unavailable");
    let credential;
    try { credential = await this.credential(id); } catch { credential = null; }
    if (!credential || /[\r\n\0]/u.test(credential.token)) return empty(id, "signedOut");
    const key = `${id}:${createHash("sha256").update(credential.account ?? credential.token).digest("hex")}`;
    const cached = this.cache.get(key);
    if (!force && cached && this.now() - cached.at < 60_000) return cached.value;
    const existing = this.flights.get(key); if (existing) return existing;
    const pending = (async (): Promise<AgentProviderUsage> => {
      try {
        const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]);
        const common = { Authorization: `Bearer ${credential.token}`, Accept: "application/json" };
        let value: AgentProviderUsage;
        if (id === "codex") {
          const result = await this.fetcher("https://chatgpt.com/backend-api/wham/usage", { headers: { ...common, "ChatGPT-Account-ID": credential.account! }, redirect: "error", signal });
          const quota = result.ok ? codexQuota(await result.json(), this.now()) : null;
          const account = quota?.account ?? credential.email;
          value = result.status === 401 ? empty(id, "expired", credential.email) : quota ? { id, ...quota, ...(account ? { account } : {}) } : empty(id, "unavailable", credential.email);
        } else {
          const call = (method: string) => this.fetcher(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, { method: "POST", headers: { ...common, "Content-Type": "application/json", "Connect-Protocol-Version": "1", "x-cursor-client-type": "cli", "x-cursor-client-version": "opencraft" }, body: "{}", redirect: "error", signal });
          const [usage, plan] = await Promise.all([call("GetCurrentPeriodUsage"), call("GetPlanInfo")]);
          const quota = ![usage.status, plan.status].includes(401) && usage.ok ? cursorQuota(await usage.json(), plan.ok ? await plan.json() : {}, this.now()) : null;
          const account = quota?.account ?? credential.email;
          value = [usage.status, plan.status].includes(401) ? empty(id, "expired", credential.email)
            : quota ? { id, ...quota, ...(account ? { account } : {}) } : empty(id, "unavailable", credential.email);
        }
        if (this.closed) return empty(id, "unavailable");
        const current = await this.credential(id).catch(() => null);
        if (!current || createHash("sha256").update(current.account ?? current.token).digest("hex") !== key.slice(id.length + 1)) return empty(id, "unavailable");
        if (value.status === "expired") this.cache.delete(key);
        if (value.status === "ok") { this.cache.set(key, { at: this.now(), value }); if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!); }
        return value.status === "unavailable" && cached ? { ...cached.value, status: "unavailable" as const } : value;
      } catch {
        const current = await this.credential(id).catch(() => null);
        if (this.closed || !current || createHash("sha256").update(current.account ?? current.token).digest("hex") !== key.slice(id.length + 1)) return empty(id, "unavailable");
        return cached ? { ...cached.value, status: "unavailable" as const } : empty(id, "unavailable");
      }
    })();
    this.flights.set(key, pending); try { return await pending; } finally { this.flights.delete(key); }
  }
  close(): void { this.closed = true; this.abort.abort(); this.cache.clear(); }
}
