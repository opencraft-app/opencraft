import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthClientInformationSchema as OAuthClientInformationMixedSchema, OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ConnectorOAuthProgress } from "@opencraft/connector-core";
import { ConnectorDatabase, ConnectorHostError, type OAuthTransaction } from "./store";
import { OAUTH_SERVICES } from "./mcp-endpoints";
import { connectorFetch } from "./network";

/** OAuth authority is the Host, including temporary secrets; the renderer only polls status. */
export class ConnectorOAuth {
  private readonly listeners = new Map<string, { server: Server; timer: ReturnType<typeof setTimeout>; abort: AbortController }>();
  private readonly refreshing = new Map<string, Promise<void>>();
  constructor(private readonly db: ConnectorDatabase, private readonly changed: (instanceId: string) => void,
    private readonly services = OAUTH_SERVICES, private readonly fetchOverride?: typeof fetch) {}
  async start(instanceId: string): Promise<ConnectorOAuthProgress> {
    const row = this.db.get(instanceId), service = this.services[row.definitionId];
    if (!service) throw new ConnectorHostError("unsupported");
    for (const id of this.listeners.keys()) if (this.db.getTransaction(id).instanceId === instanceId) this.cancel(id);
    const id = randomUUID(), abort = new AbortController();
    const tx: OAuthTransaction = { id, instanceId, revision: row.revision, state: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + 300000, status: "pending", data: {} };
    const server = createServer((req, res) => {
      void (async () => {
        res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const current = this.db.getTransaction(id), state = url.searchParams.get("state") ?? "";
        if (url.pathname !== "/callback" || current.status !== "pending" || state.length !== current.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(current.state))) {
          res.writeHead(400); res.end("授权请求无效或已过期。"); return;
        }
        // Claim before awaiting token exchange; duplicate callbacks cannot exchange twice.
        if (current.data.claimed) { res.writeHead(409); res.end("授权正在处理。"); return; }
        current.data.claimed = true; this.db.putTransaction(current);
        try {
          const code = url.searchParams.get("code"); if (!code || url.searchParams.has("error")) throw new ConnectorHostError("cancelled");
          await auth(this.provider(id), { serverUrl: service.url, authorizationCode: code, fetchFn: this.fetchFor(service, abort.signal) });
          const completed = this.db.getTransaction(id);
          if (completed.status !== "pending" || abort.signal.aborted) throw new ConnectorHostError("cancelled");
          OAuthTokensSchema.parse(completed.data.tokens);
          const { verifier: _verifier, authorizationUrl: _url, claimed: _claimed, ...credentials } = completed.data;
          this.db.saveOAuth(instanceId, tx.revision, credentials, true);
          this.finish(id, "complete"); this.changed(instanceId); res.end("授权完成。请返回 OpenCraft 检测连接，并选择用于哪个会话。");
        } catch { this.finish(id, "failed"); res.writeHead(400); res.end("授权未完成，请返回 OpenCraft 重试。"); }
      })().catch(() => { res.writeHead(400); res.end("授权请求已失效。"); });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    tx.data.redirectUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
    tx.data.discovery = { authorizationServerUrl: service.issuer };
    this.db.putTransaction(tx);
    this.listeners.set(id, { server, abort, timer: setTimeout(() => this.finish(id, "expired"), 300000) });
    try {
      const result = await auth(this.provider(id), { serverUrl: service.url, fetchFn: this.fetchFor(service, abort.signal) });
      if (result !== "REDIRECT") throw new ConnectorHostError("unavailable");
      return this.progress(id);
    } catch { this.finish(id, "failed"); throw new ConnectorHostError("unavailable"); }
  }
  progress(id: string): ConnectorOAuthProgress {
    const tx = this.db.getTransaction(id);
    return { id, status: tx.status, ...(tx.status === "pending" && typeof tx.data.authorizationUrl === "string" ? { authorizationUrl: tx.data.authorizationUrl } : {}) };
  }
  cancel(id: string) { this.finish(id, "cancelled"); }
  cancelInstance(instanceId: string) { for (const id of this.listeners.keys()) if (this.db.getTransaction(id).instanceId === instanceId) this.cancel(id); }
  private finish(id: string, status: OAuthTransaction["status"]) {
    const listener = this.listeners.get(id); if (listener) { clearTimeout(listener.timer); listener.abort.abort(); listener.server.close(); this.listeners.delete(id); }
    try { const tx = this.db.getTransaction(id); if (tx.status === "pending") this.db.putTransaction({ ...tx, status, data: {} }); } catch { /* Already deleted. */ }
  }
  private fetchFor(service: { issuer: string; url: string }, signal?: AbortSignal): typeof fetch {
    const fetcher = this.fetchOverride ?? connectorFetch([new URL(service.issuer).origin, new URL(service.url).origin]);
    return (input, init) => fetcher(input, { ...init, signal: AbortSignal.any([...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30000)]) });
  }
  private provider(id: string): OAuthClientProvider {
    const load = () => { const tx = this.db.getTransaction(id); if (tx.status !== "pending" || this.db.get(tx.instanceId).revision !== tx.revision) throw new ConnectorHostError("cancelled"); return tx; };
    const save = (key: string, value: unknown) => { const tx = load(); tx.data[key] = value; this.db.putTransaction(tx); };
    return {
      get redirectUrl() { return String(load().data.redirectUrl); },
      get clientMetadata() { return { client_name: "OpenCraft", redirect_uris: [String(load().data.redirectUrl)], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }; },
      state: () => load().state,
      clientInformation: () => load().data.client ? OAuthClientInformationMixedSchema.parse(load().data.client) : undefined,
      saveClientInformation: value => save("client", value),
      tokens: () => load().data.tokens ? OAuthTokensSchema.parse(load().data.tokens) : undefined,
      saveTokens: value => { save("tokens", value); save("expiresAt", value.expires_in ? Date.now() + value.expires_in * 1000 : null); },
      redirectToAuthorization: url => {
        const tx = load(), service = this.services[this.db.get(tx.instanceId).definitionId];
        if (url.origin !== new URL(service.issuer).origin || url.username || url.password) throw new ConnectorHostError("invalid");
        save("authorizationUrl", url.href);
      },
      saveCodeVerifier: value => save("verifier", value), codeVerifier: () => String(load().data.verifier),
      discoveryState: () => load().data.discovery as OAuthDiscoveryState,
      saveDiscoveryState: value => save("discovery", value),
      validateResourceURL: async () => { const tx = load(), service = this.services[this.db.get(tx.instanceId).definitionId]; return new URL(service.resource ?? service.url); },
    };
  }
  async refresh(instanceId: string): Promise<void> {
    const existing = this.refreshing.get(instanceId); if (existing) return existing;
    const pending = this.doRefresh(instanceId).finally(() => this.refreshing.delete(instanceId));
    this.refreshing.set(instanceId, pending); return pending;
  }
  private async doRefresh(instanceId: string) {
    const row = this.db.get(instanceId), service = this.services[row.definitionId];
    if (!service) return;
    if (!row.oauth.tokens) throw new ConnectorHostError("authorization-required");
    const expires = Number(row.oauth.expiresAt);
    if (!expires || expires > Date.now() + 30000) return;
    const tokens = OAuthTokensSchema.parse(row.oauth.tokens);
    if (!tokens.refresh_token) throw new ConnectorHostError("authorization-required");
    const oauth = structuredClone(row.oauth);
    const provider: OAuthClientProvider = {
      redirectUrl: String(oauth.redirectUrl), clientMetadata: { redirect_uris: [String(oauth.redirectUrl)], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
      clientInformation: () => OAuthClientInformationMixedSchema.parse(oauth.client), tokens: () => tokens,
      discoveryState: () => oauth.discovery as OAuthDiscoveryState,
      saveTokens: value => { oauth.tokens = value; oauth.expiresAt = value.expires_in ? Date.now() + value.expires_in * 1000 : null; this.db.saveOAuth(instanceId, row.revision, oauth, false); },
      redirectToAuthorization() { throw new ConnectorHostError("authorization-required"); },
      saveCodeVerifier() { throw new ConnectorHostError("authorization-required"); }, codeVerifier() { throw new ConnectorHostError("authorization-required"); },
    };
    try { await auth(provider, { serverUrl: service.url, fetchFn: this.fetchFor(service) }); }
    catch { throw new ConnectorHostError("authorization-required"); }
  }
  dispose() { for (const id of [...this.listeners.keys()]) this.cancel(id); }
}
