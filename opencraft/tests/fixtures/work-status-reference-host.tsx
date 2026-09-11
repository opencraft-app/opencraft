import React, { useContext, useEffect, useLayoutEffect, useRef } from "react";
import { groupTimelineFramesByTurn } from "@opencraft/chat-core";
import { ConversationTurn } from "../../apps/workbench-web/src/components/conversation";
import { LatestTurnFollowContentContext } from "../../apps/workbench-web/src/components/latest-turn-follow-content";
import { ReferenceScrollLayout } from "virtual:codex-scroll-layout";
import { ReferenceResponse } from "virtual:codex-scroll-response";
import { ScrollContext, RowContext, ResizeContext, resizeObserverCallbacksKey, resizeObserverLastEntryKey } from "virtual:codex-scroll-common";
import "./codex-scroll-comparison.css";

function Row({ entry, latestTurnFollowContentRef }: any) {
  return <LatestTurnFollowContentContext.Provider value={latestTurnFollowContentRef}>
    <ConversationTurn turn={entry.presentation} activityCollapsedById={{}} onActivityCollapsedChange={() => {}}
      isMostRecentTurn={entry.latest} threadDetailLevel="STEPS_COMMANDS" />
  </LatestTurnFollowContentContext.Provider>;
}
function Bindings() {
  const controller = useContext(ScrollContext) as any;
  useLayoutEffect(() => {
    (window as any).scrollApi = { scrollToBottom: () => {
      const response = (window as any).responseApi;
      if (response) response.scrollToBottom(); else controller.scrollToBottom();
    } };
  }, [controller]);
  return null;
}
export function ReferenceConversation({ timeline, footer }: any) {
  const observer = useRef<ResizeObserver | null>(null);
  if (!observer.current) observer.current = new ResizeObserver((records) => {
    for (const record of records) {
      const target = record.target as any;
      target[resizeObserverLastEntryKey] = record;
      for (const callback of target[resizeObserverCallbacksKey] ?? []) callback(record);
    }
  });
  useEffect(() => () => observer.current?.disconnect(), []);
  const presentations = groupTimelineFramesByTurn(timeline);
  const entries = presentations.map((presentation, index) => ({
    type: "turn", turnKey: presentation.turnKey, presentation, latest: index === presentations.length - 1,
    turn: { status: presentation.status === "streaming" ? "inProgress" : "completed",
      items: timeline.frames.filter((frame: any) => frame.type === "assistant").flatMap((frame: any) => frame.blocks)
        .map((block: any) => ({ type: block.type === "text" ? "agentMessage" : block.type, phase: block.phase })),
    },
  }));
  return <div className="reference" style={{ width: "100%", height: "100%" }}>
    <ResizeContext.Provider value={observer.current}><RowContext.Provider value={Row}>
      <ReferenceScrollLayout footer={footer}>
        <Bindings />
        <ReferenceResponse conversationId="fixture" entries={entries}
          synchronouslyMeasureLatestTurnUpdates={false}
          onResponseSpacerStateChange={(api: any) => { (window as any).responseApi = api; }} />
      </ReferenceScrollLayout>
    </RowContext.Provider></ResizeContext.Provider>
  </div>;
}
