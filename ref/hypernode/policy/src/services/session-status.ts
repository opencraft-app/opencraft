import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { HostUserRecord } from "../types/host-policy.ts";
import type { McpServerRegistration, McpToolCallResult } from "../types/mcp.ts";

export const SESSION_STATUS_SERVER_NAME = "hypernode-session-status";
export const SESSION_STATUS_RESOURCE_URI = "ui://hypernode/session-status.html";

type Dependencies =
  | "accountCatalog"
  | "mcpRegistry"
  | "modelGateway"
  | "threadEngineBinding"
  | "threadExecution"
  | "threadManager"
  | "transparentRuntimeAccess"
  | "transparentThreadBinding"
  | "userDirectory";

interface StatusAccount {
  username: string;
  displayName: string;
  email: string | null;
  planType: string | null;
  accountIdSuffix: string | null;
}

interface SessionStatus {
  threadId: string;
  engine: {
    id: string;
    label: string;
    generation: number | null;
    provenance: string | null;
  };
  model: {
    id: string | null;
    label: string;
    providerId: string | null;
    providerLabel: string;
  };
  account: StatusAccount | null;
  runtime: {
    phase: string;
    realm: string | null;
    activeTurn: boolean;
    pendingModel: string | null;
    pendingProviderId: string | null;
  };
  observedAtMs: number;
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function accountSuffix(identity: string | null): string | null {
  const value = identity?.startsWith("chatgpt:") ? identity.slice("chatgpt:".length) : "";
  return value ? value.slice(-8) : null;
}

function toolMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: SESSION_STATUS_RESOURCE_URI, visibility: ["app", "model"] },
    "ui/resourceUri": SESSION_STATUS_RESOURCE_URI,
    "openai/outputTemplate": SESSION_STATUS_RESOURCE_URI,
    "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
  };
}

function toolResult(status: SessionStatus): McpToolCallResult {
  const model = status.model.id ?? "引擎默认";
  const account = status.account ? `，Codex 账户 ${status.account.username}` : "";
  return {
    content: [{
      type: "text",
      text: `当前会话使用 ${status.engine.label} / ${model}${account}。`,
    }],
    structuredContent: status,
  };
}

export const SESSION_STATUS_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:var(--font-size-base,14px);--bg:var(--background,Canvas);--fg:var(--foreground,CanvasText);--muted:var(--muted-foreground,GrayText);--card:var(--card,color-mix(in srgb,CanvasText 4%,Canvas));--border:var(--border,color-mix(in srgb,CanvasText 15%,transparent));--primary:var(--primary,AccentColor);--primary-fg:var(--primary-foreground,AccentColorText);--success:#16a064}
*{box-sizing:border-box}body{margin:0;padding:12px;color:var(--fg);background:transparent}.app{width:100%}.head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}h1,h2,p{margin:0}h1{font:inherit;font-weight:600}.subtitle{margin-top:4px;color:var(--muted);font-size:max(11px,.86em)}.live{display:inline-flex;align-items:center;gap:6px;color:var(--success);font-size:max(11px,.8em);white-space:nowrap}.dot{width:7px;height:7px;border-radius:50%;background:currentColor}.hero{display:grid;grid-template-columns:1fr 1fr;gap:10px}.card{padding:13px;border:1px solid var(--border);border-radius:10px;background:var(--card);min-width:0}.label{color:var(--muted);font-size:max(11px,.8em);margin-bottom:7px}.value{font-size:1.15em;font-weight:600;overflow-wrap:anywhere}.meta{margin-top:5px;color:var(--muted);font-size:max(11px,.82em);overflow-wrap:anywhere}.rows{margin-top:10px;border:1px solid var(--border);border-radius:10px;overflow:hidden}.row{display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px;padding:11px 13px}.row+.row{border-top:1px solid var(--border)}.row dt{color:var(--muted)}.row dd{margin:0;text-align:right;overflow-wrap:anywhere}.footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px}.stamp{color:var(--muted);font-size:max(11px,.8em)}button{min-height:38px;padding:7px 13px;border:1px solid var(--primary);border-radius:8px;color:var(--primary-fg);background:var(--primary);font:inherit;cursor:pointer}button:disabled{opacity:.55;cursor:default}.error{padding:12px;border:1px solid color-mix(in srgb,#d33 45%,transparent);border-radius:10px;color:#d33;background:color-mix(in srgb,#d33 7%,transparent)}
@media(width<=480px){body{padding:8px}.hero{grid-template-columns:1fr}.row{grid-template-columns:88px minmax(0,1fr)}}
</style></head><body><main class="app"><header class="head"><div><h1>当前会话状态</h1><p class="subtitle">引擎、模型与执行身份</p></div><span class="live"><span class="dot"></span>LIVE</span></header><section id="content" aria-live="polite"></section><div class="footer"><span class="stamp" id="stamp"></span><button id="refresh" type="button">刷新状态</button></div></main>
<script>
const q=(id)=>document.getElementById(id),esc=(v)=>String(v??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function render(s){const account=s.account?esc(s.account.username)+" · "+esc(s.account.displayName)+(s.account.planType?" · "+esc(s.account.planType):""):"不适用";const email=s.account?s.account.email?esc(s.account.email):"仅账户所有者可见":"不适用";const pending=s.runtime.pendingModel||s.runtime.pendingProviderId;const status=s.runtime.activeTurn?"正在执行":s.runtime.phase==="ready"?"运行时就绪":s.runtime.phase==="offline"?"未启动":"空闲";q("content").innerHTML='<div class="hero"><article class="card"><p class="label">执行引擎</p><h2 class="value">'+esc(s.engine.label)+'</h2><p class="meta">'+esc(s.engine.id)+(s.engine.generation?' · 第 '+esc(s.engine.generation)+' 代':'')+'</p></article><article class="card"><p class="label">当前模型</p><h2 class="value">'+esc(s.model.label)+'</h2><p class="meta">'+esc(s.model.providerLabel)+'</p></article></div><dl class="rows"><div class="row"><dt>Codex 账户</dt><dd>'+account+'</dd></div><div class="row"><dt>订阅邮箱</dt><dd>'+email+'</dd></div><div class="row"><dt>运行状态</dt><dd>'+esc(status)+(s.runtime.realm?' · '+esc(s.runtime.realm):'')+'</dd></div>'+(pending?'<div class="row"><dt>下轮生效</dt><dd>'+esc(s.runtime.pendingModel||s.model.label)+(s.runtime.pendingProviderId?' · '+esc(s.runtime.pendingProviderId):'')+'</dd></div>':'')+'<div class="row"><dt>会话 ID</dt><dd>'+esc(s.threadId)+'</dd></div></dl>';q("stamp").textContent="更新于 "+new Date(s.observedAtMs).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}
async function refresh(){const button=q("refresh");button.disabled=true;button.textContent="刷新中…";try{if(!window.openai?.callTool)throw new Error("当前宿主没有 MCP App 工具桥接");const r=await window.openai.callTool("sessionStatus.get",{});render(r?.structuredContent||r)}catch(e){q("content").innerHTML='<div class="error">'+esc(e?.message||e)+'</div>'}finally{button.disabled=false;button.textContent="刷新状态"}}
q("refresh").addEventListener("click",refresh);const initial=window.openai?.toolOutput;if(initial&&typeof initial==="object")render(initial);else refresh();
</script></body></html>`;

export class SessionStatusService extends Service {
  static inject = [
    "accountCatalog",
    "mcpRegistry",
    "modelGateway",
    "threadEngineBinding",
    "threadExecution",
    "threadManager",
    "transparentRuntimeAccess",
    "transparentThreadBinding",
    "userDirectory",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "sessionStatus");
    ctx.effect(() => ctx.mcpRegistry.registerServer(this.registration()));
  }

  status(threadId: string, connection: AppServerConnection): SessionStatus {
    const actor = connection.identity?.id ?? null;
    const thread = this.ctx.threadManager.find(threadId);
    if (!thread || !this.ctx.threadManager.visibleTo(threadId, actor)) {
      throw rpcError(-32004, "thread not found or not accessible");
    }

    const execution = this.ctx.threadExecution.table.get(threadId);
    const runtime = this.ctx.transparentRuntimeAccess.stateForOuter(threadId);
    const hint = this.ctx.transparentThreadBinding.runtimeHintFor(threadId);
    const profile = execution?.executionProfile ?? runtime?.executionProfile ?? null;
    const binding = this.ctx.threadEngineBinding.get(threadId);
    const engineId = text(profile?.engineKind) ?? text(hint?.engineKind) ??
      text(binding?.engineKind) ?? "codex";
    const providerId = text(profile?.providerId) ?? text(hint?.providerId) ??
      text(thread["modelProvider"]) ?? (engineId === "codex" ? "openai" : null);
    const modelId = text(profile?.model) ?? text(hint?.model) ?? text(thread["model"]);
    const ownerUserId = text(profile?.actorUserId) ?? text(runtime?.ownerUserId) ??
      text(hint?.ownerUserId) ?? this.ctx.threadManager.ownerOf(threadId);
    const accountIdentity = text(profile?.credentialIdentity) ?? text(runtime?.accountIdentity) ??
      text(hint?.accountIdentity);
    const user = ownerUserId ? this.ctx.userDirectory.find(ownerUserId) : null;
    const provider = ownerUserId && providerId
      ? this.ctx.modelGateway.visibleRecordsForUser(ownerUserId)
        .find((candidate) => candidate.providerId === providerId) ?? null
      : null;
    const account = engineId === "codex"
      ? this.codexAccount(user, accountIdentity, actor === ownerUserId)
      : null;

    return {
      threadId,
      engine: {
        id: engineId,
        label: engineId === "codex" ? "Codex" : engineId === "dsh" ? "DSH 云端 Agent" : engineId,
        generation: binding?.generation ?? null,
        provenance: binding?.provenance ?? null,
      },
      model: {
        id: modelId,
        label: modelId ?? "引擎默认模型",
        providerId,
        providerLabel: text(provider?.displayName) ??
          (providerId === "openai" ? "OpenAI · Codex 订阅" : providerId ?? "引擎默认提供方"),
      },
      account,
      runtime: {
        phase: text((execution as Record<string, unknown> | null)?.["state"]) ??
          text(runtime?.phase) ?? "offline",
        realm: text(runtime?.realm) ?? text(this.ctx.transparentThreadBinding.bindings.get(threadId)?.realm),
        activeTurn: execution != null,
        pendingModel: hint?.nextModel !== undefined && hint.nextModel !== hint.model
          ? text(hint.nextModel)
          : null,
        pendingProviderId: hint?.nextProviderId !== undefined &&
            hint.nextProviderId !== hint.providerId
          ? text(hint.nextProviderId)
          : null,
      },
      observedAtMs: Date.now(),
    };
  }

  private codexAccount(
    user: HostUserRecord | null,
    identity: string | null,
    revealEmail: boolean,
  ): StatusAccount | null {
    if (!user) return null;
    const profile = this.ctx.accountCatalog.codexProfileForIdentity(user, identity);
    const suffix = accountSuffix(identity);
    const profileName = text(profile?.name);
    const safeName = profileName && !profileName.includes("@")
      ? profileName
      : profile?.planType
      ? `ChatGPT ${profile.planType}`
      : suffix
      ? `ChatGPT ···${suffix}`
      : "Codex 订阅";
    return {
      username: user.username,
      displayName: safeName,
      email: revealEmail ? profile?.email ?? user.codexAccountEmail ?? null : null,
      planType: profile?.planType ?? user.codexPlanType ?? null,
      accountIdSuffix: suffix,
    };
  }

  registration(): McpServerRegistration {
    return {
      name: SESSION_STATUS_SERVER_NAME,
      pluginId: "hypernode-control",
      title: "当前会话状态",
      description: "Read-only view of the current HyperNode thread engine, model, runtime, and Codex account owner.",
      version: "1.0.0",
      tools: [{
        name: "sessionStatus.get",
        title: "Get current session status",
        description: "Return the engine, model, runtime state, and safe Codex account label for this conversation.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: {
          type: "object",
          properties: {
            threadId: { type: "string" },
            engine: { type: "object" },
            model: { type: "object" },
            account: { type: ["object", "null"] },
            runtime: { type: "object" },
            observedAtMs: { type: "number" },
          },
          required: ["threadId", "engine", "model", "account", "runtime", "observedAtMs"],
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: toolMeta(),
        call: (_argumentsValue, context) => toolResult(this.status(context.threadId, context.connection)),
      }],
      resources: [{
        uri: SESSION_STATUS_RESOURCE_URI,
        name: "hypernode-session-status-ui",
        title: "当前会话状态",
        description: "Current engine, model, runtime, and Codex account owner.",
        mimeType: "text/html;profile=mcp-app",
        read: () => SESSION_STATUS_HTML,
      }],
    };
  }
}
