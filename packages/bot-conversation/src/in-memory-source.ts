import {
  asHostId,
  asThreadId,
  encodeConversationKey,
  type ConversationKey,
} from "@opencraft/chat-core";
import {
  composerDocumentToPlainText,
} from "@opencraft/composer-core";

import {
  botMessageStableKey,
  type BotConversationDescriptor,
  type BotExecutionSnapshot,
  type BotMessageContentPart,
  type BotConversationMessage,
  type BotConversationSnapshot,
  type BotInteractionSnapshot,
  type BotParticipantSnapshot,
  type BotPresenceFact,
  type ConversationTopology,
} from "./model";
import {
  BotConversationSourceError,
  type BotConversationListener,
  type BotConversationSource,
} from "./source";

export interface BotConversationScheduler {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface InMemoryBotConversationSeed {
  readonly key?: ConversationKey;
  readonly title?: string;
  readonly topology?: ConversationTopology;
  readonly participants?: readonly BotParticipantSnapshot[];
  readonly transcript?: readonly BotConversationMessage[];
  readonly executions?: readonly BotExecutionSnapshot[];
  readonly presence?: readonly BotPresenceFact[];
  readonly interactions?: readonly BotInteractionSnapshot[];
}

export interface InMemoryBotConversationSourceOptions {
  readonly scheduler?: BotConversationScheduler;
  readonly seed?: InMemoryBotConversationSeed;
  readonly createId?: () => string;
  readonly response?: (prompt: string) => string;
}

interface MutableConversation {
  snapshot: BotConversationSnapshot;
  transcript: readonly BotConversationMessage[];
  executions: readonly BotExecutionSnapshot[];
  presence: readonly BotPresenceFact[];
  interactions: readonly BotInteractionSnapshot[];
  readonly listeners: Set<BotConversationListener>;
  readonly cancellations: Map<string, Set<() => void>>;
}

const DEFAULT_KEY = Object.freeze({
  hostId: asHostId("bot-preview"),
  threadId: asThreadId("bot-welcome"),
});

const USER: BotParticipantSnapshot = Object.freeze({
  participantId: "person:you",
  kind: "human",
  displayName: "You",
  avatar: Object.freeze({
    kind: "monogram",
    text: "Y",
    background: "#4f64e8",
    foreground: "#ffffff",
  }),
});

const OPENCRAFT_BOT: BotParticipantSnapshot = Object.freeze({
  participantId: "bot:opencraft",
  kind: "bot",
  displayName: "OpenCraft",
  avatar: Object.freeze({
    kind: "monogram",
    text: "O",
    background: "#17191c",
    foreground: "#ffffff",
  }),
});

function browserScheduler(): BotConversationScheduler {
  return {
    now: () => Date.now(),
    schedule(delayMs, callback) {
      const handle = globalThis.setTimeout(callback, delayMs);
      return () => globalThis.clearTimeout(handle);
    },
  };
}

let fallbackId = 0;

function defaultCreateId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") return randomUUID.call(globalThis.crypto);
  fallbackId += 1;
  return `bot-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

function keyMatches(left: ConversationKey, right: ConversationKey): boolean {
  return left.hostId === right.hostId && left.threadId === right.threadId;
}

function defaultResponse(prompt: string): string {
  const subject = prompt.length > 80 ? `${prompt.slice(0, 77)}…` : prompt;
  return [
    `收到。关于“${subject}”，我会先把目标拆成一个可以验证的最小步骤。`,
    "",
    "- 保留会话和消息的稳定身份",
    "- 将临时状态与历史消息分开",
    "- 完成后给出可继续操作的结果",
  ].join("\n");
}

function freezeMessage(message: BotConversationMessage): BotConversationMessage {
  return Object.freeze({
    ...message,
    conversationKey: Object.freeze({ ...message.conversationKey }),
    author: Object.freeze({
      ...message.author,
      avatar: message.author.avatar === null
        ? null
        : Object.freeze({ ...message.author.avatar }),
    }),
    content: Object.freeze(message.content.map((part) => Object.freeze({ ...part }))),
  });
}

function freezeExecution(execution: BotExecutionSnapshot): BotExecutionSnapshot {
  return Object.freeze({
    ...execution,
    conversationKey: Object.freeze({ ...execution.conversationKey }),
  });
}

function freezePresence(fact: BotPresenceFact): BotPresenceFact {
  return Object.freeze({
    ...fact,
    conversationKey: Object.freeze({ ...fact.conversationKey }),
    activity: fact.activity === null ? null : Object.freeze({ ...fact.activity }),
  });
}

function freezeInteraction(
  interaction: BotInteractionSnapshot,
): BotInteractionSnapshot {
  if (interaction.kind === "approval") {
    return Object.freeze({
      ...interaction,
      choices: Object.freeze(
        interaction.choices.map((choice) => Object.freeze({ ...choice })),
      ),
    });
  }
  return Object.freeze({
    ...interaction,
    questions: Object.freeze(
      interaction.questions.map((question) => Object.freeze({
        ...question,
        choices: Object.freeze(
          question.choices.map((choice) => Object.freeze({ ...choice })),
        ),
      })),
    ),
  });
}

function createDescriptor(
  key: ConversationKey,
  seed: InMemoryBotConversationSeed | undefined,
): BotConversationDescriptor {
  return Object.freeze({
    key: Object.freeze({ ...key }),
    experience: "bot",
    topology: seed?.topology ?? "direct",
    title: seed?.title ?? "OpenCraft",
    rosterRevision: 1,
    participants: Object.freeze([...(seed?.participants ?? [USER, OPENCRAFT_BOT])]),
  });
}

function emptySnapshot(
  key: ConversationKey,
  seed: InMemoryBotConversationSeed | undefined,
): BotConversationSnapshot {
  const transcript = Object.freeze((seed?.transcript ?? []).map(freezeMessage));
  const executions = Object.freeze((seed?.executions ?? []).map(freezeExecution));
  const presence = Object.freeze((seed?.presence ?? []).map(freezePresence));
  const interactions = Object.freeze(
    (seed?.interactions ?? []).map(freezeInteraction),
  );
  return Object.freeze({
    revision: 0,
    phase: "idle",
    descriptor: createDescriptor(key, seed),
    transcript,
    executions,
    presence,
    interactions,
    history: Object.freeze({ hasOlder: false, loadingOlder: false }),
    error: null,
  });
}

function immutableSnapshot(
  previous: BotConversationSnapshot,
  transcript: readonly BotConversationMessage[],
  executions: readonly BotExecutionSnapshot[],
  presence: readonly BotPresenceFact[],
  interactions: readonly BotInteractionSnapshot[],
  patch: Partial<Pick<BotConversationSnapshot, "phase" | "history" | "error">>,
): BotConversationSnapshot {
  const revision = previous.revision + 1;
  return Object.freeze({
    revision,
    phase: patch.phase ?? previous.phase,
    descriptor: previous.descriptor,
    transcript,
    executions,
    presence,
    interactions,
    history: patch.history === undefined
      ? previous.history
      : Object.freeze({ ...patch.history }),
    error: patch.error === undefined ? previous.error : patch.error,
  });
}

export function createInMemoryBotConversationSource(
  options: InMemoryBotConversationSourceOptions = {},
): BotConversationSource {
  const scheduler = options.scheduler ?? browserScheduler();
  const createId = options.createId ?? defaultCreateId;
  const createResponse = options.response ?? defaultResponse;
  const conversations = new Map<string, MutableConversation>();
  let disposed = false;

  const ensureOpen = () => {
    if (disposed) throw new BotConversationSourceError("SOURCE_DISPOSED", "Bot conversation source is disposed", false);
  };
  const ensure = (key: ConversationKey): MutableConversation => {
    const encoded = encodeConversationKey(key);
    const existing = conversations.get(encoded);
    if (existing !== undefined) return existing;
    const seed = options.seed !== undefined && (
      options.seed.key === undefined || keyMatches(options.seed.key, key)
    ) ? options.seed : undefined;
    const created: MutableConversation = {
      snapshot: emptySnapshot(key, seed),
      transcript: Object.freeze((seed?.transcript ?? []).map(freezeMessage)),
      executions: Object.freeze((seed?.executions ?? []).map(freezeExecution)),
      presence: Object.freeze((seed?.presence ?? []).map(freezePresence)),
      interactions: Object.freeze(
        (seed?.interactions ?? []).map(freezeInteraction),
      ),
      listeners: new Set(),
      cancellations: new Map(),
    };
    conversations.set(encoded, created);
    return created;
  };
  const publish = (
    conversation: MutableConversation,
    patch: Partial<Pick<BotConversationSnapshot, "phase" | "history" | "error">> & {
      readonly transcript?: readonly BotConversationMessage[];
      readonly executions?: readonly BotExecutionSnapshot[];
      readonly presence?: readonly BotPresenceFact[];
      readonly interactions?: readonly BotInteractionSnapshot[];
    },
  ) => {
    if (patch.transcript !== undefined) {
      conversation.transcript = Object.freeze(patch.transcript.map(freezeMessage));
    }
    if (patch.executions !== undefined) {
      conversation.executions = Object.freeze(patch.executions.map(freezeExecution));
    }
    if (patch.presence !== undefined) {
      conversation.presence = Object.freeze(patch.presence.map(freezePresence));
    }
    if (patch.interactions !== undefined) {
      conversation.interactions = Object.freeze(
        patch.interactions.map(freezeInteraction),
      );
    }
    conversation.snapshot = immutableSnapshot(
      conversation.snapshot,
      conversation.transcript,
      conversation.executions,
      conversation.presence,
      conversation.interactions,
      patch,
    );
    for (const listener of conversation.listeners) listener();
  };
  const schedule = (
    conversation: MutableConversation,
    executionId: string,
    delayMs: number,
    callback: () => void,
  ) => {
    let cancel: () => void = () => undefined;
    cancel = scheduler.schedule(delayMs, () => {
      const owned = conversation.cancellations.get(executionId);
      owned?.delete(cancel);
      if (owned?.size === 0) conversation.cancellations.delete(executionId);
      if (!disposed) callback();
    });
    let owned = conversation.cancellations.get(executionId);
    if (owned === undefined) {
      owned = new Set();
      conversation.cancellations.set(executionId, owned);
    }
    owned.add(cancel);
  };

  return {
    getSnapshot(key) {
      ensureOpen();
      return ensure(key).snapshot;
    },
    subscribe(key, listener) {
      ensureOpen();
      const conversation = ensure(key);
      conversation.listeners.add(listener);
      return () => conversation.listeners.delete(listener);
    },
    async load(key) {
      ensureOpen();
      const conversation = ensure(key);
      if (conversation.snapshot.phase === "ready") return;
      publish(conversation, { phase: "loading", error: null });
      publish(conversation, { phase: "ready" });
    },
    async loadOlder(key) {
      ensureOpen();
      const conversation = ensure(key);
      if (!conversation.snapshot.history.hasOlder || conversation.snapshot.history.loadingOlder) return;
      publish(conversation, {
        history: { ...conversation.snapshot.history, loadingOlder: true },
      });
      publish(conversation, {
        history: { hasOlder: false, loadingOlder: false },
      });
    },
    async send(key, intent) {
      ensureOpen();
      const conversation = ensure(key);
      if (
        intent.target.type !== "existing-thread" ||
        !keyMatches(intent.target.key, key)
      ) {
        throw new BotConversationSourceError(
          "TARGET_MISMATCH",
          "Submission target does not belong to this Bot conversation",
          false,
        );
      }
      const prompt = composerDocumentToPlainText(intent.document).trim();
      if (prompt.length === 0 && intent.attachments.length === 0) {
        throw new BotConversationSourceError("EMPTY_MESSAGE", "Message is empty", false);
      }
      const user = conversation.snapshot.descriptor.participants.find(
        (participant) => participant.kind === "human",
      ) ?? USER;
      const bot = conversation.snapshot.descriptor.participants.find(
        (participant) => participant.kind === "bot",
      ) ?? OPENCRAFT_BOT;
      const content: BotMessageContentPart[] = prompt.length === 0
        ? []
        : [{ type: "text", text: prompt }];
      for (const attachment of intent.attachments) {
        if (attachment.uri === null) continue;
        if (attachment.mimeType.startsWith("image/")) {
          content.push({ type: "image", uri: attachment.uri, alt: attachment.name });
        } else {
          content.push({ type: "resource", uri: attachment.uri, title: attachment.name });
        }
      }
      for (const reference of intent.context) {
        if (reference.uri !== null) {
          content.push({ type: "resource", uri: reference.uri, title: reference.title });
        }
      }
      const optimisticId = `optimistic-user:${intent.clientMessageId}`;
      const executionId = `execution:${intent.commandId}`;
      const optimistic = freezeMessage({
        id: optimisticId,
        clientMessageId: intent.clientMessageId,
        executionId: null,
        causalMessageKey: null,
        conversationKey: key,
        author: user,
        content,
        sentAtMs: intent.createdAt,
        delivery: "sending",
        streaming: false,
      });
      const execution: BotExecutionSnapshot = {
        executionId,
        conversationKey: key,
        participantId: bot.participantId,
        causalMessageKey: botMessageStableKey(optimistic),
        status: "running",
        startedAtMs: scheduler.now(),
        completedAtMs: null,
      };
      const presence: BotPresenceFact = {
        conversationKey: key,
        participantId: bot.participantId,
        executionId,
        seq: 1,
        phase: "thinking",
        activity: {
          verb: "thinking",
          detail: "Considering your message",
          targetParticipantId: user.participantId,
        },
        observedAtMs: scheduler.now(),
        expiresAtMs: scheduler.now() + 30_000,
      };

      // One publication owns the submit boundary: the optimistic row is in
      // the list before the transient Presence can be rendered beneath it.
      publish(conversation, {
        transcript: [...conversation.transcript, optimistic],
        executions: [...conversation.executions, execution],
        presence: [presence],
        phase: "ready",
        error: null,
      });

      const messageId = `message:${intent.clientMessageId}`;
      schedule(conversation, executionId, 80, () => {
        publish(conversation, {
          transcript: conversation.transcript.map((message) =>
            message.clientMessageId === intent.clientMessageId
              ? { ...message, id: messageId, delivery: "sent" }
              : message,
          ),
        });
      });

      const responseText = createResponse(prompt || "the attachment");
      const chunks = responseText.match(/.{1,18}(?:\s|$)|.{1,18}/gu) ?? [responseText];
      const assistantMessageId = `assistant:${createId()}`;
      schedule(conversation, executionId, 260, () => {
        const assistant = freezeMessage({
          id: assistantMessageId,
          clientMessageId: null,
          executionId,
          causalMessageKey: botMessageStableKey(optimistic),
          conversationKey: key,
          author: bot,
          content: [{ type: "text", text: "" }],
          sentAtMs: scheduler.now(),
          delivery: "sent",
          streaming: true,
        });
        publish(conversation, {
          transcript: [...conversation.transcript, assistant],
          presence: [{
            ...presence,
            seq: 2,
            phase: "typing",
            activity: { ...presence.activity!, verb: "writing", detail: "Writing a reply" },
            observedAtMs: scheduler.now(),
            expiresAtMs: scheduler.now() + 30_000,
          }],
        });
      });
      chunks.forEach((chunk, index) => {
        schedule(conversation, executionId, 330 + index * 55, () => {
          const isLast = index === chunks.length - 1;
          publish(conversation, {
            transcript: conversation.transcript.map((message) => {
              if (message.id !== assistantMessageId) return message;
              const previousText = message.content[0]?.type === "text"
                ? message.content[0].text
                : "";
              return {
                ...message,
                content: [{ type: "text", text: `${previousText}${chunk}` }],
                streaming: !isLast,
              };
            }),
            presence: isLast ? [] : conversation.presence,
            executions: isLast
              ? conversation.executions.map((item) =>
                  item.executionId === executionId
                    ? { ...item, status: "completed", completedAtMs: scheduler.now() }
                    : item
                )
              : conversation.executions,
          });
        });
      });

      return {
        commandId: intent.commandId,
        clientMessageId: intent.clientMessageId,
        messageId,
        acceptedAtMs: scheduler.now(),
      };
    },
    async cancel(key, executionId) {
      ensureOpen();
      const conversation = ensure(key);
      const ownsExecution = conversation.executions.some(
        (execution) => execution.executionId === executionId,
      );
      if (!ownsExecution) return;
      for (const cancel of conversation.cancellations.get(executionId) ?? []) cancel();
      conversation.cancellations.delete(executionId);
      publish(conversation, {
        presence: conversation.presence.filter(
          (fact) => fact.executionId !== executionId,
        ),
        transcript: conversation.transcript.map((message) =>
          message.executionId === executionId && message.streaming
            ? { ...message, streaming: false }
            : message,
        ),
        executions: conversation.executions.map((execution) =>
          execution.executionId === executionId
            ? {
                ...execution,
                status: "cancelled",
                completedAtMs: scheduler.now(),
              }
            : execution,
        ),
      });
    },
    async respondToInteraction(key, interactionId, executionId, response) {
      ensureOpen();
      const conversation = ensure(key);
      const interaction = conversation.interactions.find(
        (candidate) =>
          candidate.interactionId === interactionId &&
          candidate.executionId === executionId,
      );
      if (interaction === undefined || interaction.status !== "pending") {
        throw new BotConversationSourceError(
          "INTERACTION_NOT_PENDING",
          `Interaction ${interactionId} is not pending`,
          false,
        );
      }
      if (interaction.kind !== response.type) {
        throw new BotConversationSourceError(
          "INTERACTION_RESPONSE_MISMATCH",
          `Interaction ${interactionId} does not accept ${response.type}`,
          false,
        );
      }
      publish(conversation, {
        interactions: conversation.interactions.map((candidate) =>
          candidate.interactionId === interactionId
            ? { ...candidate, status: "resolved" as const }
            : candidate
        ),
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const conversation of conversations.values()) {
        for (const cancellations of conversation.cancellations.values()) {
          for (const cancel of cancellations) cancel();
        }
        conversation.cancellations.clear();
        conversation.listeners.clear();
      }
      conversations.clear();
    },
  };
}

export const DEFAULT_BOT_CONVERSATION_KEY = DEFAULT_KEY;
