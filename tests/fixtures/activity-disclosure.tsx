import React, { useState } from "react";
import { createIntlTestRoot as createRoot } from "./intl-root";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline,
  type TimelineSourceItem, type TimelineStatus } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import "../../apps/workbench-web/src/styles/app.scss";

const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) document.documentElement.style.setProperty(key, value);
const registry = createDefaultTimelineProjectorRegistry();
const prose = (id: string, text: string, phase = "commentary"): TimelineSourceItem => ({
  id, type: "agentMessage", payload: { text, phase, completed: true } });
const user = (id: string): TimelineSourceItem => ({ id, type: "userMessage",
  payload: { clientId: id, content: [{ type: "text", text: `Follow-up ${id}` }] } });
const initial = [prose("earlier", "Earlier visible prose"), { id: "work1", type: "commandExecution",
  payload: { command: "echo first", status: "completed", exitCode: 0 } }] satisfies TimelineSourceItem[];
function Demo() {
  const [state, setState] = useState({ items: initial as TimelineSourceItem[], status: "streaming" as TimelineStatus, revision: 0 });
  (window as any).disclosureUpdate = (action: string) => setState(current => {
    let items = current.items;
    let status = current.status;
    if (action === "steer1") items = [...items, user("one"), prose("later", "Later visible prose")];
    if (action === "steer2") items = [...items, user("two"), prose("latest", "Newest visible prose")];
    if (action === "complete") status = "complete";
    if (action === "final") items = [...items, prose("answer", "Final answer stays visible", "final_answer")];
    if (action === "stream") {
      status = "streaming";
      items = items.map(item => item.id === "answer" ? { ...item,
        payload: { ...(item.payload as object), text: "Final answer stays visible and grows", completed: false } } : item);
    }
    if (action === "prepend") items = [prose("history", "Prepended earlier work"), ...items];
    return { items, status, revision: current.revision + 1 };
  });
  const timeline = projectTimeline({ key: createConversationKey("fixture", "disclosure"), revision: state.revision,
    authoritative: true, phase: "live", turns: [{ id: "turn", status: state.status, items: state.items }] }, registry);
  return <div data-revision={state.revision} style={{ width: "100vw", height: "100vh" }}>
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      <Conversation timeline={timeline} scrollPolicy="natural" threadDetailLevel="STEPS_PROSE"
        footer={<div style={{ height: 48 }}>Composer fixture</div>}
        onVisibleContentReady={() => { document.documentElement.dataset.conversationReady = "true"; }} />
    </TimelineBlockRendererProvider>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Demo />);
