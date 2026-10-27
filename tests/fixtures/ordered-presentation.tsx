import React, { useState } from "react";
import { createIntlTestRoot as createRoot } from "./intl-root";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, createTimelineTurnPresentationPlan,
  groupTimelineFramesByTurn, projectTimeline, type TimelineSourceItem, type TimelineStatus } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { orderedResponseItems } from "./ordered-response-items";
import "../../apps/workbench-web/src/styles/app.scss";

const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) document.documentElement.style.setProperty(key, value);
const registry = createDefaultTimelineProjectorRegistry();
const snapshot = (items: readonly TimelineSourceItem[], status: TimelineStatus, revision: number) => projectTimeline({
  key: createConversationKey("fixture", "ordered"), revision, authoritative: true, phase: "live",
  turns: [{ id: "turn", status, startedAtMs: 1000, firstTurnWorkItemStartedAtMs: 1100, items }],
}, registry);
const initial = snapshot(orderedResponseItems(true), "streaming", 0);
const collapsed = Object.fromEntries(createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(initial)[0]!).assistant!.slots
  .filter(s => s.type === "agent-activity").map(s => [s.id, false]));

function Demo() {
  const [state, setState] = useState({ items: orderedResponseItems(true), status: "streaming" as TimelineStatus, revision: 0 });
  (window as any).presentationUpdate = (action: string) => setState(current => {
    let items = current.items;
    let status: TimelineStatus = "streaming";
    if (action === "complete") { items = orderedResponseItems(); status = "complete"; }
    else if (action === "await-work") items = orderedResponseItems().slice(0, -1);
    else if (action === "await-input") items = orderedResponseItems().slice(0, -2);
    else if (action === "prepend") items = [current.items[0]!, { id: "earlier", type: "commandExecution", payload: { command: "echo earlier", status: "completed" } }, ...current.items.slice(1)];
    else items = current.items.map(item => item.id === "answer3" ? { ...item,
      payload: { ...(item.payload as Record<string, unknown>), text: "Newest answer extended", completed: false } } : item);
    return { items, status, revision: current.revision + 1 };
  });
  return <div data-revision={state.revision} style={{ width: "100vw", height: "100vh" }}>
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      <Conversation timeline={snapshot(state.items, state.status, state.revision)} scrollPolicy="natural" threadDetailLevel="STEPS_PROSE"
        initialRestoreSnapshot={{ agentActivityCollapsedById: collapsed }} footer={<div style={{ height: 48 }}>Composer fixture</div>}
        onVisibleContentReady={() => { document.documentElement.dataset.conversationReady = "true"; }} />
    </TimelineBlockRendererProvider>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Demo />);
