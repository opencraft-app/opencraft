import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";

import type { BotTerminalSession } from "../domain/types";
import { HermesProcessService } from "../hermes-appserver-bridge/process-service";
import {
  BrowserHermesAppServerBridge,
  HermesDashboardFileSystem,
  HermesDashboardHistoryClient,
  HermesProjectionRecovery,
  HermesTatTerminalService,
  browserHermesComposerQueueStore,
  type HermesComposerQueueStorage,
  type HermesComposerQueueStore,
} from "../hermes-appserver-bridge";
import { ensureHermesDashboard } from "../lib/hermes-dashboard-ensure";
import type { HermesSessionTokenCache } from "../lib/hermes-session-token-cache";
import { resolveHermesDashboardWebSocketUrl } from "../lib/hermes-dashboard-session";
import { createTatWebSocketConstructor } from "../lib/tat-websocket";
import { TatHttpVirtualClient } from "../lib/tat-http-virtual-client";
import { TencentTatSessionMultiplexer } from "../lib/tencent-tat-session-multiplexer";
import type { LightVelaBotInstance } from "../account/lightvela-account-service";

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
  readonly sessionTokenCache?: HermesSessionTokenCache;
  /** Test/platform override. Browsers default to their origin-local storage. */
  readonly composerQueueStorage?: HermesComposerQueueStorage;
}

function abortError(): Error {
  const error = new Error("LightVela Hermes connection was aborted");
  error.name = "AbortError";
  return error;
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
    const error = () => { cleanup(); reject(new Error("Hermes dashboard WebSocket failed")); };
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
  private boundBotId: string | null = null;
  private resolvingBinding = false;
  private disposed = false;
  private processes: HermesProcessService | null = null;
  private readonly removeAccountListener: () => void;
  private connectionStartedAt = 0;
  private accountGeneration: number | undefined;
  private composerQueue: HermesComposerQueueStore | null = null;
  private composerQueueScope: string | null = null;

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
    this.setStatus({ state: "connecting" });
    this.connectPromise = this.open(generation, signal)
      .catch(async (error) => {
        this.logConnection("connect:failed", generation, {
          reason: error instanceof Error ? error.message : String(error),
        });
        if (generation === this.generation) {
          await this.releasePhysicalConnection();
          this.setStatus({ state: "failed", reason: error instanceof Error ? error.message : String(error) });
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
    // A response from an expired request or detached bridge has no owner.
    // Turn notifications remain independent and reconcile accepted work.
    if (signal?.aborted || this.bridge !== bridge) return;
    if (method === "initialize") {
      this.logConnection("appserver:initialize:ready", this.generation, {
        stageMs: Date.now() - requestStartedAt,
      });
    }
    this.emit(JSON.stringify(response));
    bridge.didDeliverResponse(request, response);
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
    this.disposed = true;
    this.removeAccountListener();
    this.processes?.dispose();
    this.processes = null;
    this.composerQueue?.dispose();
    this.composerQueue = null;
    this.composerQueueScope = null;
    this.generation += 1;
    this.connectPromise = null;
    this.setStatus({ state: "closing" });
    await this.releasePhysicalConnection();
    this.boundBotId = null;
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
    }
    const createSession = () => this.options.account.request<BotTerminalSession>(
      `/v1/instances/${encodeURIComponent(botId)}/tat/session`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    const WebSocketImpl = this.options.WebSocketImpl ?? globalThis.WebSocket;
    const scope = this.options.account.getSnapshot().credentialScope;
    const cacheKey = scope ? `${scope}:${botId}` : botId;
    if (this.composerQueueScope !== cacheKey) {
      this.composerQueue?.dispose();
      this.composerQueue = browserHermesComposerQueueStore(
        cacheKey,
        this.options.composerQueueStorage,
      );
      this.composerQueueScope = cacheKey;
    }
    stageStartedAt = Date.now();
    const bootstrap = await createSession();
    this.logConnection("tat:session-created", generation, { stageMs: Date.now() - stageStartedAt });
    if (signal?.aborted || generation !== this.generation) throw abortError();
    const proxy = new TencentTatSessionMultiplexer(bootstrap, {
      WebSocketImpl,
      diagnosticContext: { hostId: "velahermes0", generation },
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
      socket = await this.openDashboardSocket(
        bootstrap,
        proxy,
        sessionToken,
        WebSocketImpl,
        signal,
      );
    }
    if (generation !== this.generation) throw abortError();
    this.processes ??= new HermesProcessService(new HermesTatTerminalService({ createSession, WebSocketImpl }));
    const bridge = new BrowserHermesAppServerBridge(socket, {
      defaultCwd: bootstrap.workingDirectory ?? "/",
      projectionRecovery: this.replayCheckpoint,
      fileSystem: new HermesDashboardFileSystem(
        new TatHttpVirtualClient(bootstrap, {
          proxyClient: proxy,
          target: { host: "127.0.0.1", port: 9119 },
        }),
        sessionToken,
      ),
      history: new HermesDashboardHistoryClient(
        new TatHttpVirtualClient(bootstrap, {
          proxyClient: proxy,
          target: { host: "127.0.0.1", port: 9119 },
          // Desktop fetchJson uses req.setTimeout(30s): inactivity, not the
          // total duration of an actively progressing transcript download.
          responseHeaderTimeoutMs: 30_000,
          responseBodyChunkTimeoutMs: 30_000,
        }),
        sessionToken,
      ),
      processes: this.processes,
      composerQueue: this.composerQueue ?? undefined,
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
      this.proxy?.close();
      this.proxy = null;
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
    this.proxy?.close();
    this.proxy = null;
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
    this.processes?.dispose();
    this.processes = null;
    this.composerQueue?.dispose();
    this.composerQueue = null;
    this.composerQueueScope = null;
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
