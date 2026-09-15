import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { HostUserRecord } from "../types/host-policy.ts";
import type {
  McpServerRegistration,
  McpToolCallResult,
} from "../types/mcp.ts";
import { utf8Decode } from "../runtime/bytes.ts";

export const USERS_SERVER_NAME = "hypernode-users";
export const USERS_RESOURCE_URI = "ui://hypernode/users.html";
export const CODEX_ACCOUNTS_SERVER_NAME = "hypernode-codex-accounts";
export const CODEX_ACCOUNTS_RESOURCE_URI = "ui://hypernode/codex-accounts/v6.html";

type Dependencies =
  | "accountCatalog"
  | "mcpRegistry"
  | "sharedCodex"
  | "userDirectory";

interface WeeklyUsageSummary {
  available: true;
  usedPercent: number;
  remainingPercent: number;
  resetsAtMs: number | null;
  windowDurationMins: number | null;
  resetCredits: ResetCreditsSummary | null;
  observedAtMs: number;
}

type WeeklyUsageState = WeeklyUsageSummary | {
  available: false;
  reason: string;
  resetCredits?: ResetCreditsSummary | null;
  observedAtMs: number;
};

interface ResetCreditsSummary {
  availableCount: number;
  applicableAvailableCount: number;
}

interface UsageAuth {
  accessToken: string;
  accountId: string;
  installationId: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rateLimitWindows(limit: unknown): Record<string, unknown>[] {
  const source = record(limit);
  if (!source) return [];
  return [source["primary_window"], source["secondary_window"]]
    .map(record)
    .filter((window): window is Record<string, unknown> => window !== null);
}

export function resetCreditsFromUsageResponse(value: unknown): ResetCreditsSummary | null {
  const credits = record(record(value)?.["rate_limit_reset_credits"]);
  if (!credits) return null;
  const availableCount = Number(credits["available_count"]);
  const applicableAvailableCount = Number(credits["applicable_available_count"]);
  if (!Number.isFinite(availableCount) || !Number.isFinite(applicableAvailableCount)) return null;
  return {
    availableCount: Math.max(0, Math.trunc(availableCount)),
    applicableAvailableCount: Math.max(0, Math.trunc(applicableAvailableCount)),
  };
}

export function weeklyUsageFromUsageResponse(
  value: unknown,
  observedAtMs = Date.now(),
): WeeklyUsageSummary | null {
  const payload = record(value);
  if (!payload) return null;
  const windows = rateLimitWindows(payload["rate_limit"]);
  if (windows.length === 0) return null;
  const weekly = [...windows].sort((left, right) => (
    Number(right["limit_window_seconds"] ?? 0) - Number(left["limit_window_seconds"] ?? 0)
  ))[0];
  const windowSeconds = Number(weekly?.["limit_window_seconds"] ?? 0);
  if (!weekly || windowSeconds < 6 * 24 * 60 * 60 ||
      !Number.isFinite(Number(weekly["used_percent"]))) return null;
  const usedPercent = Math.min(100, Math.max(0, Math.round(Number(weekly["used_percent"]))));
  const rawReset = Number(weekly["reset_at"]);
  const resetAfter = Number(weekly["reset_after_seconds"]);
  return {
    available: true,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAtMs: Number.isFinite(rawReset) && rawReset > 0
      ? (rawReset < 1_000_000_000_000 ? rawReset * 1_000 : rawReset)
      : Number.isFinite(resetAfter) && resetAfter > 0 ? observedAtMs + resetAfter * 1_000 : null,
    windowDurationMins: Math.round(windowSeconds / 60),
    resetCredits: resetCreditsFromUsageResponse(payload),
    observedAtMs,
  };
}

function usageAuth(user: HostUserRecord, profileId: string | null): UsageAuth {
  const bytes = profileId
    ? hostFilesystem.readFileForUser(
      user.username,
      `.codex/hypernode/accounts/${profileId}/auth.json`,
    )
    : hostIdentity.readCodexAuth(user.username);
  const auth = record(JSON.parse(utf8Decode(bytes)));
  const tokens = record(auth?.["tokens"]);
  const accessToken = tokens?.["access_token"];
  const accountId = tokens?.["account_id"];
  if (auth?.["auth_mode"] !== "chatgpt" || typeof accessToken !== "string" ||
      typeof accountId !== "string" || !accessToken || !accountId) {
    throw new Error("ChatGPT authentication is unavailable");
  }
  let installationId = user.installationId?.trim() || null;
  if (profileId) {
    try {
      installationId = utf8Decode(hostFilesystem.readFileForUser(
        user.username,
        `.codex/hypernode/accounts/${profileId}/installation_id`,
      )).trim() || installationId;
    } catch {
      // Legacy profiles use the user's active installation id until migrated.
    }
  }
  return { accessToken, accountId, installationId };
}

function usageEndpoint(): string {
  const base = String(globalThis.hypernodeConfig?.remoteControlBaseUrl || "https://chatgpt.com/backend-api")
    .replace(/\/+$/, "");
  return `${base}/wham/usage`;
}

function fetchWeeklyUsage(user: HostUserRecord, profileId: string | null): WeeklyUsageState {
  const observedAtMs = Date.now();
  try {
    const auth = usageAuth(user, profileId);
    const network = globalThis.hostNetwork;
    if (!network) throw new Error("host network is unavailable");
    const response = network.request({
      method: "GET",
      url: usageEndpoint(),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${auth.accessToken}`,
        "chatgpt-account-id": auth.accountId,
        ...(auth.installationId ? { "x-codex-installation-id": auth.installationId } : {}),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      return { available: false, reason: `HTTP ${response.status}`, observedAtMs };
    }
    const payload = JSON.parse(response.body);
    return weeklyUsageFromUsageResponse(payload, observedAtMs) ?? {
      available: false,
      reason: "weekly window unavailable",
      resetCredits: resetCreditsFromUsageResponse(payload),
      observedAtMs,
    };
  } catch {
    return { available: false, reason: "authentication or network unavailable", observedAtMs };
  }
}

function textResult(structuredContent: unknown, text: string): McpToolCallResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function toolMeta(resourceUri: string): Record<string, unknown> {
  return {
    ui: { resourceUri, visibility: ["app", "model"] },
    "ui/resourceUri": resourceUri,
    "openai/outputTemplate": resourceUri,
    "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
  };
}

function authenticated(connection: AppServerConnection): boolean {
  return typeof connection.identity?.id === "string" && connection.identity.id.length > 0;
}

const CATALOG_STYLE = `
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:var(--font-size-base,14px);--bg:var(--background,Canvas);--fg:var(--foreground,CanvasText);--muted:var(--muted-foreground,GrayText);--card:var(--card,color-mix(in srgb,CanvasText 4%,Canvas));--border:var(--border,color-mix(in srgb,CanvasText 15%,transparent));--primary:var(--primary,AccentColor);--primary-fg:var(--primary-foreground,AccentColorText);--success:#16865b;--warning:#a56700}
*{box-sizing:border-box}body{margin:0;padding:12px;color:var(--fg);background:transparent}.app{width:100%}.head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}h1,h2,p{margin:0}h1{font:inherit;font-weight:500}.sub{margin-top:4px;color:var(--muted);font-size:max(11px,.86em)}.toolbar{display:flex;gap:8px;margin-bottom:10px}.search{width:100%;min-height:40px;padding:8px 11px;border:1px solid var(--border);border-radius:8px;color:var(--fg);background:var(--bg);font:inherit;font-size:max(16px,1em)}button{min-height:40px;padding:7px 13px;border:1px solid var(--primary);border-radius:8px;color:var(--primary-fg);background:var(--primary);font:inherit;font-weight:500;cursor:pointer;white-space:nowrap}button:disabled{opacity:.55}.list{display:grid;gap:9px}.card{padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--card)}.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.name{font:inherit;font-weight:500;overflow-wrap:anywhere}.badge{padding:3px 8px;border:1px solid var(--border);border-radius:999px;color:var(--muted);font-size:max(10px,.75em);white-space:nowrap}.badge.ok{color:var(--success);border-color:color-mix(in srgb,var(--success) 35%,var(--border))}.meta{margin-top:5px;color:var(--muted);font-size:max(11px,.82em);overflow-wrap:anywhere}.details{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px}.detail{padding-top:8px;border-top:1px solid var(--border)}.label{color:var(--muted);font-size:max(10px,.75em)}.value{margin-top:3px;overflow-wrap:anywhere}.quota{grid-column:span 2}.meter{height:5px;margin-top:7px;border-radius:999px;background:color-mix(in srgb,var(--fg) 10%,transparent);overflow:hidden}.meter>i{display:block;height:100%;border-radius:inherit;background:var(--success)}.profiles{display:grid;gap:7px;margin-top:10px}.profile{display:flex;justify-content:space-between;gap:10px;padding:9px;border:1px solid var(--border);border-radius:8px;background:var(--bg)}.profile-main{min-width:0}.active{color:var(--success);font-size:max(10px,.75em);white-space:nowrap}.empty{padding:22px;border:1px dashed var(--border);border-radius:10px;text-align:center;color:var(--muted)}.foot{margin-top:9px;color:var(--muted);font-size:max(11px,.8em)}.error{padding:12px;border:1px solid color-mix(in srgb,var(--destructive,#d33) 45%,transparent);border-radius:10px;color:var(--destructive,#d33)}
@media(width<=520px){body{padding:8px}.details{grid-template-columns:1fr 1fr}.profile{display:block}.active{display:block;margin-top:4px}}`;

export const USERS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CATALOG_STYLE}</style></head><body><main class="app"><header class="head"><div><h1>用户列表</h1><p class="sub">查看本节点的 SSH 用户、登录信息与 Codex 绑定状态</p></div><span class="badge" id="count">0 位用户</span></header><div class="toolbar"><input class="search" id="search" type="search" placeholder="搜索用户名、角色或登录来源"><button id="refresh" type="button">刷新</button></div><section class="list" id="list" aria-live="polite"></section><p class="foot" id="stamp"></p></main><script>
const q=(id)=>document.getElementById(id),esc=(v)=>String(v??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])),fmt=(v)=>v?new Date(v).toLocaleString("zh-CN"):"—";let state={users:[]};
function render(){const term=q("search").value.trim().toLowerCase(),users=(state.users||[]).filter(u=>JSON.stringify(u).toLowerCase().includes(term));q("count").textContent=users.length+" 位用户";q("list").innerHTML=users.length?users.map(u=>{const origins=(u.loginOrigins||[]).map(o=>o.remoteHost).filter(Boolean).join("、")||"未知";return '<article class="card"><div class="card-head"><h2 class="name">'+esc(u.username)+'</h2><span class="badge '+(u.codexBindingState==="bound"?'ok':'')+'">'+esc(u.role||"成员")+'</span></div><p class="meta">'+esc(u.id)+'</p><div class="details"><div class="detail"><p class="label">Linux UID</p><p class="value">'+esc(u.linuxUid??"待分配")+'</p></div><div class="detail"><p class="label">Codex 绑定</p><p class="value">'+esc(u.codexBindingState||"未绑定")+'</p></div><div class="detail"><p class="label">登录次数</p><p class="value">'+esc(u.loginCount||0)+'</p></div><div class="detail"><p class="label">最近登录</p><p class="value">'+esc(fmt(u.lastLoginAtMs))+'</p></div><div class="detail"><p class="label">登录来源</p><p class="value">'+esc(origins)+'</p></div><div class="detail"><p class="label">订阅</p><p class="value">'+esc(u.codexPlanType||"—")+'</p></div></div></article>'}).join(""):'<div class="empty">没有匹配的用户</div>'}
async function refresh(){const b=q("refresh");b.disabled=true;try{if(!window.openai?.callTool)throw new Error("当前宿主没有 MCP App 工具桥接");const r=await window.openai.callTool("users.list",{});state=r?.structuredContent||r;render();q("stamp").textContent="更新于 "+new Date(state.observedAtMs).toLocaleTimeString("zh-CN")}catch(e){q("list").innerHTML='<div class="error">'+esc(e?.message||e)+'</div>'}finally{b.disabled=false}}
q("search").addEventListener("input",render);q("refresh").addEventListener("click",refresh);const initial=window.openai?.toolOutput;if(initial&&typeof initial==="object"){state=initial;render()}else refresh();
</script></body></html>`;

export const CODEX_ACCOUNTS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CATALOG_STYLE}
.account-card[aria-current="true"]{border-color:color-mix(in srgb,var(--success) 42%,var(--border));box-shadow:inset 3px 0 var(--success)}
.actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)}
.action-note,.detail-note,.risk{color:var(--muted);font-size:max(11px,.78em)}.action-note{margin-right:auto}.risk{margin-top:9px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--warning) 9%,transparent)}
.account-action{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:40px;padding:8px 14px}.secondary{color:var(--fg);background:transparent;border-color:var(--border)}.danger{color:var(--destructive,#c33);background:transparent;border-color:color-mix(in srgb,var(--destructive,#c33) 45%,var(--border))}
.current{color:var(--success);border-color:color-mix(in srgb,var(--success) 35%,var(--border))}.shared{color:var(--warning);border-color:color-mix(in srgb,var(--warning) 38%,var(--border))}.numeric{font-variant-numeric:tabular-nums}
@media(width<=520px){.actions{align-items:stretch}.action-note{width:100%}.account-action{flex:1}}
</style></head><body><main class="app"><header class="head"><div><h1>Codex 账户</h1><p class="sub">公开自己的订阅槽位，或使用节点成员共享的原生 Codex 凭据</p></div><span class="badge" id="count">0 个账户</span></header><div class="toolbar"><input class="search" id="search" type="search" placeholder="搜索发布者、邮箱或套餐"><button id="refresh" type="button">刷新</button></div><section class="list" id="list" aria-live="polite"></section><p class="foot" id="stamp"></p></main><script>
const q=(id)=>document.getElementById(id),esc=(v)=>String(v??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])),fmt=(v)=>v?new Date(v).toLocaleString("zh-CN"):"—";
let state={accounts:[],mode:"all"},busy=null,alertText="";
function button(action,id,label,kind=""){return '<button class="account-action '+kind+'" type="button" data-action="'+action+'" data-id="'+esc(id)+'" '+(busy?'disabled':'')+'>'+esc(busy===action+':'+id?'处理中…':label)+'</button>'}
function actions(a){const parts=[];if(a.source==="shared"){if(!a.active)parts.push(button("useShared",a.shareId,"使用此共享订阅"));if(a.owned)parts.push(button("unpublish",a.shareId,"撤回公开","danger"));return parts.length?'<div class="actions"><p class="action-note">凭据将激活到当前 SSH 用户环境</p>'+parts.join("")+'</div>':''}if(a.selectable&&!a.active)parts.push(button("select",a.profileId,"切换到此账户"));if(a.owned)parts.push(a.published?button("unpublish",a.shareId,"撤回公开","danger"):button("publish",a.profileId,"公开给节点用户","secondary"));return parts.length?'<div class="actions"><p class="action-note">'+(a.published?'该槽位已对节点用户公开':'这是你保存的私有槽位')+'</p>'+parts.join("")+'</div>':''}
function render(){const term=q("search").value.trim().toLowerCase(),accounts=(state.accounts||[]).filter(a=>JSON.stringify(a).toLowerCase().includes(term)),notice=alertText?'<div class="error" role="alert">'+esc(alertText)+'</div>':'';q("count").textContent=accounts.length+" 个账户";q("list").innerHTML=notice+(accounts.length?accounts.map(a=>{const u=a.weeklyUsage,remaining=u?.available?u.remainingPercent+'%':'暂不可用',reset=u?.available?fmt(u.resetsAtMs):'—',credits=u?.resetCredits,applicable=credits?credits.applicableAvailableCount+' 张':'—',held=credits?'持有 '+credits.availableCount+' 张':'接口未提供',bar=u?.available?'<div class="meter" role="progressbar" aria-label="周额度剩余" aria-valuenow="'+esc(u.remainingPercent)+'" aria-valuemin="0" aria-valuemax="100"><i style="width:'+Math.max(0,Math.min(100,Number(u.remainingPercent)))+'%"></i></div>':'',badge=a.active?'<span class="badge current">当前使用</span>':a.source==="shared"?'<span class="badge shared">节点共享</span>':a.source==="audit"?'<span class="badge">成员账户</span>':a.published?'<span class="badge shared">已公开</span>':'<span class="badge">私有</span>',risk=a.source==="shared"?'<p class="risk">该订阅由 '+esc(a.username)+' 提供；激活后使用真实共享凭据与额度。</p>':'';return '<article class="card account-card" aria-current="'+(a.active?'true':'false')+'"><div class="card-head"><h2 class="name">'+esc(a.displayName||a.email||a.username)+'</h2>'+badge+'</div><p class="meta">'+(a.source==="shared"?'发布者 ':'SSH 用户 ')+esc(a.username)+(a.email?' · '+esc(a.email):'')+(a.planType?' · '+esc(a.planType):'')+'</p><div class="details"><div class="detail quota"><p class="label">周额度剩余</p><p class="value numeric">'+esc(remaining)+'</p>'+bar+'</div><div class="detail"><p class="label">周额度重置</p><p class="value numeric">'+esc(reset)+'</p></div><div class="detail"><p class="label">当前可用重置券</p><p class="value numeric">'+esc(applicable)+'</p><p class="detail-note">'+esc(held)+'</p></div><div class="detail"><p class="label">认证方式</p><p class="value">'+esc(a.authMode||"—")+'</p></div><div class="detail"><p class="label">来源</p><p class="value">'+esc(a.source==="shared"?"节点共享":a.source==="audit"?"管理员只读":"本人保存")+'</p></div><div class="detail"><p class="label">最近验证</p><p class="value numeric">'+esc(fmt(a.lastVerifiedAtMs))+'</p></div></div>'+risk+actions(a)+'</article>'}).join(""):'<div class="empty">'+(state.mode==="shared"?'当前没有公开的 Codex 订阅':'没有可见的 Codex 账户')+'</div>')}
async function call(tool,args){if(!window.openai?.callTool)throw new Error("当前宿主没有 MCP App 工具桥接");const r=await window.openai.callTool(tool,args);return r?.structuredContent||r}
async function refresh(force=true){const b=q("refresh");b.disabled=true;alertText="";try{state=await call("codexAccounts.list",{refresh:force,mode:state.mode==="shared"?"shared":"all"});q("stamp").textContent="更新于 "+new Date(state.observedAtMs).toLocaleTimeString("zh-CN")}catch(e){alertText=e?.message||String(e)}finally{b.disabled=false;render()}}
async function mutate(action,id){if(busy)return;busy=action+':'+id;alertText="";render();const tools={select:["codexAccounts.select",{profileId:id}],publish:["codexAccounts.publish",{profileId:id}],unpublish:["codexAccounts.unpublish",{shareId:id}],useShared:["codexAccounts.useShared",{shareId:id}]};try{await call(...tools[action]);await refresh(false);q("stamp").textContent="操作已生效 · "+new Date().toLocaleTimeString("zh-CN")}catch(e){alertText=e?.message||String(e)}finally{busy=null;render()}}
q("search").addEventListener("input",render);q("refresh").addEventListener("click",()=>refresh(true));q("list").addEventListener("click",(event)=>{const button=event.target.closest?.("button[data-action]");if(button)mutate(button.dataset.action,button.dataset.id)});const initial=window.openai?.toolOutput;if(initial&&typeof initial==="object"){state=initial;render()}else refresh();
</script></body></html>`;

export class ManagementCatalogAppsService extends Service {
  static inject = ["accountCatalog", "mcpRegistry", "sharedCodex", "userDirectory"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;
  private readonly weeklyUsageCache = new Map<string, WeeklyUsageState>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "managementCatalogApps");
    ctx.effect(() => ctx.mcpRegistry.registerServer(this.usersRegistration()));
    ctx.effect(() => ctx.mcpRegistry.registerServer(this.accountsRegistration()));
  }

  users(): Record<string, unknown> {
    return {
      users: this.ctx.userDirectory.list().map((user) => ({
        id: user.id,
        username: user.username,
        role: user.role ?? "member",
        linuxUid: user.linuxUid ?? null,
        codexBindingState: user.codexBindingState ?? "unbound",
        codexPlanType: user.codexPlanType ?? null,
        loginCount: Number(user["loginCount"] ?? 0),
        lastLoginAtMs: Number(user["lastLoginAtMs"] ?? 0) || null,
        loginOrigins: Array.isArray(user["loginOrigins"])
          ? user["loginOrigins"].map((origin) => {
            const record = origin as Record<string, unknown>;
            return {
              remoteHost: typeof record["remoteHost"] === "string" ? record["remoteHost"] : null,
              loginCount: Number(record["loginCount"] ?? 0),
              lastLoginAtMs: Number(record["lastLoginAtMs"] ?? 0) || null,
            };
          })
          : [],
      })),
      observedAtMs: Date.now(),
    };
  }

  accounts(connection: AppServerConnection, mode = "all"): Record<string, unknown> {
    const currentUserId = connection.identity?.id ?? null;
    const accounts: Array<Record<string, unknown>> = [];
    const activeShared = this.ctx.sharedCodex.activeForUser(currentUserId);
    for (const account of this.ctx.accountCatalog.list(connection)) {
      const shared = {
        userId: account.userId ?? null,
        username: account.username,
        authMode: account.authMode,
        boundAtMs: account.boundAtMs ?? null,
        lastVerifiedAtMs: account.lastVerifiedAtMs ?? null,
        remoteControlStatus: account.remoteControlStatus,
      };
      const profiles = account.profiles ?? [];
      if (profiles.length === 0) {
        // Activating a node-shared subscription materializes its auth into the
        // consumer runtime. That host projection is not an owned account; the
        // shared entry below remains the authoritative UI representation.
        if (account.userId === currentUserId && activeShared !== null) continue;
        accounts.push({
          ...shared,
          source: account.userId === currentUserId ? "owned" : "audit",
          profileId: null,
          displayName: account.email ?? account.username,
          email: account.email,
          planType: account.planType,
          bindingState: account.bindingState ?? "unbound",
          active: false,
          selectable: false,
          owned: account.userId === currentUserId,
        });
        continue;
      }
      for (const profile of profiles) {
        const published = account.userId
          ? this.ctx.sharedCodex.shareForOwnerProfile(account.userId, profile.id)
          : null;
        if (published !== null && account.userId !== currentUserId) continue;
        accounts.push({
          ...shared,
          source: account.userId === currentUserId ? "owned" : "audit",
          profileId: profile.id,
          displayName: profile.name,
          email: profile.email,
          planType: profile.planType,
          bindingState: "bound",
          active: account.activeProfileId === profile.id,
          selectable: account.userId === currentUserId,
          owned: account.userId === currentUserId,
          published: published !== null,
          shareId: published?.shareId ?? null,
        });
      }
    }
    for (const shared of this.ctx.sharedCodex.list()) {
      accounts.push({
        source: "shared",
        userId: shared.ownerUserId,
        username: shared.ownerUsername,
        authMode: "chatgpt",
        boundAtMs: shared.publishedAtMs,
        lastVerifiedAtMs: shared.updatedAtMs,
        remoteControlStatus: "共享订阅",
        profileId: shared.ownerProfileId,
        shareId: shared.shareId,
        displayName: shared.displayName,
        email: shared.email,
        planType: shared.planType,
        bindingState: "bound",
        active: activeShared?.shareId === shared.shareId,
        selectable: true,
        owned: shared.ownerUserId === currentUserId,
        published: true,
      });
    }
    accounts.sort((left, right) => {
      const rank = (account: Record<string, unknown>): number =>
        account["source"] === "shared" ? 0 : account["owned"] === true ? 1 : 2;
      return rank(left) - rank(right) ||
        String(left["displayName"] ?? left["username"] ?? "")
          .localeCompare(String(right["displayName"] ?? right["username"] ?? ""));
    });
    return {
      accounts: mode === "shared"
        ? accounts.filter((account) => account["source"] === "shared")
        : accounts,
      mode,
      observedAtMs: Date.now(),
    };
  }

  accountsWithUsage(
    connection: AppServerConnection,
    forceRefresh = false,
    mode = "all",
  ): Record<string, unknown> {
    const result = this.accounts(connection, mode);
    const users = new Map(this.ctx.userDirectory.list().map((user) => [user.id, user]));
    const accounts = (result["accounts"] as Array<Record<string, unknown>>).map((account) => {
      const userId = typeof account["userId"] === "string" ? account["userId"] : null;
      const profileId = typeof account["profileId"] === "string" ? account["profileId"] : null;
      const user = userId ? users.get(userId) : null;
      if (!user || !profileId || account["bindingState"] !== "bound") {
        return { ...account, weeklyUsage: null };
      }
      const cacheKey = `${user.id}:${profileId}`;
      const cached = this.weeklyUsageCache.get(cacheKey);
      const fresh = cached && Date.now() - cached.observedAtMs < 60_000;
      const weeklyUsage = !forceRefresh && fresh
        ? cached
        : fetchWeeklyUsage(user, profileId);
      this.weeklyUsageCache.set(cacheKey, weeklyUsage);
      return { ...account, weeklyUsage };
    });
    return { ...result, accounts, observedAtMs: Date.now() };
  }

  selectAccount(
    connection: AppServerConnection,
    profileId: string,
  ): Record<string, unknown> {
    const account = (this.accounts(connection)["accounts"] as Array<Record<string, unknown>>)
      .find((candidate) => candidate["profileId"] === profileId &&
        candidate["selectable"] === true && candidate["source"] !== "shared");
    if (!account) throw new Error("the Codex account is not available to the current SSH user");
    const selected = this.ctx.accountCatalog.selectProfile(connection, { profileId });
    const result = this.accountsWithUsage(connection, false);
    return {
      ...result,
      selectedProfileId: selected.profile.profileId,
      runtimeRefresh: selected.runtimeRefresh,
    };
  }

  publishAccount(connection: AppServerConnection, profileId: string): Record<string, unknown> {
    const shared = this.ctx.sharedCodex.publish(connection, profileId);
    return { ...this.accountsWithUsage(connection, false), publishedShareId: shared.shareId };
  }

  unpublishAccount(connection: AppServerConnection, shareId: string): Record<string, unknown> {
    this.ctx.sharedCodex.unpublish(connection, shareId);
    return { ...this.accountsWithUsage(connection, false), unpublishedShareId: shareId };
  }

  useSharedAccount(connection: AppServerConnection, shareId: string): Record<string, unknown> {
    const activated = this.ctx.sharedCodex.activate(connection, shareId);
    return {
      ...this.accountsWithUsage(connection, false, "shared"),
      selectedShareId: activated.share.shareId,
      runtimeRefresh: activated.runtimeRefresh,
    };
  }

  private usersRegistration(): McpServerRegistration {
    return {
      name: USERS_SERVER_NAME,
      pluginId: "hypernode-control",
      title: "用户列表",
      description: "以只读方式查看已注册的 HyperNode SSH 用户。",
      version: "1.0.0",
      visible: authenticated,
      tools: [{
        name: "users.list",
        title: "查看用户列表",
        description: "列出已注册的 SSH 用户、登录活动与 Codex 绑定状态。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: { type: "object", properties: { users: { type: "array" }, observedAtMs: { type: "number" } }, required: ["users", "observedAtMs"] },
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: toolMeta(USERS_RESOURCE_URI),
        call: () => {
          const result = this.users();
          return textResult(result, `HyperNode 当前有 ${(result["users"] as unknown[]).length} 位注册用户。`);
        },
      }],
      resources: [{ uri: USERS_RESOURCE_URI, name: "hypernode-users-ui", title: "用户列表", mimeType: "text/html;profile=mcp-app", read: () => USERS_HTML }],
    };
  }

  private accountsRegistration(): McpServerRegistration {
    return {
      name: CODEX_ACCOUNTS_SERVER_NAME,
      pluginId: "hypernode-control",
      title: "Codex 账户",
      description: "查看、公开并使用当前节点上的 Codex 订阅槽位。",
      version: "6.0.0",
      visible: authenticated,
      tools: [{
        name: "codexAccounts.list",
        title: "查看 Codex 账户绑定",
        description: "列出当前 SSH 身份可见的 Codex 绑定与订阅槽位。",
        inputSchema: {
          type: "object",
          properties: {
            refresh: { type: "boolean" },
            mode: { type: "string", enum: ["all", "shared"] },
          },
          additionalProperties: false,
        },
        outputSchema: { type: "object", properties: { accounts: { type: "array" }, observedAtMs: { type: "number" } }, required: ["accounts", "observedAtMs"] },
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: toolMeta(CODEX_ACCOUNTS_RESOURCE_URI),
        call: (argumentsValue, context) => {
          const argumentsRecord = record(argumentsValue);
          const result = this.accountsWithUsage(
            context.connection,
            argumentsRecord?.["refresh"] === true,
            argumentsRecord?.["mode"] === "shared" ? "shared" : "all",
          );
          return textResult(result, `当前可查看 ${(result["accounts"] as unknown[]).length} 个 Codex 账户绑定。`);
        },
      }, {
        name: "codexAccounts.select",
        title: "切换当前 Codex 账户",
        description: "将当前 SSH 用户切换到指定的已保存 Codex 账户。",
        inputSchema: {
          type: "object",
          properties: { profileId: { type: "string", minLength: 1 } },
          required: ["profileId"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            accounts: { type: "array" },
            observedAtMs: { type: "number" },
            selectedProfileId: { type: "string" },
            runtimeRefresh: { type: "object" },
          },
          required: ["accounts", "observedAtMs", "selectedProfileId", "runtimeRefresh"],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: toolMeta(CODEX_ACCOUNTS_RESOURCE_URI),
        call: (argumentsValue, context) => {
          const profileId = record(argumentsValue)?.["profileId"];
          if (typeof profileId !== "string" || !profileId.trim()) {
            throw new Error("profileId is required");
          }
          const result = this.selectAccount(context.connection, profileId.trim());
          return textResult(result, "已切换当前 SSH 用户使用的 Codex 账户。");
        },
      }, {
        name: "codexAccounts.publish",
        title: "公开 Codex 订阅",
        description: "将当前 SSH 用户拥有的 Codex 槽位公开给本节点其他用户。",
        inputSchema: {
          type: "object",
          properties: { profileId: { type: "string", minLength: 1 } },
          required: ["profileId"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: toolMeta(CODEX_ACCOUNTS_RESOURCE_URI),
        call: (argumentsValue, context) => {
          const profileId = record(argumentsValue)?.["profileId"];
          if (typeof profileId !== "string" || !profileId.trim()) throw new Error("profileId is required");
          const result = this.publishAccount(context.connection, profileId.trim());
          return textResult(result, "该 Codex 订阅已公开给本节点用户。");
        },
      }, {
        name: "codexAccounts.unpublish",
        title: "撤回公开 Codex 订阅",
        description: "撤回自己发布的共享 Codex 槽位，并使消费者回退到自己的账户。",
        inputSchema: {
          type: "object",
          properties: { shareId: { type: "string", minLength: 1 } },
          required: ["shareId"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        _meta: toolMeta(CODEX_ACCOUNTS_RESOURCE_URI),
        call: (argumentsValue, context) => {
          const shareId = record(argumentsValue)?.["shareId"];
          if (typeof shareId !== "string" || !shareId.trim()) throw new Error("shareId is required");
          const result = this.unpublishAccount(context.connection, shareId.trim());
          return textResult(result, "已撤回该共享 Codex 订阅。");
        },
      }, {
        name: "codexAccounts.useShared",
        title: "使用共享 Codex 订阅",
        description: "将一个节点公开的 Codex 槽位激活到当前 SSH 用户环境。",
        inputSchema: {
          type: "object",
          properties: { shareId: { type: "string", minLength: 1 } },
          required: ["shareId"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: toolMeta(CODEX_ACCOUNTS_RESOURCE_URI),
        call: (argumentsValue, context) => {
          const shareId = record(argumentsValue)?.["shareId"];
          if (typeof shareId !== "string" || !shareId.trim()) throw new Error("shareId is required");
          const result = this.useSharedAccount(context.connection, shareId.trim());
          return textResult(result, "已切换到共享 Codex 订阅；凭据已激活到当前 SSH 用户环境。");
        },
      }],
      resources: [{ uri: CODEX_ACCOUNTS_RESOURCE_URI, name: "hypernode-codex-accounts-ui", title: "Codex 账户", mimeType: "text/html;profile=mcp-app", read: () => CODEX_ACCOUNTS_HTML }],
    };
  }
}
