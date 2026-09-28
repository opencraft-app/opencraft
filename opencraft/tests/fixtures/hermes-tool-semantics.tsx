import React from "react";
import { createIntlTestRoot as createRoot } from "./intl-root";
import { Context } from "@deepseek-ai/cordis";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { createConversationKey, createDefaultTimelineProjectorRegistry, createAssistantTurnPresentationPlan, projectTimeline } from "@opencraft/chat-core";
import { projectHermesTool } from "../../plugins/lightvela-hermes/src/hermes-appserver-bridge/tool-semantics";
import { AgentActivity } from "../../apps/workbench-web/src/components/conversation-renderers/activity/agent-activity-renderers";
import { webBuiltinTimelineRendererComponents } from "../../apps/workbench-web/src/components/conversation";
import "../../apps/workbench-web/src/styles/app.scss";

const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
for (const [type, component] of [
  ["command-execution", webBuiltinTimelineRendererComponents.command],
  ["tool-call", webBuiltinTimelineRendererComponents.toolCall],
  ["text", webBuiltinTimelineRendererComponents.text],
] as const) {
  ctx.timelineBlockRenderers.register({ name: `smoke-${type}`, priority: 0, types: [type], component });
}
const items = ["ls src", "cat src/app.ts"].map((command, i) => projectHermesTool({
  type: "dynamicToolCall", id: `tool-${i}`, callId: `source-${i}`, tool: "terminal", arguments: { command },
  status: "completed", structuredResult: { output: "sample output", exit_code: 0 },
}));
if (new URLSearchParams(location.search).has("missing")) {
  items.splice(0, items.length, projectHermesTool({ type: "dynamicToolCall", id: "missing", tool: "terminal",
    arguments: { command: "example-command" }, status: "completed", resultMissing: true }));
}
const timeline = projectTimeline({ key: createConversationKey("fixture", "fixture"), phase: "live", authoritative: true, revision: 1,
  turns: [{ id: "turn", status: "complete", items: items.map(item => ({ id: item.id, type: item.type, payload: item })) }],
}, createDefaultTimelineProjectorRegistry());
const frame = timeline.frames.find(f => f.type === "assistant")!;
const units = createAssistantTurnPresentationPlan(frame).slots;
createRoot(document.getElementById("root")!).render(<TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
  <main style={{ width: 800, padding: 32 }}>{units.map(unit => unit.type === "agent-activity"
    ? <AgentActivity key={unit.id} unit={unit} persistedCollapsed={false} onCollapsedChange={() => {}} /> : null)}</main>
</TimelineBlockRendererProvider>);
