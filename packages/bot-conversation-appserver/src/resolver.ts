import type {
  BotConversationResolver,
  BotConversationSelection,
} from "@opencraft/bot-conversation";
import { createConversationKey, type ConversationKey } from "@opencraft/chat-core";

import { AppServerBotConversationService, BotConversationServiceError } from "./service";

/**
 * Resolves a Bot card/Host selection exactly once, before the View owns a
 * conversation. It never stores a projection; AppServer remains authority.
 */
export class AppServerBotConversationResolver implements BotConversationResolver {
  private readonly pending = new Map<string, Promise<ConversationKey>>();

  constructor(
    private readonly service: AppServerBotConversationService,
    private readonly createId: () => string = () =>
      globalThis.crypto?.randomUUID?.() ??
      `bot-resolution-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  ) {}

  async resolve(
    selection: BotConversationSelection,
    signal?: AbortSignal,
  ): Promise<ConversationKey> {
    const hostId = selection.hostId.trim();
    if (hostId.length === 0) {
      throw new BotConversationServiceError(
        "BOT_HOST_REQUIRED",
        "Choose a connected Host before opening Bot chat",
        { hostId, retryable: false },
      );
    }
    const identity = `${hostId}\u0000${selection.botId ?? ""}`;
    let pending = this.pending.get(identity);
    if (pending === undefined) {
      pending = this.resolveOwned({ ...selection, hostId }).finally(() => {
        if (this.pending.get(identity) === pending) this.pending.delete(identity);
      });
      this.pending.set(identity, pending);
    }
    if (signal === undefined) return pending;
    if (signal.aborted) throw new BotConversationServiceError(
      "BOT_ACTIVATION_ABORTED",
      `Bot activation for Host ${hostId} was aborted`,
      { hostId, retryable: true },
    );
    return new Promise<ConversationKey>((resolve, reject) => {
      const abort = () => reject(new BotConversationServiceError(
        "BOT_ACTIVATION_ABORTED",
        `Bot activation for Host ${hostId} was aborted`,
        { hostId, retryable: true },
      ));
      signal.addEventListener("abort", abort, { once: true });
      pending!.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }

  private async resolveOwned(
    selection: BotConversationSelection,
  ): Promise<ConversationKey> {
    const hostId = selection.hostId;
    await this.service.waitForCapability(hostId);
    const existing = await this.service.listConversations(hostId, {
      limit: 1,
      archived: false,
      ...(selection.botId === null ? {} : { botId: selection.botId }),
    });
    if (existing.data[0] !== undefined)
      return createConversationKey(hostId, existing.data[0].conversationId);

    const listedBots = await this.service.listBots(hostId, { limit: 100 });
    const bot = selection.botId === null
      ? listedBots.data.find((candidate) => candidate.status === "available")
      : listedBots.data.find(
          (candidate) =>
            candidate.botId === selection.botId &&
            candidate.status === "available",
        );
    if (bot === undefined) {
      throw new BotConversationServiceError(
        "BOT_UNAVAILABLE",
        selection.botId === null
          ? `Host ${hostId} has no available Bot`
          : `Bot ${selection.botId} is unavailable on Host ${hostId}`,
        { hostId, retryable: true },
      );
    }
    const created = await this.service.createConversation(hostId, {
      clientRequestId: `view:${hostId}:${bot.botId}:${this.createId()}`,
      topology: "direct",
      participantIds: [`bot:${bot.botId}`],
    });
    return createConversationKey(hostId, created.conversation.conversationId);
  }
}

export function createAppServerBotConversationResolver(
  service: AppServerBotConversationService,
): BotConversationResolver {
  return new AppServerBotConversationResolver(service);
}
