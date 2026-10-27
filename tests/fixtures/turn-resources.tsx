import React, { useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, createTimelineTurnPresentationPlan,
  groupTimelineFramesByTurn, projectTimeline, type TimelineSourceItem, type TimelineStatus,
  type TurnDiffTimelineBlock } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { TurnDiffReviewDialog } from "../../apps/workbench-web/src/components/conversation/turn-diff-review-dialog";
import { ComposerTurnChangeSummary } from "../../apps/workbench-web/src/components/conversation/turn-diff-resource";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) document.documentElement.style.setProperty(key, value);
const registry = createDefaultTimelineProjectorRegistry();
const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra";
const initialItems: readonly TimelineSourceItem[] = [
  { id: "input", type: "userMessage", payload: { text: "Update files" } },
  { id: "progress", type: "agentMessage", payload: { text: "Active progress", phase: "commentary", completed: true } },
  { id: "command", type: "commandExecution", payload: { command: "test", status: "inProgress", completed: false } },
];
const startedAtMs = Date.now() - 10000;
const snapshot = (items: readonly TimelineSourceItem[], status: TimelineStatus, revision: number, unifiedDiff: string | null) => projectTimeline({
  key: createConversationKey("fixture", "resources"), revision, authoritative: true, phase: "live",
  turns: [{ id: "turn", status, startedAtMs, firstTurnWorkItemStartedAtMs: startedAtMs + 1000,
    durationMs: status === "complete" ? 9000 : null, items, unifiedDiff }],
}, registry);
const collapsed = Object.fromEntries(createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(snapshot(initialItems, "streaming", 0, diff))[0]!).assistant!.slots
  .filter(s => s.type === "agent-activity").map(s => [s.id, true]));

function Demo() {
  const [state, setState] = useState({ items: initialItems, status: "streaming" as TimelineStatus, revision: 0,
    unifiedDiff: params.has("restored") ? diff : null as string | null });
  const [review, setReview] = useState<{ block: TurnDiffTimelineBlock; path: string | null } | null>(null);
  (window as any).resourceUpdate = (action: string) => setState(current => {
    if (action === "diff") return { ...current, unifiedDiff: diff, revision: current.revision + 1 };
    if (action === "diff-update") return { ...current, unifiedDiff: `${diff}\n+review-update`, revision: current.revision + 1 };
    if (action === "new-work") return { ...current, items: [...current.items,
      { id: "later", type: "agentMessage", payload: { text: "Later progress", phase: "commentary", completed: true } },
      { id: "reasoning", type: "reasoning", payload: { summary: [], completed: false } }], revision: current.revision + 1 };
    if (action === "clear") return { ...current, unifiedDiff: null, revision: current.revision + 1 };
    return { ...current, status: "complete", revision: current.revision + 1,
      items: [...current.items.map(item => item.id === "command" ? { ...item, payload: { command: "test", status: "completed", completed: true } } : item),
        { id: "answer", type: "agentMessage", payload: { text: "Done", phase: "final_answer", completed: true } }] };
  });
  const timeline = snapshot(state.items, state.status, state.revision, state.unifiedDiff);
  const reviewedBlock = review === null ? null
    : timeline.frames.map(frame => frame.changeSummary).find(block => block?.id === review.block.id) ?? review.block;
  return <div data-revision={state.revision} style={{ width: "100vw", height: "100vh" }}>
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      <Conversation timeline={timeline} scrollPolicy="natural" threadDetailLevel="STEPS_PROSE"
        initialRestoreSnapshot={{ agentActivityCollapsedById: collapsed }}
        documentContext={{ conversationId: "resources", hostId: "fixture", cwd: "/workspace", theme, composerChangeSummaryTurnId: "turn",
          onReviewTurnDiff: (block, path) => setReview({ block, path: path ?? null }) }}
        footer={<ComposerTurnChangeSummary timeline={timeline} turnId="turn" documentContext={{ conversationId: "resources", hostId: "fixture", cwd: "/workspace", theme,
          onReviewTurnDiff: (block, path) => setReview({ block, path: path ?? null }) }} />}
        onVisibleContentReady={() => { document.documentElement.dataset.conversationReady = "true"; }} />
      {reviewedBlock === null ? null : <TurnDiffReviewDialog block={reviewedBlock} initialPath={review?.path ?? null} onClose={() => setReview(null)} />}
    </TimelineBlockRendererProvider>
  </div>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Demo />);
