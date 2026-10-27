import {
  botMessageStableKey,
  latestBotPresenceFacts,
  type BotExecutionSnapshot,
  type BotConversationMessage,
  type BotTimelineProjection,
  type BotTimelineUnit,
  type BotMessageRunProjection,
  type BotPresenceFact,
} from "./model";

function projectMessageRun(
  transcript: readonly BotConversationMessage[],
  index: number,
): readonly BotMessageRunProjection[] {
  const message = transcript[index]!;
  const previous = transcript[index - 1];
  const next = transcript[index + 1];
  const continuedFromPrevious =
    previous?.author.participantId === message.author.participantId;
  const continuedToNext =
    next?.author.participantId === message.author.participantId;
  return Object.freeze([Object.freeze({
    author: message.author,
    stableKey: botMessageStableKey(message),
    messages: Object.freeze([Object.freeze({
      message,
      stableKey: botMessageStableKey(message),
      continuedFromPrevious,
      continuedToNext,
      groupStart: !continuedFromPrevious,
      runStart: true,
      groupEnd: !continuedToNext,
    })]),
  })]);
}

function inferredExecution(
  executionId: string,
  messages: readonly BotConversationMessage[],
  presence: readonly BotPresenceFact[],
): BotExecutionSnapshot {
  const firstMessage = messages[0];
  const firstPresence = presence[0];
  if (firstMessage === undefined && firstPresence === undefined) {
    throw new Error(`Cannot infer empty Bot execution: ${executionId}`);
  }
  const conversationKey = firstMessage?.conversationKey ?? firstPresence!.conversationKey;
  const participantId = firstPresence?.participantId
    ?? messages.find((message) => message.author.kind === "bot")?.author.participantId
    ?? firstMessage!.author.participantId;
  const active = presence.some((fact) => fact.phase !== "idle")
    || messages.some((message) => message.streaming);
  const failed = messages.some((message) => message.delivery === "failed");
  const startedAtMs = Math.min(
    ...messages.map((message) => message.sentAtMs),
    ...presence.map((fact) => fact.observedAtMs),
  );
  return Object.freeze({
    executionId,
    conversationKey,
    participantId,
    causalMessageKey: firstMessage?.causalMessageKey ?? null,
    status: failed ? "failed" : active ? "running" : "completed",
    startedAtMs,
    completedAtMs: active
      ? null
      : messages.length > 0
        ? Math.max(...messages.map((message) => message.sentAtMs))
        : firstPresence!.observedAtMs,
  });
}

/**
 * Projects Bot semantics into stable layout units. These are measurement and
 * virtualization units, not AppServer Turns and not persistence authority.
 */
export function projectBotTimeline({
  transcript,
  executions,
  presence,
  revision,
}: {
  readonly transcript: readonly BotConversationMessage[];
  readonly executions: readonly BotExecutionSnapshot[];
  readonly presence: readonly BotPresenceFact[];
  readonly revision: number;
}): BotTimelineProjection {
  const presenceByExecution = new Map<string, BotPresenceFact[]>();
  for (const fact of latestBotPresenceFacts(presence)) {
    let facts = presenceByExecution.get(fact.executionId);
    if (facts === undefined) {
      facts = [];
      presenceByExecution.set(fact.executionId, facts);
    }
    facts.push(fact);
  }

  const executionById = new Map(executions.map((execution) => [execution.executionId, execution]));
  const executionIds = new Set([
    ...executionById.keys(),
    ...transcript.flatMap((message) =>
      message.executionId === null ? [] : [message.executionId]
    ),
    ...presenceByExecution.keys(),
  ]);
  const executionUnits = new Map<string, Extract<BotTimelineUnit, { kind: "execution" }>>();
  for (const executionId of executionIds) {
    const messages = Object.freeze(
      transcript.filter((message) => message.executionId === executionId),
    );
    const facts = Object.freeze([...(presenceByExecution.get(executionId) ?? [])]);
    const execution = executionById.get(executionId)
      ?? inferredExecution(executionId, messages, facts);
    const shouldProjectExecution = facts.some((fact) => fact.phase !== "idle") ||
      execution.status === "queued" ||
      execution.status === "running" ||
      execution.status === "waiting" ||
      execution.status === "failed";
    if (!shouldProjectExecution) continue;
    executionUnits.set(executionId, Object.freeze({
      kind: "execution",
      unitKey: `execution:${executionId}`,
      occurredAtMs: Math.max(
        execution.startedAtMs,
        ...messages.map((message) => message.sentAtMs),
        ...facts.map((fact) => fact.observedAtMs),
      ),
      execution,
      presence: facts,
    }));
  }

  const units: BotTimelineUnit[] = [];
  transcript.forEach((message, ordinal) => {
    units.push({
      kind: "message",
      unitKey: `message:${botMessageStableKey(message)}`,
      occurredAtMs: message.sentAtMs,
      messageRuns: projectMessageRun(transcript, ordinal),
    });
  });
  // Transcript is append-oriented authority. Client/Bot/automation clocks can
  // differ, so timestamps must never reorder durable messages. Live execution
  // rows form a transient tail in stable execution insertion order.
  units.push(...executionUnits.values());

  return Object.freeze({
    revision,
    units: Object.freeze(units.map((unit) => Object.freeze(unit))),
  });
}
