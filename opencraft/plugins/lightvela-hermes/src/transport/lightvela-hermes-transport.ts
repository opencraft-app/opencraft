import type {
  DuplexTransport,
  TransportFailureDisposition,
  TransportStatus,
} from "@opencraft/appserver-client/transport";
import { findHostConnectionInterventionError } from "@opencraft/workbench-runtime";

import type { BotTerminalSession } from "../domain/types";
import { HermesProcessService } from "../hermes-appserver-bridge/process-service";
import {
  BrowserHermesAppServerBridge,
  HermesDashboardFileSystem,
  HermesDashboardHistoryClient,
  HermesProjectionRecovery,
  HermesDashboardProfileSkillsHandler,
  HermesDashboardWhatsAppOnboardingHandler,
  HermesTatTerminalService,
  browserProfileSkillsJournalStorage,
  browserHermesComposerQueueService,
  type HermesComposerQueueStorage,
  type HermesComposerQueueService,
  type ProfileSkillsJournalStorage,
} from "../hermes-appserver-bridge";
import { ensureHermesDashboard } from "../lib/hermes-dashboard-ensure";
import type { HermesSessionTokenCache } from "../lib/hermes-session-token-cache";
import { resolveHermesDashboardWebSocketUrl } from "../lib/hermes-dashboard-session";
import { createTatWebSocketConstructor } from "../lib/tat-websocket";
import type { Rfc6455Sha1 } from "../lib/rfc6455-client";
import { TatHttpVirtualClient } from "../lib/tat-http-virtual-client";
import { TencentTatSessionMultiplexer } from "../lib/tencent-tat-session-multiplexer";
import {
  LightVelaApiError,
  type LightVelaBotInstance,
} from "../account/lightvela-account-service";
import { LIGHTVELA_HERMES_HOST_ID } from "../host/lightvela-hermes-host-identity";
import { parseInstanceProfileBots } from "../hermes-appserver-bridge/instance-profile-bots";
import { HermesInstanceBotManagement } from "../hermes-appserver-bridge/instance-bot-management";

const HERMES_DASHBOARD_PORT = 9119;
// The observed forwarding path retires a fully idle socket after roughly 75s.
// Chromium may throttle background timers to one wake-up per minute, so this
// remains below that network deadline without coupling liveness to Hermes RPC.
const TAT_IDLE_KEEPALIVE_INTERVAL_MS = 20_000;

export interface LightVelaAccountPort {
  getSnapshot(): { readonly phase: string; readonly activeBotId: string | null; readonly authGeneration?: number; readonly credentialScope?: string };
  subscribe(listener: () => void): () => void;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  resolveActiveBot(): Promise<LightVelaBotInstance>;
}

export interface LightVelaHermesTransportOptions {
  readonly account: LightVelaAccountPort;
  readonly dashboardUrl?: string;
  readonly WebSocketImpl?: typeof WebSocket;
  readonly sha1?: Rfc6455Sha1;
  /** React Native Response cannot consume a custom streaming response body. */
  readonly bufferHttpResponses?: boolean;
  readonly sessionTokenCache?: HermesSessionTokenCache;
  /** Test/platform override. Browsers default to their origin-local storage. */
  readonly composerQueueStorage?: HermesComposerQueueStorage;
  /** Test/platform override. Browser journals default to origin-local storage. */
  readonly profileSkillsJournalStorage?: ProfileSkillsJournalStorage;
}

function abortError(): Error {
  const error = new Error("LightVela Hermes connection was aborted");
  error.name = "AbortError";
  return error;
}

/** Provider-owned classification; the generic Workbench never parses API text. */
function classifyConnectFailure(error: unknown): TransportFailureDisposition | undefined {
  const intervention = findHostConnectionInterventionError(error);
  if (intervention !== null) {
    return {
      code: `intervention:${intervention.code}`,
      recovery: "manual",
    };
  }
  if (
    error instanceof LightVelaApiError
    && error.status === 404
    && /\bresource not found\b/iu.test(error.message)
  ) {
    return { code: "remote-resource-not-found", recovery: "manual" };
  }
  return undefined;
}

function waitForOpen(socket: WebSocket, signal?: AbortSignal): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", open);
      socket.removeEventListener("error", error);
      socket.removeEventListener("close", close);
      signal?.removeEventListener("abort", abort);
    };
    const open = () => { cleanup(); resolve(); };
    const error = (event: Event) => {
      cleanup();
      const cause = (event as Event & { readonly error?: unknown }).error;
      reject(cause instanceof Error ? cause : new Error("Hermes dashboard WebSocket failed"));
    };
    const close = () => { cleanup(); reject(new Error("Hermes dashboard WebSocket closed before opening")); };
    const abort = () => {
      cleanup();
      try { socket.close(1000, "aborted"); } catch { /* best effort */ }
      reject(abortError());
    };
    socket.addEventListener("open", open, { once: true });
    socket.addEventListener("error", error, { once: true });
    socket.addEventListener("close", close, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** AppServer transport whose physical link is Hermes JSON-RPC over Tencent TAT. */
export class LightVelaHermesTransport implements DuplexTransport {
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private currentStatus: TransportStatus = { state: "idle" };
  private connectPromise: Promise<void> | null = null;
  private generation = 0;
  private bridge: BrowserHermesAppServerBridge | null = null;
  private readonly replayCheckpoint = new HermesProjectionRecovery();
  private socket: WebSocket | null = null;
  private proxy: TencentTatSessionMultiplexer | null = null;
  private loopbackHttp: TatHttpVirtualClient | null = null;
  private boundBotId: string | null = null;
  private botManagement: HermesInstanceBotManagement | null = null;
  private resolvingBinding = false;
  private disposed = false;
  private processes: HermesProcessService | null = null;
  private terminal: HermesTatTerminalService | null = null;
  private readonly removeAccountListener: () => void;
  private connectionStartedAt = 0;
  private accountGeneration: number | undefined;
  private composerQueue: HermesComposerQueueService | null = null;
  private composerQueueScope: string | null = null;
  private profileSkills: HermesDashboardProfileSkillsHandler | null = null;
  private profileSkillsScope: string | null = null;
  private whatsappOnboarding: HermesDashboardWhatsAppOnboardingHandler | null = null;

  constructor(private readonly options: LightVelaHermesTransportOptions) {
    this.accountGeneration = options.account.getSnapshot().authGeneration;
    this.removeAccountListener = options.account.subscribe(() => this.reconcileAccountBinding());
  }

  get status(): TransportStatus { return this.currentStatus; }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("LightVela Hermes transport is closed"));
    if (this.currentStatus.state === "open") return Promise.resolve();
    if (this.connectPromise !== null) return this.connectPromise;
    if (signal?.aborted) return Promise.reject(abortError());
    const generation = ++this.generation;
    this.connectionStartedAt = Date.now();
    this.logConnection("connect:start", generation);
    this.setStatus({ state: "connecting", reason: "正在确认云端 Agent…" });
    this.connectPromise = this.open(generation, signal)
      .catch(async (error) => {
        const failure = classifyConnectFailure(error);
        this.logConnection("connect:failed", generation, {
          reason: error instanceof Error ? error.message : String(error),
          failure,
        });
        if (generation === this.generation) {
          await this.releasePhysicalConnection();
          this.setStatus({
            state: "failed",
            reason: error instanceof Error ? error.message : String(error),
            ...(failure === undefined ? {} : { failure }),
          });
        }
        throw error;
      })
      .finally(() => {
        if (generation === this.generation) this.connectPromise = null;
      });
    return this.connectPromise;
  }

  async send(frame: string, signal?: AbortSignal): Promise<void> {
    const bridge = this.bridge;
    if (this.currentStatus.state !== "open" || bridge === null) {
      throw new Error("LightVela Hermes transport is not open");
    }
    let request: unknown;
    try { request = JSON.parse(frame); } catch { throw new TypeError("AppServer frame is not valid JSON"); }
    if (await bridge.handleResponse(request)) return;
    const method = request !== null && typeof request === "object" && "method" in request
      ? String((request as { method?: unknown }).method ?? "")
      : "";
    const requestStartedAt = Date.now();
    if (method === "initialize") this.logConnection("appserver:initialize:start", this.generation);
    const response = await bridge.handle(request, signal);
    if (
      response !== null
      && typeof response === "object"
      && "error" in response
      && (response as { error?: unknown }).error !== undefined
    ) {
      this.logConnection("appserver:request-failed", this.generation, {
        method,
        responseError: (response as { error?: unknown }).error,
      });
    }
    // A response from an expired request or detached bridge has no owner.
    // Turn notifications remain independent and reconcile accepted work.
    if (signal?.aborted || this.bridge !== bridge) return;
    if (method === "initialize") {
      this.logConnection("appserver:initialize:response", this.generation, {
        stageMs: Date.now() - requestStartedAt,
      });
    }
    this.emit(JSON.stringify(response));
    bridge.didDeliverResponse(request, response);
  }

  /** Uses the Host-owned TAT session; it never creates a second tunnel owner. */
  async fetchLoopback(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    const loopbackHost = new Set(["localhost", "0.0.0.0", "[::1]", "::1"]).has(url.hostname)
      || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
    if (url.protocol !== "http:" || !loopbackHost) {
      throw new Error("Hermes loopback HTTP only supports plain HTTP loopback URLs");
    }
    if (this.currentStatus.state !== "open" || this.loopbackHttp === null) {
      throw new Error("LightVela Hermes loopback HTTP is not ready");
    }
    let body: Uint8Array | ArrayBuffer | string | undefined;
    if (typeof init.body === "string" || init.body instanceof ArrayBuffer) {
      body = init.body;
    } else if (ArrayBuffer.isView(init.body)) {
      body = new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength);
    } else if (init.body != null) {
      throw new TypeError("Hermes loopback HTTP requires a buffered request body");
    }
    const { body: _requestBody, ...requestInit } = init;
    return this.loopbackHttp.fetch(url, {
      ...requestInit,
      ...(body === undefined ? {} : { body }),
    });
  }

  subscribeMessage(listener: (frame: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.logConnection("dispose:start", this.generation);
    this.disposed = true;
    this.removeAccountListener();
    this.processes?.dispose();
    this.processes = null;
    this.terminal = null;
    this.composerQueue?.dispose();
    this.composerQueue = null;
    this.composerQueueScope = null;
    this.profileSkills?.dispose();
    this.profileSkills = null;
    this.profileSkillsScope = null;
    this.whatsappOnboarding?.dispose();
    this.whatsappOnboarding = null;
    this.generation += 1;
    this.connectPromise = null;
    this.setStatus({ state: "closing" });
    await this.releasePhysicalConnection();
    this.boundBotId = null;
    this.botManagement = null;
    this.replayCheckpoint.reset();
    this.setStatus({ state: "closed" });
  }

  private async open(generation: number, signal?: AbortSignal): Promise<void> {
    let stageStartedAt = Date.now();
    this.resolvingBinding = true;
    let botId: string;
    try {
      botId = (await this.options.account.resolveActiveBot()).instanceId;
    } finally {
      this.resolvingBinding = false;
    }
    this.logConnection("bot:resolved", generation, {
      instanceId: botId,
      stageMs: Date.now() - stageStartedAt,
    });
    if (signal?.aborted || generation !== this.generation) throw abortError();
    if (this.boundBotId !== botId) {
      this.replayCheckpoint.reset();
      this.boundBotId = botId;
      this.botManagement = null;
    }
    if (this.botManagement === null) {
      const authority = this.accountGeneration;
      const assertBinding = () => {
        if (this.disposed || this.accountGeneration !== authority || this.boundBotId !== botId) throw abortError();
      };
      this.botManagement = new HermesInstanceBotManagement(botId, async <T>(path: string, init?: RequestInit): Promise<T> => {
        assertBinding();
        const result = await this.options.account.request<T>(path, init);
        assertBinding();
        return result;
      });
    }
    this.setConnectingReason(generation, "正在创建 TAT 会话…");
    const createSession = () => this.options.account.request<BotTerminalSession>(
      `/v1/instances/${encodeURIComponent(botId)}/tat/session`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    const WebSocketImpl = this.options.WebSocketImpl ?? globalThis.WebSocket;
    const scope = this.options.account.getSnapshot().credentialScope;
    const cacheKey = scope ? `${scope}:${botId}` : botId;
    if (this.composerQueueScope !== cacheKey) {
      this.composerQueue?.dispose();
      this.composerQueue = browserHermesComposerQueueService(
        cacheKey,
        this.options.composerQueueStorage,
      );
      this.composerQueueScope = cacheKey;
    }
    if (this.profileSkillsScope !== cacheKey) {
      this.profileSkills?.dispose();
      this.profileSkills = new HermesDashboardProfileSkillsHandler(
        `vela.hermes.profile-skills.v1:${cacheKey}`,
        this.options.profileSkillsJournalStorage ?? browserProfileSkillsJournalStorage(),
      );
      this.profileSkillsScope = cacheKey;
    }
    this.whatsappOnboarding ??= new HermesDashboardWhatsAppOnboardingHandler();
    stageStartedAt = Date.now();
    const bootstrap = await createSession();
    this.logConnection("tat:session-created", generation, { stageMs: Date.now() - stageStartedAt });
    if (signal?.aborted || generation !== this.generation) throw abortError();
    const proxy = new TencentTatSessionMultiplexer(bootstrap, {
      WebSocketImpl,
      diagnosticContext: { hostId: LIGHTVELA_HERMES_HOST_ID, generation },
      idleKeepaliveIntervalMs: TAT_IDLE_KEEPALIVE_INTERVAL_MS,
      idleKeepaliveTarget: { ip: "127.0.0.1", port: HERMES_DASHBOARD_PORT },
      onUnhealthy: () => {
        if (this.disposed || generation !== this.generation) return;
        const retiredGeneration = ++this.generation;
        this.connectPromise = null;
        this.logConnection("tat:unhealthy", generation, { reason: "probe_failed_without_inbound_progress" });
        void this.releasePhysicalConnection().finally(() => {
          if (this.disposed || retiredGeneration !== this.generation) return;
          this.setStatus({ state: "failed", reason: "TAT tunnel health probe failed" });
        });
      },
    });
    this.proxy = proxy;
    this.loopbackHttp = new TatHttpVirtualClient(bootstrap, {
      bufferResponseBody: this.options.bufferHttpResponses,
      proxyClient: proxy,
      responseHeaderTimeoutMs: 30_000,
      responseBodyChunkTimeoutMs: 300_000,
    });
    this.setConnectingReason(generation, "正在启动 Hermes Dashboard…");
    stageStartedAt = Date.now();
    let sessionToken: string | null = null;
    try {
      sessionToken = (await this.options.sessionTokenCache?.get(cacheKey))?.trim() || null;
    } catch {
      // IndexedDB is a performance hint and never blocks Host connection.
    }
    if (signal?.aborted || generation !== this.generation) throw abortError();
    let socket: WebSocket | null = null;
    if (sessionToken !== null) {
      try {
        socket = await this.openDashboardSocket(
          bootstrap,
          proxy,
          sessionToken,
          WebSocketImpl,
          signal,
        );
        this.logConnection("hermes:backend-adopted", generation, {
          stageMs: Date.now() - stageStartedAt,
        });
      } catch {
        if (signal?.aborted || generation !== this.generation) throw abortError();
        try {
          // Compare-and-delete prevents a stale tab from erasing a token that
          // another tab has already refreshed for this physical instance.
          await this.options.sessionTokenCache?.remove(cacheKey, sessionToken);
        } catch {
          // Cache invalidation is best-effort.
        }
        this.socket = null;
        sessionToken = null;
      }
    }
    if (sessionToken === null) {
      sessionToken = await ensureHermesDashboard(proxy);
      if (signal?.aborted || generation !== this.generation) throw abortError();
      this.logConnection("hermes:backend-ready", generation, { stageMs: Date.now() - stageStartedAt });
      try {
        await this.options.sessionTokenCache?.put(cacheKey, sessionToken);
      } catch {
        // Token persistence is an optimization, never part of Host readiness.
      }
    }
    if (socket === null) {
      this.setConnectingReason(generation, "正在建立 Hermes AppServer 连接…");
      socket = await this.openDashboardSocket(
        bootstrap,
        proxy,
        sessionToken,
        WebSocketImpl,
        signal,
      );
    }
    if (generation !== this.generation) throw abortError();
    this.terminal ??= new HermesTatTerminalService({ createSession, WebSocketImpl });
    this.processes ??= new HermesProcessService(this.terminal);
    const profileSkills = this.profileSkills;
    if (profileSkills === null) throw new Error("Hermes Profile Skills owner was not initialized");
    profileSkills.attach(
      new TatHttpVirtualClient(bootstrap, {
        bufferResponseBody: this.options.bufferHttpResponses,
        proxyClient: proxy,
        target: { host: "127.0.0.1", port: HERMES_DASHBOARD_PORT },
        responseHeaderTimeoutMs: 45_000,
        responseBodyChunkTimeoutMs: 45_000,
      }),
      sessionToken,
    );
    const whatsappOnboarding = this.whatsappOnboarding;
    if (whatsappOnboarding === null) throw new Error("Hermes WhatsApp onboarding owner was not initialized");
    whatsappOnboarding.attach(
      new TatHttpVirtualClient(bootstrap, {
        bufferResponseBody: this.options.bufferHttpResponses,
        proxyClient: proxy,
        target: { host: "127.0.0.1", port: HERMES_DASHBOARD_PORT },
        responseHeaderTimeoutMs: 45_000,
        responseBodyChunkTimeoutMs: 45_000,
      }),
      sessionToken,
    );
    const bridge = new BrowserHermesAppServerBridge(socket, {
      defaultCwd: bootstrap.workingDirectory ?? "/",
      projectionRecovery: this.replayCheckpoint,
      fileSystem: new HermesDashboardFileSystem(
        new TatHttpVirtualClient(bootstrap, {
          bufferResponseBody: this.options.bufferHttpResponses,
          proxyClient: proxy,
          target: { host: "127.0.0.1", port: HERMES_DASHBOARD_PORT },
        }),
        sessionToken,
      ),
      history: new HermesDashboardHistoryClient(
        new TatHttpVirtualClient(bootstrap, {
          bufferResponseBody: this.options.bufferHttpResponses,
          proxyClient: proxy,
          target: { host: "127.0.0.1", port: HERMES_DASHBOARD_PORT },
          // Desktop fetchJson uses req.setTimeout(30s): inactivity, not the
          // total duration of an actively progressing transcript download.
          responseHeaderTimeoutMs: 30_000,
          responseBodyChunkTimeoutMs: 30_000,
        }),
        sessionToken,
      ),
      terminal: this.terminal,
      processes: this.processes,
      composerQueue: this.composerQueue ?? undefined,
      profileSkills,
      whatsappOnboarding,
      instanceId: botId,
      botManagement: this.botManagement,
      resolveProfileBots: async () => {
        if (generation !== this.generation || signal?.aborted) throw abortError();
        const catalog = await this.options.account.request<unknown>(
          `/v1/instances/${encodeURIComponent(botId)}/bots`, { method: "GET", signal },
        );
        if (generation !== this.generation || signal?.aborted) throw abortError();
        return parseInstanceProfileBots(catalog, botId);
      },
    });
    bridge.onNotification((notification) => this.emit(JSON.stringify(notification)));
    this.bridge = bridge;
    socket.addEventListener("close", (event) => {
      if (generation !== this.generation) return;
      const closeEvent = event as CloseEvent;
      this.logConnection("hermes:websocket-closed", generation, {
        code: closeEvent.code,
        reason: closeEvent.reason,
        wasClean: closeEvent.wasClean,
      });
      this.bridge?.dispose();
      this.bridge = null;
      this.socket = null;
      this.loopbackHttp?.close();
      this.loopbackHttp = null;
      this.proxy?.close();
      this.proxy = null;
      this.profileSkills?.detach();
      this.whatsappOnboarding?.detach();
      this.setStatus({
        state: "closed",
        ...(closeEvent.wasClean ? {} : { reason: closeEvent.reason || `Hermes closed with code ${closeEvent.code}` }),
      });
    });
    this.logConnection("connect:open", generation);
    this.setStatus({ state: "open" });
  }

  private async openDashboardSocket(
    bootstrap: BotTerminalSession,
    proxy: TencentTatSessionMultiplexer,
    sessionToken: string,
    WebSocketImpl: typeof WebSocket,
    signal?: AbortSignal,
  ): Promise<WebSocket> {
    let stageStartedAt = Date.now();
    const dashboardUrl = await resolveHermesDashboardWebSocketUrl(
      bootstrap,
      this.options.dashboardUrl ?? "ws://127.0.0.1:9119/api/ws",
      { proxyClient: proxy, sessionToken },
    );
    this.logConnection("hermes:endpoint-resolved", this.generation, {
      stageMs: Date.now() - stageStartedAt,
    });
    const TatWebSocket = createTatWebSocketConstructor(proxy, {
      origin: `http://${dashboardUrl.host}`,
      sha1: this.options.sha1,
      onError: (error) => this.logConnection("hermes:websocket-error", this.generation, {
        reason: error.message.replace(/([?&]token=)[^&\s]+/g, "$1[redacted]"),
      }),
    });
    const socket = new TatWebSocket(dashboardUrl);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    stageStartedAt = Date.now();
    try {
      await waitForOpen(socket, signal);
    } catch (error) {
      try { socket.close(1000, "Hermes session rejected"); } catch { /* best effort */ }
      throw error;
    }
    this.logConnection("hermes:websocket-open", this.generation, {
      stageMs: Date.now() - stageStartedAt,
    });
    return socket;
  }

  private async releasePhysicalConnection(): Promise<void> {
    this.bridge?.dispose();
    this.bridge = null;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null && socket.readyState < WebSocket.CLOSING) {
      try { socket.close(1000, "OpenCraft Host closing"); } catch { /* best effort */ }
    }
    this.loopbackHttp?.close();
    this.loopbackHttp = null;
    this.proxy?.close();
    this.proxy = null;
    this.profileSkills?.detach();
    this.whatsappOnboarding?.detach();
  }

  private emit(frame: string): void {
    for (const listener of this.listeners) listener(frame);
  }

  private setStatus(status: TransportStatus): void {
    if (this.currentStatus.state !== status.state) {
      this.logConnection(`status:${this.currentStatus.state}->${status.state}`, this.generation);
    }
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private setConnectingReason(generation: number, reason: string): void {
    if (this.disposed || generation !== this.generation || this.currentStatus.state !== "connecting") return;
    this.setStatus({ state: "connecting", reason });
  }

  private logConnection(
    stage: string,
    generation: number,
    details: Readonly<Record<string, unknown>> = {},
  ): void {
    console.log("[lightvela-hermes]", {
      stage,
      generation,
      elapsedMs: this.connectionStartedAt === 0 ? 0 : Date.now() - this.connectionStartedAt,
      ...details,
    });
  }

  private reconcileAccountBinding(): void {
    if (this.disposed) return;
    const snapshot = this.options.account.getSnapshot();
    const authorityChanged = snapshot.authGeneration !== this.accountGeneration;
    this.accountGeneration = snapshot.authGeneration;
    if (!authorityChanged) {
      if (this.resolvingBinding || this.boundBotId === null) return;
      if (snapshot.phase !== "authenticated" && snapshot.phase !== "anonymous") return;
      if (snapshot.activeBotId === this.boundBotId) return;
    }
    const retiredBotId = this.boundBotId;
    this.botManagement = null;
    this.logConnection("binding:retire", this.generation, {
      activeBotId: snapshot.activeBotId,
      authorityChanged,
      retiredBotId,
      accountPhase: snapshot.phase,
    });
    this.processes?.dispose();
    this.processes = null;
    this.terminal = null;
    this.composerQueue?.dispose();
    this.composerQueue = null;
    this.composerQueueScope = null;
    this.profileSkills?.dispose();
    this.profileSkills = null;
    this.profileSkillsScope = null;
    this.whatsappOnboarding?.dispose();
    this.whatsappOnboarding = null;
    const generation = ++this.generation;
    this.connectPromise = null;
    this.boundBotId = null;
    this.replayCheckpoint.reset();
    this.setStatus({ state: "closing" });
    void this.releasePhysicalConnection().finally(() => {
      if (this.disposed || generation !== this.generation) return;
      this.setStatus({
        state: "closed",
        reason: snapshot.activeBotId === null
          ? `LightVela Bot ${retiredBotId} is no longer available`
          : `LightVela Bot binding changed to ${snapshot.activeBotId}`,
      });
    });
  }
}
