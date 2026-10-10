import React, { useState } from "react";
import { createIntlTestRoot as createRoot } from "./intl-root";
import { Context } from "@deepseek-ai/cordis";
import type { AppServerTurn } from "@opencraft/appserver-protocol";
import { mergeTurns, reconcileHistoryTurns, reconcileHydratedTurn } from "@opencraft/appserver-session";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline, type TimelineSourceTurn } from "@opencraft/chat-core";
import { buildCodexThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import "../../apps/workbench-web/src/styles/app.scss";

const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
document.documentElement.dataset.theme = "light";
for (const [key, value] of Object.entries(buildCodexThemeCssProperties("light"))) document.documentElement.style.setProperty(key, value);
const registry = createDefaultTimelineProjectorRegistry();
const makeTurn = (id: string): AppServerTurn => ({ id, status: "completed", itemsView: "full", items: [
  { id: `${id}:user`, type: "userMessage", clientId: `${id}:client`, content: [{ type: "text", text: `Prompt ${id}` }] },
  { id: `${id}:reply`, type: "agentMessage", text: `Answer ${id}`, phase: "final_answer" },
] });
const baseline = [makeTurn("older-unindexed"), makeTurn("a"), makeTurn("c"), {
  ...makeTurn("live"), status: "inProgress",
}];
let rows: readonly AppServerTurn[] = baseline;
let revision = 0;

function Demo() {
  const [state, setState] = useState({ rows, revision });
  (window as any).historyOrder = (action: "hydrate" | "stream" | "snapshot" | "complete") => {
    if (action === "hydrate") rows = reconcileHydratedTurn(rows, makeTurn("b"), ["a", "b", "c"]);
    else if (action === "snapshot") rows = reconcileHistoryTurns(rows, baseline, "older", { baselineTurns: baseline });
    else if (action === "complete") rows = mergeTurns(rows, [{ id: "live", status: "completed", items: [] }]);
    else {
      const reply = rows.find(turn => turn.id === "live")!.items!.find(item => item.id === "live:reply")!;
      rows = mergeTurns(rows, [{ id: "live", items: [{ ...reply, text: `${reply.text} ·` }] }]);
    }
    setState({ rows, revision: ++revision });
    return revision;
  };
  const turns: TimelineSourceTurn[] = state.rows.map(turn => ({
    id: turn.id,
    status: turn.status === "inProgress" ? "streaming" : "complete",
    items: (turn.items ?? []).map(item => ({ id: item.id, type: item.type ?? "unknown", payload: item })),
  }));
  const timeline = projectTimeline({ key: createConversationKey("fixture", "thread"), revision: state.revision,
    authoritative: true, phase: "live", turns }, registry);
  return <div data-test-revision={state.revision} style={{ width: "100vw", height: "100vh" }}>
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      <Conversation scrollPolicy="response-placement" timeline={timeline} threadDetailLevel="STEPS_PROSE"
        onVisibleContentReady={() => { document.documentElement.dataset.conversationReady = "true"; }}
        footer={<div style={{ height: 48 }}>Composer fixture</div>} />
    </TimelineBlockRendererProvider>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Demo />);
