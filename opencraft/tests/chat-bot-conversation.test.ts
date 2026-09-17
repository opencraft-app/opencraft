import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  botMessageStableKey,
  botMessageText,
  createInMemoryBotConversationSource,
  latestBotPresenceFacts,
  projectBotTimeline,
  type BotConversationScheduler,
  type BotPresenceFact,
  type BotTimelineProjection,
} from "@opencraft/bot-conversation";
import { createConversationKey } from "@opencraft/chat-core";
import type { SubmitIntent } from "@opencraft/composer-core";
import {
  BOT_AVATAR_MOTION,
  BOT_AVATAR_MOTION_STATES,
  botAvatarContinuousPose,
  botAvatarMotionState,
} from "../plugins/bot-chat/src/bot-avatar-motion";
import {
  BOT_MOTION_REPLAY_SCENES,
  BOT_REPLAY_PARTICIPANTS,
  createBotMotionReplayController,
  projectBotMotionReplay,
} from "../plugins/bot-chat/src/motion-replay";
import { projectBotActivityIndicator } from "../plugins/bot-chat/src/bot-activity-indicator";

class ManualScheduler implements BotConversationScheduler {
  private clock = 1_000;
  private sequence = 0;
  private readonly tasks = new Map<
    number,
    { readonly due: number; readonly callback: () => void }
  >();

  now = () => this.clock;

  schedule(delayMs: number, callback: () => void): () => void {
    const id = ++this.sequence;
    this.tasks.set(id, { due: this.clock + delayMs, callback });
    return () => {
      this.tasks.delete(id);
    };
  }

  advance(delayMs: number): void {
    const target = this.clock + delayMs;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= target)
        .sort(
          (left, right) => left[1].due - right[1].due || left[0] - right[0],
        )[0];
      if (next === undefined) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.clock = task.due;
      task.callback();
    }
    this.clock = target;
  }
}

function intent(
  threadId = "bot-thread",
  text = "Build a calm group chat",
): SubmitIntent {
  return {
    commandId: "command-1",
    clientMessageId: "client-message-1",
    target: {
      type: "existing-thread",
      key: createConversationKey("bot-host", threadId),
    },
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: [{ type: "text", text }] }],
    },
    attachments: [],
    context: [],
    selections: {},
    options: { autoContext: true },
    createdAt: 1_000,
  };
}

function timelineMessages(projection: BotTimelineProjection) {
  return projection.units.flatMap((unit) =>
    unit.kind === "message"
      ? unit.messageRuns.flatMap((run) =>
          run.messages.map((message) => message.message),
        )
      : [],
  );
}

test("Bot Source publishes the optimistic message before transient Presence", async () => {
  const scheduler = new ManualScheduler();
  const source = createInMemoryBotConversationSource({
    scheduler,
    createId: () => "assistant-1",
  });
  const key = createConversationKey("bot-host", "bot-thread");
  const revisions: Array<{
    readonly messages: number;
    readonly presence: number;
  }> = [];
  source.subscribe(key, () => {
    const snapshot = source.getSnapshot(key);
    revisions.push({
      messages: snapshot.transcript.length,
      presence: snapshot.presence.length,
    });
  });

  await source.load(key);
  const sendPromise = source.send(key, intent());
  const submitted = source.getSnapshot(key);

  assert.equal(submitted.transcript.length, 1);
  assert.equal(submitted.presence.length, 1);
  assert.equal(submitted.transcript[0]?.delivery, "sending");
  assert.equal(submitted.executions.length, 1);
  assert.equal(submitted.executions[0]?.causalMessageKey, "client-message-1");
  assert.equal(
    revisions.some(
      (revision) => revision.presence > 0 && revision.messages === 0,
    ),
    false,
  );
  await sendPromise;
  source.dispose();
});

test("acknowledgement changes server identity without remounting the optimistic row", async () => {
  const scheduler = new ManualScheduler();
  const source = createInMemoryBotConversationSource({ scheduler });
  const key = createConversationKey("bot-host", "bot-thread");
  await source.load(key);
  await source.send(key, intent());
  const optimistic = source.getSnapshot(key).transcript[0]!;

  scheduler.advance(80);
  const acknowledged = source.getSnapshot(key).transcript[0]!;

  assert.notEqual(acknowledged.id, optimistic.id);
  assert.equal(acknowledged.delivery, "sent");
  assert.equal(
    botMessageStableKey(acknowledged),
    botMessageStableKey(optimistic),
  );
  source.dispose();
});

test("Presence remains outside history while the assistant reply streams deterministically", async () => {
  const scheduler = new ManualScheduler();
  const response = "One stable response.";
  const source = createInMemoryBotConversationSource({
    scheduler,
    response: () => response,
  });
  const key = createConversationKey("bot-host", "bot-thread");
  await source.load(key);
  await source.send(key, intent());

  scheduler.advance(260);
  let snapshot = source.getSnapshot(key);
  assert.equal(snapshot.transcript.length, 2);
  assert.equal(snapshot.transcript[1]?.streaming, true);
  assert.equal(snapshot.presence[0]?.phase, "typing");

  scheduler.advance(2_000);
  snapshot = source.getSnapshot(key);
  assert.equal(snapshot.transcript.length, 2);
  assert.equal(snapshot.presence.length, 0);
  assert.equal(snapshot.transcript[1]?.streaming, false);
  assert.equal(botMessageText(snapshot.transcript[1]!), response);
  assert.equal(snapshot.executions[0]?.status, "completed");
  source.dispose();
});

test("cancel owns the active run and leaves no streaming projection behind", async () => {
  const scheduler = new ManualScheduler();
  const source = createInMemoryBotConversationSource({
    scheduler,
    response: () => "a response in progress",
  });
  const key = createConversationKey("bot-host", "bot-thread");
  await source.load(key);
  await source.send(key, intent());
  scheduler.advance(260);
  const executionId = source.getSnapshot(key).presence[0]!.executionId;

  await source.cancel(key, executionId);
  scheduler.advance(2_000);
  const snapshot = source.getSnapshot(key);

  assert.equal(snapshot.presence.length, 0);
  assert.equal(
    snapshot.transcript.some((message) => message.streaming),
    false,
  );
  source.dispose();
});

test("a Source rejects submissions owned by another Conversation", async () => {
  const source = createInMemoryBotConversationSource();
  const key = createConversationKey("bot-host", "bot-thread");
  await assert.rejects(
    source.send(key, intent("another-thread")),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "TARGET_MISMATCH");
      return true;
    },
  );
  source.dispose();
});

test("Presence projection keeps the latest fact for every participant", () => {
  const key = createConversationKey("bot-host", "group-thread");
  const fact = (
    participantId: string,
    seq: number,
    observedAtMs: number,
  ): BotPresenceFact => ({
    conversationKey: key,
    participantId,
    executionId: `execution:${participantId}`,
    seq,
    phase: seq > 1 ? "typing" : "thinking",
    activity: null,
    observedAtMs,
    expiresAtMs: observedAtMs + 30_000,
  });

  const projected = latestBotPresenceFacts([
    fact("bot:b", 1, 1_010),
    fact("bot:a", 2, 1_020),
    fact("bot:a", 1, 1_000),
    fact("bot:b", 2, 1_030),
  ]);

  assert.deepEqual(
    projected.map((item) => [item.participantId, item.seq]),
    [
      ["bot:a", 2],
      ["bot:b", 2],
    ],
  );
});

test("Presence sequence remains authoritative when one run is replayed out of order", () => {
  const key = createConversationKey("bot-host", "replayed-thread");
  const base = {
    conversationKey: key,
    participantId: "bot:a",
    executionId: "execution:a",
    activity: null,
    expiresAtMs: 40_000,
  } as const;
  const projected = latestBotPresenceFacts([
    { ...base, seq: 4, phase: "typing", observedAtMs: 10_000 },
    { ...base, seq: 2, phase: "thinking", observedAtMs: 12_000 },
  ]);

  assert.equal(projected[0]?.seq, 4);
  assert.equal(projected[0]?.phase, "typing");
});

test("Bot motion replay advances deterministically and can pause without losing its scene", () => {
  const scheduler = new ManualScheduler();
  const replay = createBotMotionReplayController(scheduler);
  const revisions: string[] = [];
  replay.subscribe(() => revisions.push(replay.getSnapshot().scene.id));

  replay.play();
  scheduler.advance(BOT_MOTION_REPLAY_SCENES[0]!.durationMs);
  assert.equal(replay.getSnapshot().scene.id, "spawning");

  scheduler.advance(400);
  const executionIdBeforePause = replay.presenceFor(
    createConversationKey("bot-preview", "pause-run"),
  )[0]?.executionId;
  replay.pause();
  const paused = replay.getSnapshot();
  replay.play();
  const executionIdAfterResume = replay.presenceFor(
    createConversationKey("bot-preview", "pause-run"),
  )[0]?.executionId;
  replay.pause();
  scheduler.advance(10_000);
  assert.equal(replay.getSnapshot().scene.id, "spawning");
  assert.equal(replay.getSnapshot().remainingMs, paused.remainingMs);
  assert.equal(executionIdAfterResume, executionIdBeforePause);
  assert.deepEqual(revisions.slice(0, 5), [
    "idle",
    "spawning",
    "spawning",
    "spawning",
    "spawning",
  ]);
  replay.dispose();
});

test("Bot motion replay retains every active group participant", () => {
  const scheduler = new ManualScheduler();
  const replay = createBotMotionReplayController(scheduler);
  const key = createConversationKey("bot-preview", "motion-lab");

  replay.select("group");
  const presence = replay.presenceFor(key);

  assert.deepEqual(
    presence.map((fact) => fact.participantId),
    ["bot:vela", "bot:nova", "bot:muse"],
  );
  assert.equal(replay.getSnapshot().playing, false);
  assert.equal(new Set(presence.map((fact) => fact.executionId)).size, 3);
  replay.dispose();
});

test("Bot motion replay covers the complete current Grok motion vocabulary", () => {
  const sceneIds = new Set(BOT_MOTION_REPLAY_SCENES.map((scene) => scene.id));

  assert.equal(BOT_AVATAR_MOTION_STATES.length, 39);
  for (const state of BOT_AVATAR_MOTION_STATES) {
    assert.equal(sceneIds.has(state), true, `missing replay scene: ${state}`);
    assert.ok(BOT_AVATAR_MOTION[state]);
    const pose = botAvatarContinuousPose(state, 1_234);
    assert.equal(
      Object.values(pose).every(Number.isFinite),
      true,
      `non-finite pose: ${state}`,
    );
  }
  assert.equal(BOT_AVATAR_MOTION.thinking.effect, "dots");
  assert.equal(BOT_AVATAR_MOTION.radar.effect, "radar");
  assert.equal(BOT_AVATAR_MOTION.dictating.effect, "wave");
  assert.equal(BOT_AVATAR_MOTION["powering-down"].effect, "standby");
});

test("semantic Presence never fabricates celebration on ordinary completion", () => {
  const fact: BotPresenceFact = {
    conversationKey: createConversationKey("bot-preview", "celebration-policy"),
    participantId: "bot:vela",
    executionId: "execution",
    seq: 1,
    phase: "working",
    activity: null,
    observedAtMs: 1,
    expiresAtMs: 2,
  };
  for (const phase of [
    "idle",
    "thinking",
    "working",
    "typing",
    "waiting",
    "blocked",
  ] as const) {
    assert.notEqual(
      botAvatarMotionState(phase, { ...fact, phase }),
      "celebrate",
    );
  }
});

test("replay visual state remains presentation-only and does not rewrite Presence", () => {
  const scheduler = new ManualScheduler();
  const replay = createBotMotionReplayController(scheduler);
  const key = createConversationKey("bot-preview", "presentation-seam");

  replay.select("playful");
  const presence = replay.presenceFor(key);
  const projection = projectBotMotionReplay(
    replay.getSnapshot(),
    key,
    BOT_REPLAY_PARTICIPANTS,
    presence,
  );

  assert.equal(presence[0]?.phase, "working");
  assert.equal(presence[0]?.activity?.verb, "running");
  assert.equal(projection.motionStates.get("bot:vela"), "playful");
  replay.dispose();
});

test("Bot motion replay projects a monotonic product transcript instead of debug scenes", () => {
  const scheduler = new ManualScheduler();
  const replay = createBotMotionReplayController(scheduler);
  const key = createConversationKey("bot-preview", "replay-thread");

  replay.select("group");
  const group = projectBotMotionReplay(
    replay.getSnapshot(),
    key,
    BOT_REPLAY_PARTICIPANTS,
    replay.presenceFor(key),
  );
  assert.deepEqual(
    timelineMessages(group.timeline).map((message) => message.id),
    ["replay:user:launch-brief", "replay:nova:mobile", "replay:muse:rollout"],
  );
  assert.equal(group.placement, "group");

  replay.select("complete");
  const complete = projectBotMotionReplay(
    replay.getSnapshot(),
    key,
    BOT_REPLAY_PARTICIPANTS,
    replay.presenceFor(key),
  );
  assert.deepEqual(
    timelineMessages(complete.timeline)
      .slice(0, 3)
      .map((message) => message.id),
    timelineMessages(group.timeline).map((message) => message.id),
  );
  assert.equal(
    timelineMessages(complete.timeline).at(-2)?.id,
    "replay:vela:release-plan",
  );
  assert.equal(timelineMessages(complete.timeline).at(-2)?.streaming, false);
  assert.equal(
    timelineMessages(complete.timeline).at(-1)?.id,
    "replay:vela:release-ready",
  );
  replay.dispose();
});

test("Bot replay hands activity to one stable streaming assistant message", () => {
  const scheduler = new ManualScheduler();
  const replay = createBotMotionReplayController(scheduler);
  const key = createConversationKey("bot-preview", "replay-thread");

  replay.select("replying-checks");
  const streaming = projectBotMotionReplay(
    replay.getSnapshot(),
    key,
    BOT_REPLAY_PARTICIPANTS,
    replay.presenceFor(key),
  );
  replay.select("complete");
  const complete = projectBotMotionReplay(
    replay.getSnapshot(),
    key,
    BOT_REPLAY_PARTICIPANTS,
    replay.presenceFor(key),
  );

  const streamingReply = timelineMessages(streaming.timeline).find(
    (message) => message.id === "replay:vela:release-plan",
  )!;
  const completedReply = timelineMessages(complete.timeline).find(
    (message) => message.id === "replay:vela:release-plan",
  )!;
  assert.equal(streamingReply.delivery, "sent");
  assert.equal(streamingReply.streaming, true);
  assert.equal(
    botMessageStableKey(streamingReply),
    botMessageStableKey(completedReply),
  );
  assert.equal(
    botMessageText(completedReply).startsWith(botMessageText(streamingReply)),
    true,
  );
  replay.dispose();
});

test("bubble adjacency is projected once from transcript order", () => {
  const scheduler = new ManualScheduler();
  const replay = createBotMotionReplayController(scheduler);
  const key = createConversationKey("bot-preview", "bubble-runs");
  replay.select("complete");
  const projection = projectBotMotionReplay(
    replay.getSnapshot(),
    key,
    BOT_REPLAY_PARTICIPANTS,
    replay.presenceFor(key),
  );
  const opencraftRuns = projection.timeline.units.flatMap((unit) =>
    unit.kind === "message" &&
    unit.messageRuns[0]?.author.participantId === "bot:vela"
      ? unit.messageRuns
      : [],
  );

  assert.equal(opencraftRuns.length, 2);
  assert.deepEqual(
    opencraftRuns
      .flatMap((run) => run.messages)
      .map((message) => ({
        previous: message.continuedFromPrevious,
        next: message.continuedToNext,
        start: message.runStart,
        end: message.groupEnd,
      })),
    [
      { previous: false, next: true, start: true, end: false },
      { previous: true, next: false, start: true, end: true },
    ],
  );
  replay.dispose();
});

test("Presence projects into its exact execution activity owner", () => {
  const key = createConversationKey("bot-host", "bot-thread");
  const fact: BotPresenceFact = {
    conversationKey: key,
    participantId: "bot:vela",
    executionId: "execution:1",
    seq: 1,
    phase: "typing",
    activity: {
      verb: "writing",
      detail: "Writing a reply",
      targetParticipantId: "person:you",
    },
    observedAtMs: 1_000,
    expiresAtMs: 31_000,
  };

  const model = projectBotActivityIndicator([fact], BOT_REPLAY_PARTICIPANTS);
  assert.equal(model?.mode, "typing");
  assert.equal(model?.entries.length, 1);
  assert.equal(model?.entries[0]?.label, "Writing a reply");
  assert.equal(model?.semanticKey, "execution:1:bot:vela:typing:writing");
});

test("working Presence without a detailed activity keeps the Bot identity in the live label", () => {
  const key = createConversationKey("bot-host", "bot-thread");
  const fact: BotPresenceFact = {
    conversationKey: key,
    participantId: "bot:vela",
    executionId: "execution:2",
    seq: 2,
    phase: "working",
    activity: null,
    observedAtMs: 2_000,
    expiresAtMs: 32_000,
  };

  const model = projectBotActivityIndicator([fact], BOT_REPLAY_PARTICIPANTS);
  assert.equal(model?.entries[0]?.label, "OpenCraft is working…");
});

test("group fan-out keeps one stable layout unit per execution", () => {
  const scheduler = new ManualScheduler();
  const replay = createBotMotionReplayController(scheduler);
  const key = createConversationKey("bot-preview", "execution-fan-out");
  replay.select("group");
  const projection = projectBotMotionReplay(
    replay.getSnapshot(),
    key,
    BOT_REPLAY_PARTICIPANTS,
    replay.presenceFor(key),
  );
  const executionUnits = projection.timeline.units.filter(
    (unit) => unit.kind === "execution",
  );

  assert.equal(executionUnits.length, 3);
  assert.equal(new Set(executionUnits.map((unit) => unit.unitKey)).size, 3);
  for (const unit of executionUnits) {
    assert.equal(
      unit.presence.every(
        (fact) => fact.executionId === unit.execution.executionId,
      ),
      true,
    );
  }
  replay.dispose();
});

test("Transcript append order is authority even when participant clocks disagree", () => {
  const scheduler = new ManualScheduler();
  const replay = createBotMotionReplayController(scheduler);
  const key = createConversationKey("bot-preview", "clock-skew");
  replay.select("complete");
  const complete = projectBotMotionReplay(
    replay.getSnapshot(),
    key,
    BOT_REPLAY_PARTICIPANTS,
    replay.presenceFor(key),
  );
  const transcript = timelineMessages(complete.timeline)
    .slice(0, 3)
    .map((message, index) => ({
      ...message,
      // Deliberately make later append positions look older. Wall-clock time
      // is metadata, never authority for an already ordered transcript.
      sentAtMs: 3_000 - index * 1_000,
    }));

  const projected = projectBotTimeline({
    transcript,
    executions: [],
    presence: [],
    revision: 1,
  });

  assert.deepEqual(
    timelineMessages(projected).map((message) => message.id),
    transcript.map((message) => message.id),
  );
  assert.equal(
    projected.units
      .filter((unit) => unit.kind === "message")
      .every((unit) => unit.messageRuns.length === 1),
    true,
  );
  replay.dispose();
});

test("Bot motion replay stops on the completed conversation until explicitly restarted", () => {
  const scheduler = new ManualScheduler();
  const replay = createBotMotionReplayController(scheduler);
  replay.select("complete");
  replay.play();

  scheduler.advance(
    BOT_MOTION_REPLAY_SCENES.find((scene) => scene.id === "complete")!
      .durationMs,
  );

  assert.equal(replay.getSnapshot().scene.id, "complete");
  assert.equal(replay.getSnapshot().playing, false);
  replay.dispose();
});

test("Bot avatar animation uses persistent sources with local flow-owned mirrors", () => {
  const stageSource = readFileSync(
    new URL("../plugins/bot-chat/src/bot-avatar-stage.tsx", import.meta.url),
    "utf8",
  );
  const avatarSource = readFileSync(
    new URL("../plugins/bot-chat/src/bot-avatar.tsx", import.meta.url),
    "utf8",
  );
  const runtimeSource = readFileSync(
    new URL("../plugins/bot-chat/src/bot-avatar-runtime.ts", import.meta.url),
    "utf8",
  );
  const styles = readFileSync(
    new URL("../plugins/bot-chat/src/styles.scss", import.meta.url),
    "utf8",
  );

  assert.match(stageSource, /<use\b[\s\S]*?\bhref=/);
  assert.match(stageSource, /bot-chat-mark-sources/);
  assert.match(stageSource, /ResizeObserver/);
  assert.match(stageSource, /IntersectionObserver/);
  assert.doesNotMatch(
    avatarSource,
    /getBoundingClientRect|requestAnimationFrame/,
  );
  assert.match(runtimeSource, /class BotAvatarScheduler/);
  assert.match(
    styles,
    /\.bot-chat-mark-anchor\s*\{[\s\S]*display: inline-grid/,
  );
  assert.doesNotMatch(
    styles,
    /\[data-effect="(?:dots|orbit|radar|progress|gather|wave|send|receive|dock|ball|whirl|pencil|bang|standby)"\][\s\S]{0,180}?infinite/,
  );
  assert.doesNotMatch(styles, /\.bot-chat-mark-actor/);
});
