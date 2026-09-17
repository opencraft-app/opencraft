import { Context, Service, type Fiber } from "@deepseek-ai/cordis";
import {
  AppServerRpcError,
  type AppServerClientRegistryService,
} from "@opencraft/appserver-client";
import {
  isAppServerBotConversationEvent,
  OPENCRAFT_BOT_CONVERSATIONS_EXTENSION,
  type AppServerBotAttachment,
  type AppServerBotConversationDescriptor,
  type AppServerBotConversationEvent,
  type AppServerBotDescriptor,
  type AppServerBotExecution,
  type AppServerBotInteraction,
  type AppServerBotMethod,
  type AppServerBotMethodParams,
  type AppServerBotMethodResult,
  type BotConversationsCapability,
} from "@opencraft/appserver-protocol";

export type HostBotConversationEvent = AppServerBotConversationEvent & {
  readonly hostId: string;
};

export interface BotConversationServiceErrorOptions {
  readonly hostId: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export class BotConversationServiceError extends Error {
  readonly hostId: string;
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    options: BotConversationServiceErrorOptions,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BotConversationServiceError";
    this.hostId = options.hostId;
    this.retryable = options.retryable;
  }
}

function domainError(error: unknown, hostId: string): BotConversationServiceError {
  if (error instanceof BotConversationServiceError) return error;
  if (error instanceof AppServerRpcError) {
    const data = typeof error.data === "object" && error.data !== null
      ? error.data as { code?: unknown; retryable?: unknown }
      : {};
    return new BotConversationServiceError(
      typeof data.code === "string" ? data.code : "BOT_RPC_ERROR",
      error.message,
      { hostId, retryable: data.retryable === true, cause: error },
    );
  }
  return new BotConversationServiceError(
    "BOT_TRANSPORT_ERROR",
    error instanceof Error ? error.message : String(error),
    { hostId, retryable: true, cause: error },
  );
}

function capabilityFrom(value: unknown): BotConversationsCapability | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<BotConversationsCapability>;
  return candidate.version === 1 ? candidate as BotConversationsCapability : null;
}

/**
 * Host-neutral Cordis service for the `bot/*` AppServer extension.
 *
 * It owns no Bot state and no transport. AppServer owns the domain; the
 * multi-Host client registry owns physical links. This service is only the
 * typed request/event port shared by React, Electron and future native shells.
 */
export class AppServerBotConversationService extends Service {
  static inject = ["appServerClients"];

  private readonly listeners = new Set<(event: HostBotConversationEvent) => void>();
  private readonly clientSubscriptions = new Map<string, () => void>();
  private readonly stopRegistryEvents: () => void;
  private readonly clients: AppServerClientRegistryService;

  constructor(ctx: Context) {
    super(ctx, "botConversations");
    this.clients = ctx.appServerClients;
    for (const client of this.clients.getAll()) this.observeClient(client.hostId);
    this.stopRegistryEvents = this.clients.subscribeEvent((event) => {
      if (event.type === "added") this.observeClient(event.hostId);
      if (event.type === "removed") this.unobserveClient(event.hostId);
    });
    ctx.effect(() => () => this.disposeOwnedResources());
  }

  capability(hostId: string): BotConversationsCapability | null {
    const extensions = this.clients.get(hostId)?.initializeResult?.capabilities?.extensions;
    return capabilityFrom(extensions?.[OPENCRAFT_BOT_CONVERSATIONS_EXTENSION]);
  }

  supports(hostId: string): boolean {
    return this.capability(hostId) !== null;
  }

  /**
   * Host connection and View activation are separate transactions. A View may
   * be restored before the Host has completed `initialize`; callers wait on
   * the capability boundary instead of guessing with retries in React.
   */
  waitForCapability(
    hostId: string,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<BotConversationsCapability> {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const immediate = this.capability(hostId);
    if (immediate !== null) return Promise.resolve(immediate);
    if (options.signal?.aborted) {
      return Promise.reject(new BotConversationServiceError(
        "BOT_ACTIVATION_ABORTED",
        `Bot activation for Host ${hostId} was aborted`,
        { hostId, retryable: true },
      ));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let stopClientStatus: () => void = () => undefined;
      let stopRegistry: () => void = () => undefined;
      let pollTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
      const cleanup = () => {
        stopRegistry();
        stopClientStatus();
        if (pollTimer !== null) globalThis.clearTimeout(pollTimer);
        if (timeoutTimer !== null) globalThis.clearTimeout(timeoutTimer);
        options.signal?.removeEventListener("abort", abort);
      };
      const finish = (capability: BotConversationsCapability) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(capability);
      };
      const fail = (error: BotConversationServiceError) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const check = () => {
        if (settled) return;
        const capability = this.capability(hostId);
        if (capability !== null) {
          finish(capability);
          return;
        }
        if (pollTimer !== null) globalThis.clearTimeout(pollTimer);
        pollTimer = globalThis.setTimeout(check, 50);
      };
      const observeCurrentClient = () => {
        stopClientStatus();
        const client = this.clients.get(hostId);
        stopClientStatus = client === null
          ? (() => { /* no client to observe yet */ })
          : client.subscribeStatus(check);
        check();
      };
      stopRegistry = this.clients.subscribeEvent((event) => {
        if (event.hostId === hostId) observeCurrentClient();
      });
      const abort = () => fail(new BotConversationServiceError(
        "BOT_ACTIVATION_ABORTED",
        `Bot activation for Host ${hostId} was aborted`,
        { hostId, retryable: true },
      ));
      timeoutTimer = globalThis.setTimeout(() => fail(
        new BotConversationServiceError(
          "BOT_EXTENSION_UNAVAILABLE",
          `Host ${hostId} did not advertise ${OPENCRAFT_BOT_CONVERSATIONS_EXTENSION} version 1`,
          { hostId, retryable: true },
        ),
      ), timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      observeCurrentClient();
    });
  }

  subscribe(listener: (event: HostBotConversationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request<TMethod extends AppServerBotMethod>(
    hostId: string,
    method: TMethod,
    params: AppServerBotMethodParams<TMethod>,
  ): Promise<AppServerBotMethodResult<TMethod>> {
    const client = this.clients.getOrThrow(hostId);
    if (!this.supports(hostId)) {
      return Promise.reject(new BotConversationServiceError(
        "BOT_EXTENSION_UNAVAILABLE",
        `Host ${hostId} does not advertise ${OPENCRAFT_BOT_CONVERSATIONS_EXTENSION} version 1`,
        { hostId, retryable: false },
      ));
    }
    const management = method === "bot/create" || method === "bot/update" || method === "bot/delete";
    if (management && this.capability(hostId)?.features.botManagement !== true) {
      return Promise.reject(new BotConversationServiceError("BOT_CAPABILITY_UNAVAILABLE", "此实例不支持 Bot 管理。", { hostId, retryable: false }));
    }
    const configuration = method === "bot/configuration/read"
      || method === "bot/configuration/options"
      || method === "bot/configuration/update";
    if (configuration && this.capability(hostId)?.features.configuration !== true) {
      return Promise.reject(new BotConversationServiceError("BOT_CAPABILITY_UNAVAILABLE", "此实例不支持 Bot 配置。", { hostId, retryable: false }));
    }
    return client.request(method, params, management || method === "bot/configuration/update" ? { timeoutMs: 120_000 } : undefined).catch((error: unknown) => {
      throw domainError(error, hostId);
    });
  }

  listBots(hostId: string, params: AppServerBotMethodParams<"bot/list"> = {}) {
    return this.request(hostId, "bot/list", params);
  }

  async readBot(hostId: string, botId: string): Promise<AppServerBotDescriptor> {
    return (await this.request(hostId, "bot/read", { botId })).bot;
  }

  readBotConfiguration(hostId: string, botId: string) {
    return this.request(hostId, "bot/configuration/read", { botId });
  }

  readBotConfigurationOptions(hostId: string, botId: string) {
    return this.request(hostId, "bot/configuration/options", { botId });
  }

  updateBotConfiguration(
    hostId: string,
    params: AppServerBotMethodParams<"bot/configuration/update">,
  ) {
    return this.request(hostId, "bot/configuration/update", params);
  }

  createBot(hostId: string, params: AppServerBotMethodParams<"bot/create">) {
    return this.request(hostId, "bot/create", params);
  }

  async updateBot(
    hostId: string,
    params: AppServerBotMethodParams<"bot/update">,
  ): Promise<AppServerBotDescriptor> {
    return (await this.request(hostId, "bot/update", params)).bot;
  }

  async deleteBot(
    hostId: string,
    params: AppServerBotMethodParams<"bot/delete">,
  ): Promise<void> {
    await this.request(hostId, "bot/delete", params);
  }

  listConversations(
    hostId: string,
    params: AppServerBotMethodParams<"bot/conversation/list"> = {},
  ) {
    return this.request(hostId, "bot/conversation/list", params);
  }

  async createConversation(
    hostId: string,
    params: AppServerBotMethodParams<"bot/conversation/create">,
  ): Promise<{ readonly conversation: AppServerBotConversationDescriptor; readonly replayed: boolean }> {
    return this.request(hostId, "bot/conversation/create", params);
  }

  readConversation(hostId: string, params: AppServerBotMethodParams<"bot/conversation/read">) {
    return this.request(hostId, "bot/conversation/read", params);
  }

  async updateConversation(
    hostId: string,
    params: AppServerBotMethodParams<"bot/conversation/update">,
  ): Promise<AppServerBotConversationDescriptor> {
    return (await this.request(hostId, "bot/conversation/update", params)).conversation;
  }

  async archiveConversation(
    hostId: string,
    params: AppServerBotMethodParams<"bot/conversation/archive">,
  ): Promise<AppServerBotConversationDescriptor> {
    return (await this.request(hostId, "bot/conversation/archive", params)).conversation;
  }

  async unarchiveConversation(
    hostId: string,
    params: AppServerBotMethodParams<"bot/conversation/unarchive">,
  ): Promise<AppServerBotConversationDescriptor> {
    return (await this.request(hostId, "bot/conversation/unarchive", params)).conversation;
  }

  async deleteConversation(
    hostId: string,
    params: AppServerBotMethodParams<"bot/conversation/delete">,
  ): Promise<void> {
    await this.request(hostId, "bot/conversation/delete", params);
  }

  listMessages(hostId: string, params: AppServerBotMethodParams<"bot/messages/list">) {
    return this.request(hostId, "bot/messages/list", params);
  }

  sendMessage(hostId: string, params: AppServerBotMethodParams<"bot/message/send">) {
    return this.request(hostId, "bot/message/send", params);
  }

  async cancelExecution(
    hostId: string,
    params: AppServerBotMethodParams<"bot/execution/cancel">,
  ): Promise<AppServerBotExecution> {
    return (await this.request(hostId, "bot/execution/cancel", params)).execution;
  }

  async respondToInteraction(
    hostId: string,
    params: AppServerBotMethodParams<"bot/interaction/respond">,
  ): Promise<AppServerBotInteraction> {
    return (await this.request(hostId, "bot/interaction/respond", params)).interaction;
  }

  async uploadAttachment(
    hostId: string,
    params: AppServerBotMethodParams<"bot/attachment/upload">,
  ): Promise<AppServerBotAttachment> {
    return (await this.request(hostId, "bot/attachment/upload", params)).attachment;
  }

  private observeClient(hostId: string): void {
    if (this.clientSubscriptions.has(hostId)) return;
    const client = this.clients.get(hostId);
    if (client === null) return;
    this.clientSubscriptions.set(hostId, client.subscribeNotification((notification) => {
      if (!isAppServerBotConversationEvent(notification)) return;
      const event = { ...notification, hostId } as HostBotConversationEvent;
      for (const listener of this.listeners) listener(event);
    }));
  }

  private unobserveClient(hostId: string): void {
    this.clientSubscriptions.get(hostId)?.();
    this.clientSubscriptions.delete(hostId);
  }

  private disposeOwnedResources(): void {
    this.stopRegistryEvents();
    for (const stop of this.clientSubscriptions.values()) stop();
    this.clientSubscriptions.clear();
    this.listeners.clear();
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    botConversations: AppServerBotConversationService;
  }
}

export interface CordisBotConversationRuntime {
  readonly context: Context;
  readonly fiber: Fiber;
  readonly service: AppServerBotConversationService;
  dispose(): Promise<void>;
}

export async function createCordisBotConversationRuntime(
  context: Context,
): Promise<CordisBotConversationRuntime> {
  const fiber = context.plugin(AppServerBotConversationService);
  await fiber;
  return {
    context,
    fiber,
    service: context.botConversations,
    dispose: () => fiber.dispose(),
  };
}
