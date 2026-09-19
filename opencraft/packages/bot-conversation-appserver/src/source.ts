import {
  botMessageStableKey,
  BotConversationSourceError,
  type BotConversationDescriptor,
  type BotConversationListener,
  type BotConversationMessage,
  type BotConversationSnapshot,
  type BotConversationSource,
  type BotExecutionSnapshot,
  type BotInteractionResponse,
  type BotInteractionSnapshot,
  type BotMessageContentPart,
  type BotParticipantSnapshot,
  type BotPresenceFact,
  type BotSendReceipt,
} from "@opencraft/bot-conversation";
import { encodeConversationKey, type ConversationKey } from "@opencraft/chat-core";
import { composerDocumentToPlainText, type SubmitIntent } from "@opencraft/composer-core";
import type {
  AppServerBotConversationDescriptor,
  AppServerBotConversationEvent,
  AppServerBotExecution,
  AppServerBotInteraction,
  AppServerBotMessage,
  AppServerBotParticipantSnapshot,
  AppServerBotPresenceFact,
} from "@opencraft/appserver-protocol";

import {
  AppServerBotConversationService,
  BotConversationServiceError,
  type HostBotConversationEvent,
} from "./service";

export interface AppServerBotConversationSourceOptions {
  readonly initialPageSize?: number;
  readonly olderPageSize?: number;
  readonly createId?: () => string;
}

interface MutableConversationState {
  readonly logicalKey: ConversationKey;
  remoteConversationId: string | null;
  snapshot: BotConversationSnapshot;
  nextCursor: string | null;
  liveEpoch: string | null;
  nextSeq: number;
  hydrating: boolean;
  loadPromise: Promise<void> | null;
  resyncRequested: boolean;
  bufferedEvents: HostBotConversationEvent[];
  readonly listeners: Set<BotConversationListener>;
  readonly deltaSeqByMessage: Map<string, number>;
}

const FALLBACK_HUMAN: BotParticipantSnapshot = Object.freeze({
  participantId: "person:you",
  kind: "human",
  displayName: "You",
  avatar: Object.freeze({ kind: "monogram", text: "Y", background: "#4f64e8", foreground: "#fff" }),
});

const FALLBACK_BOT: BotParticipantSnapshot = Object.freeze({
  participantId: "bot:unknown",
  kind: "bot",
  displayName: "Bot",
  avatar: Object.freeze({ kind: "monogram", text: "B", background: "#1ebfb3", foreground: "#fff" }),
});

let fallbackId = 0;
const defaultCreateId = (): string => globalThis.crypto?.randomUUID?.()
  ?? `bot-client-${Date.now().toString(36)}-${(++fallbackId).toString(36)}`;

function participant(value: AppServerBotParticipantSnapshot): BotParticipantSnapshot {
  const avatar = value.avatar;
  return Object.freeze({
    participantId: value.participantId,
    kind: value.kind,
    displayName: value.displayName,
    avatar: avatar?.type === "resource"
      ? Object.freeze({ kind: "image-url" as const, url: avatar.uri, alt: value.displayName })
      : Object.freeze({
          kind: "monogram" as const,
          text: value.displayName.trim().slice(0, 1).toUpperCase() || (value.kind === "bot" ? "B" : "Y"),
          background: value.kind === "bot" ? "#1ebfb3" : "#4f64e8",
          foreground: "#ffffff",
        }),
  });
}

function messageContent(value: AppServerBotMessage): readonly BotMessageContentPart[] {
  return Object.freeze(value.content.map((part): BotMessageContentPart => {
    if (part.type === "text") return Object.freeze({ type: "text", text: part.text });
    if (part.type === "resource") return Object.freeze({ type: "resource", uri: part.uri, title: part.title });
    const uri = part.attachment.downloadUri;
    return part.attachment.mimeType.startsWith("image/") && uri !== undefined
      ? Object.freeze({ type: "image", uri, alt: part.attachment.name })
      : Object.freeze({ type: "resource", uri: uri ?? `attachment:${part.attachment.attachmentId}`, title: part.attachment.name });
  }));
}

function message(value: AppServerBotMessage, key: ConversationKey): BotConversationMessage {
  return Object.freeze({
    id: value.messageId,
    clientMessageId: value.clientMessageId ?? null,
    executionId: value.executionId ?? null,
    causalMessageKey: value.causalMessageId ?? null,
    conversationKey: key,
    author: participant(value.author),
    content: messageContent(value),
    sentAtMs: value.createdAtMs,
    delivery: value.state === "failed" ? "failed" : "sent",
    streaming: value.state === "streaming",
  });
}

function execution(value: AppServerBotExecution, key: ConversationKey): BotExecutionSnapshot {
  return Object.freeze({
    executionId: value.executionId,
    conversationKey: key,
    participantId: value.participantId,
    causalMessageKey: value.causalMessageId,
    status: value.status,
    startedAtMs: value.startedAtMs ?? Date.now(),
    completedAtMs: value.completedAtMs ?? null,
    ...(value.error === undefined ? {} : {
      error: Object.freeze({ code: value.error.code, retryable: value.error.retryable }),
    }),
  });
}

function presence(value: AppServerBotPresenceFact, key: ConversationKey, seq: number): BotPresenceFact {
  const verb = value.phase === "thinking"
    ? "thinking"
    : value.phase === "responding"
      ? "messaging"
      : value.phase === "queued"
        ? "waiting"
        : "running";
  return Object.freeze({
    conversationKey: key,
    participantId: value.participantId,
    executionId: value.executionId,
    seq,
    phase: value.phase === "responding"
      ? "typing"
      : value.phase === "queued"
        ? "waiting"
        : value.phase,
    activity: Object.freeze({ verb, detail: value.activity ?? null, targetParticipantId: null }),
    observedAtMs: value.observedAtMs,
    expiresAtMs: value.expiresAtMs,
  });
}

function interaction(value: AppServerBotInteraction): BotInteractionSnapshot {
  if (value.kind === "approval") {
    return Object.freeze({
      interactionId: value.interactionId,
      executionId: value.executionId,
      participantId: value.participantId,
      kind: "approval" as const,
      status: value.status,
      title: value.title,
      description: value.description ?? null,
      choices: Object.freeze(value.choices.map((choice) => Object.freeze({
        choiceId: choice.choiceId,
        label: choice.label,
        destructive: choice.destructive === true,
      }))),
    });
  }
  return Object.freeze({
    interactionId: value.interactionId,
    executionId: value.executionId,
    participantId: value.participantId,
    kind: "clarification" as const,
    status: value.status,
    title: value.title,
    questions: Object.freeze(value.questions.map((question) => Object.freeze({
      questionId: question.questionId,
      prompt: question.prompt,
      multiple: question.multiple === true,
      choices: Object.freeze((question.choices ?? []).map((choice) =>
        Object.freeze({ ...choice })
      )),
    }))),
  });
}

function descriptor(
  value: AppServerBotConversationDescriptor,
  key: ConversationKey,
  participants: readonly BotParticipantSnapshot[],
): BotConversationDescriptor {
  return Object.freeze({
    key,
    experience: "bot",
    topology: value.topology,
    title: value.title || null,
    rosterRevision: value.revision,
    participants: Object.freeze([...participants]),
    ...(value.readOnly === true ? { readOnly: true } : {}),
  });
}

function emptySnapshot(key: ConversationKey): BotConversationSnapshot {
  return Object.freeze({
    revision: 0,
    phase: "idle",
    descriptor: Object.freeze({
      key,
      experience: "bot",
      topology: "direct",
      title: null,
      rosterRevision: 0,
      participants: Object.freeze([FALLBACK_HUMAN, FALLBACK_BOT]),
    }),
    transcript: Object.freeze([]),
    executions: Object.freeze([]),
    presence: Object.freeze([]),
    interactions: Object.freeze([]),
    history: Object.freeze({ hasOlder: false, loadingOlder: false }),
    error: null,
  });
}

function replaceSnapshot(
  state: MutableConversationState,
  patch: Partial<Omit<BotConversationSnapshot, "revision">>,
  publish = true,
): void {
  const current = state.snapshot;
  state.snapshot = Object.freeze({
    revision: current.revision + 1,
    phase: patch.phase ?? current.phase,
    descriptor: patch.descriptor ?? current.descriptor,
    transcript: patch.transcript ?? current.transcript,
    executions: patch.executions ?? current.executions,
    presence: patch.presence ?? current.presence,
    interactions: patch.interactions ?? current.interactions,
    history: patch.history ?? current.history,
    error: patch.error === undefined ? current.error : patch.error,
  });
  if (publish) {
    for (const listener of state.listeners) listener();
  }
}

function upsertBy<T>(items: readonly T[], candidate: T, key: (value: T) => string): readonly T[] {
  const id = key(candidate);
  const index = items.findIndex((item) => key(item) === id);
  if (index < 0) return Object.freeze([...items, candidate]);
  const next = [...items];
  next[index] = candidate;
  return Object.freeze(next);
}

function sourceError(error: unknown): BotConversationSourceError {
  if (error instanceof BotConversationSourceError) return error;
  if (error instanceof BotConversationServiceError) {
    return new BotConversationSourceError(error.code, error.message, error.retryable);
  }
  return new BotConversationSourceError(
    "BOT_SOURCE_ERROR",
    error instanceof Error ? error.message : String(error),
    true,
  );
}

async function uriBytesBase64(uri: string): Promise<string> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`Cannot read attachment (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const size = 0x8000;
  for (let index = 0; index < bytes.length; index += size) {
    binary += String.fromCharCode(...bytes.subarray(index, index + size));
  }
  return btoa(binary);
}

/**
 * React-facing projection over the Cordis AppServer service. It owns only
 * hydration buffers, optimistic identities and immutable view snapshots.
 */
export class AppServerBotConversationSource implements BotConversationSource {
  private readonly states = new Map<string, MutableConversationState>();
  private readonly deletedBots = new Set<string>();
  private readonly deletedConversations = new Set<string>();
  private readonly stopEvents: () => void;
  private readonly initialPageSize: number;
  private readonly olderPageSize: number;
  private readonly createId: () => string;
  private disposed = false;

  constructor(
    private readonly service: AppServerBotConversationService,
    options: AppServerBotConversationSourceOptions = {},
  ) {
    this.initialPageSize = options.initialPageSize ?? 50;
    this.olderPageSize = options.olderPageSize ?? 50;
    this.createId = options.createId ?? defaultCreateId;
    this.stopEvents = service.subscribe((event) => this.receive(event));
  }

  getSnapshot(key: ConversationKey): BotConversationSnapshot {
    return this.ensure(key).snapshot;
  }

  subscribe(key: ConversationKey, listener: BotConversationListener): () => void {
    const state = this.ensure(key);
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  load(key: ConversationKey): Promise<void> {
    const state = this.ensure(key);
    if (this.deletedConversations.has(encodeConversationKey(key))) return Promise.reject(new BotConversationSourceError("BOT_DELETED", "此 Bot 已删除。", false));
    if (state.loadPromise !== null) return state.loadPromise;
    // A ready Conversation already owns its materialized transcript. Calling
    // load from send, remount, or another observer must only acquire that
    // snapshot; it must never replace it with a possibly lagging history page.
    // Only a detected cursor discontinuity grants authority to rehydrate.
    if (state.snapshot.phase === "ready" && !state.resyncRequested) {
      return Promise.resolve();
    }
    const showLoading = state.snapshot.phase !== "ready";
    state.resyncRequested = false;
    state.loadPromise = this.hydrate(state, showLoading).finally(() => {
      state.loadPromise = null;
      if (state.resyncRequested && !this.disposed) {
        void this.load(state.logicalKey).catch(() => undefined);
      }
    });
    return state.loadPromise;
  }

  async loadOlder(key: ConversationKey): Promise<void> {
    const state = this.ensure(key);
    if (state.remoteConversationId === null || state.nextCursor === null || state.snapshot.history.loadingOlder) return;
    replaceSnapshot(state, { history: Object.freeze({ ...state.snapshot.history, loadingOlder: true }) });
    try {
      const page = await this.service.listMessages(key.hostId, {
        conversationId: state.remoteConversationId,
        cursor: state.nextCursor,
        limit: this.olderPageSize,
        direction: "backwards",
      });
      const older = page.data.map((item) => message(item, state.logicalKey));
      const seen = new Set(state.snapshot.transcript.map(botMessageStableKey));
      const prepended = older.filter((item) => !seen.has(botMessageStableKey(item)));
      state.nextCursor = page.nextCursor ?? null;
      replaceSnapshot(state, {
        transcript: Object.freeze([...prepended, ...state.snapshot.transcript]),
        history: Object.freeze({ hasOlder: state.nextCursor !== null, loadingOlder: false }),
      });
    } catch (error) {
      replaceSnapshot(state, { history: Object.freeze({ ...state.snapshot.history, loadingOlder: false }) });
      throw sourceError(error);
    }
  }

  async send(key: ConversationKey, intent: SubmitIntent): Promise<BotSendReceipt> {
    if (intent.target.type !== "existing-thread" || encodeConversationKey(intent.target.key) !== encodeConversationKey(key)) {
      throw new BotConversationSourceError("TARGET_MISMATCH", "Bot submission belongs to another Conversation", false);
    }
    const state = this.ensure(key);
    await this.load(key);
    if (state.snapshot.descriptor.readOnly === true) {
      throw new BotConversationSourceError("BOT_CONVERSATION_READ_ONLY", "This historical group is read-only because a member no longer exists.", false);
    }
    if (state.remoteConversationId === null) throw new BotConversationSourceError("NOT_LOADED", "Bot conversation is not loaded", true);
    const author = state.snapshot.descriptor.participants.find((item) => item.kind === "human") ?? FALLBACK_HUMAN;
    const optimistic: BotConversationMessage = Object.freeze({
      id: `optimistic:${intent.clientMessageId}`,
      clientMessageId: intent.clientMessageId,
      executionId: null,
      causalMessageKey: null,
      conversationKey: key,
      author,
      content: Object.freeze([{ type: "text" as const, text: composerDocumentToPlainText(intent.document) }]),
      sentAtMs: intent.createdAt,
      delivery: "sending",
      streaming: false,
    });
    replaceSnapshot(state, {
      transcript: upsertBy(state.snapshot.transcript, optimistic, botMessageStableKey),
    });
    try {
      const attachments = await Promise.all(intent.attachments.map(async (item) => {
        if (item.uri === null || item.lifecycle !== "ready") {
          throw new BotConversationSourceError("ATTACHMENT_NOT_READY", `Attachment ${item.name} is not ready`, true);
        }
        return this.service.uploadAttachment(key.hostId, {
          clientAttachmentId: item.id,
          name: item.name,
          mimeType: item.mimeType,
          sizeBytes: item.size,
          bytesBase64: await uriBytesBase64(item.uri),
        });
      }));
      const text = composerDocumentToPlainText(intent.document);
      const result = await this.service.sendMessage(key.hostId, {
        conversationId: state.remoteConversationId,
        clientMessageId: intent.clientMessageId,
        content: [
          ...(text === "" ? [] : [{ type: "text" as const, text }]),
          ...attachments.map((item) => ({ type: "attachment" as const, attachmentId: item.attachmentId })),
          ...intent.context.flatMap((item) => item.uri === null ? [] : [{ type: "resource" as const, uri: item.uri, title: item.title }]),
        ],
      });
      const accepted = message(result.message, key);
      const transcript = upsertBy(state.snapshot.transcript, accepted, botMessageStableKey);
      const executions = result.executions.reduce(
        (items, item) => upsertBy(items, execution(item, key), (value) => value.executionId),
        state.snapshot.executions,
      );
      replaceSnapshot(state, { transcript, executions });
      return {
        commandId: intent.commandId,
        clientMessageId: intent.clientMessageId,
        messageId: result.message.messageId,
        acceptedAtMs: result.message.createdAtMs,
      };
    } catch (error) {
      const failed = Object.freeze({ ...optimistic, delivery: "failed" as const });
      replaceSnapshot(state, { transcript: upsertBy(state.snapshot.transcript, failed, botMessageStableKey) });
      throw sourceError(error);
    }
  }

  async cancel(key: ConversationKey, executionId: string): Promise<void> {
    const state = this.ensure(key);
    if (state.snapshot.descriptor.readOnly === true)
      throw new BotConversationSourceError("BOT_CONVERSATION_READ_ONLY", "This historical group is read-only because a member no longer exists.", false);
    if (state.remoteConversationId === null) throw new BotConversationSourceError("NOT_LOADED", "Bot conversation is not loaded", true);
    const result = await this.service.cancelExecution(key.hostId, {
      conversationId: state.remoteConversationId,
      executionId,
      commandId: this.createId(),
    });
    replaceSnapshot(state, {
      executions: upsertBy(state.snapshot.executions, execution(result, key), (item) => item.executionId),
      presence: Object.freeze(state.snapshot.presence.filter((item) => item.executionId !== executionId)),
    });
  }

  async respondToInteraction(
    key: ConversationKey,
    interactionId: string,
    executionId: string,
    response: BotInteractionResponse,
  ): Promise<void> {
    const state = this.ensure(key);
    if (state.snapshot.descriptor.readOnly === true)
      throw new BotConversationSourceError("BOT_CONVERSATION_READ_ONLY", "This historical group is read-only because a member no longer exists.", false);
    if (state.remoteConversationId === null)
      throw new BotConversationSourceError("NOT_LOADED", "Bot conversation is not loaded", true);
    const result = await this.service.respondToInteraction(key.hostId, {
      conversationId: state.remoteConversationId,
      executionId,
      interactionId,
      commandId: this.createId(),
      response,
    });
    replaceSnapshot(state, {
      interactions: upsertBy(
        state.snapshot.interactions,
        interaction(result),
        (item) => item.interactionId,
      ),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopEvents();
    this.states.clear();
  }

  private ensure(key: ConversationKey): MutableConversationState {
    if (this.disposed) throw new BotConversationSourceError("SOURCE_DISPOSED", "Bot source is disposed", false);
    const identity = encodeConversationKey(key);
    let state = this.states.get(identity);
    if (state === undefined) {
      state = {
        logicalKey: key,
        remoteConversationId: null,
        snapshot: emptySnapshot(key),
        nextCursor: null,
        liveEpoch: null,
        nextSeq: 0,
        hydrating: false,
        loadPromise: null,
        resyncRequested: false,
        bufferedEvents: [],
        listeners: new Set(),
        deltaSeqByMessage: new Map(),
      };
      this.states.set(identity, state);
    }
    return state;
  }

  private async resolveRemoteConversation(state: MutableConversationState): Promise<string> {
    if (state.remoteConversationId !== null) return state.remoteConversationId;
    state.remoteConversationId = state.logicalKey.threadId;
    return state.remoteConversationId;
  }

  private async hydrate(state: MutableConversationState, showLoading: boolean): Promise<void> {
    state.hydrating = true;
    state.bufferedEvents = [];
    if (showLoading) replaceSnapshot(state, { phase: "loading", error: null });
    try {
      await this.service.waitForCapability(state.logicalKey.hostId);
      const conversationId = await this.resolveRemoteConversation(state);
      const result = await this.service.readConversation(state.logicalKey.hostId, {
        conversationId,
        initialMessagesPage: { limit: this.initialPageSize },
      });
      if (this.disposed) return;
      if (this.deletedConversations.has(encodeConversationKey(state.logicalKey)) || result.participants.some(person =>
        person.kind === "bot" && this.deletedBots.has(JSON.stringify([state.logicalKey.hostId, person.participantId])))) {
        this.markDeleted(state);
        throw new BotConversationSourceError("BOT_DELETED", "此 Bot 已删除。", false);
      }
      const participants = result.participants.map(participant);
      state.nextCursor = result.initialMessagesPage.nextCursor ?? null;
      state.liveEpoch = result.liveCursor.epoch;
      state.nextSeq = result.liveCursor.nextSeq;
      state.deltaSeqByMessage.clear();
      state.snapshot = Object.freeze({
        revision: state.snapshot.revision + 1,
        phase: "ready",
        descriptor: descriptor(result.conversation, state.logicalKey, participants),
        transcript: Object.freeze(result.initialMessagesPage.data.map((item) => message(item, state.logicalKey))),
        executions: Object.freeze(result.executions.map((item) => execution(item, state.logicalKey))),
        presence: Object.freeze(result.presence.map((item) => presence(item, state.logicalKey, result.liveCursor.nextSeq))),
        interactions: Object.freeze(result.interactions.map(interaction)),
        history: Object.freeze({ hasOlder: state.nextCursor !== null, loadingOlder: false }),
        error: null,
      });
      const buffered = [...state.bufferedEvents];
      state.bufferedEvents = [];
      state.hydrating = false;
      // Hydration is one view transaction. Buffered live events are folded
      // into the authoritative snapshot before React may observe any of it.
      for (const event of buffered) this.applyEvent(state, event, false);
      if (state.resyncRequested) return;
      for (const listener of state.listeners) listener();
    } catch (error) {
      state.hydrating = false;
      state.bufferedEvents = [];
      const normalized = sourceError(error);
      replaceSnapshot(state, { phase: "error", error: normalized.message });
      throw normalized;
    }
  }

  private receive(event: HostBotConversationEvent): void {
    if (this.disposed) return;
    if (event.method === "bot/deleted") this.deletedBots.add(JSON.stringify([event.hostId, `bot:${event.params.botId}`]));
    for (const state of this.states.values()) {
      if (state.logicalKey.hostId !== event.hostId) continue;
      if (event.method === "bot/deleted") {
        if (state.snapshot.descriptor.participants.some(person => person.participantId === `bot:${event.params.botId}`)) this.markDeleted(state);
        continue;
      }
      if (event.method === "bot/updated") {
        const participants = state.snapshot.descriptor.participants.map(person => person.participantId === `bot:${event.params.bot.botId}`
          ? Object.freeze({ ...person, displayName: event.params.bot.name }) : person);
        replaceSnapshot(state, { descriptor: Object.freeze({ ...state.snapshot.descriptor, participants: Object.freeze(participants) }) });
        continue;
      }
      const params = event.params as { conversationId?: string };
      if (params.conversationId !== state.remoteConversationId) continue;
      if (event.method === "bot/conversation/deleted") { this.markDeleted(state); continue; }
      if (this.deletedConversations.has(encodeConversationKey(state.logicalKey))) continue;
      if (state.hydrating) state.bufferedEvents.push(event);
      else this.applyEvent(state, event);
    }
  }

  private markDeleted(state: MutableConversationState): void {
    this.deletedConversations.add(encodeConversationKey(state.logicalKey));
    state.resyncRequested = false;
    state.bufferedEvents = [];
    replaceSnapshot(state, { phase: "error", error: "此 Bot 已删除。", executions: [], presence: [], interactions: [] });
  }

  private applyEvent(
    state: MutableConversationState,
    event: HostBotConversationEvent,
    publish = true,
  ): void {
    if (event.method === "bot/updated" || event.method === "bot/deleted") return;
    const stamp = event.params.stamp;
    if (state.liveEpoch !== stamp.epoch) {
      this.requestResync(state);
      return;
    }
    if (stamp.seq < state.nextSeq) return;
    if (stamp.seq > state.nextSeq) {
      this.requestResync(state);
      return;
    }
    state.nextSeq += 1;
    this.applyOrderedEvent(state, event, publish);
  }

  private applyOrderedEvent(
    state: MutableConversationState,
    event: HostBotConversationEvent,
    publish: boolean,
  ): void {
    const key = state.logicalKey;
    switch (event.method) {
      case "bot/conversation/updated":
        replaceSnapshot(state, { descriptor: descriptor(event.params.conversation, key, state.snapshot.descriptor.participants) }, publish);
        return;
      case "bot/conversation/deleted":
        replaceSnapshot(state, { phase: "error", error: "This Bot conversation was deleted" }, publish);
        return;
      case "bot/message/started":
      case "bot/message/completed": {
        const next = message(event.params.message, key);
        replaceSnapshot(state, { transcript: upsertBy(state.snapshot.transcript, next, botMessageStableKey) }, publish);
        return;
      }
      case "bot/message/delta": {
        const expected = state.deltaSeqByMessage.get(event.params.messageId) ?? 0;
        if (event.params.deltaSeq < expected) return;
        if (event.params.deltaSeq > expected) {
          this.requestResync(state);
          return;
        }
        state.deltaSeqByMessage.set(event.params.messageId, expected + 1);
        const index = state.snapshot.transcript.findIndex((item) => item.id === event.params.messageId);
        if (index < 0) {
          this.requestResync(state);
          return;
        }
        const current = state.snapshot.transcript[index]!;
        const content = [...current.content];
        const part = content[event.params.partIndex];
        if (part?.type !== "text") {
          this.requestResync(state);
          return;
        }
        content[event.params.partIndex] = Object.freeze({ type: "text", text: part.text + event.params.delta });
        const transcript = [...state.snapshot.transcript];
        transcript[index] = Object.freeze({ ...current, content: Object.freeze(content), streaming: true });
        replaceSnapshot(state, { transcript: Object.freeze(transcript) }, publish);
        return;
      }
      case "bot/execution/updated":
        replaceSnapshot(state, {
          executions: upsertBy(state.snapshot.executions, execution(event.params.execution, key), (item) => item.executionId),
        }, publish);
        return;
      case "bot/presence/updated": {
        const retained = state.snapshot.presence.filter((item) => !(
          item.participantId === event.params.participantId && item.executionId === event.params.executionId
        ));
        replaceSnapshot(state, {
          presence: Object.freeze(event.params.presence === null
            ? retained
            : [...retained, presence(event.params.presence, key, event.params.stamp.seq)]),
        }, publish);
        return;
      }
      case "bot/interaction/requested":
      case "bot/interaction/resolved":
        replaceSnapshot(state, {
          interactions: upsertBy(
            state.snapshot.interactions,
            interaction(event.params.interaction),
            (item) => item.interactionId,
          ),
        }, publish);
        return;
    }
  }

  /**
   * A cursor discontinuity invalidates the whole materialized view. Resync is
   * single-flight: it never races an active hydration or publishes a partial
   * repair assembled from events whose prefix is unknown.
   */
  private requestResync(state: MutableConversationState): void {
    if (this.disposed || state.resyncRequested) return;
    state.resyncRequested = true;
    if (state.loadPromise !== null || state.hydrating) return;
    void this.load(state.logicalKey).catch(() => undefined);
  }
}

export function createAppServerBotConversationSource(
  service: AppServerBotConversationService,
  options?: AppServerBotConversationSourceOptions,
): BotConversationSource {
  return new AppServerBotConversationSource(service, options);
}
