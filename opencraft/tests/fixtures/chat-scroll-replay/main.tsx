import { Context } from "@deepseek-ai/cordis";
import type { TimelineFrame, TimelineTurnView } from "@opencraft/chat-core";
import {
  TimelineBlockRendererProvider,
  TimelineBlockRendererRegistryService,
} from "@opencraft/timeline-render-react";
import { WebConversationViewportOwner } from "@opencraft/timeline-host-web";
import { TurnResponsePositioningController } from "@opencraft/timeline-virtualizer";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  Conversation,
  type ConversationScrollApi,
} from "../../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import "../../../apps/workbench-web/src/styles/app.scss";

const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);

const diagnosticEvents: unknown[] = [];
const originalReduceFollow = TurnResponsePositioningController.prototype.reduceFollow;
TurnResponsePositioningController.prototype.reduceFollow = function (event) {
  const before = this.getFollowState().followMode;
  const result = originalReduceFollow.call(this, event);
  diagnosticEvents.push({ type: "follow", before, event, after: result.followMode, at: performance.now() });
  return result;
};
const originalTransitionPhase = TurnResponsePositioningController.prototype.transitionLatestTurnPhase;
TurnResponsePositioningController.prototype.transitionLatestTurnPhase = function (previous, next) {
  const before = this.getFollowState().followMode;
  const result = originalTransitionPhase.call(this, previous, next);
  diagnosticEvents.push({ type: "phase", previous, next, before, result, at: performance.now() });
  return result;
};
const originalSetLatestTurnMeasurementListener = WebConversationViewportOwner.prototype.setLatestTurnMeasurementListener;
WebConversationViewportOwner.prototype.setLatestTurnMeasurementListener = function (listener) {
  return originalSetLatestTurnMeasurementListener.call(this, listener === null ? null : (change) => {
    const scroll = this.scrollElementRef.current;
    diagnosticEvents.push({
      type: "measurement",
      kind: change.kind,
      turnKey: change.turnKey,
      height: change.kind === "turn-height" ? change.heightPx : change.followContentHeightPx,
      target: change.element?.className ?? null,
      targetBottom: change.element?.getBoundingClientRect().bottom ?? null,
      viewportBottom: scroll?.getBoundingClientRect().bottom ?? null,
      footerPadding: this.getFooterScrollPaddingPx(),
      at: performance.now(),
    });
    listener(change);
  });
};

type ReplayStage = "history" | "prework" | "final" | "complete";
type ReplayScenario = "stable" | "remount-on-first-text" | "shrink-on-first-text";

declare global {
  interface Window {
    chatScrollReplay: {
      firstText(): void;
      complete(): void;
      getTrace(): readonly ReplayTrace[];
      getDiagnosticEvents(): readonly unknown[];
      nextTurn(): void;
      reset(): void;
      scrollToBottom(): void;
      setScenario(scenario: ReplayScenario): void;
      start(): void;
    };
  }
}

interface ReplayTrace {
  readonly at: number;
  readonly source: string;
  readonly stage: ReplayStage;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly distanceFromBottom: number;
  readonly spacerHeight: number;
  readonly followBottom: number | null;
  readonly viewportBottom: number;
  readonly footerPadding: number;
}

function frame(id: string, type: TimelineFrame["type"], blocks: TimelineFrame["blocks"]): TimelineFrame {
  return {
    id,
    turnId: id.split(":")[0]!,
    type,
    status: "streaming",
    anchors: [],
    blocks,
    hookStats: null,
  } as TimelineFrame;
}

function turn(turnKey: string, status: TimelineTurnView["status"], frames: readonly TimelineFrame[]): TimelineTurnView {
  return { type: "turn", turnKey, turnId: turnKey, status, frames } as TimelineTurnView;
}

const historyTurns = Array.from({ length: 5 }, (_, index) => turn(
  `history-${index}`,
  "completed",
  [frame(`history-${index}:assistant`, "assistant", [{
    id: `history-${index}:text`,
    type: "text",
    phase: "final_answer",
    text: `Historical turn ${index} `.repeat(28),
    streaming: false,
    sourceItemIds: [`history-${index}:text`],
  }] as TimelineFrame["blocks"])],
));

function latestTurn(turnIndex: number, stage: Exclude<ReplayStage, "history">): TimelineTurnView {
  const blocks = stage === "prework"
    ? [{ id: "work", type: "reasoning", summary: "", detail: null, streaming: true, sourceItemIds: ["work"] }]
    : [{ id: "answer", type: "text", phase: "final_answer", text: "一", streaming: stage !== "complete", sourceItemIds: ["answer"] }];
  const turnKey = `latest-${turnIndex}`;
  return turn(
    turnKey,
    stage === "complete" ? "completed" : "streaming",
    [frame(`${turnKey}:assistant`, "assistant", blocks as TimelineFrame["blocks"])],
  );
}

function Replay() {
  const [stage, setStage] = useState<ReplayStage>("history");
  const [turnIndex, setTurnIndex] = useState(1);
  const [completedTurns, setCompletedTurns] = useState<readonly TimelineTurnView[]>([]);
  const [scenario, setScenario] = useState<ReplayScenario>("stable");
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const conversationApiRef = useRef<ConversationScrollApi | null>(null);
  const pendingPlacementRef = useRef<ReturnType<ConversationScrollApi["captureLatestTurnSubmitPlacement"]>>(null);
  const traceRef = useRef<ReplayTrace[]>([]);
  const entries = stage === "history"
    ? [...historyTurns, ...completedTurns]
    : [...historyTurns, ...completedTurns, latestTurn(turnIndex, stage)];

  const record = useCallback((source: string) => {
    const element = document.querySelector<HTMLDivElement>(".thread-scroll");
    if (element === null) return;
    const follow = element.querySelector<HTMLElement>(".thread-thinking-placeholder, [data-local-conversation-final-assistant], [data-assistant-copy-content]");
    const viewport = element.getBoundingClientRect();
    const spacer = element.querySelector<HTMLElement>(".thread-response-spacer");
    const footerPadding = Number.parseFloat(element.style.getPropertyValue("--thread-scroll-padding-bottom"));
    traceRef.current.push({
      at: performance.now(),
      source,
      stage: stageRef.current,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      distanceFromBottom: Math.max(0, -element.scrollTop),
      spacerHeight: spacer?.getBoundingClientRect().height ?? 0,
      followBottom: follow?.getBoundingClientRect().bottom ?? null,
      viewportBottom: viewport.bottom,
      footerPadding: Number.isFinite(footerPadding) ? footerPadding : 0,
    });
  }, []);

  useEffect(() => {
    window.chatScrollReplay = {
      getDiagnosticEvents: () => diagnosticEvents,
      getTrace: () => traceRef.current,
      reset: () => {
        diagnosticEvents.length = 0;
        traceRef.current = [];
        setStage("history");
        setTurnIndex(1);
        setCompletedTurns([]);
      },
      setScenario: (nextScenario) => setScenario(nextScenario),
      scrollToBottom: () => conversationApiRef.current?.scrollToBottom(),
      start: () => {
        pendingPlacementRef.current = conversationApiRef.current?.captureLatestTurnSubmitPlacement() ?? null;
        record("before-start");
        setStage("prework");
      },
      firstText: () => {
        record("before-first-text");
        setStage("final");
        queueMicrotask(() => record("after-first-text-microtask"));
        requestAnimationFrame(() => record("after-first-text-raf"));
      },
      complete: () => {
        record("before-complete");
        setStage("complete");
        requestAnimationFrame(() => record("after-complete-raf"));
      },
      nextTurn: () => {
        const completed = latestTurn(turnIndex, "complete");
        pendingPlacementRef.current = conversationApiRef.current?.captureLatestTurnSubmitPlacement() ?? null;
        record("before-next-turn");
        setCompletedTurns((current) => [...current, completed]);
        setTurnIndex((current) => current + 1);
        setStage("prework");
        requestAnimationFrame(() => record("after-next-turn-raf"));
      },
    };
  }, [record]);

  const frames = entries.flatMap((entry) => entry.frames);
  const revision = completedTurns.length * 4 + (stage === "history" ? 1 : stage === "prework" ? 2 : stage === "final" ? 3 : 4);
  return <div className="replay-shell" data-replay-scenario={scenario}>
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      <Conversation
        key={scenario === "remount-on-first-text" && stage === "final" ? "final" : "stable"}
        scrollPolicy="response-placement"
        timeline={{
          key: { hostId: "replay-host", threadId: "replay-thread" },
          revision,
          phase: "live",
          authoritative: true,
          frames,
          anchorFrameIds: new Map(),
        }}
        consumePendingLatestTurnSubmitPlacement={() => {
          const placement = pendingPlacementRef.current;
          pendingPlacementRef.current = null;
          return placement;
        }}
        footer={<div className="replay-composer">Composer</div>}
        onConversationScrollApiChange={(api) => { conversationApiRef.current = api; }}
      />
    </TimelineBlockRendererProvider>
  </div>;
}

const style = document.createElement("style");
style.textContent = `
  html, body, #root { width: 100%; height: 100%; margin: 0; }
  .replay-shell { width: 720px; height: 720px; margin: 0 auto; background: white; }
  .thread-content { padding-top: 24px; }
  .replay-history-turn { box-sizing: border-box; height: 260px; padding: 32px; border-bottom: 1px solid #eee; }
  .replay-latest-turn { box-sizing: border-box; min-height: 190px; padding: 28px 32px; font: 28px/1.4 system-ui; }
  .replay-shell[data-replay-scenario="shrink-on-first-text"] .replay-latest-turn[data-replay-stage="prework"] { height: 520px; }
  .replay-worked { color: #777; }
  .replay-rule { height: 1px; margin: 16px 0 26px; background: #ddd; }
  .replay-follow-target { min-height: 48px; }
  .replay-composer { box-sizing: border-box; height: 112px; margin: 0 24px 16px; border: 1px solid #ddd; border-radius: 24px; background: white; padding: 32px; }
`;
document.head.append(style);

createRoot(document.getElementById("root")!).render(<Replay />);
