import React, { useState } from "react";
import type { TimelineStatus, TurnDiffTimelineBlock } from "@opencraft/chat-core";
import { TurnDiffReviewDialog } from "../../apps/workbench-web/src/components/conversation/turn-diff-review-dialog";
import gitCases from "./turn-diff-git-cases.json";
import { reviewDiffForFile } from "../../apps/workbench-web/src/components/conversation/turn-diff-review";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

const files = [
  ["2026-10-05-opencraft-ssh-management.checkpoint.md", 3, 1],
  ["docs/context/tasks/2026-10-05-opencraft-ssh-management.md", 5, 0],
  ["opencraft/apps/workbench-web/src/app.tsx", 2, 0],
  [`deep/directory/${"long-basename-".repeat(12)}.css`, 1234, 987],
  ["short.js", 0, 12],
] as const;
const layoutDiff = files.map(([path, added, removed]) => [
  `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
  `@@ -1,${removed} +1,${added} @@`,
  ...Array.from({ length: removed }, () => "-old"),
  ...Array.from({ length: added }, () => "+new"),
].join("\n")).join("\n");
const selectedCase = new URLSearchParams(location.search).get("gitCase");
const diff = selectedCase === "all" ? gitCases.map(entry => entry.diff).join("")
  : gitCases.find(entry => entry.name === selectedCase)?.diff ?? layoutDiff;
const requestedStatus = new URLSearchParams(location.search).get("turnStatus");
const status: TimelineStatus = requestedStatus === "failed" || requestedStatus === "interrupted" ? requestedStatus : "complete";
const withoutAssistant = new URLSearchParams(location.search).has("withoutAssistant");
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) {
  document.documentElement.style.setProperty(key, value);
}
const timeline = projectTimeline({
  key: createConversationKey("fixture", "diff-layout"), revision: 1, authoritative: true, phase: "live",
  turns: [{ id: "turn", status, unifiedDiff: diff, items: [
    { id: "question", type: "userMessage", payload: { text: "Update files" } },
    ...withoutAssistant ? [] : [{ id: "answer", type: "agentMessage", payload: { text: "Updated.", completed: true, phase: "final_answer" } }],
  ] }],
}, createDefaultTimelineProjectorRegistry());
function Fixture() {
  const [review, setReview] = useState<{ block: TurnDiffTimelineBlock; path: string | null } | null>(null);
  return (
  <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
    <Conversation timeline={timeline} scrollPolicy="natural" threadDetailLevel="STEPS_PROSE"
      documentContext={{ conversationId: "diff-layout", hostId: "fixture", cwd: "/workspace", theme,
        onReviewTurnDiff: (block, path) => {
          document.documentElement.dataset.reviewPath = path ?? "";
          document.documentElement.dataset.reviewDiff = reviewDiffForFile(block.unifiedDiff, path ?? null);
          if (new URLSearchParams(location.search).has("review")) setReview({ block, path: path ?? null });
        } }}
      onVisibleContentReady={() => { document.documentElement.dataset.conversationReady = "true"; }} />
    {review !== null ? <TurnDiffReviewDialog block={review.block} initialPath={review.path} onClose={() => setReview(null)} /> : null}
  </TimelineBlockRendererProvider>
  );
}
createIntlTestRoot(document.getElementById("root")!).render(<Fixture />);
