import { accountFailure } from "./account-diagnostics.js";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { configuredModelGatewayPath, ModelGatewayStore } from './model-gateway-store.js';
import { modelGatewayProvider } from './model-gateway-connection.js';
import { deviceLoginMaintenanceReason } from "./device-login-maintenance.js";
import type { CodexAccountView } from "@opencraft/appserver-protocol";
import { AccountPoolStore, accountCreditStatus } from "./store.js";
import { CodexAccountPoolProxy, PROXY_CALLERS, PROXY_CALLER_PREFIX } from "./codex-proxy.js";
import { AccountCredentialRefreshManager } from "./oauth-refresh.js";
import { CodexDeviceLoginService, createManagedCodexRefresh, type CodexMaintenanceClientFactory } from "./codex-auth.js";
import { CodexSubscriptionService } from "./codex-usage.js";
import { CodexResetCreditService } from "./codex-reset-credits.js";
import { createCodexMaintenanceClient } from "./codex-maintenance-client.js";
import { createCodexAccountPoolLaunch } from "./codex-launch.js";
import type { ConfiguredCodexResponses } from "./configured-responses.js";
import { startCodexAccountPoolServer, type AccountPoolUncertainDiagnostic } from "./server.js";

function string(value: unknown): string { return typeof value === "string" ? value : ""; }

export interface CodexAccountServiceOptions {
  readonly configuredResponses?: ConfiguredCodexResponses;
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
    onUncertain(route: string, diagnostic: AccountPoolUncertainDiagnostic): void | Promise<void>;
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

  private readonly personalPools = new Map<string, Promise<CodexAccountService>>();
  private readonly personalInstances = new Map<string,CodexAccountService>();
  private personalLogin?: Promise<Awaited<ReturnType<CodexDeviceLoginService['start']>>>;
  private constructor(private readonly options: CodexAccountServiceOptions, private readonly personal: string | null = null) {
    const store = new AccountPoolStore({
      ownerActor: personal,
      databasePath: join(options.dataDirectory, "account-pool.sqlite"),
      secretsDirectory: join(options.dataDirectory, "secrets"),
      preserveAffinity: options.ownerHandoff?.admissionOpen() === false,
    });
    this.store = store;
    const createClient = options.createMaintenanceClient
      ?? (codexHome => createCodexMaintenanceClient({ executable: options.executable, codexHome }));
    const maintenanceDirectory = personal ? join(options.dataDirectory,"personal-logins",createHash("sha256").update(personal).digest("hex")) : options.dataDirectory;
    const managedRefresh = createManagedCodexRefresh({
      refreshRoot: join(maintenanceDirectory, "refresh"), createClient,
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
    this.login = new CodexDeviceLoginService({ store, loginRoot: join(maintenanceDirectory, "login"), createClient,
      deferRecovery: options.ownerHandoff?.admissionOpen() === false,
      onAccountImported: account => { void this.subscriptions.refreshAccount(account.id).catch(() => undefined); },
    });
    this.proxy = new CodexAccountPoolProxy({ store,
      privateHostId: personal ? "personal-subscription:"+createHash("sha256").update(personal).digest("hex") : undefined,
      personalRoute: personal ? undefined : request => this.personalRoute(request),
      configuredResponses: options.configuredResponses ? {
        catalog: () => options.configuredResponses!.catalog(),
        resolve: async model => {
          const route=await options.configuredResponses!.resolve(model);
          const match=route&&/^http:\/\/127\.0\.0\.1:[0-9]+(\/personal\/([a-f0-9]{64})\/v1)$/.exec(route.baseUrl);
          if(match && modelGatewayProvider(model)==='subscription-'+match[2]) {
            if(!this.server)throw Error('Subscription proxy unavailable');
            return {...route!,baseUrl:this.server.url+match[1]};
          }
          return route;
        },
      } : undefined,
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
      if (options.ownerHandoff) service.validateCredentials(options.ownerHandoff.admissionOpen() === false);
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

  handoffObservation(): { counts: { requests: number; proxy: number; oauth: number; refresh: number; subscriptions: number; resetCredits: number }; activeCount: number; historicalCount: number } {
    const counts = { requests: this.requests.size + [...this.personalInstances.values()].reduce((n,pool)=>n+pool.handoffObservation().activeCount,0), proxy: this.server?.activeCount() ?? 0,
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

  validateCredentials(requireAccountCredentials = true): void {
    try {
      const token = this.store.issueHostToken("local-codex");
      if (this.store.authenticateHostToken(token) !== "local-codex") throw new Error("Invalid account Host identity");
      // Frozen successors attest external credentials before readiness. Open
      // owners must keep control/login available when an external owner is down.
      // Local records and Host authentication remain strict in both modes.
      for (const account of this.store.listAccounts()) {
        if (account.credentialConfigured) this.store.validateCredential(account.id, requireAccountCredentials);
      }
      this.accountViews();
    } catch { throw new Error("Account credential validation failed"); }
  }

  private callersPublished = false;
  /** Issue stable proxy tokens for non-Codex callers and publish them beside the Core sockets (0600, owner only). */
  private publishCallerTokens(): void {
    if (this.callersPublished || this.personal !== null || this.server === null) return;
    const directory = join(dirname(this.options.dataDirectory), "run", "proxy-callers");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const caller of PROXY_CALLERS) {
      const path = join(directory, caller.slice(PROXY_CALLER_PREFIX.length) + ".json"), temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ caller, baseUrl: this.server.url, token: this.store.issueHostToken(caller) }) + "\n", { mode: 0o600 });
      renameSync(temporary, path);
    }
    this.callersPublished = true;
  }

  launch() {
    if (this.server === null || this.closing) throw new Error("Codex account service is unavailable");
    this.publishCallerTokens();
    return createCodexAccountPoolLaunch({ baseUrl: this.server.url, hostToken: this.store.issueHostToken("local-codex") });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error("Codex account service is closing"));
    const operation = this.handleRequest(method, params);
    this.requests.add(operation);
    void operation.finally(() => this.requests.delete(operation)).catch(() => undefined);
    return operation;
  }

  async interruptForMaintenance(): Promise<void> {
    if (this.options.ownerHandoff?.admissionOpen() !== false || this.closing) {
      throw new Error("Account maintenance requires a fenced live owner");
    }
    await this.server!.interruptForMaintenance();
    await Promise.all([...this.personalPools.values()].map(async pool => (await pool).close()));
    this.personalPools.clear();
    this.personalInstances.clear();
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
        await Promise.allSettled([...this.personalPools.values()].map(async pool => (await pool).close()));
        this.store.close();
      } finally { clearInterval(timer); }
    })();
  }

  private async handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method.startsWith('opencraft/codex/accounts/personal/')) {
      if (this.personal || !configuredModelGatewayPath() || this.options.ownerHandoff?.admissionOpen() === false) throw Error('Personal subscriptions unavailable');
      const actor=string(params.actor);
      if (!actor || actor.length>512) throw Error('Human identity required');
      const pool=await this.personalPool(actor), operation=method.slice('opencraft/codex/accounts/personal/'.length);
      if(operation==='cancel') {
        const cancelled=await pool.login.cancel(string(params.sessionId));
        if(cancelled)pool.personalLogin=undefined;
        return {cancelled};
      }
      if(operation==='disconnect') {for(const account of pool.store.listAccounts())pool.store.removeAccount(account.id);return {disconnected:true};}
      if(operation==='start' && pool.store.listAccounts().length===0) {
        if(pool.personalLogin) {
          const previous=await pool.personalLogin;
          if(previous.expiresAt<=Date.now()) {
            await pool.login.cancel(previous.sessionId);
            pool.personalLogin=undefined;
          }
        }
        if(!pool.personalLogin) {
          const pending=pool.login.start();pool.personalLogin=pending;
          void pending.catch(()=>{if(pool.personalLogin===pending)pool.personalLogin=undefined;});
        }
        return {status:'pending',login:await pool.personalLogin};
      }
      if(operation==='poll') {
        const result=await pool.login.poll(string(params.sessionId));
        if(result.status!=='pending' && pool.personalLogin && (await pool.personalLogin).sessionId===string(params.sessionId))pool.personalLogin=undefined;
        if(result.status!=='complete')return result;
      } else if(operation!=='start')throw Error('Unsupported subscription operation');
      return {status:'complete',connection:await this.personalDescriptor(actor,pool)};
    }
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
        if (polled.status === "error") {
          const reason = await deviceLoginMaintenanceReason(this.options.dataDirectory, string(params.sessionId), polled);
          result = reason ? { ...polled, reason } : polled;
        } else if (polled.status !== "complete") result = polled;
        else {
          const account = this.accountViews().find(candidate => candidate.id === polled.account.id);
          if (account === undefined) throw new Error("Codex account was not found after login");
          result = { status: "complete", account };
        }
        break;
      }
      case "opencraft/codex/accounts/deviceLogin/cancel": result = { cancelled: await login.cancel(string(params.sessionId)) }; break;
      default: throw accountFailure("invalid-request", "operation", false);
    }
    return result;
  }

  /** Reuse the account owner in a Human-specific directory. Subscription tokens
   * never enter the installation pool or the model configuration document. */
  private personalPool(actor:string):Promise<CodexAccountService> {
    const namespace=createHash('sha256').update(actor).digest('hex');
    let pending=this.personalPools.get(namespace);
    if(!pending) {
      if(this.personalPools.size>=128)throw Error('Personal subscription capacity reached');
      const directory=join(this.options.dataDirectory,'personal-subscriptions',namespace);
      pending=(async()=>{
        const pool=new CodexAccountService({...this.options,nativeCodexHomeDirectory:join(directory,'native'),proxyPort:undefined,configuredResponses:undefined,ownerHandoff:undefined},actor);
        try{await pool.login.ready();await pool.activate();this.personalInstances.set(namespace,pool);return pool;}catch(error){await pool.close();throw error;}
      })();
      this.personalPools.set(namespace,pending);
      void pending.catch(()=>this.personalPools.delete(namespace));
    }
    return pending;
  }

  private async personalDescriptor(actor:string,pool:CodexAccountService) {
    if(!this.server)throw Error('Subscription proxy unavailable');
    const namespace=createHash('sha256').update(actor).digest('hex'),token=pool.store.issueHostToken('personal-subscription:'+namespace);
    const response=await pool.proxy.handle(new Request('http://personal.invalid/v1/models',{headers:{'x-opencraft-account-pool-token':token}}));
    if(!response.ok)throw Error('Subscription model catalog unavailable');
    const catalog=await response.json() as {models?:Record<string,unknown>[]};
    const models=(catalog.models??[]).flatMap(m=>{
      const id=string(m.slug)||string(m.id)||string(m.model);
      return /^[A-Za-z0-9_.:/-]{1,160}$/.test(id)?[{id,name:string(m.display_name)||string(m.name)||id,enabled:true}]:[];
    });
    if(!models.length)throw Error('Subscription has no available models');
    return {providerId:'subscription-'+namespace,baseUrl:this.server.url+'/personal/'+namespace+'/v1',proxyToken:token,models,
      name:'我的 Codex 订阅',accounts:pool.accountViews().map(a=>({label:a.label,subscriptionType:a.subscriptionType,enabled:a.enabled}))};
  }

  private async personalRoute(request:Request):Promise<Response|null> {
    const match=/^\/personal\/([a-f0-9]{64})\/v1\/(responses|models)$/.exec(new URL(request.url).pathname);
    if(!match)return null;
    const path=configuredModelGatewayPath();if(!path)return new Response(null,{status:404});
    const ledger=new ModelGatewayStore(path);
    let actor:string;
    try {
      const connection=ledger.contribution('subscription-'+match[1]);
      if(connection?.state!=='shared'||connection.templateProvider!=='codex-subscription'||connection.scope!=='personal')return new Response(null,{status:403});
      actor=connection.actor;
    }finally{ledger.close();}
    if(createHash('sha256').update(actor).digest('hex')!==match[1])return new Response(null,{status:403});
    const token=request.headers.get('authorization')?.replace(/^Bearer /,'')??'';
    if(this.store.authenticateHostToken(token)!=='personal-subscription:'+match[1])return new Response(null,{status:401});
    const pool=await this.personalPool(actor);
    const headers=new Headers(request.headers);headers.set('x-opencraft-account-pool-token',token);headers.delete('authorization');
    return pool.proxy.handle(new Request('http://personal.invalid/v1/'+match[2],{method:request.method,headers,
      ...(request.method==='GET'?{}:{body:request.body,duplex:'half'}),signal:request.signal} as RequestInit));
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
        credentialSource: account.credentialSource,
        email: state.email,
        subscriptionType: state.subscriptionType,
        rateLimitTier: state.rateLimitTier,
        resetCredits: state.resetCredits,
        resetCreditActions: true,
        credits: accountCreditStatus(state.limitWindows),
        status: state.status,
        maintenance: store.accountMaintenance(account.id),
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
