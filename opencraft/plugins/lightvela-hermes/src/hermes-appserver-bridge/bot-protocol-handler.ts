import type {
  AppServerBotAttachment,
  AppServerBotConversationDescriptor,
  AppServerBotConversationEvent,
  AppServerBotDescriptor,
  AppServerBotExecution,
  AppServerBotInputPart,
  AppServerBotMessage,
  AppServerBotMessageContentPart,
  AppServerBotParticipantSnapshot,
  AppServerBotPresenceFact,
} from "@opencraft/appserver-protocol";

import {
  HermesAppServerAdapter,
  isHermesHistoryNotMaterialized,
  isUnmaterializedHermesHistory,
} from "./adapter";
import type {
  AppServerThread,
  AppServerThreadItem,
  AppServerTurn,
  HermesProfileSummary,
} from "./types";
import { instanceBotRevision, isProfileBotsUnsupported, type HermesInstanceProfileBot } from "./instance-profile-bots";
import type { HermesBotManagementPort } from "./instance-bot-management";
import { HermesGroupConversations } from "./group-conversations";

export interface HermesBotHandlerOptions {
  /** Borrowed, physical-instance-bound control-plane catalog. */
  readonly resolveProfileBots?: () => Promise<readonly HermesInstanceProfileBot[]>;
  readonly management?: HermesBotManagementPort;
}

const BOT_ID = "lightvela.hermes";
const PROFILE_BOT_PREFIX = `${BOT_ID}.profile:`;
const CANONICAL_BOT_CHAT_TITLE = "Bot Chat";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const HUMAN: AppServerBotParticipantSnapshot = Object.freeze({
  participantId: "person:you",
  kind: "human",
  displayName: "You",
  avatar: Object.freeze({ type: "generated", seed: "opencraft-human" }),
});

const profileSlug = (value: string): string => value
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-")
  .replace(/^-+|-+$/gu, "")
  .slice(0, 64);

const botIdForProfile = (profile: string): string => (
  profile === "default" ? BOT_ID : `${PROFILE_BOT_PREFIX}${encodeURIComponent(profile)}`
);

const profileForBotId = (botId: string): string | null => {
  if (botId === BOT_ID) return "default";
  if (!botId.startsWith(PROFILE_BOT_PREFIX)) return null;
  try {
    return decodeURIComponent(botId.slice(PROFILE_BOT_PREFIX.length));
  } catch {
    return null;
  }
};

const participantForBot = (bot: AppServerBotDescriptor): AppServerBotParticipantSnapshot => Object.freeze({
  participantId: `bot:${bot.botId}`,
  kind: "bot",
  displayName: bot.name,
  avatar: bot.avatar,
});

function botDescriptor(profile: HermesProfileSummary, revisionOverride?: number): AppServerBotDescriptor {
  const profileName = profile.name.trim() || "default";
  const meta = asRecord(profile.ui_meta?.["hermes-bots"]);
  const displayName = typeof meta.title === "string" && meta.title.trim() !== ""
    ? meta.title.trim()
    : typeof profile.display_name === "string" && profile.display_name.trim() !== ""
      ? profile.display_name.trim()
      : profileName === "default"
        ? "Hermes"
        : profileName.replace(/[-_]+/gu, " ").replace(/\b\w/gu, (character) => character.toUpperCase());
  const description = typeof meta.description === "string" && meta.description.trim() !== ""
    ? meta.description.trim()
    : profile.description?.trim();
  const serverRevision = Object.values(profile.ui_meta_revisions ?? {})
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .reduce((maximum, value) => Math.max(maximum, Math.floor(value)), 1);
  return Object.freeze({
    botId: botIdForProfile(profileName),
    revision: revisionOverride ?? serverRevision,
    name: displayName,
    subtitle: description || "LightVela",
    avatar: Object.freeze({ type: "generated", seed: `lightvela-hermes:${profileName}`, palette: "aqua" }),
    status: meta.hidden === true ? "disabled" : "available",
    capabilities: Object.freeze(["messageStreaming", "executionCancellation", "attachments"]),
  });
}

const DEFAULT_BOT = botDescriptor({ name: "default" });

const secondsToMs = (value: number | null | undefined, fallback = Date.now()): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1_000)
    : fallback;

function descriptor(thread: AppServerThread, bot: AppServerBotDescriptor): AppServerBotConversationDescriptor {
  return {
    conversationId: thread.id,
    revision: Math.max(1, Math.floor(thread.updatedAt || thread.createdAt || 1)),
    topology: "direct",
    title: thread.name?.trim() || thread.preview.trim() || "New chat",
    participantIds: [HUMAN.participantId, `bot:${bot.botId}`],
    createdAtMs: secondsToMs(thread.createdAt),
    updatedAtMs: secondsToMs(thread.updatedAt || thread.recencyAt || thread.createdAt),
  };
}

function messageContent(item: AppServerThreadItem): AppServerBotMessageContentPart[] {
  if (item.type === "agentMessage") {
    return [{ type: "text", text: typeof item.text === "string" ? item.text : "" }];
  }
  if (item.type !== "userMessage") return [];
  const content = Array.isArray(item.content) ? item.content : [];
  return content.flatMap((rawPart, index): AppServerBotMessageContentPart[] => {
    const part = asRecord(rawPart);
    if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }];
    const uri = part.type === "image" && typeof part.url === "string"
      ? part.url
      : part.type === "localImage" && typeof part.path === "string"
        ? `file://${part.path}`
        : null;
    if (uri === null) return [];
    if (uri.startsWith("data:image/")) {
      const mimeType = /^data:([^;,]+)/u.exec(uri)?.[1] ?? "image/*";
      return [{
        type: "attachment",
        attachment: {
          attachmentId: `${item.id}:image:${index}`,
          name: "Image",
          mimeType,
          sizeBytes: 0,
          downloadUri: uri,
        },
      }];
    }
    return [{ type: "resource", uri, title: "Image" }];
  });
}

function turnCausalMessageId(turn: AppServerTurn): string {
  return turn.items.find((item) => item.type === "userMessage")?.id ?? `causal:${turn.id}`;
}

function executionFromTurn(
  conversationId: string,
  turn: AppServerTurn,
  bot: AppServerBotDescriptor = DEFAULT_BOT,
): AppServerBotExecution {
  const status: AppServerBotExecution["status"] = turn.status === "inProgress"
    ? "running"
    : turn.status === "interrupted"
      ? "cancelled"
      : turn.status === "failed"
        ? "failed"
        : "completed";
  return {
    executionId: turn.id,
    conversationId,
    participantId: `bot:${bot.botId}`,
    causalMessageId: turnCausalMessageId(turn),
    status,
    ...(turn.startedAt === null ? {} : { startedAtMs: secondsToMs(turn.startedAt) }),
    ...(turn.completedAt === null ? {} : { completedAtMs: secondsToMs(turn.completedAt) }),
    ...(turn.error === null || turn.error === undefined
      ? {}
      : { error: { code: "HERMES_EXECUTION_FAILED", retryable: true, details: { error: turn.error } } }),
  };
}

function messageFromItem(
  conversationId: string,
  turn: AppServerTurn,
  item: AppServerThreadItem,
  state: AppServerBotMessage["state"] = "complete",
  bot: AppServerBotDescriptor = DEFAULT_BOT,
): AppServerBotMessage | null {
  if (item.type !== "userMessage" && item.type !== "agentMessage") return null;
  const createdAtMs = secondsToMs(turn.startedAt);
  return {
    messageId: item.id,
    conversationId,
    ...(typeof item.clientId === "string" && item.clientId !== "" ? { clientMessageId: item.clientId } : {}),
    author: item.type === "userMessage" ? HUMAN : participantForBot(bot),
    createdAtMs,
    updatedAtMs: state === "complete" ? secondsToMs(turn.completedAt, createdAtMs) : Date.now(),
    state,
    content: messageContent(item),
    ...(item.type === "agentMessage"
      ? { causalMessageId: turnCausalMessageId(turn), executionId: turn.id }
      : {}),
  };
}

function messagesFromTurns(
  conversationId: string,
  turns: readonly AppServerTurn[],
  bot: AppServerBotDescriptor = DEFAULT_BOT,
) {
  return turns.flatMap((turn) => turn.items.flatMap((item) => {
    const message = messageFromItem(
      conversationId,
      turn,
      item,
      turn.status === "inProgress" && item.type === "agentMessage" ? "streaming" : "complete",
      bot,
    );
    return message === null ? [] : [message];
  }));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface IdempotentEntry<T> { readonly params: unknown; readonly result: T }
interface InFlightIdempotentEntry<T> { readonly params: unknown; readonly result: Promise<T> }
interface UploadedAttachment { readonly descriptor: AppServerBotAttachment; readonly dataUri: string }

/** Temporary browser Handler for the stable, engine-neutral AppServer Bot façade. */
export class HermesBotAppServerHandler {
  private readonly epoch = globalThis.crypto?.randomUUID?.() ?? `hermes-${Date.now().toString(36)}`;
  private readonly nextSeqByConversation = new Map<string, number>();
  private readonly deltaSeqByMessage = new Map<string, number>();
  private readonly turnsById = new Map<string, AppServerTurn>();
  private readonly conversationByTurnId = new Map<string, string>();
  private readonly activeExecutionByConversation = new Map<string, string>();
  private readonly botCreateReceipts = new Map<string, IdempotentEntry<unknown>>();
  private readonly conversationCreateReceipts = new Map<string, IdempotentEntry<unknown>>();
  private readonly sendReceipts = new Map<string, IdempotentEntry<unknown>>();
  /** Same command id has one admission transaction even while the RPC awaits. */
  private readonly inFlightSends = new Map<string, InFlightIdempotentEntry<Record<string, unknown>>>();
  private readonly cancelReceipts = new Map<string, IdempotentEntry<unknown>>();
  private readonly attachments = new Map<string, UploadedAttachment>();
  private readonly botsById = new Map<string, AppServerBotDescriptor>([[DEFAULT_BOT.botId, DEFAULT_BOT]]);
  private readonly botByConversationId = new Map<string, AppServerBotDescriptor>();
  /** Stable named-session identity for the lifetime of one Host connection. */
  private readonly canonicalConversationByProfile = new Map<string, AppServerThread>();
  /** One canonical creation transaction per Profile in this Handler. */
  private readonly canonicalConversationCreations = new Map<string, Promise<AppServerThread>>();
  private readonly profileByBotId = new Map<string, string>();
  private readonly boundProfileByBotId = new Map<string, string>();
  private catalogReady = false;
  private unsupported = false;
  private disposed = false;
  private catalogRefresh: Promise<void> | null = null;
  private managementTail: Promise<unknown> = Promise.resolve();
  private readonly groups: HermesGroupConversations;

  constructor(
    private readonly adapter: HermesAppServerAdapter,
    private readonly emit: (event: AppServerBotConversationEvent) => void,
    private readonly options: HermesBotHandlerOptions = {},
  ) {
    if (options.resolveProfileBots !== undefined) this.botsById.clear();
    this.groups = new HermesGroupConversations(adapter, {
      resolveBot: (botId) => this.resolveBot(botId),
      botForProfile: (profile) => this.botForProfile(profile),
      profileForBotId: (botId) => this.profileForBotId(botId),
      emit: (method, conversationId, payload) => this.emitConversation(
        method as AppServerBotConversationEvent["method"], conversationId, payload,
      ),
    });
  }

  private get managedCatalog(): boolean { return this.options.resolveProfileBots !== undefined; }
  get botManagement(): boolean { return !this.managedCatalog || this.options.management !== undefined; }
  get groupConversations(): boolean { return this.groups.available; }

  dispose(): void { this.disposed = true; this.groups.dispose(); }

  async prepareCapability(): Promise<boolean> {
    if (this.unsupported || this.disposed) return false;
    if (this.managedCatalog && !this.catalogReady) {
      try { await this.refreshCatalog(); }
      catch (error) {
        if (!isProfileBotsUnsupported(error)) throw error;
        this.unsupported = true;
        return false;
      }
    }
    await this.groups.prepareCapability().catch(() => false);
    return true;
  }

  private refreshCatalog(): Promise<void> {
    if (this.catalogRefresh !== null) return this.catalogRefresh;
    const refresh = (async () => {
      await this.managementTail;
      if (this.disposed) throw new Error("Hermes Bot handler is detached");
      const bindings = this.options.resolveProfileBots === undefined
        ? undefined : await this.options.resolveProfileBots();
      const profiles = await this.adapter.listProfiles();
      if (this.disposed) throw new Error("Hermes Bot handler is detached");
      if (bindings === undefined) this.replaceBots(profiles);
      else {
        const byProfile = new Map(profiles.map(profile => [profile.name, profile]));
        const bots = new Map<string, AppServerBotDescriptor>();
        const routes = new Map<string, string>();
        for (const binding of bindings) {
          const previousRoute = this.boundProfileByBotId.get(binding.botId);
          if (previousRoute !== undefined && previousRoute !== binding.nativeProfile) {
            throw new Error("Hermes Bot profile binding changed within one Host connection");
          }
          const profile = byProfile.get(binding.nativeProfile);
          if (profile === undefined) continue;
          const base = botDescriptor(profile);
          bots.set(binding.botId, Object.freeze({
            ...base, botId: binding.botId, name: binding.name,
            revision: this.options.management?.revision(binding) ?? instanceBotRevision(binding),
            subtitle: binding.description || base.subtitle,
            status: base.status === "disabled" ? "disabled" : binding.status,
            management: {
              rename: this.botManagement, clone: this.botManagement,
              delete: this.botManagement && binding.nativeProfile !== "default",
            },
          }));
          routes.set(binding.botId, binding.nativeProfile);
        }
        this.botsById.clear();
        this.profileByBotId.clear();
        for (const [id, bot] of bots) this.botsById.set(id, bot);
        for (const [id, profile] of routes) this.profileByBotId.set(id, profile);
        for (const [id, profile] of routes) this.boundProfileByBotId.set(id, profile);
      }
      this.catalogReady = true;
    })().finally(() => { if (this.catalogRefresh === refresh) this.catalogRefresh = null; });
    this.catalogRefresh = refresh;
    return refresh;
  }

  private profileForBotId(botId: string): string | null {
    return !this.managedCatalog ? profileForBotId(botId) : this.profileByBotId.get(botId) ?? null;
  }

  private rememberTurn(conversationId: string, turn: AppServerTurn, active = true): void {
    const owner = this.conversationByTurnId.get(turn.id);
    if (owner !== undefined && owner !== conversationId) throw new Error("Ambiguous Hermes execution identity");
    this.conversationByTurnId.set(turn.id, conversationId);
    this.turnsById.set(turn.id, turn);
    if (turn.status === "inProgress" && active) this.activeExecutionByConversation.set(conversationId, turn.id);
    else if (turn.status !== "inProgress" && this.activeExecutionByConversation.get(conversationId) === turn.id) {
      this.activeExecutionByConversation.delete(conversationId);
    }
  }

  private rememberConversation(conversationId: string, bot: AppServerBotDescriptor): void {
    const owner = this.botByConversationId.get(conversationId);
    if (owner !== undefined && owner.botId !== bot.botId) throw new Error("Ambiguous Hermes conversation identity");
    this.botByConversationId.set(conversationId, bot);
  }

  private async resolveConversationBot(conversationId: string): Promise<AppServerBotDescriptor> {
    const existing = this.botByConversationId.get(conversationId);
    if (existing !== undefined) {
      // Refresh may remove or disable a Bot; cached session identity is not admission authority.
      return this.resolveBot(existing.botId);
    }
    const thread = await this.adapter.loadThread(conversationId, false);
    if (this.managedCatalog && thread.name !== CANONICAL_BOT_CHAT_TITLE) this.notFound("Conversation", conversationId);
    const bot = this.botForProfile(this.adapter.profileForThread(conversationId));
    this.rememberConversation(conversationId, bot);
    return bot;
  }

  async handle(method: string, value: Record<string, unknown>): Promise<unknown> {
    if (!this.botManagement && ["bot/create", "bot/update", "bot/delete"].includes(method)) {
      this.capabilityUnavailable("Bot management belongs to the LightVela control plane");
    }
    if (!await this.prepareCapability()) this.capabilityUnavailable("Hermes profile Bots are unavailable");
    switch (method) {
      case "bot/list": return this.listBots(value);
      case "bot/read": return { bot: await this.resolveBot(this.requiredString(value.botId, "botId")) };
      case "bot/create": return this.options.management ? this.runManaged(() => this.createManagedBot(value)) : this.createBot(value);
      case "bot/update": return this.options.management ? this.runManaged(() => this.updateManagedBot(value)) : this.updateBot(value);
      case "bot/delete": return this.options.management ? this.runManaged(() => this.deleteManagedBot(value)) : this.deleteBot(value);
      case "bot/conversation/list": return this.listConversations(value);
      case "bot/conversation/create": return this.createConversation(value);
      case "bot/conversation/read": return this.readConversation(value);
      case "bot/messages/list": return this.listMessages(value);
      case "bot/message/send": return this.sendMessage(value);
      case "bot/execution/cancel": return this.cancelExecution(value);
      case "bot/attachment/upload": return this.uploadAttachment(value);
      case "bot/conversation/update":
        if (await this.groups.owns(this.requiredString(value.conversationId, "conversationId"))) {
          return this.groups.update(
            this.requiredString(value.conversationId, "conversationId"),
            this.requiredRevision(value.expectedRevision),
            asRecord(value.patch),
          );
        }
        return this.capabilityUnavailable(`${method} is not supported by Hermes direct conversations`);
      case "bot/conversation/delete":
        if (await this.groups.owns(this.requiredString(value.conversationId, "conversationId"))) {
          return this.groups.remove(this.requiredString(value.conversationId, "conversationId"));
        }
        return this.capabilityUnavailable(`${method} is not supported by Hermes direct conversations`);
      case "bot/conversation/archive":
      case "bot/conversation/unarchive":
        return this.capabilityUnavailable(`${method} is not supported by Hermes`);
      case "bot/interaction/respond": {
        const conversationId = this.requiredString(value.conversationId, "conversationId");
        if (!await this.groups.owns(conversationId)) return this.capabilityUnavailable(`${method} is not supported by Hermes direct conversations`);
        const response = asRecord(value.response);
        if (response.type !== "approval") return this.capabilityUnavailable("Hermes group rooms currently support approval responses only");
        return this.groups.respond(
          conversationId,
          this.requiredString(value.interactionId, "interactionId"),
          this.requiredString(response.choiceId, "choiceId"),
        );
      }
      default:
        throw Object.assign(new Error(`Unknown Bot method: ${method}`), { rpcCode: -32601 });
    }
  }

  private runManaged(operation: () => Promise<unknown>): Promise<unknown> {
    const priorRefresh = this.catalogRefresh;
    const result = this.managementTail.then(async () => {
      await priorRefresh;
      if (this.disposed) throw new Error("Hermes Bot handler is detached");
      return operation();
    });
    this.managementTail = result.catch(() => undefined);
    return result;
  }

  observeAppServerNotification(method: string, params: unknown): void {
    const value = asRecord(params);
    const conversationId = typeof value.threadId === "string" ? value.threadId : null;
    if (conversationId === null) return;
    const turnId = typeof value.turnId === "string" ? value.turnId : asRecord(value.turn).id;
    const turn = typeof turnId === "string" ? this.turnsById.get(turnId) : undefined;
    const bot = this.botByConversationId.get(conversationId);
    if (bot === undefined) return;
    if (method === "turn/started") {
      const started = value.turn as AppServerTurn | undefined;
      if (started === undefined) return;
      const owner = this.conversationByTurnId.get(started.id);
      if (owner !== undefined && owner !== conversationId) return;
      this.rememberTurn(conversationId, started);
      this.emitConversation("bot/execution/updated", conversationId, { execution: executionFromTurn(conversationId, started, bot) });
      this.emitPresence(conversationId, started.id, "thinking", "Thinking", bot);
      return;
    }
    if (turn === undefined) return;
    if (this.conversationByTurnId.get(turn.id) !== conversationId) return;
    const item = value.item as AppServerThreadItem | undefined;
    if (method === "item/started" && item?.type === "agentMessage") {
      const message = messageFromItem(conversationId, turn, item, "streaming", bot);
      if (message !== null) this.emitConversation("bot/message/started", conversationId, { message });
      this.emitPresence(conversationId, turn.id, "responding", "Writing", bot);
      return;
    }
    if (method === "item/agentMessage/delta") {
      const messageId = typeof value.itemId === "string" ? value.itemId : null;
      const delta = typeof value.delta === "string" ? value.delta : "";
      if (messageId === null || delta === "") return;
      const deltaSeq = this.deltaSeqByMessage.get(messageId) ?? 0;
      this.deltaSeqByMessage.set(messageId, deltaSeq + 1);
      this.emitConversation("bot/message/delta", conversationId, {
        messageId, executionId: turn.id, deltaSeq, partIndex: 0, delta,
      });
      return;
    }
    if (method === "item/started" && item?.type === "reasoning") {
      this.emitPresence(conversationId, turn.id, "thinking", "Thinking", bot);
      return;
    }
    if (method === "item/started" && (item?.type === "dynamicToolCall" || item?.type === "commandExecution")) {
      this.emitPresence(conversationId, turn.id, "working", typeof item.tool === "string" ? item.tool : "Using a tool", bot);
      return;
    }
    if (method === "item/completed" && item?.type === "agentMessage") {
      const message = messageFromItem(conversationId, turn, item, "complete", bot);
      if (message !== null) this.emitConversation("bot/message/completed", conversationId, { message });
      return;
    }
    if (method === "turn/completed") {
      const completed = (value.turn as AppServerTurn | undefined) ?? turn;
      this.rememberTurn(conversationId, completed);
      this.emitPresence(conversationId, completed.id, null, null, bot);
      this.emitConversation("bot/execution/updated", conversationId, { execution: executionFromTurn(conversationId, completed, bot) });
    }
  }

  private async listBots(value: Record<string, unknown>): Promise<unknown> {
    await this.refreshCatalog();
    const all = [...this.botsById.values()]
      .filter((bot) => bot.status !== "disabled")
      .sort((left, right) => left.name.localeCompare(right.name));
    const offset = typeof value.cursor === "string" && value.cursor.startsWith("hermes-bots:")
      ? Number(value.cursor.slice("hermes-bots:".length)) || 0
      : 0;
    const limit = typeof value.limit === "number"
      ? Math.min(Math.max(Math.floor(value.limit), 1), 200)
      : 100;
    return {
      data: all.slice(offset, offset + limit),
      ...(offset + limit < all.length ? { nextCursor: `hermes-bots:${offset + limit}` } : {}),
    };
  }

  private async createBot(value: Record<string, unknown>): Promise<unknown> {
    const requestId = this.requiredString(value.clientRequestId, "clientRequestId");
    const prior = this.botCreateReceipts.get(requestId);
    if (prior !== undefined) {
      if (!sameJson(prior.params, value)) this.idempotencyConflict(requestId);
      return { ...(prior.result as object), replayed: true };
    }
    const name = this.requiredString(value.name, "name").trim();
    const profile = profileSlug(name);
    if (profile === "" || profile === "default") {
      throw Object.assign(new Error("Bot name must produce a non-default Hermes profile name"), { rpcCode: -32602 });
    }
    const templateId = typeof value.templateId === "string" ? value.templateId : null;
    const cloneFrom = templateId === null ? "default" : profileForBotId(templateId);
    if (cloneFrom === null) this.notFound("Bot", templateId!);
    await this.adapter.createProfile({
      name: profile,
      description: name,
      clone_from: cloneFrom,
      no_skills: false,
      share_auth: true,
    });
    await this.adapter.configureProfile({
      name: profile,
      ui_meta: { "hermes-bots": { title: name, created: Date.now(), hidden: false } },
    }).catch(() => undefined);
    const bot = botDescriptor({
      name: profile,
      display_name: name,
      description: name,
      ui_meta: { "hermes-bots": { title: name, hidden: false } },
    });
    this.botsById.set(bot.botId, bot);
    const result = { bot, replayed: false };
    this.botCreateReceipts.set(requestId, { params: structuredClone(value), result });
    this.emit({ method: "bot/updated", params: { bot } });
    return result;
  }

  private publishManagedBot(binding: HermesInstanceProfileBot): AppServerBotDescriptor {
    if (this.disposed) throw new Error("Hermes Bot handler is detached");
    const previous = this.boundProfileByBotId.get(binding.botId);
    if (previous !== undefined && previous !== binding.nativeProfile) throw new Error("Hermes Bot profile binding changed");
    const bot: AppServerBotDescriptor = {
      ...botDescriptor({ name: binding.nativeProfile }), botId: binding.botId,
      revision: this.options.management!.revision(binding), name: binding.name, subtitle: binding.description || "LightVela",
      status: binding.status, management: { rename: true, clone: true, delete: binding.nativeProfile !== "default" },
    };
    this.botsById.set(bot.botId, bot);
    this.profileByBotId.set(bot.botId, binding.nativeProfile);
    this.boundProfileByBotId.set(bot.botId, binding.nativeProfile);
    for (const [id, owner] of this.botByConversationId) if (owner.botId === bot.botId) this.botByConversationId.set(id, bot);
    this.emit({ method: "bot/updated", params: { bot } });
    return bot;
  }

  private async createManagedBot(value: Record<string, unknown>): Promise<unknown> {
    const requestId = this.requiredString(value.clientRequestId, "clientRequestId");
    const prior = this.botCreateReceipts.get(requestId);
    if (prior !== undefined) {
      if (!sameJson(prior.params, value)) this.idempotencyConflict(requestId);
      return { ...(prior.result as object), replayed: true };
    }
    const binding = await this.options.management!.create({
      clientRequestId: requestId, name: this.requiredString(value.name, "name"),
      ...(value.templateId === undefined ? {} : { templateId: this.requiredString(value.templateId, "templateId") }),
    });
    const result = { bot: this.publishManagedBot(binding), replayed: false };
    this.botCreateReceipts.set(requestId, { params: structuredClone(value), result });
    return result;
  }

  private async updateManagedBot(value: Record<string, unknown>): Promise<unknown> {
    const botId = this.requiredString(value.botId, "botId");
    const patch = asRecord(value.patch);
    if (Object.keys(patch).some(key => key !== "name" && key !== "subtitle")) this.capabilityUnavailable("此 Bot 仅支持修改名称和说明。");
    if (Object.keys(patch).length === 0) throw Object.assign(new Error("Empty Bot patch"), { rpcCode: -32602 });
    const binding = await this.options.management!.update(botId, this.requiredRevision(value.expectedRevision), {
      ...(patch.name === undefined ? {} : { name: this.requiredString(patch.name, "name") }),
      ...(typeof patch.subtitle === "string" ? { subtitle: patch.subtitle } : {}),
    });
    return { bot: this.publishManagedBot(binding) };
  }

  private async deleteManagedBot(value: Record<string, unknown>): Promise<unknown> {
    const botId = this.requiredString(value.botId, "botId");
    const revision = this.requiredRevision(value.expectedRevision);
    for (const [id, bot] of this.botByConversationId) {
      if (bot.botId === botId && this.activeExecutionByConversation.has(id)) this.capabilityUnavailable("请先停止 Bot 当前执行，再删除。");
    }
    await this.options.management!.delete(botId, revision);
    if (this.disposed) throw new Error("Hermes Bot handler is detached");
    this.botsById.delete(botId);
    const profile = this.profileByBotId.get(botId);
    this.profileByBotId.delete(botId);
    if (profile) this.canonicalConversationByProfile.delete(profile);
    for (const [id, bot] of this.botByConversationId) if (bot.botId === botId) {
      this.emitConversation("bot/conversation/deleted", id, { conversationId: id, revision: revision + 1 });
      this.botByConversationId.delete(id);
    }
    this.emit({ method: "bot/deleted", params: { botId, revision: revision + 1 } });
    return { botId, revision: revision + 1 };
  }

  private async updateBot(value: Record<string, unknown>): Promise<unknown> {
    const botId = this.requiredString(value.botId, "botId");
    const current = await this.resolveBot(botId);
    const expectedRevision = this.requiredRevision(value.expectedRevision);
    if (current.revision !== expectedRevision) this.revisionConflict(botId, expectedRevision, current.revision);
    const patch = asRecord(value.patch);
    const title = typeof patch.name === "string" && patch.name.trim() !== "" ? patch.name.trim() : current.name;
    const subtitle = typeof patch.subtitle === "string" ? patch.subtitle.trim() : current.subtitle;
    const status = patch.status === "disabled" || patch.status === "available" ? patch.status : current.status;
    const profile = profileForBotId(botId);
    if (profile === null) this.notFound("Bot", botId);
    await this.adapter.configureProfile({
      name: profile,
      ...(subtitle === undefined ? {} : { description: subtitle }),
      ui_meta: {
        "hermes-bots": {
          title,
          ...(subtitle === undefined ? {} : { description: subtitle }),
          hidden: status === "disabled",
        },
      },
    });
    const bot: AppServerBotDescriptor = Object.freeze({
      ...current,
      revision: current.revision + 1,
      name: title,
      ...(subtitle === undefined ? {} : { subtitle }),
      status,
    });
    this.botsById.set(bot.botId, bot);
    this.emit({ method: "bot/updated", params: { bot } });
    return { bot };
  }

  private async deleteBot(value: Record<string, unknown>): Promise<unknown> {
    const botId = this.requiredString(value.botId, "botId");
    if (botId === BOT_ID) this.capabilityUnavailable("The default Hermes Bot cannot be deleted");
    const current = await this.resolveBot(botId);
    const expectedRevision = this.requiredRevision(value.expectedRevision);
    if (current.revision !== expectedRevision) this.revisionConflict(botId, expectedRevision, current.revision);
    const profile = profileForBotId(botId);
    if (profile === null) this.notFound("Bot", botId);
    await this.adapter.deleteProfile(profile);
    const revision = current.revision + 1;
    this.botsById.delete(botId);
    this.emit({ method: "bot/deleted", params: { botId, revision } });
    return { botId, revision };
  }

  private replaceBots(profiles: readonly HermesProfileSummary[]): void {
    const next = new Map<string, AppServerBotDescriptor>();
    const withDefault = profiles.some((profile) => profile.name === "default")
      ? profiles
      : [{ name: "default" }, ...profiles];
    for (const profile of withDefault) {
      const previous = this.botsById.get(botIdForProfile(profile.name));
      const bot = botDescriptor(profile, previous === undefined ? undefined : Math.max(previous.revision, botDescriptor(profile).revision));
      next.set(bot.botId, bot);
    }
    this.botsById.clear();
    for (const [botId, bot] of next) this.botsById.set(botId, bot);
  }

  private async resolveBot(botId: string): Promise<AppServerBotDescriptor> {
    const cached = this.botsById.get(botId);
    if (cached !== undefined) return cached;
    await this.refreshCatalog();
    const bot = this.botsById.get(botId);
    if (bot === undefined) this.notFound("Bot", botId);
    return bot;
  }

  private botForProfile(profile: string): AppServerBotDescriptor {
    if (this.managedCatalog) {
      const entry = [...this.profileByBotId].find(([, nativeProfile]) => nativeProfile === profile);
      if (entry === undefined) this.notFound("Bot profile", profile);
      return this.botsById.get(entry![0])!;
    }
    const botId = botIdForProfile(profile);
    const existing = this.botsById.get(botId);
    if (existing !== undefined) return existing;
    const bot = botDescriptor({ name: profile });
    this.botsById.set(botId, bot);
    return bot;
  }

  private async listConversations(value: Record<string, unknown>): Promise<unknown> {
    const requestedBot = typeof value.botId === "string" ? await this.resolveBot(value.botId)
      : !this.managedCatalog ? DEFAULT_BOT : this.botForProfile("default");
    const profile = this.profileForBotId(requestedBot.botId);
    if (profile === null) this.notFound("Bot", requestedBot.botId);
    const page = await this.adapter.listThreads({
      cursor: typeof value.cursor === "string" ? value.cursor : null,
      limit: typeof value.limit === "number" ? value.limit : null,
      archived: value.archived === true,
      sortDirection: "desc",
      profile,
      includeHidden: true,
      exactTitle: CANONICAL_BOT_CHAT_TITLE,
    });
    for (const thread of page.data) {
      if (this.managedCatalog && this.adapter.profileForThread(thread.id) !== profile) {
        throw new Error("Hermes conversation does not belong to the requested Bot profile");
      }
      this.rememberConversation(thread.id, requestedBot);
      this.canonicalConversationByProfile.set(profile, thread);
    }
    const groups = await this.groups.list(typeof value.botId === "string" ? requestedBot.botId : undefined);
    return {
      data: [...page.data.map((thread) => descriptor(thread, requestedBot)), ...groups],
      ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
    };
  }

  private async createConversation(value: Record<string, unknown>): Promise<unknown> {
    const requestId = this.requiredString(value.clientRequestId, "clientRequestId");
    const prior = this.conversationCreateReceipts.get(requestId);
    if (prior !== undefined) {
      if (!sameJson(prior.params, value)) this.idempotencyConflict(requestId);
      return { ...(prior.result as object), replayed: true };
    }
    if (value.topology === "group") {
      if (!this.groups.available) this.capabilityUnavailable("Hermes hosted group rooms are unavailable");
      const result = await this.groups.create(value);
      this.conversationCreateReceipts.set(requestId, { params: structuredClone(value), result });
      return result;
    }
    if (value.topology !== "direct") this.capabilityUnavailable("Unsupported Hermes Bot conversation topology");
    const participantIds = Array.isArray(value.participantIds) ? value.participantIds.map(String) : [];
    if (participantIds.length !== 1 || !participantIds[0]!.startsWith("bot:")) {
      throw Object.assign(new Error("A direct Hermes conversation requires exactly one Bot participant"), { rpcCode: -32602 });
    }
    const bot = await this.resolveBot(participantIds[0]!.slice("bot:".length));
    if (bot.status !== "available") this.capabilityUnavailable(`Bot ${bot.name} is not available`);
    const profile = this.profileForBotId(bot.botId);
    if (profile === null) this.notFound("Bot", bot.botId);
    const thread = await this.resolveCanonicalConversation(profile);
    this.rememberConversation(thread.id, bot);
    const result = { conversation: descriptor(thread, bot), replayed: false };
    this.conversationCreateReceipts.set(requestId, { params: structuredClone(value), result });
    return result;
  }

  private resolveCanonicalConversation(profile: string): Promise<AppServerThread> {
    const settled = this.canonicalConversationByProfile.get(profile);
    if (settled !== undefined) return Promise.resolve(settled);
    const active = this.canonicalConversationCreations.get(profile);
    if (active !== undefined) return active;
    const creation = this.resolveOrCreateCanonicalConversation(profile)
      .then((thread) => {
        this.canonicalConversationByProfile.set(profile, thread);
        return thread;
      })
      .finally(() => {
        if (this.canonicalConversationCreations.get(profile) === creation) {
          this.canonicalConversationCreations.delete(profile);
        }
      });
    this.canonicalConversationCreations.set(profile, creation);
    return creation;
  }

  private async resolveOrCreateCanonicalConversation(profile: string): Promise<AppServerThread> {
    const existing = await this.adapter.resolveNamedThread(profile, CANONICAL_BOT_CHAT_TITLE);
    if (existing !== null) return existing;

    try {
      const candidate = await this.adapter.startThread(null, undefined, profile, {
        title: CANONICAL_BOT_CHAT_TITLE,
        hidden: true,
        followProfileConfig: true,
      });
      await this.adapter.materializeThread(candidate.id, CANONICAL_BOT_CHAT_TITLE, true);
      return candidate;
    } catch (error) {
      // A peer may commit the named-session transaction while this client is
      // creating or materializing it. Re-read the server-owned title index;
      // only a successfully resumed canonical session can satisfy the intent.
      const winner = await this.adapter.resolveNamedThread(profile, CANONICAL_BOT_CHAT_TITLE)
        .catch(() => null);
      if (winner !== null) return winner;
      throw error;
    }
  }

  private async readConversation(value: Record<string, unknown>): Promise<unknown> {
    const conversationId = this.requiredString(value.conversationId, "conversationId");
    if (await this.groups.owns(conversationId)) {
      const initial = asRecord(value.initialMessagesPage);
      return this.groups.read(
        conversationId,
        typeof initial.limit === "number" ? Math.min(Math.max(Math.floor(initial.limit), 1), 100) : 50,
      );
    }
    const cursorAtStart = this.nextSeqByConversation.get(conversationId) ?? 0;
    const initial = asRecord(value.initialMessagesPage);
    const limit = typeof initial.limit === "number" ? Math.min(Math.max(Math.floor(initial.limit), 1), 100) : 50;
    const history = this.adapter.readTurnsPage(conversationId, 0, limit, "desc")
      .then((page) => ({ page, error: null as unknown }))
      .catch((error: unknown) => ({ page: null, error }));
    const [thread, historyResult] = await Promise.all([
      this.adapter.loadThread(conversationId, false),
      history,
    ]);
    const profile = this.adapter.profileForThread(conversationId);
    let canonicalBotConversation = !this.managedCatalog && thread.name === CANONICAL_BOT_CHAT_TITLE;
    if (this.managedCatalog) {
      const canonical = this.canonicalConversationByProfile.get(profile)
        ?? await this.adapter.resolveNamedThread(profile, CANONICAL_BOT_CHAT_TITLE);
      if (canonical === null || canonical.id !== conversationId) {
        this.notFound("Conversation", conversationId);
      }
      this.canonicalConversationByProfile.set(profile, canonical);
      canonicalBotConversation = true;
    }
    const page = historyResult.page ?? (() => {
      // A lazy canonical session exists in the WebSocket title registry before
      // Hermes creates a REST history row. Resume owns existence; REST owns
      // only materialized messages, so its 404 is an empty snapshot iff the
      // authoritative Resume reports zero messages.
      if (
        isUnmaterializedHermesHistory(thread, historyResult.error)
        // A canonical Bot Chat has already been authoritatively resumed by
        // loadThread. Dashboard owns only its materialized transcript and may
        // legitimately have no row yet. Hermes message_count is Gateway state,
        // not a durable-history row count, so it cannot gate this fallback.
        || (canonicalBotConversation
          && isHermesHistoryNotMaterialized(historyResult.error))
      ) {
        return { data: [], chronological: [], nextOffset: null };
      }
      throw historyResult.error;
    })();
    const bot = this.botForProfile(profile);
    this.rememberConversation(conversationId, bot);
    for (const turn of page.chronological) this.rememberTurn(conversationId, turn);
    await this.adapter.activateProjection(conversationId, page.chronological);
    // Cold activation can append a server-running Turn; warm activation can
    // replace history with the retained owner. Cancellation must consume that
    // authoritative post-activation ledger, not the pre-activation REST tail.
    for (const turn of page.chronological) this.rememberTurn(conversationId, turn);
    const activeTurns = page.chronological.filter((turn) => turn.status === "inProgress");
    return {
      conversation: descriptor(thread, bot),
      participants: [HUMAN, participantForBot(bot)],
      initialMessagesPage: {
        data: messagesFromTurns(conversationId, page.chronological, bot),
        ...(page.nextOffset === null ? {} : { nextCursor: `hermes-messages:${page.nextOffset}` }),
      },
      executions: activeTurns.map((turn) => executionFromTurn(conversationId, turn, bot)),
      interactions: [],
      presence: activeTurns.map((turn) => this.presence(conversationId, turn.id, "thinking", "Thinking", bot)),
      liveCursor: { epoch: this.epoch, nextSeq: cursorAtStart },
    };
  }

  private async listMessages(value: Record<string, unknown>): Promise<unknown> {
    const conversationId = this.requiredString(value.conversationId, "conversationId");
    if (await this.groups.owns(conversationId)) {
      return this.groups.messages(
        conversationId,
        typeof value.cursor === "string" ? value.cursor : undefined,
        typeof value.limit === "number" ? value.limit : 50,
      );
    }
    const bot = await this.resolveConversationBot(conversationId);
    const cursor = typeof value.cursor === "string" ? value.cursor : "hermes-messages:0";
    const match = /^hermes-messages:(\d+)$/u.exec(cursor);
    if (match === null) throw Object.assign(new Error("Invalid Hermes Bot message cursor"), { rpcCode: -32602 });
    const page = await this.adapter.readTurnsPage(
      conversationId,
      Number(match[1]),
      typeof value.limit === "number" ? value.limit : 50,
      value.direction === "forwards" ? "asc" : "desc",
    );
    for (const turn of page.chronological) this.rememberTurn(conversationId, turn);
    return {
      data: messagesFromTurns(conversationId, page.chronological, bot),
      ...(page.nextOffset === null ? {} : { nextCursor: `hermes-messages:${page.nextOffset}` }),
    };
  }

  private async sendMessage(value: Record<string, unknown>): Promise<unknown> {
    const conversationId = this.requiredString(value.conversationId, "conversationId");
    const clientMessageId = this.requiredString(value.clientMessageId, "clientMessageId");
    const receiptKey = `${conversationId}\u0000${clientMessageId}`;
    const prior = this.sendReceipts.get(receiptKey);
    if (prior !== undefined) {
      if (!sameJson(prior.params, value)) this.idempotencyConflict(clientMessageId);
      return { ...(prior.result as object), replayed: true };
    }
    const inFlight = this.inFlightSends.get(receiptKey);
    if (inFlight !== undefined) {
      if (!sameJson(inFlight.params, value)) this.idempotencyConflict(clientMessageId);
      return { ...await inFlight.result, replayed: true };
    }
    const params = structuredClone(value);
    const result = this.performSendMessage(value, conversationId, clientMessageId, receiptKey);
    this.inFlightSends.set(receiptKey, { params, result });
    try {
      return await result;
    } finally {
      if (this.inFlightSends.get(receiptKey)?.result === result) this.inFlightSends.delete(receiptKey);
    }
  }

  private async performSendMessage(
    value: Record<string, unknown>,
    conversationId: string,
    clientMessageId: string,
    receiptKey: string,
  ): Promise<Record<string, unknown>> {
    if (!Array.isArray(value.content)) throw Object.assign(new Error("content must be an array"), { rpcCode: -32602 });
    if (await this.groups.owns(conversationId)) {
      const result = await this.groups.send(
        conversationId,
        clientMessageId,
        value.content,
        typeof value.replyToMessageId === "string" ? value.replyToMessageId : undefined,
      );
      this.sendReceipts.set(receiptKey, { params: structuredClone(value), result });
      return result;
    }
    const input = value.content.flatMap((rawPart): Record<string, unknown>[] => {
      const part = asRecord(rawPart) as AppServerBotInputPart;
      if (part.type === "text") return [{ type: "text", text: part.text }];
      if (part.type === "mention") return [{ type: "text", text: `@${part.label}` }];
      if (part.type === "resource") return [{ type: "text", text: `[${part.title}](${part.uri})` }];
      if (part.type === "attachment") {
        const upload = this.attachments.get(part.attachmentId);
        if (upload === undefined) this.notFound("Attachment", part.attachmentId);
        return upload!.descriptor.mimeType.startsWith("image/")
          ? [{ type: "image", url: upload!.dataUri }]
          : [{ type: "text", text: `[Attachment: ${upload!.descriptor.name}]` }];
      }
      return [];
    });
    const bot = await this.resolveConversationBot(conversationId);
    if (bot.status !== "available") this.capabilityUnavailable(`Bot ${bot.name} is not available`);
    const submission = await this.adapter.submitBotTurn(
      conversationId,
      input,
      clientMessageId,
      undefined,
      this.profileForBotId(bot.botId),
    );
    const turn = submission.turn;
    this.rememberTurn(conversationId, turn, submission.disposition !== "queued");
    const userItem = turn.items.find((item) => item.type === "userMessage");
    if (userItem === undefined) throw new Error("Hermes accepted a Turn without a user message");
    const message = messageFromItem(conversationId, turn, userItem, "complete", bot)!;
    const execution = executionFromTurn(conversationId, turn, bot);
    const result = {
      message,
      executions: [{ ...execution, status: submission.disposition === "queued" ? "queued" : execution.status }],
      replayed: false,
    };
    this.sendReceipts.set(receiptKey, { params: structuredClone(value), result });
    return result;
  }

  private async cancelExecution(value: Record<string, unknown>): Promise<unknown> {
    const conversationId = this.requiredString(value.conversationId, "conversationId");
    const executionId = this.requiredString(value.executionId, "executionId");
    const commandId = this.requiredString(value.commandId, "commandId");
    const key = `${conversationId}\u0000${commandId}`;
    const prior = this.cancelReceipts.get(key);
    if (prior !== undefined) {
      if (!sameJson(prior.params, value)) this.idempotencyConflict(commandId);
      return { ...(prior.result as object), replayed: true };
    }
    if (await this.groups.owns(conversationId)) {
      const result = await this.groups.cancel(conversationId, executionId, commandId);
      this.cancelReceipts.set(key, { params: structuredClone(value), result });
      return result;
    }
    const turn = this.turnsById.get(executionId);
    if (turn === undefined || this.conversationByTurnId.get(executionId) !== conversationId) this.notFound("Execution", executionId);
    if (turn!.status !== "inProgress") this.capabilityUnavailable("Execution is no longer running");
    if (this.activeExecutionByConversation.get(conversationId) !== executionId) {
      this.capabilityUnavailable("Execution does not own the active Hermes turn");
    }
    await this.adapter.cancelTurn(conversationId);
    this.activeExecutionByConversation.delete(conversationId);
    const bot = this.botByConversationId.get(conversationId)!;
    const execution: AppServerBotExecution = {
      ...executionFromTurn(conversationId, turn!, bot),
      status: "cancelled",
      completedAtMs: Date.now(),
    };
    const result = { execution, replayed: false };
    this.cancelReceipts.set(key, { params: structuredClone(value), result });
    return result;
  }

  private uploadAttachment(value: Record<string, unknown>): unknown {
    const clientAttachmentId = this.requiredString(value.clientAttachmentId, "clientAttachmentId");
    const prior = this.attachments.get(clientAttachmentId);
    if (prior !== undefined) return { attachment: prior.descriptor, replayed: true };
    const bytesBase64 = this.requiredString(value.bytesBase64, "bytesBase64");
    const mimeType = this.requiredString(value.mimeType, "mimeType");
    const attachment: AppServerBotAttachment = {
      attachmentId: clientAttachmentId,
      name: this.requiredString(value.name, "name"),
      mimeType,
      sizeBytes: typeof value.sizeBytes === "number" ? value.sizeBytes : 0,
    };
    this.attachments.set(clientAttachmentId, { descriptor: attachment, dataUri: `data:${mimeType};base64,${bytesBase64}` });
    return { attachment, replayed: false };
  }

  private emitPresence(
    conversationId: string,
    executionId: string,
    phase: AppServerBotPresenceFact["phase"] | null,
    activity: string | null,
    bot: AppServerBotDescriptor,
  ): void {
    this.emitConversation("bot/presence/updated", conversationId, {
      participantId: `bot:${bot.botId}`,
      executionId,
      presence: phase === null ? null : this.presence(conversationId, executionId, phase, activity, bot),
    });
  }

  private presence(
    conversationId: string,
    executionId: string,
    phase: AppServerBotPresenceFact["phase"],
    activity: string | null,
    bot: AppServerBotDescriptor,
  ): AppServerBotPresenceFact {
    const observedAtMs = Date.now();
    return {
      conversationId, participantId: `bot:${bot.botId}`, executionId, phase,
      ...(activity === null ? {} : { activity }), observedAtMs, expiresAtMs: observedAtMs + 30_000,
    };
  }

  private emitConversation(method: AppServerBotConversationEvent["method"], conversationId: string, payload: Record<string, unknown>): void {
    const seq = this.nextSeqByConversation.get(conversationId) ?? 0;
    this.nextSeqByConversation.set(conversationId, seq + 1);
    this.emit({ method, params: { stamp: { epoch: this.epoch, seq }, conversationId, ...payload } } as AppServerBotConversationEvent);
  }

  private requiredString(value: unknown, name: string): string {
    if (typeof value !== "string" || value === "") throw Object.assign(new Error(`${name} must be a non-empty string`), { rpcCode: -32602 });
    return value;
  }

  private requiredRevision(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw Object.assign(new Error("expectedRevision must be a positive integer"), { rpcCode: -32602 });
    }
    return value;
  }

  private notFound(kind: string, id: string): never {
    throw Object.assign(new Error(`${kind} not found: ${id}`), {
      rpcCode: -32044, domainData: { code: `BOT_${kind.toUpperCase()}_NOT_FOUND`, retryable: false },
    });
  }

  private idempotencyConflict(id: string): never {
    throw Object.assign(new Error(`Idempotency key was reused with different content: ${id}`), {
      rpcCode: -32049, domainData: { code: "BOT_IDEMPOTENCY_CONFLICT", retryable: false },
    });
  }

  private revisionConflict(botId: string, expected: number, actual: number): never {
    throw Object.assign(new Error(`Bot revision conflict for ${botId}: expected ${expected}, got ${actual}`), {
      rpcCode: -32049,
      domainData: { code: "BOT_REVISION_CONFLICT", retryable: true, details: { botId, expected, actual } },
    });
  }

  private capabilityUnavailable(message: string): never {
    throw Object.assign(new Error(message), {
      rpcCode: -32049, domainData: { code: "BOT_CAPABILITY_UNAVAILABLE", retryable: false },
    });
  }
}
