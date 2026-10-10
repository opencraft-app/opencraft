import React from "react";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "@opencraft/chat-core";
import { buildCodexThemeCssProperties } from "@opencraft/design-system/theme-engine";
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
const diff = files.map(([path, added, removed]) => [
  `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
  `@@ -1,${removed} +1,${added} @@`,
  ...Array.from({ length: removed }, () => "-old"),
  ...Array.from({ length: added }, () => "+new"),
].join("\n")).join("\n");
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildCodexThemeCssProperties(theme))) {
  document.documentElement.style.setProperty(key, value);
}
const timeline = projectTimeline({
  key: createConversationKey("fixture", "diff-layout"), revision: 1, authoritative: true, phase: "live",
  turns: [{ id: "turn", status: "complete", items: [
    { id: "question", type: "userMessage", payload: { text: "Update files" } },
    { id: "answer", type: "agentMessage", payload: { text: "Updated.", completed: true, phase: "final_answer" } },
    { id: "diff", type: "turnDiff", payload: { diff } },
  ] }],
}, createDefaultTimelineProjectorRegistry());
createIntlTestRoot(document.getElementById("root")!).render(
  <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
    <Conversation timeline={timeline} scrollPolicy="natural" threadDetailLevel="STEPS_PROSE"
      documentContext={{ conversationId: "diff-layout", hostId: "fixture", cwd: "/workspace", theme,
        onReviewTurnDiff: (_block, path) => { document.documentElement.dataset.reviewPath = path ?? ""; } }}
      onVisibleContentReady={() => { document.documentElement.dataset.conversationReady = "true"; }} />
  </TimelineBlockRendererProvider>,
);
