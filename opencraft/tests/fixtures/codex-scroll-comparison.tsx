import React, { useLayoutEffect, useRef, useState } from "react";
import { createIntlTestRoot as createRoot } from "./intl-root";
import { flushSync } from "react-dom";
import { Context } from "@deepseek-ai/cordis";
import {
  TimelineBlockRendererProvider,
  TimelineBlockRendererRegistryService,
} from "@opencraft/timeline-render-react";
import { groupTimelineFramesByTurn } from "@opencraft/chat-core";
import { WebConversationViewportOwner } from "@opencraft/timeline-host-web";
import {
  Conversation,
  ConversationTurn,
  webBuiltinTimelineRendererComponents,
} from "../../apps/workbench-web/src/components/conversation";
import { LatestTurnFollowContentContext } from "../../apps/workbench-web/src/components/latest-turn-follow-content";
import { ReferenceScrollLayout } from "virtual:codex-scroll-layout";
import { ReferenceVirtualizedTurns } from "virtual:codex-scroll-list";
import {
  ReferenceResponse,
  referencePlacementSnapshot,
} from "virtual:codex-scroll-response";
import {
  ScrollContext,
  RowContext,
  ResizeContext,
  resizeObserverCallbacksKey,
  resizeObserverLastEntryKey,
} from "virtual:codex-scroll-common";
import "../../apps/workbench-web/src/styles/app.scss";
import "./codex-scroll-comparison.css";

// Common presentation is intentional: compare the ORIGINAL controller,
// virtualizer and response policy under identical row geometry, not typography.
const reference =
  new URLSearchParams(location.search).get("backend") === "codex";
const productionText = new URLSearchParams(location.search).get("renderer") === "production";
const baselinePolicy = new URLSearchParams(location.search).get("policy") === "baseline";
const ProductionText = webBuiltinTimelineRendererComponents.text;
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
ctx.timelineBlockRenderers.register({
  name: "fixture-text",
  priority: 0,
  types: ["text"],
  component: (props) => productionText && !/^\d+$/.test((props.block as any).text) ? (
    <div data-probe={props.block.id} style={{ width: 650, maxWidth: "100%" }}>
      <ProductionText {...props} />
    </div>
  ) : (({ block }) => (
    <div data-probe={block.id} style={/^\d+$/.test((block as any).text)
      ? { height: Number((block as any).text) }
      : { width: 650, maxWidth: "100%", whiteSpace: "pre-wrap", fontSize: 16, lineHeight: "26px" }}>
      {/^\d+$/.test((block as any).text) ? block.id : (block as any).text}
    </div>
  ))(props),
});
const probe = window as any;
const captureReferenceRestore = (virtualizedTurnList: any) => {
  probe.restore = { ...probe.restore, virtualizedTurnList };
};
probe.reads = 0;
probe.pending = null;
probe.measurementCount = 0;
const listen =
  WebConversationViewportOwner.prototype.setLatestTurnMeasurementListener;
WebConversationViewportOwner.prototype.setLatestTurnMeasurementListener =
  function (listener) {
    probe.owner = this;
    return listen.call(this, listener === null ? null : (change) => {
      probe.measurementCount++;
      probe.lastMeasurementKind = change.kind;
      listener(change);
    });
  };

function ReferenceBindings() {
  const controller = React.useContext(ScrollContext) as any;
  useLayoutEffect(() => {
    probe.controller = controller;
    probe.api = {
      scrollToBottom: () => probe.response ? probe.response.scrollToBottom() : controller.scrollToBottom(),
      captureLatestTurnSubmitPlacement: () =>
        baselinePolicy ? null : referencePlacementSnapshot({
          distanceFromBottomPx: controller.getLastScrollDistanceFromBottomPx(),
          responseSpacerHeightPx: probe.response?.getHeightPx() ?? 0,
          scrollHeightPx: controller.getScrollElement().scrollHeight,
        }),
    };
  }, [controller]);
  return null;
}
function ReferenceRow({ entry, latestTurnFollowContentRef }: any) {
  return (
    <LatestTurnFollowContentContext.Provider value={latestTurnFollowContentRef}>
      <ConversationTurn
        turn={entry.presentation}
        activityCollapsedById={{}}
        onActivityCollapsedChange={() => {}}
        isMostRecentTurn={entry.latest}
        threadDetailLevel="STEPS_COMMANDS"
      />
    </LatestTurnFollowContentContext.Provider>
  );
}
function ReferenceEnvironment({ children }: { children: React.ReactNode }) {
  const observer = useRef<ResizeObserver | null>(null);
  if (observer.current === null)
    observer.current = new ResizeObserver((records) => {
      for (const record of records) {
        const target = record.target as any;
        target[resizeObserverLastEntryKey] = record;
        for (const callback of target[resizeObserverCallbacksKey] ?? [])
          callback(record);
      }
    });
  React.useEffect(() => () => observer.current?.disconnect(), []);
  return (
    <ResizeContext.Provider value={observer.current}>
      <RowContext.Provider value={ReferenceRow}>{children}</RowContext.Provider>
    </ResizeContext.Provider>
  );
}
function Demo() {
  const [mounted, setMounted] = useState(true);
  const [state, setState] = useState({
    revision: 0,
    footerHeight: 80,
    heights: [600, 600, 600, 600, 600, 200],
    active: false,
    phase: "final_answer",
    texts: {} as Record<number, string>,
  });
  const timeline: any = {
    key: { hostId: "fixture", threadId: "fixture" },
    revision: state.revision,
    phase: "live",
    authoritative: true,
    anchorFrameIds: new Map(),
    frames: state.heights.flatMap((height, index) => [
      {
        id: `user-${index}`,
        type: "user",
        turnId: `turn-${index}`,
        status: "complete",
        durationMs: null,
        hookStats: null,
        anchors: [],
        blocks: [
          {
            id: `user-text-${index}`,
            type: "text",
            text: "40",
            sourceItemIds: [],
            streaming: false,
          },
        ],
      },
      {
        id: `frame-${index}`,
        type: "assistant",
        turnId: `turn-${index}`,
        status:
          index === state.heights.length - 1 && state.active
            ? "streaming"
            : "complete",
        durationMs: null,
        hookStats: null,
        anchors: [],
        blocks:
          index === state.heights.length - 1 && state.phase === "idle"
            ? []
            : [
                {
                  id: `text-${index}`,
                  type: "text",
                  text: state.texts[index] ?? String(height),
                  sourceItemIds: [],
                  streaming: index === state.heights.length - 1 && state.active,
                  phase:
                    index === state.heights.length - 1
                      ? state.phase
                      : "final_answer",
                },
              ],
      },
    ]),
  };
  const entries = groupTimelineFramesByTurn(timeline).map(
    (presentation, index) => ({
      type: "turn",
      turnKey: presentation.turnKey,
      presentation,
      latest: index === state.heights.length - 1,
      turn: {
        status:
          index === state.heights.length - 1 && state.active
            ? "inProgress"
            : "completed",
        items:
          index === state.heights.length - 1 && state.phase === "idle"
            ? []
            : [
                {
                  type: "agentMessage",
                  phase:
                    index === state.heights.length - 1
                      ? state.phase
                      : "final_answer",
                },
              ],
      },
    }),
  );
  probe.event = async (event: any) => {
    probe.resizeStep = event;
    if (event.type === "fixed-row-height") {
      const content = document.querySelector(`[data-probe="text-${state.heights.length - 1}"]`)!;
      (content.closest(".thread-frame") as HTMLElement).style.height = `${event.value}px`;
      return;
    }
    if (event.type === "physical-bottom") {
      const scroll = document.querySelector(reference ? ".thread-scroll-container" : ".thread-scroll") as HTMLElement;
      // Change physical position and issue the command in the same task,
      // before the browser can deliver the corresponding scroll event.
      scroll.scrollTop = -event.value;
      probe.api.scrollToBottom();
      return;
    }
    if (event.type === "wheel") {
      const scroll = document.querySelector(reference ? ".thread-scroll-container" : ".thread-scroll") as HTMLElement;
      // Paired comparison supplies identical wheel intent + browser scroll
      // geometry. Trusted compositor input is covered by the separate smoke.
      scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -event.value, bubbles: true }));
      scroll.scrollTop -= event.value;
      return;
    }
    if (event.type === "remount") {
      if (reference) probe.restore = {
        distanceFromBottomPx: probe.controller.getLastScrollDistanceFromBottomPx(),
      };
      setMounted(false);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      setMounted(true);
      return;
    }
    if (event.type === "bottom") {
      probe.api.scrollToBottom();
      return;
    }
    if (event.type === "distance") {
      (reference
        ? probe.controller
        : probe.owner.scrollController
      ).scrollToDistanceFromBottomPx(event.value, "instant", "user");
      return;
    }
    if (event.type === "submit")
      probe.pending =
        event.local === false
          ? null
          : probe.api.captureLatestTurnSubmitPlacement();
    flushSync(() => setState((current) => ({
      ...current,
      revision: current.revision + 1,
      ...(event.type === "submit"
        ? {
            active: true,
            phase: event.phase ?? "idle",
            texts: event.text === undefined ? current.texts : {
              ...current.texts, [current.heights.length]: event.text,
            },
            heights: [
              ...current.heights.map((height, index) =>
                index === current.heights.length - 1
                  ? (event.shrinkPreviousTo ?? height)
                  : height,
              ),
              event.height ?? 60,
            ],
          }
        : {}),
      ...(event.type === "phase" ? { phase: event.value } : {}),
      ...(event.type === "footer" ? { footerHeight: event.value } : {}),
      ...(event.type === "text" ? { texts: {
        ...current.texts, [current.heights.length - 1]: event.value,
      } } : {}),
      ...(event.type === "resize"
        ? {
            heights: current.heights.map((height, index) =>
              index === (event.index ?? current.heights.length - 1)
                ? event.value
                : height,
            ),
          }
        : {}),
      ...(event.type === "complete" ? { active: false } : {}),
    })));
  };
  probe.sample = () => {
    const scroll = document.querySelector(
      reference ? ".thread-scroll-container" : ".thread-scroll",
    ) as HTMLElement;
    const spacer = document.querySelector(reference
      ? '.reference [aria-hidden="true"].shrink-0'
      : ".thread-response-spacer")?.getBoundingClientRect().height ?? 0;
    return {
      distance: -scroll.scrollTop,
      height: scroll.scrollHeight,
      viewport: scroll.clientHeight,
      spacer,
      reads: probe.reads,
      follow: probe.__readScrollFollow?.() ?? null,
      measurementCount: probe.measurementCount,
      lastMeasurementKind: probe.lastMeasurementKind ?? null,
      phase: state.active ? state.phase : "idle",
      textLength: state.texts[state.heights.length - 1]?.length ?? null,
      latestBottom: document.querySelector(`[data-probe="text-${state.heights.length - 1}"]`)?.getBoundingClientRect().bottom ?? null,
      anchors: Object.fromEntries(
        [
          ...document.querySelectorAll<HTMLElement>('[data-probe^="text-"]'),
        ].map((element) => [
          element.dataset.probe,
          element.getBoundingClientRect().top,
        ]),
      ),
    };
  };
  const consume = () => {
    probe.reads++;
    const value = probe.pending;
    probe.pending = null;
    return value;
  };
  return (
    <div
      className={reference ? "reference" : "candidate"}
      style={{ height: 700, width: 1000 }}
    >
      <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
        {!mounted ? null : reference ? (
          <ReferenceEnvironment>
            <ReferenceScrollLayout
              initialOffset={probe.restore?.distanceFromBottomPx}
              footer={<div style={{ height: state.footerHeight }}>Composer</div>}
            >
              <ReferenceBindings />
              {baselinePolicy ? <ReferenceVirtualizedTurns
                entries={entries}
                initialRestoreState={probe.restore?.virtualizedTurnList}
                onRestoreStateChange={captureReferenceRestore}
                preserveMeasuredTurnViewport
                RowComponent={ReferenceRow}
              /> : <ReferenceResponse
                conversationId="fixture"
                entries={entries}
                consumePendingLatestTurnSubmitPlacement={consume}
                onResponseSpacerStateChange={(value: any) => {
                  probe.response = value;
                }}
                onVirtualizedTurnListRestoreStateChange={() => {}}
                synchronouslyMeasureLatestTurnUpdates={new URLSearchParams(location.search).get("sync") === "true"}
              />}
            </ReferenceScrollLayout>
          </ReferenceEnvironment>
        ) : (
          <Conversation
            scrollPolicy={baselinePolicy ? "natural" : "response-placement"}
            initialRestoreSnapshot={probe.restore}
            onRestoreSnapshotChange={(snapshot) => { probe.restore = snapshot; }}
            timeline={timeline}
            consumePendingLatestTurnSubmitPlacement={consume}
            onConversationScrollApiChange={(api) => {
              probe.api = api;
            }}
            footer={<div style={{ height: state.footerHeight }}>Composer</div>}
          />
        )}
      </TimelineBlockRendererProvider>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Demo />);
