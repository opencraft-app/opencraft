import { ReplayIcon as RotateCcw } from "@opencraft/design-system-web/action-icons";
import { NativeSelect } from "@opencraft/design-system-web/native-controls";
import {
  botMessageStableKey,
  botMessageText,
  botConversationResourceUri,
  latestBotPresenceFacts,
  parseBotConversationViewResource,
  projectBotTimeline,
  type BotConversationResolver,
  type BotConversationMessage,
  type BotConversationSource,
  type BotInteractionResponse,
  type BotInteractionSnapshot,
  type BotTimelineUnit,
  type BotMessageBubbleProjection,
  type BotMessageRunProjection,
  type BotParticipantSnapshot,
} from "@opencraft/bot-conversation";
import { createConversationKey, encodeConversationKey } from "@opencraft/chat-core";
import { WebChatDocument, WebUserMessageDocument } from "@opencraft/chat-render-web";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { createClientId, createComposerController, type ComposerDraftStorage } from "@opencraft/composer-core";
import type { ExtensionSettingsViewProps } from "@opencraft/extension-react";
import { ArrowDownIcon as ArrowDown, AlertIcon as CircleAlert, PauseIcon as Pause, PlayIcon as Play, PeopleIcon as UsersRound } from "@opencraft/design-system-web/action-icons";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { BotAvatar } from "./bot-avatar";
import {
  BOT_ACTIVITY_TIMING,
  BotActivityIndicator,
  projectBotActivityIndicator,
} from "./bot-activity-indicator";
import { BotAvatarMark, BotAvatarStage } from "./bot-avatar-stage";
import {
  projectBotMotionReplay,
  type BotMotionReplayController,
} from "./motion-replay";
import { useBotConversationViewport } from "./conversation-viewport";
import { BotExecutionError } from "./execution-error";
import { useBotTimelinePresentation } from "./timeline-presentation";
import "./styles.scss";

const EMPTY_REPLAY_SUBSCRIBE = () => () => undefined;
const EMPTY_REPLAY_SNAPSHOT = () => null;
export interface BotChatViewStatus {
  readonly conversationId: string | null;
  readonly error: string | null;
  readonly phase: "opening" | "ready" | "error";
}

export interface BotChatViewOptions {
  readonly drafts?: ComposerDraftStorage;
  readonly resolver: BotConversationResolver;
  readonly createMotionReplay?: () => BotMotionReplayController;
  readonly onStatusChange?: (status: BotChatViewStatus) => void;
  readonly portalContainer?: HTMLElement | null;
}

function currentRenderTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function firstBot(
  participants: readonly BotParticipantSnapshot[],
): BotParticipantSnapshot {
  return (
    participants.find((participant) => participant.kind === "bot") ??
    participants[0]!
  );
}

function executionUnitIsActive(unit: BotTimelineUnit): boolean {
  return unit.kind === "execution" && unit.execution.status !== "failed" &&
    unit.execution.status !== "completed" && unit.execution.status !== "cancelled" && (
    unit.execution.status === "queued" ||
    unit.execution.status === "running" ||
    unit.execution.status === "waiting" ||
    unit.presence.some((fact) => fact.phase !== "idle")
  );
}

function MessageContent({
  message,
}: {
  readonly message: BotConversationMessage;
}) {
  const markdown = botMessageText(message);
  const theme = currentRenderTheme();
  return (
    <>
      {markdown.length === 0 && message.streaming ? (
        <span
          className="bot-chat-message__streaming-caret"
          aria-label="Writing"
        />
      ) : message.author.kind === "human" ? (
        <WebUserMessageDocument
          conversationId={encodeConversationKey(message.conversationKey)}
          documentId={`${botMessageStableKey(message)}:user`}
          hostId={message.conversationKey.hostId}
          source={markdown}
          theme={theme}
        />
      ) : (
        <WebChatDocument
          conversationId={encodeConversationKey(message.conversationKey)}
          documentId={`${botMessageStableKey(message)}:bot`}
          hostId={message.conversationKey.hostId}
          source={markdown}
          streaming={message.streaming}
          theme={theme}
        />
      )}
      {message.content.map((part, index) => {
        if (part.type === "text") return null;
        if (part.type === "image") {
          return (
            <img
              className="bot-chat-message__image"
              key={`${part.uri}:${index}`}
              alt={part.alt ?? ""}
              src={part.uri}
            />
          );
        }
        return (
          <a
            className="bot-chat-message__resource"
            href={part.uri}
            key={`${part.uri}:${index}`}
            rel="noreferrer"
            target="_blank"
          >
            {part.title}
          </a>
        );
      })}
    </>
  );
}

function MessageBubble({
  entering,
  projection,
}: {
  readonly entering: boolean;
  readonly projection: BotMessageBubbleProjection;
}) {
  // Capture entrance ownership once. Streaming revisions may update the
  // message body, but they must never replay the row entrance animation.
  const [enteredAsNew] = useState(entering);
  const { message } = projection;
  return (
    <div className="bot-chat-message-shell" data-author-kind={message.author.kind}>
      <article
        className="bot-chat-message"
        data-selection="text"
        data-author-kind={message.author.kind}
        data-continued-next={projection.continuedToNext || undefined}
        data-continued-prev={projection.continuedFromPrevious || undefined}
        data-delivery={message.delivery}
        data-enter={enteredAsNew ? "new" : undefined}
        data-group-end={projection.groupEnd || undefined}
        data-group-start={projection.groupStart || undefined}
        data-streaming={message.streaming || undefined}
      >
        <MessageContent message={message} />
      </article>
      {message.delivery === "sending" ? (
        <span className="bot-chat-message__delivery" role="status">Sending…</span>
      ) : null}
      {message.delivery === "failed" ? (
        <span className="bot-chat-message__delivery is-failed" role="status">Not sent</span>
      ) : null}
    </div>
  );
}

function MessageRun({
  enteringKeys,
  liveAvatar,
  run,
}: {
  readonly enteringKeys: ReadonlySet<string>;
  readonly liveAvatar: boolean;
  readonly run: BotMessageRunProjection;
}) {
  const { author } = run;
  const isHuman = author.kind === "human";
  return (
    <section className="bot-chat-message-run" data-author-kind={author.kind}>
      {!isHuman ? (
        liveAvatar ? (
          <BotAvatarMark
            active
            followPointer
            participant={author}
          />
        ) : (
          <BotAvatar participant={author} presentation="static" />
        )
      ) : null}
      <div className="bot-chat-message-run__body">
        {!isHuman ? (
          <strong className="bot-chat-message-run__author">
            {author.displayName}
          </strong>
        ) : null}
        {run.messages.map((projection) => (
          <MessageBubble
            entering={enteringKeys.has(projection.stableKey)}
            key={projection.stableKey}
            projection={projection}
          />
        ))}
      </div>
    </section>
  );
}

function TimelineUnitRow({
  activeExecutionIds,
  enteringKeys,
  latestBotMessageKeys,
  participants,
  requiresApproval,
  unit,
  onApprove,
}: {
  readonly activeExecutionIds: ReadonlySet<string>;
  readonly enteringKeys: ReadonlySet<string>;
  readonly latestBotMessageKeys: ReadonlyMap<string, string>;
  readonly participants: readonly BotParticipantSnapshot[];
  readonly requiresApproval: boolean;
  readonly unit: BotTimelineUnit;
  readonly onApprove: () => void;
}) {
  const activityModel = useMemo(
    () =>
      unit.kind === "execution" && unit.execution.status !== "failed"
        ? projectBotActivityIndicator(unit.presence, participants)
        : null,
    [participants, unit],
  );
  const failedBot = unit.kind === "execution" && unit.execution.status === "failed"
    ? participants.find((participant) => participant.participantId === unit.execution.participantId)
    : undefined;
  return (
    <div className="bot-chat-timeline-unit" data-unit-kind={unit.kind}>
      {(unit.kind === "message" ? unit.messageRuns : []).map((run) => {
        const last = run.messages.at(-1)!.message;
        return (
          <MessageRun
            enteringKeys={enteringKeys}
            key={run.stableKey}
            liveAvatar={
              last.author.kind === "bot" &&
              last.executionId !== null &&
              activeExecutionIds.has(last.executionId) &&
              latestBotMessageKeys.get(last.author.participantId) ===
                botMessageStableKey(last)
            }
            run={run}
          />
        );
      })}
      <BotActivityIndicator model={activityModel} />
      {unit.kind === "execution" && unit.execution.status === "failed" ? (
        <BotExecutionError
          code={unit.execution.error?.code}
          participantName={failedBot?.displayName ?? "Bot"}
        />
      ) : null}
      {requiresApproval && unit.kind === "execution" ? (
        <div className="bot-chat-replay-approval" role="status">
          <CircleAlert aria-hidden="true" size={16} />
          <span>
            <strong>Approval needed</strong>
            <small>OpenCraft wants to open the deployment checklist.</small>
          </span>
          <button onClick={onApprove} type="button">Allow</button>
        </div>
      ) : null}
    </div>
  );
}

function BotInteractionCard({
  busy,
  interaction,
  onRespond,
}: {
  readonly busy: boolean;
  readonly interaction: BotInteractionSnapshot;
  readonly onRespond: (response: BotInteractionResponse) => void;
}) {
  const [answers, setAnswers] = useState<
    Record<string, string | readonly string[]>
  >({});

  if (interaction.kind === "approval") {
    return (
      <section
        className="bot-chat-interaction"
        data-kind="approval"
        role="group"
        aria-label={interaction.title}
      >
        <CircleAlert aria-hidden="true" size={17} />
        <span className="bot-chat-interaction__copy">
          <strong>{interaction.title}</strong>
          {interaction.description === null ? null : (
            <small>{interaction.description}</small>
          )}
        </span>
        <span className="bot-chat-interaction__actions">
          {interaction.choices.map((choice) => (
            <button
              data-destructive={choice.destructive || undefined}
              disabled={busy}
              key={choice.choiceId}
              onClick={() => onRespond({
                type: "approval",
                choiceId: choice.choiceId,
              })}
              type="button"
            >
              {choice.label}
            </button>
          ))}
        </span>
      </section>
    );
  }

  const complete = interaction.questions.every((question) => {
    const value = answers[question.questionId];
    return typeof value === "string"
      ? value.trim().length > 0
      : value !== undefined && value.length > 0;
  });
  return (
    <form
      className="bot-chat-interaction bot-chat-interaction--clarification"
      onSubmit={(event) => {
        event.preventDefault();
        if (!complete || busy) return;
        onRespond({ type: "clarification", answers });
      }}
    >
      <CircleAlert aria-hidden="true" size={17} />
      <div className="bot-chat-interaction__copy">
        <strong>{interaction.title}</strong>
        {interaction.questions.map((question) => (
          <label key={question.questionId}>
            <span>{question.prompt}</span>
            {question.choices.length === 0 ? (
              <input
                disabled={busy}
                onChange={(event) => setAnswers((current) => ({
                  ...current,
                  [question.questionId]: event.currentTarget.value,
                }))}
                value={typeof answers[question.questionId] === "string"
                  ? answers[question.questionId]
                  : ""}
              />
            ) : (
              <NativeSelect
                disabled={busy}
                multiple={question.multiple}
                onChange={(event) => {
                  const values = [...event.currentTarget.selectedOptions].map(
                    (option) => option.value,
                  );
                  setAnswers((current) => ({
                    ...current,
                    [question.questionId]: question.multiple
                      ? values
                      : values[0] ?? "",
                  }));
                }}
                value={answers[question.questionId] ?? (question.multiple ? [] : "")}
              >
                {question.multiple ? null : <option value="">Choose…</option>}
                {question.choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </label>
        ))}
      </div>
      <span className="bot-chat-interaction__actions">
        <button disabled={!complete || busy} type="submit">
          Respond
        </button>
      </span>
    </form>
  );
}

function useEnteringMessageKeys(
  identity: string,
  ready: boolean,
  messages: readonly BotConversationMessage[],
): ReadonlySet<string> {
  const ledgerRef = useRef<{
    identity: string;
    baselineCommitted: boolean;
    knownKeys: Set<string>;
  }>({ identity, baselineCommitted: false, knownKeys: new Set() });

  if (ledgerRef.current.identity !== identity) {
    ledgerRef.current = {
      identity,
      baselineCommitted: false,
      knownKeys: new Set(),
    };
  }

  const ledger = ledgerRef.current;
  const enteringKeys = new Set<string>();
  if (ledger.baselineCommitted) {
    for (const message of messages) {
      const stableKey = botMessageStableKey(message);
      if (!ledger.knownKeys.has(stableKey)) enteringKeys.add(stableKey);
    }
  }

  useLayoutEffect(() => {
    if (ledgerRef.current.identity !== identity) return;
    for (const message of messages)
      ledgerRef.current.knownKeys.add(botMessageStableKey(message));
    if (ready) ledgerRef.current.baselineCommitted = true;
  }, [identity, messages, ready]);

  return enteringKeys;
}

export function createBotChatView(
  source: BotConversationSource,
  options: BotChatViewOptions,
) {
  return function BotChatView({ activation, host }: ExtensionSettingsViewProps) {
    const replay = useMemo(() => options.createMotionReplay?.(), []);
    const requestedResource = useMemo(
      () => parseBotConversationViewResource(activation.resourceUri),
      [activation.resourceUri],
    );
    const exactRequestedKey = requestedResource?.kind === "conversation"
      ? requestedResource.key
      : null;
    const [resolvedKey, setResolvedKey] = useState(exactRequestedKey);
    const [activationError, setActivationError] = useState<string | null>(null);
    const [activationAttempt, setActivationAttempt] = useState(0);
    const pendingKey = useMemo(
      () => createConversationKey(
        (requestedResource?.kind === "selection"
          ? requestedResource.hostId
          : host.activeHostId) || "unbound",
        "pending-bot-activation",
      ),
      [host.activeHostId, requestedResource],
    );
    const key = exactRequestedKey ?? resolvedKey ?? pendingKey;
    const identity = encodeConversationKey(key);
    const subscribe = useCallback(
      (listener: () => void) => source.subscribe(key, listener),
      [identity],
    );
    const getSnapshot = useCallback(() => source.getSnapshot(key), [identity]);
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const replaySnapshot = useSyncExternalStore(
      replay?.subscribe ?? EMPTY_REPLAY_SUBSCRIBE,
      replay?.getSnapshot ?? EMPTY_REPLAY_SNAPSHOT,
      replay?.getSnapshot ?? EMPTY_REPLAY_SNAPSHOT,
    );
    const [replayEnabled, setReplayEnabled] = useState(replay !== undefined);
    const composer = useMemo(
      () =>
        createComposerController(
          { type: "existing-thread", key },
          { createId: createClientId, now: () => Date.now(), drafts: options.drafts,
            onDraftStorageError: () => console.warn("Chat draft could not be saved locally") },
        ),
      [identity],
    );
    const objectUrlsRef = useRef(new Set<string>());
    const [submissionError, setSubmissionError] = useState<string | null>(null);
    const [respondingInteractionId, setRespondingInteractionId] = useState<
      string | null
    >(null);
    const bot = firstBot(snapshot.descriptor.participants);
    const replayProjection = useMemo(
      () =>
        !replayEnabled || replaySnapshot === null || replay === undefined
          ? null
          : projectBotMotionReplay(
              replaySnapshot,
              key,
              snapshot.descriptor.participants,
              replay.presenceFor(key),
            ),
      [
        identity,
        replay,
        replayEnabled,
        replaySnapshot,
        snapshot.descriptor.participants,
      ],
    );
    const liveTimeline = useMemo(
      () => projectBotTimeline({
        transcript: snapshot.transcript,
        executions: snapshot.executions,
        presence: snapshot.presence,
        revision: snapshot.revision,
      }),
      [snapshot.executions, snapshot.presence, snapshot.revision, snapshot.transcript],
    );
    const semanticTimeline = replayProjection?.timeline ?? liveTimeline;
    const timeline = useBotTimelinePresentation(
      `${identity}:${replayEnabled ? "replay" : "live"}`,
      semanticTimeline,
      BOT_ACTIVITY_TIMING.exitMs,
    );
    const renderedMessages = useMemo(
      () => timeline.units.flatMap((unit) =>
        unit.kind === "message" ? unit.messageRuns.flatMap((run) =>
          run.messages.map((message) => message.message)
        ) : []
      ),
      [timeline],
    );
    const enteringMessageKeys = useEnteringMessageKeys(
      `${identity}:${replayEnabled ? "replay" : "live"}`,
      replayEnabled || snapshot.phase === "ready",
      renderedMessages,
    );
    const latestBotMessageKeys = useMemo(() => {
      const keys = new Map<string, string>();
      for (const message of renderedMessages) {
        if (message.author.kind === "bot")
          keys.set(
            message.author.participantId,
            botMessageStableKey(message),
          );
      }
      return keys;
    }, [renderedMessages]);
    const hasStreamingMessage = renderedMessages.some(
      (message) => message.streaming,
    );
    const effectivePresence = useMemo(
      () => timeline.units.flatMap((unit) =>
        unit.kind === "execution" ? unit.presence : []
      ),
      [timeline],
    );
    const activeExecutionIds = useMemo(
      () => new Set(
        timeline.units
          .filter(executionUnitIsActive)
          .map((unit) => unit.kind === "execution" ? unit.execution.executionId : ""),
      ),
      [timeline],
    );
    const isStreaming =
      timeline.units.some(executionUnitIsActive) ||
      latestBotPresenceFacts(effectivePresence).some(
        (fact) => fact.phase !== "idle",
      ) || hasStreamingMessage;
    const viewport = useBotConversationViewport(
      `${identity}:${replayEnabled ? "replay" : "live"}`,
      timeline.units,
      {
        enabled: snapshot.phase === "ready" && !replayEnabled,
        hasOlder: snapshot.history.hasOlder,
        loadingOlder: snapshot.history.loadingOlder,
        loadOlder: () => source.loadOlder(key),
      },
    );
    const {
      following,
      followLatest,
      transcriptRef,
    } = viewport;

    useEffect(() => {
      setActivationError(null);
      if (exactRequestedKey !== null) {
        setResolvedKey(exactRequestedKey);
        return;
      }
      setResolvedKey(null);
      const hostId = requestedResource?.kind === "selection"
        ? requestedResource.hostId
        : host.activeHostId;
      if (hostId.trim().length === 0) {
        setActivationError("Choose a connected Host before opening Bot chat.");
        return;
      }
      const controller = new AbortController();
      void options.resolver.resolve({
        hostId,
        botId: requestedResource?.kind === "selection"
          ? requestedResource.botId
          : null,
      }, controller.signal).then((resolved) => {
        if (controller.signal.aborted) return;
        setResolvedKey(resolved);
        host.replaceViewResource(
          activation.viewId,
          botConversationResourceUri(resolved),
        );
      }).catch((error) => {
        if (controller.signal.aborted) return;
        setActivationError(error instanceof Error ? error.message : String(error));
      });
      return () => controller.abort();
    }, [
      activation.viewId,
      activationAttempt,
      exactRequestedKey,
      host,
      requestedResource,
    ]);

    const conversationReady = exactRequestedKey !== null || resolvedKey !== null;
    const statusPhase = activationError !== null || snapshot.phase === "error"
      ? "error"
      : conversationReady && snapshot.phase === "ready"
        ? "ready"
        : "opening";
    const statusError = activationError ?? (snapshot.phase === "error" ? snapshot.error : null);
    useLayoutEffect(() => {
      options.onStatusChange?.({
        conversationId: conversationReady ? key.threadId : null,
        error: statusError,
        phase: statusPhase,
      });
    }, [conversationReady, identity, statusError, statusPhase]);
    useEffect(() => {
      if (!conversationReady) return;
      // Source owns the error frame. A failed Host hydration must not escape
      // as an unhandled Promise rejection owned by React.
      void source.load(key).catch(() => undefined);
      replay?.restart();
      return () => {
        replay?.pause();
        composer.dispose();
      };
    }, [composer, conversationReady, identity, replay]);
    useEffect(
      () => () => {
        for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
        objectUrlsRef.current.clear();
      },
      [],
    );
    const submit = useCallback(
      (intent: Parameters<BotConversationSource["send"]>[1]) => {
        if (snapshot.descriptor.readOnly === true) {
          setSubmissionError("This historical group is read-only because a member no longer exists.");
          return false;
        }
        setSubmissionError(null);
        followLatest({ smooth: false });
        if (replayEnabled) {
          replay?.pause();
          setReplayEnabled(false);
        }
        void source.send(key, intent).catch((error) => {
          setSubmissionError(
            error instanceof Error ? error.message : String(error),
          );
        });
        return true;
      },
      [followLatest, identity, replay, replayEnabled, snapshot.descriptor.readOnly],
    );
    const cancel = useCallback(() => {
      if (replay !== undefined && replayEnabled) {
        replay.pause();
        return;
      }
      const executionId = latestBotPresenceFacts(effectivePresence).at(-1)?.executionId;
      if (executionId !== undefined) void source.cancel(key, executionId);
    }, [effectivePresence, identity, replay, replayEnabled]);
    const respondToInteraction = useCallback((
      interaction: BotInteractionSnapshot,
      response: BotInteractionResponse,
    ) => {
      setSubmissionError(null);
      setRespondingInteractionId(interaction.interactionId);
      void source.respondToInteraction(
        key,
        interaction.interactionId,
        interaction.executionId,
        response,
      ).catch((error) => {
        setSubmissionError(error instanceof Error ? error.message : String(error));
      }).finally(() => setRespondingInteractionId((current) =>
        current === interaction.interactionId ? null : current
      ));
    }, [identity]);
    const resolveAttachment = useCallback(
      (
        file: File,
        pending: Parameters<
          NonNullable<
            React.ComponentProps<typeof OpenCraftComposer>["onResolveAttachment"]
          >
        >[1],
      ) => {
        const uri = URL.createObjectURL(file);
        objectUrlsRef.current.add(uri);
        return { ...pending, uri, lifecycle: "ready" as const, error: null };
      },
      [],
    );

    if (!conversationReady) {
      return (
        <section className="bot-chat-stage bot-chat-stage--activation">
          <div className="bot-chat-activation" role={activationError === null ? "status" : "alert"}>
            <BotAvatar participant={bot} presentation="static" />
            <h2>{activationError === null ? "Opening Bot conversation…" : "Could not open Bot chat"}</h2>
            {activationError === null ? null : <p>{activationError}</p>}
            {activationError === null ? null : (
              <button onClick={() => setActivationAttempt((attempt) => attempt + 1)} type="button">
                Try again
              </button>
            )}
          </div>
        </section>
      );
    }

    return (
      <section
        className="bot-chat-stage"
        data-topology={snapshot.descriptor.topology}
      >
        <BotAvatarStage
          motionOverrides={replayProjection?.motionStates}
          presence={effectivePresence}
        >
          <header className="bot-chat-header">
            <div className="bot-chat-rail bot-chat-header__rail">
              <div className="bot-chat-header__identity">
                <BotAvatarMark
                  active={
                    replayProjection?.placement === "header" ||
                    replayProjection === null
                  }
                  followPointer
                  participant={bot}
                  size="large"
                />
                <span>
                  <strong>
                    {snapshot.descriptor.title ?? bot.displayName}
                  </strong>
                  <small>{bot.displayName}</small>
                </span>
              </div>
              <span className="bot-chat-header__actions">
                <span className="bot-chat-header__topology">
                  <UsersRound aria-hidden="true" size={14} />
                  {snapshot.descriptor.topology === "group"
                    ? `${snapshot.descriptor.participants.length} members`
                    : "Direct chat"}
                </span>
                {replay === undefined || replaySnapshot === null ? null : (
                  <button
                    aria-label={
                      replayEnabled && replaySnapshot.playing
                        ? "Pause conversation replay"
                        : "Replay conversation"
                    }
                    className="bot-chat-header__replay"
                    onClick={() => {
                      if (
                        !replayEnabled ||
                        replaySnapshot.scene.id === "complete"
                      ) {
                        setReplayEnabled(true);
                        replay.restart();
                      } else if (replaySnapshot.playing) replay.pause();
                      else replay.play();
                    }}
                    title={
                      replayEnabled && replaySnapshot.playing
                        ? "Pause replay"
                        : "Replay conversation"
                    }
                    type="button"
                  >
                    {replayEnabled && replaySnapshot.playing ? (
                      <Pause aria-hidden="true" size={15} />
                    ) : replaySnapshot.scene.id === "complete" ||
                      !replayEnabled ? (
                      <RotateCcw aria-hidden="true" size={15} />
                    ) : (
                      <Play aria-hidden="true" size={15} />
                    )}
                  </button>
                )}
              </span>
            </div>
          </header>
          <div
            className="bot-chat-transcript"
            ref={transcriptRef}
            role="log"
          >
            <div className="bot-chat-transcript__surface">
            <div className="bot-chat-rail bot-chat-transcript__rail">
              {snapshot.phase === "loading" ? (
                <p className="bot-chat-stage__status">Loading conversation…</p>
              ) : null}
              {viewport.historyLoading ? (
                <p className="bot-chat-stage__status">Loading earlier messages…</p>
              ) : viewport.historyError !== null ? (
                <div className="bot-chat-stage__error" role="alert">
                  <span>{viewport.historyError}</span>
                  <button className="bot-chat-stage__history-action" onClick={viewport.requestOlderHistory} type="button">Try again</button>
                </div>
              ) : timeline.units.length === 0 && snapshot.phase === "ready" && snapshot.history.hasOlder ? (
                <p className="bot-chat-stage__status">
                  <button className="bot-chat-stage__history-action" onClick={viewport.requestOlderHistory} type="button">Load earlier messages</button>
                </p>
              ) : null}
              {snapshot.phase === "error" ? (
                <div className="bot-chat-stage__error" role="alert">
                  <strong>Could not restore this Bot conversation</strong>
                  <span>{snapshot.error}</span>
                  <button onClick={() => void source.load(key).catch(() => undefined)} type="button">
                    Try again
                  </button>
                </div>
              ) : null}
              {timeline.units.length === 0 && snapshot.phase === "ready" && !snapshot.history.hasOlder ? (
                <div className="bot-chat-empty">
                  <h2>What should we work on?</h2>
                  <p>
                    Send a message to OpenCraft, or replay a short multi-Bot
                    collaboration.
                  </p>
                </div>
              ) : null}
              {timeline.units.length === 0 ? null : (
                <div
                  className="bot-chat-virtualizer-spacer"
                  style={{ height: viewport.totalHeightPx }}
                >
                  <div
                    className="bot-chat-virtualizer-window"
                    style={{ gap: viewport.gapPx, marginTop: viewport.marginTopPx }}
                  >
                    {viewport.units.map((unit) => (
                      <div className="bot-chat-virtualizer-row" key={unit.unitKey}>
                        <div ref={(element) => viewport.observeUnit(unit.unitKey, element)}>
                          <TimelineUnitRow
                            activeExecutionIds={activeExecutionIds}
                            enteringKeys={enteringMessageKeys}
                            latestBotMessageKeys={latestBotMessageKeys}
                            onApprove={() => replay?.next()}
                            participants={snapshot.descriptor.participants}
                            requiresApproval={
                              replayProjection?.requiresApproval === true &&
                              unit.kind === "execution" &&
                              unit.presence.length > 0
                            }
                            unit={unit}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {snapshot.interactions
                .filter((interaction) => interaction.status === "pending")
                .map((interaction) => (
                  <BotInteractionCard
                    busy={respondingInteractionId === interaction.interactionId}
                    interaction={interaction}
                    key={interaction.interactionId}
                    onRespond={(response) => respondToInteraction(interaction, response)}
                  />
                ))}
              {submissionError === null ? null : (
                <p className="bot-chat-stage__error" role="alert">
                  {submissionError}
                </p>
              )}
            </div>
            </div>
          </div>
          {!following ? (
            <button
              className="bot-chat-scroll-latest"
              onClick={() => followLatest()}
              type="button"
            >
              <ArrowDown aria-hidden="true" size={18} />
              <span>Latest message</span>
            </button>
          ) : null}
          <div className="bot-chat-composer-dock">
            <div className="bot-chat-rail bot-chat-composer-rail">
              {snapshot.descriptor.readOnly === true ? <p className="bot-chat-stage__status" role="status">This historical group is read-only because a member no longer exists.</p> : null}
              <OpenCraftComposer
                controller={composer}
                disabled={snapshot.descriptor.readOnly === true}
                isStreaming={isStreaming}
                onCancel={cancel}
                onResolveAttachment={resolveAttachment}
                onSubmit={submit}
                placeholder={`Message ${bot.displayName}`}
                portalContainer={options.portalContainer}
              />
            </div>
          </div>
        </BotAvatarStage>
      </section>
    );
  };
}
