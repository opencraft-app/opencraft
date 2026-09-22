import type { AppServerClient } from "@opencraft/appserver-client";
import type { AuthenticationProvider, AuthenticationResult, AuthenticationSession } from "../authentication/contract";
import { objectInput, ConnectorError } from "./lifetime";

export function connectorAuthorizationUrl(value: unknown): string {
  if (typeof value !== "string") throw new ConnectorError("invalid-input");
  const url = new URL(value);
  if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new ConnectorError("invalid-input");
  return url.href;
}

export interface McpInventoryRow { readonly name: string; readonly authStatus: string; readonly toolCount: number }
export async function readMcpInventory(client: AppServerClient, signal?: AbortSignal): Promise<readonly McpInventoryRow[]> {
  let cursor: string | null = null;
  const seen = new Set<string>(), rows: McpInventoryRow[] = [];
  for (let page = 0; page < 100; page++) {
    const value = objectInput(await client.requestRaw("mcpServerStatus/list", { cursor, limit: 100, detail: "toolsAndAuthOnly" }, { signal }));
    if (!Array.isArray(value.data)) throw new ConnectorError("invalid-input");
    for (const raw of value.data) {
      const row = objectInput(raw);
      if (typeof row.name !== "string" || !row.name || typeof row.authStatus !== "string") throw new ConnectorError("invalid-input");
      rows.push({ name: row.name, authStatus: row.authStatus, toolCount: Object.keys(objectInput(row.tools)).length });
    }
    if (value.nextCursor === null) return rows;
    if (typeof value.nextCursor !== "string" || seen.has(value.nextCursor)) throw new ConnectorError("invalid-input");
    cursor = value.nextCursor; seen.add(cursor);
  }
  throw new ConnectorError("invalid-input");
}

interface Flight {
  readonly generation: number;
  abandoned: boolean;
  completing: boolean;
  resolve(result: AuthenticationResult): void;
  reject(error: Error): void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** OAuth transactions and credentials live in the Host. This is a bounded UI bridge. */
export class McpOAuthAuthenticationProvider implements AuthenticationProvider {
  private session: AuthenticationSession = { status: "anonymous", epoch: 0 };
  private readonly listeners = new Set<() => void>();
  private flight: Flight | null = null;
  private generation: number;
  private disposed = false;
  private readonly removeStatus: () => void;
  private readonly removeNotifications: () => void;

  constructor(readonly id: string, private readonly client: AppServerClient, private readonly server: string,
    private readonly presentUrl: (url: string | null) => void, private readonly timeoutMs = 65000) {
    this.generation = client.connectionGeneration;
    this.removeStatus = client.subscribeStatus(status => {
      if (status.state !== "open" || this.generation !== client.connectionGeneration) {
        this.end({ status: "cancelled" }); this.publish(false); this.generation = client.connectionGeneration;
      }
    });
    // Subscribe before issuing the request, including completion-before-response.
    this.removeNotifications = client.subscribeNotification(event => {
      if (event.method !== "mcpServer/oauthLogin/completed") return;
      const params = event.params as { name?: unknown; threadId?: unknown; success?: unknown };
      if (params.name !== server || (params.threadId !== null && params.threadId !== undefined)) return;
      const flight = this.flight;
      if (!flight || flight.completing || flight.generation !== client.connectionGeneration) return;
      if (params.success !== true) { this.end({ status: "cancelled" }); return; }
      flight.completing = true;
      void this.complete(flight);
    });
  }
  getSession = () => this.session;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  async refresh(): Promise<void> {
    const generation = this.client.connectionGeneration;
    const row = (await readMcpInventory(this.client)).find(r => r.name === this.server);
    if (this.disposed || generation !== this.client.connectionGeneration || this.client.status.state !== "open") return;
    // "unsupported" means native Host-managed credentials/no browser OAuth,
    // not a claim that a private service is public.
    const authenticated = !!row && (["oAuth", "bearerToken"].includes(row.authStatus) || (row.authStatus === "unsupported" && row.toolCount > 0));
    if ((this.session.status === "authenticated") !== authenticated) this.publish(authenticated);
  }
  signIn(): Promise<AuthenticationResult> {
    if (this.disposed || this.client.status.state !== "open") return Promise.reject(new ConnectorError("unavailable"));
    // The native notification has no operation ID. Never let a late completion
    // from a cancelled attempt settle a new attempt for the same server.
    if (this.flight) return Promise.reject(new ConnectorError("authorization-pending"));
    return new Promise((resolve, reject) => {
      const flight: Flight = { generation: this.client.connectionGeneration, abandoned: false, completing: false, resolve, reject,
        timer: setTimeout(() => {
          if (this.flight !== flight) return;
          flight.abandoned = true; this.presentUrl(null);
          reject(new ConnectorError("authorization-pending"));
          // Quarantine until native completion or Host generation replacement.
        }, this.timeoutMs) };
      this.flight = flight;
      void this.client.requestRaw("mcpServer/oauth/login", { name: this.server, timeoutSecs: 60 }).then(raw => {
        if (this.flight !== flight || flight.abandoned || this.disposed) return;
        this.presentUrl(connectorAuthorizationUrl(objectInput(raw).authorizationUrl));
      }).catch(() => { if (this.flight === flight && !flight.abandoned) { flight.abandoned = true; this.presentUrl(null); reject(new ConnectorError("failed")); } });
    });
  }
  async cancelSignIn(): Promise<void> {
    if (!this.flight) return;
    this.flight.abandoned = true; this.presentUrl(null); this.flight.resolve({ status: "cancelled" });
  }
  dispose(): void { this.disposed = true; this.end({ status: "cancelled" }); this.removeStatus(); this.removeNotifications(); this.listeners.clear(); }
  private async complete(flight: Flight): Promise<void> {
    try {
      await this.client.requestRaw("config/mcpServer/reload", undefined);
      await this.refresh();
      if (this.flight !== flight || this.disposed || flight.generation !== this.client.connectionGeneration) return;
      // Same-account reauthorization is still a new authority epoch.
      this.publish(this.session.status === "authenticated");
      this.end(!flight.abandoned && this.session.status === "authenticated"
        ? { status: "authenticated", epoch: this.session.epoch } : { status: "cancelled" });
    } catch { if (this.flight === flight) this.end({ status: "cancelled" }); }
  }
  private end(result: AuthenticationResult): void {
    const flight = this.flight; this.flight = null; this.presentUrl(null);
    if (flight) { clearTimeout(flight.timer); flight.resolve(result); }
  }
  private publish(authenticated: boolean): void {
    this.session = Object.freeze({ status: authenticated ? "authenticated" : "anonymous", epoch: this.session.epoch + 1 });
    for (const listener of this.listeners) listener();
  }
}
