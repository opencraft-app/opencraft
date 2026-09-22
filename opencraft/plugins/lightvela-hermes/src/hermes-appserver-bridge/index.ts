import { Service, type Context } from "@deepseek-ai/cordis";

import { HermesAppServerAdapter, isHermesSessionNotFound } from "./adapter";
import { HermesProjectionRecovery } from "./projection-recovery";
import { HermesBotAppServerHandler, type HermesBotHandlerOptions } from "./bot-protocol-handler";
import type { HermesHostFileSystem } from "./dashboard-file-system";
import { HermesAttachmentStagingService } from "./attachment-staging";
import type { HermesHistoryClient } from "./history-client";
import type { HermesHostTerminal } from "./tat-terminal";
import type { HermesProcessService } from "./process-service";
import type { HermesComposerQueueService } from "./composer-queue/service";
import type { HermesDashboardProfileSkillsHandler } from "./profile-skills-handler";
import type { HermesDashboardWhatsAppOnboardingHandler } from "./whatsapp-onboarding-handler";
import { dispatchAppServerRequest } from "./protocol";
import {
  HermesRpcError,
  HermesRpcWebSocketTransport,
  type HermesRpcTransportOptions,
  type HermesSocket,
} from "./rpc-transport";
import type {
  AppServerNotification,
  AppServerOutboundMessage,
  JsonRpcFailure,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types";

export interface BrowserHermesBridgeOptions extends Omit<HermesRpcTransportOptions, "replayCheckpoint"> {
  projectionRecovery?: HermesProjectionRecovery;
  /** Legacy runtime-only opt-in; production uses the instance-bound catalog below. */
  enableBotConversations?: boolean;
  resolveProfileBots?: HermesBotHandlerOptions["resolveProfileBots"];
  botManagement?: HermesBotHandlerOptions["management"];
  defaultCwd?: string;
  fileSystem?: HermesHostFileSystem;
  history?: HermesHistoryClient;
  /** Host-owned command executor; survives replaceable bridge generations. */
  terminal?: HermesHostTerminal;
  /** Borrowed from the Host transport; a bridge only owns its subscription. */
  processes?: HermesProcessService;
  /** Client-owned editable queue; survives Gateway/WebSocket bridge renewal. */
  composerQueue?: HermesComposerQueueService;
  /** Host-owned Profile Skills projection; survives Gateway/WebSocket renewal. */
  profileSkills?: HermesDashboardProfileSkillsHandler;
  /** Host-owned WhatsApp pairing transaction over Hermes Dashboard REST. */
  whatsappOnboarding?: HermesDashboardWhatsAppOnboardingHandler;
  /** Physical instance currently bound beneath the stable logical Host id. */
  instanceId?: string;
  /** Fixed native Hermes Profile owned by this logical embedded Host. */
  profileScope?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const failure = (
  id: JsonRpcRequest["id"] | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

/** In-browser protocol translator. It never owns or closes the supplied socket. */
export class BrowserHermesAppServerBridge {
  private readonly transport: HermesRpcWebSocketTransport;
  private readonly adapter: HermesAppServerAdapter;
  private readonly attachments: HermesAttachmentStagingService | null;
  private readonly bots: HermesBotAppServerHandler | null;
  private readonly notificationListeners = new Set<(event: AppServerOutboundMessage) => void>();
  private readonly stopNotifications: () => void;
  private readonly stopServerRequests: () => void;
  private readonly stopTerminalNotifications: () => void;
  private readonly stopProcessNotifications: () => void;
  private readonly stopProfileSkillsNotifications: () => void;
  private disposed = false;

  constructor(socket: HermesSocket, private readonly options: BrowserHermesBridgeOptions = {}) {
    options.projectionRecovery?.prepareReconnect();
    this.transport = new HermesRpcWebSocketTransport(socket, {
      ...options,
      // A bridge has a fresh adapter unless its matching owners survived.
      replayCheckpoint: options.projectionRecovery ?? new HermesProjectionRecovery(),
    });
    this.attachments = options.fileSystem === undefined
      ? null
      : new HermesAttachmentStagingService(options.fileSystem);
    this.adapter = new HermesAppServerAdapter(this.transport, options.defaultCwd ?? "/", options.history,
      undefined, options.projectionRecovery, options.composerQueue, this.attachments ?? undefined,
      options.profileScope);
    this.bots = options.profileScope === undefined
      && (options.enableBotConversations === true || options.resolveProfileBots !== undefined)
      ? new HermesBotAppServerHandler(this.adapter, (event) => {
          const notification: AppServerNotification = { jsonrpc: "2.0", ...event };
          for (const listener of this.notificationListeners) listener(notification);
        }, { resolveProfileBots: options.resolveProfileBots, management: options.botManagement })
      : null;
    this.stopNotifications = this.adapter.subscribeNotification((method, params) => {
      this.bots?.observeAppServerNotification(method, params);
      const notification: AppServerNotification = { jsonrpc: "2.0", method, params };
      for (const listener of this.notificationListeners) listener(notification);
    });
    this.stopServerRequests = this.adapter.subscribeServerRequest((request) => {
      const frame: AppServerOutboundMessage = {
        jsonrpc: "2.0",
        id: request.id,
        method: request.method,
        params: request.params,
      };
      for (const listener of this.notificationListeners) listener(frame);
    });
    this.stopTerminalNotifications = options.terminal?.subscribeNotification((notification) => {
      for (const listener of this.notificationListeners) listener(notification);
    }) ?? (() => undefined);
    this.stopProcessNotifications = options.processes?.subscribeNotification((notification) => {
      for (const listener of this.notificationListeners) listener(notification);
    }) ?? (() => undefined);
    this.stopProfileSkillsNotifications = options.profileSkills?.subscribe((event) => {
      const notification: AppServerNotification = { jsonrpc: "2.0", ...event };
      for (const listener of this.notificationListeners) listener(notification);
      if (event.method === "skills/installed/changed") {
        for (const listener of this.notificationListeners) listener({ jsonrpc: "2.0", method: "skills/changed", params: {} });
      }
    }) ?? (() => undefined);
    if (options.profileSkills) this.adapter.setSkillValidator((profile, skills) => options.profileSkills!.validateComposerSkills(profile, skills));
  }

  onNotification(listener: (event: AppServerOutboundMessage) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.disposed) throw new Error("Hermes AppServer bridge is detached");
    return dispatchAppServerRequest(this.adapter, { jsonrpc: "2.0", id: 0, method, params }, {
      fileSystem: this.options.fileSystem,
      attachments: this.attachments ?? undefined,
      terminal: this.options.terminal,
      processes: this.options.processes,
      profileSkills: this.options.profileSkills,
      whatsappOnboarding: this.options.whatsappOnboarding,
      instanceId: this.options.instanceId,
      ...(this.bots === null ? {} : { bots: this.bots }),
    });
  }

  async handle(value: unknown, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (!isObject(value) || typeof value.method !== "string") {
      return failure(null, -32600, "invalid AppServer JSON-RPC request");
    }
    const id = typeof value.id === "string" || typeof value.id === "number" ? value.id : null;
    if (id === null) return failure(null, -32600, "AppServer request id must be a string or number");
    const request: JsonRpcRequest = {
      ...(value.jsonrpc === "2.0" ? { jsonrpc: "2.0" as const } : {}),
      id,
      method: value.method,
      ...(Object.hasOwn(value, "params") ? { params: value.params } : {}),
    };
    try {
      return {
        jsonrpc: "2.0",
        id,
        result: await dispatchAppServerRequest(this.adapter, request, {
          signal,
          fileSystem: this.options.fileSystem,
          attachments: this.attachments ?? undefined,
          terminal: this.options.terminal,
          processes: this.options.processes,
          profileSkills: this.options.profileSkills,
          whatsappOnboarding: this.options.whatsappOnboarding,
          instanceId: this.options.instanceId,
          ...(this.bots === null ? {} : { bots: this.bots }),
        }),
      };
    } catch (error) {
      // JSON-RPC deliberately returns a stable public error envelope, but the
      // bridge still owns the original exception and is the only layer that
      // can retain its actionable stack. This is especially important on
      // React Native, where Hermes otherwise reduces call failures to
      // "undefined is not a function" at the transport boundary.
      const details = {
        method: request.method,
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
      };
      // Missing Thread identities are a public AppServer domain outcome. The
      // caller still receives the JSON-RPC error below, but React Native must
      // not turn a recoverable metadata probe into a development red screen.
      // Unexpected bridge faults retain console.error and their original stack.
      if (isHermesSessionNotFound(error)) {
        console.debug("[hermes-appserver-bridge] request unavailable", details);
      } else {
        console.error("[hermes-appserver-bridge] request failed", details);
      }
      const code = isObject(error) && typeof error.rpcCode === "number" ? error.rpcCode : -32000;
      const data = error instanceof HermesRpcError
        ? { hermesCode: error.code, details: error.details }
        : isObject(error) && isObject(error.domainData)
          ? error.domainData
          : undefined;
      return failure(id, code, error instanceof Error ? error.message : String(error), data);
    }
  }

  /** AppServer response delivery owns restored-queue activation ordering. */
  didDeliverResponse(value: unknown, response: JsonRpcResponse): void {
    if (!isObject(value) || "error" in response) return;
    if (value.method !== "thread/resume" && value.method !== "thread/read") return;
    const params = isObject(value.params) ? value.params : {};
    const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
    if (threadId !== "") this.adapter.resumeQueuedSubmissions(threadId);
  }

  /** Consume a client answer to a server-initiated interaction request. */
  async handleResponse(value: unknown): Promise<boolean> {
    if (!isObject(value) || typeof value.method === "string") return false;
    const id = typeof value.id === "string" || typeof value.id === "number" ? value.id : null;
    if (id === null) return false;
    if (Object.hasOwn(value, "result")) {
      return this.adapter.respondServerRequest(String(id), value.result);
    }
    if (Object.hasOwn(value, "error")) {
      return this.adapter.rejectServerRequest(String(id), value.error);
    }
    return false;
  }

  dispose(): void {
    this.bots?.dispose();
    if (this.disposed) return;
    this.disposed = true;
    this.stopNotifications();
    this.stopServerRequests();
    this.stopTerminalNotifications();
    this.stopProcessNotifications();
    this.stopProfileSkillsNotifications();
    this.notificationListeners.clear();
    this.adapter.dispose();
    this.options.fileSystem?.dispose();
    this.options.history?.dispose();
    // Terminal lifetime belongs to the Host/process service, not to this
    // replaceable dashboard WebSocket bridge generation.
    this.transport.dispose();
  }
}

export class HermesAppServerBridgeService extends Service {
  private readonly bridges = new Set<BrowserHermesAppServerBridge>();

  constructor(ctx: Context) {
    super(ctx, "hermesAppServerBridge");
    ctx.effect(() => () => {
      for (const bridge of this.bridges) bridge.dispose();
      this.bridges.clear();
    });
  }

  attach(socket: HermesSocket, options?: BrowserHermesBridgeOptions): BrowserHermesAppServerBridge {
    const bridge = new BrowserHermesAppServerBridge(socket, options);
    this.bridges.add(bridge);
    return bridge;
  }

  detach(bridge: BrowserHermesAppServerBridge): void {
    bridge.dispose();
    this.bridges.delete(bridge);
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    hermesAppServerBridge: HermesAppServerBridgeService;
  }
}

export type { AppServerNotification, AppServerOutboundMessage, JsonRpcRequest, JsonRpcResponse } from "./types";
export { HermesRpcError } from "./rpc-transport";
export { HermesProjectionRecovery } from "./projection-recovery";
export { HermesDashboardFileSystem } from "./dashboard-file-system";
export type { HermesHostFileSystem } from "./dashboard-file-system";
export { HermesDashboardHistoryClient } from "./history-client";
export type { HermesHistoryClient, HermesHistoryPageRequest } from "./history-client";
export { HermesTatTerminalService } from "./tat-terminal";
export type { HermesHostTerminal } from "./tat-terminal";
export { HermesReplayCheckpoint } from "./rpc-transport";
export {
  browserHermesComposerQueueService,
  BrowserHermesComposerQueueService,
  MemoryHermesComposerQueueService,
} from "./composer-queue/service";
export type {
  HermesComposerQueueStorage,
  HermesComposerQueueService,
} from "./composer-queue/service";
export {
  browserProfileSkillsJournalStorage,
  HermesDashboardProfileSkillsHandler,
  ProfileSkillsDomainError,
} from "./profile-skills-handler";
export type { ProfileSkillsJournalStorage } from "./profile-skills-handler";
export {
  HermesDashboardWhatsAppOnboardingHandler,
  isHermesWhatsAppOnboardingMethod,
} from "./whatsapp-onboarding-handler";
export type {
  HermesWhatsAppOnboardingApplyResult,
  HermesWhatsAppOnboardingSession,
  HermesWhatsAppOnboardingStatus,
} from "./whatsapp-onboarding-handler";
