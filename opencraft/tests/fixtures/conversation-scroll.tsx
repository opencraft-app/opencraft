import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { WebConversationViewportOwner } from "@opencraft/timeline-host-web";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import "../../apps/workbench-web/src/styles/app.scss";

// Test-only entry: real Conversation, virtualizer, ResizeObserver and scrollport;
// deterministic text dimensions replace network/provider dependencies.
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
ctx.timelineBlockRenderers.register({
  name: "fixture-text", priority: 0, types: ["text"],
  component: ({ block }) => <div data-probe={block.id} style={{ height: Number((block as any).text), background: "#eef" }}>{block.id}</div>,
});
const probe = window as any;
probe.events = [];
probe.placementReads = 0;
probe.pendingPlacement = null;
const submissionMode = new URLSearchParams(location.search).has("submissions");
const historyMode = new URLSearchParams(location.search).has("history");
const naturalMode = new URLSearchParams(location.search).has("natural");
probe.historyLoads = 0;
// Capture owner through listener setup; no production debug API is installed.
const listen = WebConversationViewportOwner.prototype.setLatestTurnMeasurementListener;
WebConversationViewportOwner.prototype.setLatestTurnMeasurementListener = function (listener) {
  probe.owner = this;
  return listen.call(this, listener === null ? null : (change) => {
    probe.events.push({ ...change, element: undefined });
    listener(change);
  });
};
function Demo() {
  const [mounted, setMounted] = useState(true);
  const [state, setState] = useState({ revision: 0, heights: [600, 600, 600, 600, 600, 200], active: !submissionMode && !historyMode, phase: "final_answer", lifetime: 0 });
  probe.shrinkHistory = () => setState((current) => ({ ...current, revision: current.revision + 1, heights: [20, 20] }));
  const loadHistory = () => {
    probe.historyLoads++;
    setState((current) => ({ ...current, revision: current.revision + 1, heights: [1200, ...current.heights] }));
    return "stop" as const;
  };
  probe.submit = ({ local = true, shrinkPreviousTo, phase = "idle", height = 60 }: { local?: boolean; shrinkPreviousTo?: number; phase?: string; height?: number } = {}) => {
    probe.pendingPlacement = local ? probe.api.captureLatestTurnSubmitPlacement() : null;
    probe.lastPlacement = probe.pendingPlacement;
    setState((current) => ({
      ...current, revision: current.revision + 1, active: true, phase,
      heights: [...current.heights.map((previousHeight, index) => index === current.heights.length - 1 ? shrinkPreviousTo ?? previousHeight : previousHeight), height],
    }));
  };
  probe.renderAgain = () => setState((current) => ({ ...current, revision: current.revision + 1 }));
  probe.unmount = () => setMounted(false);
  probe.remountFromSnapshot = () => {
    probe.initialRestoreSnapshot = probe.restoreSnapshot;
    setState((current) => ({ ...current, lifetime: current.lifetime + 1 }));
    setMounted(true);
  };
  probe.change = (index: number, height: number) => setState((current) => ({ ...current, revision: current.revision + 1, heights: current.heights.map((value, i) => i === index ? height : value) }));
  probe.complete = () => setState((current) => ({ ...current, revision: current.revision + 1, active: false }));
  probe.setPhase = (phase: string) => setState((current) => ({ ...current, revision: current.revision + 1, phase }));
  probe.restartPrework = () => setState((current) => ({ ...current, revision: current.revision + 1, lifetime: current.lifetime + 1, active: true, phase: "idle", heights: [600, 600, 600, 600, 600, 100] }));
  const timeline = {
    key: { hostId: "fixture", threadId: "fixture" }, revision: state.revision, phase: "live", authoritative: true, anchorFrameIds: new Map(),
    frames: state.heights.flatMap((height, index) => [...(submissionMode ? [{
      id: `user-${index}`, type: "user", turnId: `turn-${index}`, status: "complete", durationMs: null, hookStats: null, anchors: [],
      blocks: [{ id: `user-text-${index}`, type: "text", text: "40", sourceItemIds: [], streaming: false }],
    }] : []), {
      id: `frame-${index}`, type: "assistant", turnId: `turn-${index}`,
      status: index === state.heights.length - 1 && state.active ? "streaming" : "complete", durationMs: null, hookStats: null, anchors: [],
      blocks: index === state.heights.length - 1 && state.phase === "idle" ? [] : [{ id: `text-${index}`, type: "text", text: String(height), sourceItemIds: [], streaming: index === state.heights.length - 1 && state.active, phase: index === state.heights.length - 1 ? state.phase : "final_answer" }],
    }]),
  } as any;
  return <div style={{ height: 700, width: 1000 }}>
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      {mounted && <Conversation key={state.lifetime} timeline={timeline} scrollPolicy={naturalMode ? "natural" : "response-placement"}
        onLoadOlder={historyMode ? loadHistory : undefined}
        initialRestoreSnapshot={probe.initialRestoreSnapshot ?? null}
        consumePendingLatestTurnSubmitPlacement={() => { probe.placementReads++; const value = probe.pendingPlacement; probe.pendingPlacement = null; return value; }}
        onRestoreSnapshotChange={(snapshot) => { probe.restoreSnapshot = snapshot; }}
        onConversationScrollApiChange={(api) => { probe.api = api; }} footer={<div style={{ height: 80 }}>Composer</div>} />}
    </TimelineBlockRendererProvider>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Demo />);
