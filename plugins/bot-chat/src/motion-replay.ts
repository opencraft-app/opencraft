import type {
  BotConversationMessage,
  BotExecutionSnapshot,
  BotTimelineProjection,
  BotParticipantSnapshot,
  BotPresenceFact,
  BotPresencePhase,
} from "@opencraft/bot-conversation";
import { projectBotTimeline } from "@opencraft/bot-conversation";
import type { ConversationKey } from "@opencraft/chat-core";

import {
  BOT_AVATAR_MOTION_STATES,
  type BotAvatarMotionState,
} from "./bot-avatar-motion";

export type BotReplayPlacement = "header" | "thread" | "group";
export type BotReplayTranscriptPhase =
  | "empty"
  | "request"
  | "group"
  | "streaming"
  | "complete";

type BotReplaySceneId =
  | BotAvatarMotionState
  | "reading"
  | "group"
  | "reviewing"
  | "blocked"
  | "replying-intro"
  | "replying-plan"
  | "replying-checks"
  | "complete";

export interface BotMotionReplayScene {
  readonly id: BotReplaySceneId;
  readonly label: string;
  readonly detail: string;
  readonly durationMs: number;
  readonly placement: BotReplayPlacement;
  readonly transcriptPhase: BotReplayTranscriptPhase;
  readonly terminal?: boolean;
  readonly facts: readonly {
    readonly participantId: string;
    readonly phase: BotPresencePhase;
    readonly verb: NonNullable<BotPresenceFact["activity"]>["verb"];
    readonly detail: string;
  }[];
}

export interface BotMotionReplaySnapshot {
  readonly revision: number;
  readonly sceneEpoch: number;
  readonly sceneIndex: number;
  readonly scene: BotMotionReplayScene;
  readonly playing: boolean;
  readonly remainingMs: number;
  readonly startedAtMs: number | null;
}

export interface BotMotionReplayScheduler {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface BotMotionReplayController {
  getSnapshot(): BotMotionReplaySnapshot;
  subscribe(listener: () => void): () => void;
  presenceFor(key: ConversationKey): readonly BotPresenceFact[];
  play(): void;
  pause(): void;
  restart(): void;
  next(): void;
  select(sceneId: BotMotionReplayScene["id"]): void;
  dispose(): void;
}

export interface BotMotionReplayProjection {
  readonly timeline: BotTimelineProjection;
  readonly placement: BotReplayPlacement;
  readonly requiresApproval: boolean;
  readonly motionStates: ReadonlyMap<string, BotAvatarMotionState>;
}

export const BOT_REPLAY_PARTICIPANTS: readonly BotParticipantSnapshot[] =
  Object.freeze([
    Object.freeze({
      participantId: "person:you",
      kind: "human",
      displayName: "You",
      avatar: Object.freeze({
        kind: "monogram",
        text: "Y",
        background: "#5b67df",
        foreground: "#ffffff",
      }),
    }),
    Object.freeze({
      participantId: "bot:opencraft",
      kind: "bot",
      displayName: "OpenCraft",
      avatar: Object.freeze({
        kind: "monogram",
        text: "O",
        background: "#17191c",
        foreground: "#ffffff",
      }),
    }),
    Object.freeze({
      participantId: "bot:nova",
      kind: "bot",
      displayName: "Nova",
      avatar: Object.freeze({
        kind: "monogram",
        text: "N",
        background: "#167c80",
        foreground: "#ffffff",
      }),
    }),
    Object.freeze({
      participantId: "bot:muse",
      kind: "bot",
      displayName: "Muse",
      avatar: Object.freeze({
        kind: "monogram",
        text: "M",
        background: "#7156b5",
        foreground: "#ffffff",
      }),
    }),
  ]);

type ReplayActivityVerb = NonNullable<BotPresenceFact["activity"]>["verb"];

function replayFact(
  participantId: string,
  phase: BotPresencePhase,
  verb: ReplayActivityVerb,
  detail: string,
) {
  return Object.freeze({ participantId, phase, verb, detail });
}

const MAIN_REPLAY_MOTIONS = new Set<string>([
  "idle",
  "spawning",
  "thinking",
  "searching",
  "working",
  "writing",
]);

const MOTION_SCENE_DETAILS: Partial<Record<BotAvatarMotionState, string>> =
  Object.freeze({
    sleeping: "Settling into a quiet resting pose",
    waking: "Returning with a compact wake gesture",
    listening: "Leaning toward the active speaker",
    excited: "Reacting with lifted, elastic energy",
    surprised: "Holding a brief wide-eyed response",
    suspicious: "Inspecting the request with an asymmetric glance",
    angry: "Showing a restrained high-tension response",
    drowsy: "Drifting through a slow low-energy pose",
    happy: "Responding with a soft buoyant expression",
    curious: "Following a new detail with an inquisitive lean",
    confused: "Searching for orientation with an uneven gaze",
    bored: "Waiting in a deliberately subdued pose",
    proud: "Holding a quiet, lifted completion pose",
    shy: "Turning away without losing the active identity",
    sad: "Lowering the actor into a gentle weighted pose",
    laughing: "Bouncing through a compact laughing gesture",
    scared: "Reacting with a tight high-frequency tremor",
    playful: "Using an asymmetric wink and elastic sway",
    celebrate: "Finishing with a bright celebration gesture",
    radar: "Sweeping for a remote result",
    progress: "Showing determinate work around the actor",
    humming: "Idling musically while retaining presence",
    loading: "Waiting on an indeterminate operation",
    dictating: "Following live speech input",
    receiving: "Receiving a message into the conversation",
    uploading: "Docking an attachment into the run",
    notifying: "Calling attention without becoming an error",
    alerting: "Holding a clear action-required state",
    bouncing: "Following a playful external impulse",
    dragging: "Remaining alive while being repositioned",
    "powering-down": "Closing the actor without abruptly removing it",
  });

function replaySemanticsForMotion(state: BotAvatarMotionState): {
  readonly phase: BotPresencePhase;
  readonly verb: ReplayActivityVerb;
} {
  if (state === "thinking") return { phase: "thinking", verb: "thinking" };
  if (state === "writing" || state === "dictating")
    return { phase: "typing", verb: "writing" };
  if (state === "searching" || state === "radar")
    return { phase: "working", verb: "searching" };
  if (state === "orbit" || state === "loading")
    return { phase: "waiting", verb: "waiting" };
  if (state === "spawning") return { phase: "working", verb: "spawning" };
  if (state === "alerting") return { phase: "blocked", verb: "waiting" };
  if (state === "sending" || state === "receiving" || state === "notifying")
    return { phase: "working", verb: "messaging" };
  return { phase: "working", verb: "running" };
}

function galleryScene(state: BotAvatarMotionState): BotMotionReplayScene {
  const semantics = replaySemanticsForMotion(state);
  const detail = MOTION_SCENE_DETAILS[state] ?? `Replaying the ${state} pose`;
  return Object.freeze({
    id: state,
    label: state
      .split("-")
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" "),
    detail,
    durationMs: 1_850,
    placement: "thread",
    transcriptPhase: "request",
    facts: Object.freeze([
      replayFact("bot:opencraft", semantics.phase, semantics.verb, detail),
    ]),
  });
}

/**
 * The default replay is a real work sequence. The remaining avatar vocabulary
 * stays addressable after the terminal scene, but autoplay never enters it.
 */
export const BOT_MOTION_REPLAY_SCENES: readonly BotMotionReplayScene[] =
  Object.freeze([
    Object.freeze({
      id: "idle",
      label: "Idle",
      detail: "Listening for your next idea",
      durationMs: 1_150,
      placement: "header",
      transcriptPhase: "empty",
      facts: Object.freeze([]),
    }),
    Object.freeze({
      id: "spawning",
      label: "Starting",
      detail: "Starting the task",
      durationMs: 850,
      placement: "thread",
      transcriptPhase: "request",
      facts: Object.freeze([
        replayFact("bot:opencraft", "working", "spawning", "Starting the task"),
      ]),
    }),
    Object.freeze({
      id: "thinking",
      label: "Thinking",
      detail: "Understanding the request",
      durationMs: 1_750,
      placement: "thread",
      transcriptPhase: "request",
      facts: Object.freeze([
        replayFact(
          "bot:opencraft",
          "thinking",
          "thinking",
          "Understanding the request",
        ),
      ]),
    }),
    Object.freeze({
      id: "searching",
      label: "Searching",
      detail: "Searching the workspace",
      durationMs: 1_850,
      placement: "thread",
      transcriptPhase: "request",
      facts: Object.freeze([
        replayFact(
          "bot:opencraft",
          "working",
          "searching",
          "Searching the workspace",
        ),
      ]),
    }),
    Object.freeze({
      id: "reading",
      label: "Reading",
      detail: "Reading the page structure",
      durationMs: 1_550,
      placement: "thread",
      transcriptPhase: "request",
      facts: Object.freeze([
        replayFact(
          "bot:opencraft",
          "working",
          "reading",
          "Reading the page structure",
        ),
      ]),
    }),
    Object.freeze({
      id: "working",
      label: "Editing",
      detail: "Updating the interaction",
      durationMs: 1_950,
      placement: "thread",
      transcriptPhase: "request",
      facts: Object.freeze([
        replayFact(
          "bot:opencraft",
          "working",
          "coding",
          "Updating the interaction",
        ),
      ]),
    }),
    Object.freeze({
      id: "group",
      label: "Collaborating",
      detail: "Three Bots work on one result",
      durationMs: 2_450,
      placement: "group",
      transcriptPhase: "group",
      facts: Object.freeze([
        replayFact(
          "bot:opencraft",
          "working",
          "running",
          "Coordinating the plan",
        ),
        replayFact(
          "bot:nova",
          "working",
          "searching",
          "Checking mobile breakpoints",
        ),
        replayFact(
          "bot:muse",
          "typing",
          "writing",
          "Drafting the rollout notes",
        ),
      ]),
    }),
    Object.freeze({
      id: "reviewing",
      label: "Reviewing",
      detail: "Checking the preview",
      durationMs: 1_650,
      placement: "thread",
      transcriptPhase: "group",
      facts: Object.freeze([
        replayFact(
          "bot:opencraft",
          "waiting",
          "waiting",
          "Checking the preview",
        ),
      ]),
    }),
    Object.freeze({
      id: "blocked",
      label: "Approval",
      detail: "Waiting for approval",
      durationMs: 1_750,
      placement: "thread",
      transcriptPhase: "group",
      facts: Object.freeze([
        replayFact(
          "bot:opencraft",
          "blocked",
          "waiting",
          "Waiting for approval",
        ),
      ]),
    }),
    Object.freeze({
      id: "writing",
      label: "Writing",
      detail: "Writing the final response",
      durationMs: 1_450,
      placement: "thread",
      transcriptPhase: "group",
      facts: Object.freeze([
        replayFact(
          "bot:opencraft",
          "typing",
          "writing",
          "Writing the final response",
        ),
      ]),
    }),
    Object.freeze({
      id: "replying-intro",
      label: "Replying",
      detail: "Streaming the response",
      durationMs: 560,
      placement: "thread",
      transcriptPhase: "streaming",
      facts: Object.freeze([]),
    }),
    Object.freeze({
      id: "replying-plan",
      label: "Replying",
      detail: "Streaming the response",
      durationMs: 680,
      placement: "thread",
      transcriptPhase: "streaming",
      facts: Object.freeze([]),
    }),
    Object.freeze({
      id: "replying-checks",
      label: "Replying",
      detail: "Streaming the response",
      durationMs: 760,
      placement: "thread",
      transcriptPhase: "streaming",
      facts: Object.freeze([]),
    }),
    Object.freeze({
      id: "complete",
      label: "Done",
      detail: "The response owns the transcript tail",
      durationMs: 1_850,
      placement: "thread",
      transcriptPhase: "complete",
      terminal: true,
      facts: Object.freeze([]),
    }),
    ...BOT_AVATAR_MOTION_STATES.filter(
      (state) => !MAIN_REPLAY_MOTIONS.has(state),
    ).map(galleryScene),
  ]);

function replayParticipant(
  participants: readonly BotParticipantSnapshot[],
  participantId: string,
): BotParticipantSnapshot {
  const participant = participants.find(
    (candidate) => candidate.participantId === participantId,
  );
  if (participant === undefined)
    throw new Error(`Missing replay participant: ${participantId}`);
  return participant;
}

function replayMessage(
  key: ConversationKey,
  participant: BotParticipantSnapshot,
  input: {
    readonly id: string;
    readonly text: string;
    readonly sentAtMs: number;
    readonly streaming?: boolean;
    readonly executionId: string | null;
    readonly causalMessageKey?: string | null;
  },
): BotConversationMessage {
  return Object.freeze({
    id: input.id,
    clientMessageId: input.id,
    executionId: input.executionId,
    causalMessageKey: input.causalMessageKey ?? null,
    conversationKey: Object.freeze({ ...key }),
    author: participant,
    content: Object.freeze([
      Object.freeze({ type: "text" as const, text: input.text }),
    ]),
    sentAtMs: input.sentAtMs,
    delivery: "sent",
    streaming: input.streaming ?? false,
  });
}

const RESPONSE_LINES = [
  "检查完成，可以按两阶段发布：",
  "",
  "- 先向 10% 用户开放，观察登录成功率与移动端布局",
  "- 保留上一版本静态资源，异常时可直接切回",
  "- 发布后持续检查错误率、首屏耗时和会话恢复",
] as const;

function responseForScene(sceneId: BotReplaySceneId): string {
  if (sceneId === "replying-intro") return RESPONSE_LINES[0];
  if (sceneId === "replying-plan") return RESPONSE_LINES.slice(0, 3).join("\n");
  if (sceneId === "replying-checks")
    return RESPONSE_LINES.slice(0, 4).join("\n");
  return RESPONSE_LINES.join("\n");
}

const MOTION_STATE_SET = new Set<string>(BOT_AVATAR_MOTION_STATES);

function motionForScene(sceneId: BotReplaySceneId): BotAvatarMotionState {
  if (MOTION_STATE_SET.has(sceneId)) return sceneId as BotAvatarMotionState;
  if (sceneId === "reading") return "radar";
  if (sceneId === "reviewing") return "orbit";
  if (sceneId === "blocked") return "alerting";
  if (sceneId.startsWith("replying-")) return "sending";
  return "idle";
}

/** Converts the deterministic clock into the same immutable facts as a source. */
export function projectBotMotionReplay(
  snapshot: BotMotionReplaySnapshot,
  key: ConversationKey,
  participants: readonly BotParticipantSnapshot[],
  presence: readonly BotPresenceFact[],
): BotMotionReplayProjection {
  const promptMessageKey = "replay:user:launch-brief";
  const executionId = (participantId: string) =>
    `bot-motion-replay:release-plan:${participantId}`;
  const messages: BotConversationMessage[] = [];
  const motionStates = new Map<string, BotAvatarMotionState>();
  const human = replayParticipant(participants, "person:you");
  const opencraft = replayParticipant(participants, "bot:opencraft");
  const nova = replayParticipant(participants, "bot:nova");
  const muse = replayParticipant(participants, "bot:muse");

  if (snapshot.scene.id === "group") {
    motionStates.set("bot:opencraft", "working");
    motionStates.set("bot:nova", "searching");
    motionStates.set("bot:muse", "writing");
  } else {
    motionStates.set("bot:opencraft", motionForScene(snapshot.scene.id));
  }

  if (snapshot.scene.transcriptPhase !== "empty") {
    messages.push(
      replayMessage(key, human, {
        id: "replay:user:launch-brief",
        executionId: null,
        sentAtMs: 1,
        text: "帮我整理新版登陆页的发布计划，重点检查移动端体验和回滚路径。",
      }),
    );
  }
  if (
    snapshot.scene.transcriptPhase === "group" ||
    snapshot.scene.transcriptPhase === "streaming" ||
    snapshot.scene.transcriptPhase === "complete"
  ) {
    messages.push(
      replayMessage(key, nova, {
        id: "replay:nova:mobile",
        executionId: executionId(nova.participantId),
        causalMessageKey: promptMessageKey,
        sentAtMs: 2,
        text: "我来核对移动端断点和触控路径。",
      }),
      replayMessage(key, muse, {
        id: "replay:muse:rollout",
        executionId: executionId(muse.participantId),
        causalMessageKey: promptMessageKey,
        sentAtMs: 3,
        text: "我来整理灰度发布和回滚清单。",
      }),
    );
  }
  if (
    snapshot.scene.transcriptPhase === "streaming" ||
    snapshot.scene.transcriptPhase === "complete"
  ) {
    messages.push(
      replayMessage(key, opencraft, {
        id: "replay:opencraft:release-plan",
        executionId: executionId(opencraft.participantId),
        causalMessageKey: promptMessageKey,
        sentAtMs: 4,
        text: responseForScene(snapshot.scene.id),
        streaming: snapshot.scene.transcriptPhase === "streaming",
      }),
    );
    if (snapshot.scene.transcriptPhase === "complete") {
      messages.push(
        replayMessage(key, opencraft, {
          id: "replay:opencraft:release-ready",
          executionId: executionId(opencraft.participantId),
          causalMessageKey: promptMessageKey,
          sentAtMs: 5,
          text: "清单已经排好。你确认后，我会从小流量发布开始。",
        }),
      );
    }
  }

  const executionParticipants = new Set([
    ...messages.flatMap((message) =>
      message.executionId === null ? [] : [message.author.participantId]
    ),
    ...presence.map((fact) => fact.participantId),
  ]);
  const executions: BotExecutionSnapshot[] = [...executionParticipants].map(
    (participantId) => Object.freeze({
      executionId: executionId(participantId),
      conversationKey: Object.freeze({ ...key }),
      participantId,
      causalMessageKey: promptMessageKey,
      status: presence.some(
        (fact) =>
          fact.participantId === participantId && fact.phase !== "idle",
      ) ? "running" : "completed",
      startedAtMs: 2,
      completedAtMs: snapshot.scene.transcriptPhase === "complete" ? 5 : null,
    }),
  );

  return Object.freeze({
    timeline: projectBotTimeline({
      transcript: Object.freeze(messages),
      executions: Object.freeze(executions),
      presence,
      revision: snapshot.revision,
    }),
    placement: snapshot.scene.placement,
    requiresApproval: snapshot.scene.id === "blocked",
    motionStates,
  });
}

function browserScheduler(): BotMotionReplayScheduler {
  return {
    now: () => performance.now(),
    schedule(delayMs, callback) {
      const handle = globalThis.setTimeout(callback, delayMs);
      return () => globalThis.clearTimeout(handle);
    },
  };
}

export function createBotMotionReplayController(
  scheduler: BotMotionReplayScheduler = browserScheduler(),
): BotMotionReplayController {
  const listeners = new Set<() => void>();
  let revision = 0;
  let sceneEpoch = 0;
  let sceneIndex = 0;
  let remainingMs = BOT_MOTION_REPLAY_SCENES[0]!.durationMs;
  let startedAtMs: number | null = null;
  let playing = false;
  let disposed = false;
  let cancelTimer: (() => void) | null = null;
  let snapshot: BotMotionReplaySnapshot;

  const rebuild = () => {
    snapshot = Object.freeze({
      revision,
      sceneEpoch,
      sceneIndex,
      scene: BOT_MOTION_REPLAY_SCENES[sceneIndex]!,
      playing,
      remainingMs,
      startedAtMs,
    });
  };
  const publish = () => {
    revision += 1;
    rebuild();
    for (const listener of listeners) listener();
  };
  const stopTimer = () => {
    cancelTimer?.();
    cancelTimer = null;
  };
  const scheduleCurrent = () => {
    stopTimer();
    if (!playing || disposed) return;
    startedAtMs = scheduler.now();
    cancelTimer = scheduler.schedule(remainingMs, () => {
      cancelTimer = null;
      const scene = BOT_MOTION_REPLAY_SCENES[sceneIndex]!;
      if (scene.terminal || sceneIndex === BOT_MOTION_REPLAY_SCENES.length - 1) {
        playing = false;
        startedAtMs = null;
        publish();
        return;
      }
      sceneIndex += 1;
      sceneEpoch += 1;
      remainingMs = BOT_MOTION_REPLAY_SCENES[sceneIndex]!.durationMs;
      startedAtMs = scheduler.now();
      publish();
      scheduleCurrent();
    });
  };
  const moveTo = (nextIndex: number, continuePlaying: boolean) => {
    stopTimer();
    sceneIndex =
      (nextIndex + BOT_MOTION_REPLAY_SCENES.length) %
      BOT_MOTION_REPLAY_SCENES.length;
    sceneEpoch += 1;
    remainingMs = BOT_MOTION_REPLAY_SCENES[sceneIndex]!.durationMs;
    playing = continuePlaying;
    startedAtMs = playing ? scheduler.now() : null;
    publish();
    scheduleCurrent();
  };

  rebuild();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    presenceFor(key) {
      const now = scheduler.now();
      return snapshot.scene.facts.map((fact, index) =>
        Object.freeze({
          conversationKey: key,
          participantId: fact.participantId,
          executionId: `bot-motion-replay:release-plan:${fact.participantId}`,
          seq: index + 1,
          phase: fact.phase,
          activity: Object.freeze({
            verb: fact.verb,
            detail: fact.detail,
            targetParticipantId: "person:you",
          }),
          observedAtMs: now,
          expiresAtMs: now + snapshot.scene.durationMs + 1_000,
        }),
      );
    },
    play() {
      if (disposed || playing) return;
      playing = true;
      startedAtMs = scheduler.now();
      publish();
      scheduleCurrent();
    },
    pause() {
      if (disposed || !playing) return;
      if (startedAtMs !== null) {
        remainingMs = Math.max(
          1,
          remainingMs - (scheduler.now() - startedAtMs),
        );
      }
      playing = false;
      startedAtMs = null;
      stopTimer();
      publish();
    },
    restart() {
      if (disposed) return;
      moveTo(0, true);
    },
    next() {
      if (disposed) return;
      moveTo(sceneIndex + 1, playing);
    },
    select(sceneId) {
      if (disposed) return;
      const nextIndex = BOT_MOTION_REPLAY_SCENES.findIndex(
        (scene) => scene.id === sceneId,
      );
      if (nextIndex >= 0) moveTo(nextIndex, false);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopTimer();
      listeners.clear();
    },
  };
}
