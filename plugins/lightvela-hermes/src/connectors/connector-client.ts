import type { LightVelaAccountService } from "../account/lightvela-account-service";
import type { BotTerminalSession } from "../domain/types";
import { HermesTatTerminalService } from "../hermes-appserver-bridge/tat-terminal";
import { createTatPortFetch, type TatHttpVirtualFetch } from "../lib/tat-http-virtual-client";
import { installerScript } from "./installer-script";

export interface ConnectorCard {
  id: string; name: string; description: string; type: string; authMode: string;
  status: string; tools: string[]; hasTokenSchema: boolean;
}
export interface ConnectorInstance { instanceId: string; packageId: string; displayName: string; defaultOpen: boolean }
export interface ConnectorState { id: string; status: string; error?: string; tools: string[] }
export interface ConnectorDetail {
  icon?: string;
  definition: { name_zh?: string; description_zh?: string; examples_zh?: string[] };
  tokenSchema?: { description?: string; fields: { key: string; label?: string; required?: boolean; secret?: boolean; type?: string }[] };
}
export interface ConnectorRelease { url: string; sha256: string }
export class SidecarNotInstalled extends Error {
  constructor() { super("Sidecar is not installed"); this.name = "SidecarNotInstalled"; }
}

/** PTY output is a terminal stream: bracketed-paste CSI and bare CR may precede a record. */
export function readConnectorBootstrap(output: string): string {
  const lines = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r\n?/g, "\n").split("\n");
  const record = lines.find((line) => /^OVERMIND_INFO=[A-Za-z0-9+/=]+$/.test(line));
  if (record) return record.slice("OVERMIND_INFO=".length);
  if (lines.includes("OVERMIND_MISSING")) throw new SidecarNotInstalled();
  throw new Error("运行服务连接信息未能解析；请检查连接，不必重复安装。");
}

// These three packages omit auth_mode in the upstream manifest; WorkBuddy injects
// credentials through its separate library-account flow, not MCP OAuth.
const workbuddyManagedPackages = new Set(["ima-mcp", "tencent-docs", "lexiang"]);
export function requiresWorkbuddyAccount(card: ConnectorCard): boolean {
  return workbuddyManagedPackages.has(card.id) || ["server-side", "gateway", "oneid-token"].includes(card.authMode);
}

// These upstream manifests omit auth_mode; their MCP endpoints require OAuth.
const oauthPackages = new Set(["canva", "canva-ai", "westock-mcp"]);
export function requiresBrowserOAuth(card: ConnectorCard): boolean {
  return oauthPackages.has(card.id) || ["oauth", "mcp"].includes(card.authMode);
}
export function isConnectorVisible(card: ConnectorCard): boolean {
  return !requiresWorkbuddyAccount(card) && !requiresBrowserOAuth(card);
}
export function prototypeUnsupported(card: ConnectorCard): string | null {
  if (requiresWorkbuddyAccount(card)) return "需要 WorkBuddy 专属账号服务，暂不可用";
  if (requiresBrowserOAuth(card)) return "远程 OAuth 回调尚未接入，暂不可用";
  return null;
}

export function validateRelease(release: ConnectorRelease): ConnectorRelease {
  const url = new URL(release.url);
  if (url.protocol !== "https:" || url.username || url.password || !/^[a-f0-9]{64}$/.test(release.sha256)) {
    throw new Error("需要 HTTPS 产物地址及 64 位 SHA256");
  }
  return { url: url.href, sha256: release.sha256 };
}

/** A settings view owns this transport, never the VM daemon or the Agent session. */
export class HermesConnectorClient {
  private readonly abort = new AbortController();
  private readonly terminal: HermesTatTerminalService;
  private fetch: TatHttpVirtualFetch | null = null;
  private secret = "";
  private sequence = 0;
  private readonly details = new Map<string, Promise<ConnectorDetail>>();

  constructor(private readonly account: LightVelaAccountService, readonly botId: string) {
    this.terminal = new HermesTatTerminalService({ createSession: () => this.createSession() });
  }
  private createSession() {
    this.abort.signal.throwIfAborted();
    return this.account.request<BotTerminalSession>(`/v1/instances/${encodeURIComponent(this.botId)}/tat/session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: this.abort.signal,
    });
  }
  private async exec(command: string[]): Promise<string> {
    this.abort.signal.throwIfAborted();
    const processId = `overmind-${++this.sequence}`;
    let output = "";
    const unsubscribe = this.terminal.subscribeNotification(({ params }) => {
      if (params.processId !== processId) return;
      output = (output + new TextDecoder().decode(Uint8Array.from(atob(params.deltaBase64), (c) => c.charCodeAt(0)))).slice(-131072);
    });
    const timer = setTimeout(() => { void this.terminal.terminate({ processId }).catch(() => undefined); }, 180000);
    try {
      const result = await this.terminal.exec({ command, processId });
      this.abort.signal.throwIfAborted();
      if (result.exitCode !== 0) throw new Error(`远端命令失败（${result.exitCode}）。请检查 VM 的 ~/.overmind/daemon.log；未将日志或凭据回传到界面。`);
      return output;
    } finally { clearTimeout(timer); unsubscribe(); }
  }
  async install(release: ConnectorRelease) {
    const validated = validateRelease(release);
    await this.exec(["bash", "-c", installerScript, "install-overmind", validated.url, validated.sha256]);
    await this.connect();
  }
  async connect() {
    // Explicit tagged base64 keeps the PTY prompt/echo out of the private bootstrap payload.
    const output = await this.exec(["python3", "-c", "import pathlib,base64,os; p=pathlib.Path(os.environ.get('OVERMIND_HOME',str(pathlib.Path.home()/'.overmind')))/'connection.json'; print('OVERMIND_'+'INFO='+base64.b64encode(p.read_bytes()).decode() if p.is_file() else 'OVERMIND_'+'MISSING')"]);
    const encoded = readConnectorBootstrap(output);
    const info = JSON.parse(atob(encoded)) as { apiBaseUrl: string; proxySecret: string };
    const url = new URL(info.apiBaseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || typeof info.proxySecret !== "string" || !info.proxySecret) {
      throw new Error("Sidecar 本地连接信息无效");
    }
    const bootstrap = await this.createSession();
    this.abort.signal.throwIfAborted();
    this.fetch?.close();
    // This client performs mutations: never replay a request after an ambiguous keep-alive failure.
    this.fetch = createTatPortFetch(bootstrap, url.port, { keepAlive: false });
    this.secret = info.proxySecret;
    await this.request("/v1/state");
  }
  async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    this.abort.signal.throwIfAborted();
    if (!this.fetch) throw new Error("尚未连接 Sidecar");
    const response = await this.fetch(path, { method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { Authorization: `Bearer ${this.secret}` }, signal: this.abort.signal,
      ...(body === undefined ? {} : { json: body }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`连接器请求失败（HTTP ${response.status}）`);
    return result as T;
  }
  detail(id: string) {
    let result = this.details.get(id);
    if (!result) {
      result = this.request<ConnectorDetail>(`/v1/catalog/${encodeURIComponent(id)}`);
      this.details.set(id, result);
      void result.catch(() => { this.details.delete(id); });
    }
    return result;
  }
  dispose() {
    this.abort.abort(); this.terminal.dispose(); this.fetch?.close(); this.fetch = null;
    this.secret = ""; this.details.clear();
  }
}
