import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { join } from "node:path";

import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import {
  OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY,
  OPENCRAFT_THREAD_START_DURABILITY_EXTENSION,
  type CodexAccountView,
} from "@opencraft/appserver-protocol";
import {
  AccountPoolStore,
  CodexAccountPoolProxy,
  CodexCredentialRefreshManager,
  CodexDeviceLoginService,
  CodexSubscriptionService,
  createCodexAccountPoolLaunch,
  createCodexMaintenanceClient,
  createManagedCodexRefresh,
  startCodexAccountPoolServer,
  type CodexMaintenanceClientFactory,
} from "@opencraft/account-pool-host";

type RpcRecord = Record<string, unknown>;

interface PendingRequest {
  readonly clientId: string;
  readonly originalId: string | number;
  readonly method: string;
  readonly params: RpcRecord;
}

function record(value: unknown): RpcRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RpcRecord : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function responseId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Codex account operation failed";
}

function withCodexHostCapabilities(value: unknown): RpcRecord {
  const result = record(value);
  const capabilities = record(result.capabilities);
  const extensions = record(capabilities.extensions);
  return {
    ...result,
    capabilities: {
      ...capabilities,
      extensions: {
        ...extensions,
        [OPENCRAFT_THREAD_START_DURABILITY_EXTENSION]:
          OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY,
      },
    },
  };
}

export class CodexEngineAdapter implements DuplexTransport {
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly initializeWaiters: PendingRequest[] = [];
  private readonly initializedClients = new Set<string>();
  private readonly threadClients = new Map<string, Set<string>>();
  private readonly serverRequests = new Map<string, string>();
  private statusValue: TransportStatus = { state: "idle" };
  private sequence = 0;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadLineInterface | null = null;
  private initializeResult: unknown | null = null;
  private physicalInitializePending = false;
  private poolStore: AccountPoolStore | null = null;
  private poolServer: Awaited<ReturnType<typeof startCodexAccountPoolServer>> | null = null;
  private login: CodexDeviceLoginService | null = null;
  private refresh: CodexCredentialRefreshManager | null = null;
  private subscriptions: CodexSubscriptionService | null = null;
  private stderrTail = "";
  private closeOperation: Promise<void> | null = null;

  constructor(private readonly options: {
    readonly executable: string;
    readonly runtimeDirectory: string;
    readonly dataDirectory: string;
    readonly nativeCodexHomeDirectory: string;
    readonly upstreamBaseUrl?: string;
    readonly fetch?: typeof fetch;
    readonly createMaintenanceClient?: CodexMaintenanceClientFactory;
    readonly spawnAppServer?: (input: {
      readonly args: readonly string[];
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
    }) => ChildProcessWithoutNullStreams;
  }) {}

  get status(): TransportStatus { return this.statusValue; }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.statusValue.state === "open") return;
    if (signal?.aborted) throw signal.reason;
    this.publishStatus({ state: "connecting" });
    const dataRoot = this.options.dataDirectory;
    const runtimeRoot = join(dataRoot, "runtime");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const store = new AccountPoolStore({
      databasePath: join(dataRoot, "account-pool.sqlite"),
      secretsDirectory: join(dataRoot, "secrets"),
    });
    this.poolStore = store;
    const createMaintenanceClient = this.options.createMaintenanceClient
      ?? (codexHome => createCodexMaintenanceClient({ executable: this.options.executable, codexHome }));
    const managedRefresh = createManagedCodexRefresh({
      refreshRoot: join(dataRoot, "refresh"),
      createClient: createMaintenanceClient,
    });
    const refresh = new CodexCredentialRefreshManager({ store, refresh: managedRefresh });
    this.refresh = refresh;
    const subscriptions = new CodexSubscriptionService({
      store,
      resolveCredential: (account, secret, reason) => refresh.resolve(account, secret, reason),
      fetch: this.options.fetch,
    });
    this.subscriptions = subscriptions;
    this.login = new CodexDeviceLoginService({
      store,
      loginRoot: join(dataRoot, "login"),
      createClient: createMaintenanceClient,
    });
    const proxy = new CodexAccountPoolProxy({
      store,
      upstreamBaseUrl: this.options.upstreamBaseUrl ?? "https://chatgpt.com/backend-api/codex",
      fetch: this.options.fetch,
      resolveCredential: (account, secret, reason) => refresh.resolve(account, secret, reason),
    });
    const poolServer = await startCodexAccountPoolServer({ proxy });
    this.poolServer = poolServer;
    subscriptions.start();
    const hostToken = store.issueHostToken("local-codex");
    const launch = createCodexAccountPoolLaunch({ baseUrl: poolServer.url, hostToken });
    const childArgs = ["app-server", "--stdio", ...launch.args];
    const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...launch.env,
        CODEX_HOME: runtimeRoot,
        OPENAI_API_KEY: "opencraft-account-pool",
        CODEX_API_KEY: undefined,
        CODEX_ACCESS_TOKEN: undefined,
    };
    const child = this.options.spawnAppServer?.({
      args: childArgs,
      cwd: this.options.runtimeDirectory,
      env: childEnv,
    }) ?? spawn(this.options.executable, childArgs, {
      cwd: this.options.runtimeDirectory,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", chunk => { this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4_000); });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", this.receivePhysicalLine);
    child.once("error", this.fail);
    child.once("close", (code, childSignal) => {
      if (["closing", "closed"].includes(this.statusValue.state)) return;
      this.fail(new Error(`Codex AppServer exited (${code ?? childSignal ?? "unknown"})${this.stderrTail ? `: ${this.stderrTail}` : ""}`));
    });
    const abort = () => { void this.close(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      await this.close();
      throw signal.reason;
    }
    this.publishStatus({ state: "open" });
    signal?.removeEventListener("abort", abort);
  }

  async send(frame: string): Promise<void> {
    if (this.statusValue.state !== "open" || this.child === null) throw new Error("Codex Engine is not connected");
    const message = record(JSON.parse(frame));
    const clientId = string(message[LOGICAL_CLIENT_FIELD]);
    if (!clientId) throw new Error("Codex Engine requires a logical client identity");
    delete message[LOGICAL_CLIENT_FIELD];
    if (message.method === "runtime/client/disconnect") {
      this.disconnectClient(clientId);
      return;
    }
    if (typeof message.method === "string" && message.method.startsWith("opencraft/codex/accounts/")) {
      await this.handleAccountRequest(clientId, message);
      return;
    }
    if (message.method === "initialized") return;
    if (message.method === "initialize") {
      await this.handleInitialize(clientId, message);
      return;
    }
    const id = responseId(message.id);
    if (id !== null && message.method === undefined && ("result" in message || "error" in message)) {
      const owner = this.serverRequests.get(JSON.stringify(id));
      if (owner !== clientId) return;
      this.serverRequests.delete(JSON.stringify(id));
      this.writePhysical(message);
      return;
    }
    if (id !== null && typeof message.method === "string") {
      const physicalId = `opencraft:${++this.sequence}`;
      const params = record(message.params);
      this.pending.set(physicalId, { clientId, originalId: id, method: message.method, params });
      if (message.method === "turn/start") this.subscribeThread(string(params.threadId), clientId);
      this.writePhysical({ ...message, id: physicalId });
      return;
    }
    this.writePhysical(message);
  }

  subscribeMessage(listener: (frame: string) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener); return () => this.statusListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closeOperation !== null) return this.closeOperation;
    this.publishStatus({ state: "closing" });
    this.closeOperation = (async () => {
      const child = this.child;
      this.child = null;
      this.lines?.close();
      this.lines = null;
      await this.login?.dispose().catch(() => undefined);
      this.login = null;
      await this.subscriptions?.dispose();
      this.subscriptions = null;
      if (child !== null && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
          timer.unref();
          child.once("close", () => { clearTimeout(timer); resolve(); });
          child.stdin.end();
          child.kill("SIGTERM");
        });
      }
      await this.poolServer?.close().catch(() => undefined);
      this.poolServer = null;
      this.poolStore?.close();
      this.poolStore = null;
      this.pending.clear();
      this.initializeWaiters.length = 0;
      this.initializedClients.clear();
      this.threadClients.clear();
      this.serverRequests.clear();
      this.publishStatus({ state: "closed" });
    })();
    return this.closeOperation;
  }

  private async handleInitialize(clientId: string, message: RpcRecord): Promise<void> {
    const id = responseId(message.id);
    if (id === null) throw new Error("Initialize requires an id");
    const pending: PendingRequest = { clientId, originalId: id, method: "initialize", params: record(message.params) };
    this.initializedClients.add(clientId);
    if (this.initializeResult !== null) {
      this.emit({ id, result: this.initializeResult }, clientId);
      return;
    }
    if (this.physicalInitializePending) {
      this.initializeWaiters.push(pending);
      return;
    }
    this.physicalInitializePending = true;
    const physicalId = `opencraft:${++this.sequence}`;
    this.pending.set(physicalId, pending);
    this.writePhysical({ ...message, id: physicalId });
  }

  private readonly receivePhysicalLine = (line: string): void => {
    let message: RpcRecord;
    try { message = record(JSON.parse(line)); } catch { return; }
    const id = responseId(message.id);
    if (id !== null) {
      const pending = this.pending.get(String(id));
      if (pending !== undefined) {
        this.pending.delete(String(id));
        if (pending.method === "initialize") {
          this.physicalInitializePending = false;
          if ("result" in message) {
            this.initializeResult = withCodexHostCapabilities(message.result);
            message = { ...message, result: this.initializeResult };
            this.writePhysical({ method: "initialized", params: {} });
          }
          this.emit({ ...message, id: pending.originalId }, pending.clientId);
          for (const waiter of this.initializeWaiters.splice(0)) {
            this.emit("result" in message
              ? { id: waiter.originalId, result: message.result }
              : { id: waiter.originalId, error: message.error }, waiter.clientId);
          }
          return;
        }
        if ("result" in message) this.commitThreadSubscription(pending, message.result);
        this.emit({ ...message, id: pending.originalId }, pending.clientId);
        return;
      }
      const target = this.targetForThread(string(record(message.params).threadId)) ?? this.initializedClients.values().next().value;
      if (typeof message.method === "string" && typeof target === "string") {
        this.serverRequests.set(JSON.stringify(id), target);
        this.emit(message, target);
      }
      return;
    }
    const threadId = string(record(message.params).threadId) || string(record(record(message.params).thread).id);
    const targets = threadId ? [...(this.threadClients.get(threadId) ?? [])] : [];
    if (targets.length === 0) this.emit(message);
    else for (const target of targets) this.emit(message, target);
  };

  private commitThreadSubscription(pending: PendingRequest, result: unknown): void {
    if (pending.method === "thread/start" || pending.method === "thread/fork") {
      this.subscribeThread(string(record(record(result).thread).id), pending.clientId);
    } else if (pending.method === "thread/resume") {
      this.subscribeThread(string(pending.params.threadId), pending.clientId);
    } else if (pending.method === "thread/unsubscribe") {
      this.threadClients.get(string(pending.params.threadId))?.delete(pending.clientId);
    }
  }

  private subscribeThread(threadId: string, clientId: string): void {
    if (!threadId) return;
    let clients = this.threadClients.get(threadId);
    if (clients === undefined) { clients = new Set(); this.threadClients.set(threadId, clients); }
    clients.add(clientId);
  }

  private targetForThread(threadId: string): string | undefined {
    return threadId ? this.threadClients.get(threadId)?.values().next().value : undefined;
  }

  private disconnectClient(clientId: string): void {
    this.initializedClients.delete(clientId);
    for (const clients of this.threadClients.values()) clients.delete(clientId);
    for (const [id, owner] of this.serverRequests) if (owner === clientId) this.serverRequests.delete(id);
  }

  private async handleAccountRequest(clientId: string, message: RpcRecord): Promise<void> {
    const id = responseId(message.id);
    if (id === null) return;
    try {
      const store = this.poolStore;
      const login = this.login;
      const refresh = this.refresh;
      const subscriptions = this.subscriptions;
      if (store === null || login === null || refresh === null || subscriptions === null) throw new Error("Codex account service is unavailable");
      const params = record(message.params);
      let result: unknown;
      switch (message.method) {
        case "opencraft/codex/accounts/list": result = { accounts: this.accountViews(store) }; break;
        case "opencraft/codex/accounts/setEnabled":
          store.setEnabled(string(params.accountId), params.enabled === true);
          if (params.enabled === true) void subscriptions.refreshAccount(string(params.accountId)).catch(() => undefined);
          result = { accounts: this.accountViews(store) }; break;
        case "opencraft/codex/accounts/reorder":
          if (!Array.isArray(params.accountIds)) throw new Error("Invalid account order");
          store.reorder("codex", params.accountIds.map(string));
          result = { accounts: this.accountViews(store) }; break;
        case "opencraft/codex/accounts/remove":
          store.removeAccount(string(params.accountId));
          result = { accounts: this.accountViews(store) }; break;
        case "opencraft/codex/accounts/refresh": {
          await subscriptions.refreshAccount(string(params.accountId));
          result = { accounts: this.accountViews(store) }; break;
        }
        case "opencraft/codex/accounts/import": {
          const imported = await login.importFrom(this.options.nativeCodexHomeDirectory);
          void subscriptions.refreshAccount(imported.id).catch(() => undefined);
          const account = this.accountViews(store).find(candidate => candidate.id === imported.id);
          if (account === undefined) throw new Error("Imported Codex account was not found");
          result = { account };
          break;
        }
        case "opencraft/codex/accounts/deviceLogin/start": result = await login.start(); break;
        case "opencraft/codex/accounts/deviceLogin/poll": {
          const polled = await login.poll(string(params.sessionId));
          if (polled.status !== "complete") result = polled;
          else {
            void subscriptions.refreshAccount(polled.account.id).catch(() => undefined);
            const account = this.accountViews(store).find(candidate => candidate.id === polled.account.id);
            if (account === undefined) throw new Error("Codex account was not found after login");
            result = { status: "complete", account };
          }
          break;
        }
        case "opencraft/codex/accounts/deviceLogin/cancel": result = { cancelled: await login.cancel(string(params.sessionId)) }; break;
        default: throw new Error("Unsupported Codex account method");
      }
      this.emit({ id, result }, clientId);
    } catch (error) {
      this.emit({ id, error: { code: -32020, message: errorMessage(error) } }, clientId);
    }
  }

  private accountViews(store: AccountPoolStore): CodexAccountView[] {
    const states = new Map(store.listAccountStates().map(state => [state.accountId, state]));
    return store.listAccounts().map(account => {
      const state = states.get(account.id);
      if (state === undefined) throw new Error("Codex account state is unavailable");
      return {
        id: account.id,
        label: account.label,
        priority: account.priority,
        enabled: account.enabled,
        credentialConfigured: account.credentialConfigured,
        email: state.email,
        subscriptionType: state.subscriptionType,
        rateLimitTier: state.rateLimitTier,
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

  private writePhysical(message: RpcRecord): void {
    if (this.child === null || this.child.stdin.destroyed) throw new Error("Codex AppServer stdin is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private emit(message: RpcRecord, clientId?: string): void {
    const frame = JSON.stringify(clientId ? { ...message, [LOGICAL_CLIENT_FIELD]: clientId } : message);
    for (const listener of this.listeners) listener(frame);
  }

  private readonly fail = (error: Error): void => {
    this.publishStatus({ state: "failed", reason: error.message, failure: { code: "codex-appserver-exited", recovery: "automatic" } });
  };

  private publishStatus(status: TransportStatus): void {
    this.statusValue = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
