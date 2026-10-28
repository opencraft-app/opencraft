import { join } from "node:path";
import type { CodexAccountView } from "@opencraft/appserver-protocol";
import { AccountPoolStore } from "./store.js";
import { CodexAccountPoolProxy } from "./codex-proxy.js";
import { AccountCredentialRefreshManager } from "./oauth-refresh.js";
import { CodexDeviceLoginService, createManagedCodexRefresh, type CodexMaintenanceClientFactory } from "./codex-auth.js";
import { CodexSubscriptionService } from "./codex-usage.js";
import { CodexResetCreditService } from "./codex-reset-credits.js";
import { createCodexMaintenanceClient } from "./codex-maintenance-client.js";
import { createCodexAccountPoolLaunch } from "./codex-launch.js";
import { startCodexAccountPoolServer } from "./server.js";

function string(value: unknown): string { return typeof value === "string" ? value : ""; }

export interface CodexAccountServiceOptions {
  readonly executable: string;
  readonly dataDirectory: string;
  readonly nativeCodexHomeDirectory: string;
  readonly upstreamBaseUrl?: string;
  /** Fixed loopback port for an independently running AppServer. */
  readonly proxyPort?: number;
  readonly fetch?: typeof fetch;
  readonly createMaintenanceClient?: CodexMaintenanceClientFactory;
  readonly ownerHandoff?: {
    admissionOpen(): boolean;
    onUncertain(route: string): void | Promise<void>;
    retained?: CodexAccountRetainedState;
  };
}

export interface CodexAccountRetainedState {
  imageAffinities: ReturnType<CodexAccountPoolProxy["handoffAffinities"]>;
  resetReceipts: ReturnType<CodexResetCreditService["handoffReceipts"]>;
  loginReceipts: ReturnType<CodexDeviceLoginService["handoffReceipts"]>;
}

/** One owner for inference credentials, login and background account maintenance. */
export class CodexAccountService {
  private readonly store: AccountPoolStore;
  private readonly login: CodexDeviceLoginService;
  private readonly subscriptions: CodexSubscriptionService;
  private readonly resetCreditService: CodexResetCreditService;
  private server: Awaited<ReturnType<typeof startCodexAccountPoolServer>> | null = null;
  private readonly requests = new Set<Promise<unknown>>();
  private closing: Promise<void> | null = null;
  private readonly refresh: AccountCredentialRefreshManager;
  private readonly maintenanceReady: () => Promise<void>;
  private activation?: Promise<void>;

  private constructor(private readonly options: CodexAccountServiceOptions) {
    const store = new AccountPoolStore({
      databasePath: join(options.dataDirectory, "account-pool.sqlite"),
      secretsDirectory: join(options.dataDirectory, "secrets"),
      preserveAffinity: options.ownerHandoff?.admissionOpen() === false,
    });
    this.store = store;
    const createClient = options.createMaintenanceClient
      ?? (codexHome => createCodexMaintenanceClient({ executable: options.executable, codexHome }));
    const managedRefresh = createManagedCodexRefresh({
      refreshRoot: join(options.dataDirectory, "refresh"), createClient,
      deferRecovery: options.ownerHandoff?.admissionOpen() === false,
    });
    this.maintenanceReady = managedRefresh.ready;
    const refresh = new AccountCredentialRefreshManager({ store, refresh: managedRefresh });
    this.refresh = refresh;
    this.subscriptions = new CodexSubscriptionService({ store, fetch: options.fetch,
      admissionOpen: options.ownerHandoff?.admissionOpen,
      resolveCredential: (account, secret, reason) => refresh.resolve(account, secret, reason) });
    this.resetCreditService = new CodexResetCreditService({ store, fetch: options.fetch,
      resolveCredential: (account, secret, reason) => refresh.resolve(account, secret, reason),
      refreshUsage: accountId => this.subscriptions.refreshAccount(accountId) });
    this.login = new CodexDeviceLoginService({ store, loginRoot: join(options.dataDirectory, "login"), createClient,
      deferRecovery: options.ownerHandoff?.admissionOpen() === false,
      onAccountImported: account => { void this.subscriptions.refreshAccount(account.id).catch(() => undefined); },
    });
    this.proxy = new CodexAccountPoolProxy({ store,
      upstreamBaseUrl: options.upstreamBaseUrl ?? "https://chatgpt.com/backend-api/codex",
      fetch: options.fetch, resolveCredential: (account, secret, reason) => refresh.resolve(account, secret, reason) });
    if (options.ownerHandoff?.retained) {
      this.proxy.restoreAffinities(options.ownerHandoff.retained.imageAffinities);
      this.resetCreditService.restoreReceipts(options.ownerHandoff.retained.resetReceipts);
      this.login.restoreReceipts(options.ownerHandoff.retained.loginReceipts);
    }
  }
  private readonly proxy: CodexAccountPoolProxy;

  static async start(options: CodexAccountServiceOptions): Promise<CodexAccountService> {
    const service = new CodexAccountService(options);
    try {
      await service.login.ready();
      service.server = await startCodexAccountPoolServer({ proxy: service.proxy, port: options.proxyPort,
        admissionOpen: options.ownerHandoff?.admissionOpen, onUncertain: options.ownerHandoff?.onUncertain });
      if (options.ownerHandoff?.admissionOpen() !== false) await service.activate();
      return service;
    } catch (error) { await service.close(); throw error; }
  }

  activate(): Promise<void> {
    return this.activation ??= (async () => {
      await this.login.activate(); await this.maintenanceReady(); this.subscriptions.start();
    })();
  }

  handoffObservation() {
    const counts = { requests: this.requests.size, proxy: this.server?.activeCount() ?? 0,
      oauth: this.login.activeCount(), refresh: this.refresh.activeCount(),
      subscriptions: this.subscriptions.activeCount(), resetCredits: this.resetCreditService.activeCount() };
    return { counts, activeCount: Object.values(counts).reduce((a, b) => a + b, 0),
      historicalCount: this.store.affinityCount() + this.proxy.handoffAffinities().length
        + this.login.historicalCount() + this.resetCreditService.historicalCount() };
  }

  retainedState(): CodexAccountRetainedState {
    if (this.handoffObservation().activeCount !== 0) throw new Error("Account service is not drained");
    return { imageAffinities: this.proxy.handoffAffinities(), resetReceipts: this.resetCreditService.handoffReceipts(),
      loginReceipts: this.login.handoffReceipts() };
  }

  validateCredentials(): void {
    for (const account of this.store.listAccounts()) {
      if (account.credentialConfigured) this.store.readCredential(account.id);
    }
    this.accountViews();
  }

  launch() {
    if (this.server === null || this.closing) throw new Error("Codex account service is unavailable");
    return createCodexAccountPoolLaunch({ baseUrl: this.server.url, hostToken: this.store.issueHostToken("local-codex") });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error("Codex account service is closing"));
    const operation = this.handleRequest(method, params);
    this.requests.add(operation);
    void operation.finally(() => this.requests.delete(operation)).catch(() => undefined);
    return operation;
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      let phase = "account-requests";
      const startedAt = Date.now();
      const timer = setInterval(() => console.warn("[opencraft account-pool]", JSON.stringify({
        event: "shutdown-account-wait", phase, durationMs: Date.now() - startedAt,
      })), 15_000);
      timer.unref();
      try {
        await Promise.allSettled(this.requests);
        // Stop background jobs while inference still listens. Inference's own
        // credential resolver remains available until its idle-point drain ends.
        phase = "login"; await this.login.dispose();
        phase = "reset-credits"; await this.resetCreditService.dispose();
        phase = "subscriptions"; await this.subscriptions.dispose();
        phase = "proxy"; await this.server?.close();
        this.store.close();
      } finally { clearInterval(timer); }
    })();
  }

  private async handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const { store, login, subscriptions } = this;
    let result: unknown;
    switch (method) {
      case "opencraft/codex/accounts/resetCredits/list":
        return this.resetCreditService.list(string(params.accountId));
      case "opencraft/codex/accounts/resetCredits/consume": {
        const consumed = await this.resetCreditService.consume({ accountId: string(params.accountId), creditId: string(params.creditId),
          idempotencyKey: string(params.idempotencyKey), confirmed: params.confirmed });
        return { ...consumed, accounts: this.accountViews() };
      }
      case "opencraft/codex/accounts/list": result = { accounts: this.accountViews() }; break;
      case "opencraft/codex/accounts/setEnabled":
        store.setEnabled(string(params.accountId), params.enabled === true);
        if (params.enabled === true) void subscriptions.refreshAccount(string(params.accountId)).catch(() => undefined);
        result = { accounts: this.accountViews() }; break;
      case "opencraft/codex/accounts/setAllowCredits":
        if (typeof params.allowCredits !== "boolean") throw new TypeError("Invalid credit policy");
        store.setAllowCredits(string(params.accountId), params.allowCredits);
        if (params.allowCredits) void subscriptions.refreshAccount(string(params.accountId)).catch(() => undefined);
        result = { accounts: this.accountViews() }; break;
      case "opencraft/codex/accounts/reorder":
        if (!Array.isArray(params.accountIds)) throw new Error("Invalid account order");
        store.reorder("codex", params.accountIds.map(string));
        result = { accounts: this.accountViews() }; break;
      case "opencraft/codex/accounts/remove":
        store.removeAccount(string(params.accountId));
        result = { accounts: this.accountViews() }; break;
      case "opencraft/codex/accounts/refresh": {
        await subscriptions.refreshAccount(string(params.accountId));
        result = { accounts: this.accountViews() }; break;
      }
      case "opencraft/codex/accounts/import": {
        const imported = await login.importFrom(this.options.nativeCodexHomeDirectory);
        void subscriptions.refreshAccount(imported.id).catch(() => undefined);
        const account = this.accountViews().find(candidate => candidate.id === imported.id);
        if (account === undefined) throw new Error("Imported Codex account was not found");
        result = { account };
        break;
      }
      case "opencraft/codex/accounts/deviceLogin/start": result = await login.start(); break;
      case "opencraft/codex/accounts/deviceLogin/poll": {
        const polled = await login.poll(string(params.sessionId));
        if (polled.status !== "complete") result = polled;
        else {
          const account = this.accountViews().find(candidate => candidate.id === polled.account.id);
          if (account === undefined) throw new Error("Codex account was not found after login");
          result = { status: "complete", account };
        }
        break;
      }
      case "opencraft/codex/accounts/deviceLogin/cancel": result = { cancelled: await login.cancel(string(params.sessionId)) }; break;
      default: throw new Error("Unsupported Codex account method");
    }
    return result;
  }

  private accountViews(): CodexAccountView[] {
    const store = this.store;
    const states = new Map(store.listAccountStates().map(state => [state.accountId, state]));
    return store.listAccounts().map(account => {
      const state = states.get(account.id);
      if (state === undefined) throw new Error("Codex account state is unavailable");
      return {
        id: account.id,
        label: account.label,
        priority: account.priority,
        enabled: account.enabled,
        allowCredits: account.allowCredits,
        credentialConfigured: account.credentialConfigured,
        email: state.email,
        subscriptionType: state.subscriptionType,
        rateLimitTier: state.rateLimitTier,
        resetCredits: state.resetCredits,
        resetCreditActions: true,
        status: state.status,
        observedAt: state.observedAt,
        heldUntil: state.heldUntil,
        lastUsedAt: state.lastUsedAt,
        lastUsedHostId: state.lastUsedHostId,
        limitWindows: state.limitWindows.map(window => ({
          slot: window.slot,
          windowMinutes: window.windowMinutes,
          utilization: window.utilization,
          resetAt: window.resetAt,
          observedAt: window.observedAt,
        })),
      };
    });
  }
}
