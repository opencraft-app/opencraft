import React, { useState } from "react";
import { createIntlTestRoot as createRoot } from "./intl-root";
import { Context } from "@deepseek-ai/cordis";
import { buildCodexThemeCssProperties } from "@opencraft/design-system/theme-engine";
import {
  createConversationKey,
  createDefaultTimelineProjectorRegistry,
  createAssistantTurnPresentationPlan,
  projectTimeline,
  type TimelineSourceTurn,
} from "@opencraft/chat-core";
import {
  TimelineBlockRendererProvider,
  TimelineBlockRendererRegistryService,
} from "@opencraft/timeline-render-react";
import { AgentActivity } from "../../apps/workbench-web/src/components/conversation-renderers/activity/agent-activity-renderers";
import { Conversation, webBuiltinTimelineRendererComponents } from "../../apps/workbench-web/src/components/conversation";
import "../../apps/workbench-web/src/styles/app.scss";

const ctx = new Context();
document.documentElement.dataset.theme = "light";
for (const [name, value] of Object.entries(
  buildCodexThemeCssProperties("light"),
))
  document.documentElement.style.setProperty(name, value);
await ctx.plugin(TimelineBlockRendererRegistryService);
ctx.timelineBlockRenderers.register({
  name: "work-probe",
  priority: 0,
  types: ["text", "command-execution"],
  component: ({ block }) => (
    new URLSearchParams(location.search).has("production") && block.type === "text"
      ? <div style={{ width: 650, maxWidth: "100%" }}>{React.createElement(webBuiltinTimelineRendererComponents.text, { block, richText: true })}</div>
      : <div style={{ width: 650, maxWidth: "100%" }}>{block.type === "text" ? block.text : "Tool output"}</div>
  ),
});
const probe = window as any;
const params = new URLSearchParams(location.search);
const initial: TimelineSourceTurn = {
  id: "turn",
  status: "streaming",
  startedAtMs: Date.now(),
  firstTurnWorkItemStartedAtMs: Date.now(),
  items: [
    {
      id: "work",
      type: "commandExecution",
      payload: { command: "pwd", status: "completed" },
    },
  ],
};
function Demo() {
  const [turn, setTurn] = useState<TimelineSourceTurn>(initial);
  const [choice, setChoice] = useState<boolean>();
  const [generation, setGeneration] = useState(0);
  probe.final = () =>
    setTurn((turn) => ({
      ...turn,
      finalAssistantStartedAtMs: params.has("no-final-clock") ? null : turn.startedAtMs! + 2_600,
      items: [
        ...initial.items,
        {
          id: "answer",
          type: "agentMessage",
          payload: { text: params.has("conversation") ? "Final answer.\n".repeat(params.has("long") ? 90 : 8) : "Final answer", phase: params.has("late-final") ? "commentary" : params.has("unphased") ? undefined : "final_answer" },
        },
      ],
    }));
  probe.complete = () =>
    setTurn((turn) => ({ ...turn, status: "complete", durationMs: 99_000,
      ...(params.has("late-final") || params.has("interim-shrink") ? { items: turn.items.map((item) => item.id === "answer"
        ? { ...item, payload: { ...item.payload, phase: "final_answer" } } : item) } : {}),
    }));
  probe.interim = () => setTurn(turn => ({ ...turn,
    items: turn.items.map(item => item.id === "answer"
      ? { ...item, payload: { ...item.payload, phase: params.has("sealed-preview") ? null : "commentary" } } : item),
  }));
  probe.restore = () => {
    setChoice(undefined);
    setTurn((turn) => JSON.parse(JSON.stringify(turn)));
    setGeneration((value) => value + 1);
  };
  probe.stop = () =>
    setTurn({
      ...initial,
      status: "interrupted",
      interruptedByThisClient: true,
      durationMs: 4_500,
    });
  const timeline = projectTimeline(
    {
      key: createConversationKey("fixture", "fixture"),
      phase: "live",
      authoritative: true,
      revision: 1,
      turns: [turn],
    },
    createDefaultTimelineProjectorRegistry(),
  );
  const frame = timeline.frames.find((frame) => frame.type === "assistant")!;
  if (frame.type !== "assistant") throw new Error("Missing frame");
  const slots = createAssistantTurnPresentationPlan(frame).slots;
  if (params.has("conversation")) return <div style={{ width: 900, height: 700 }}>
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      <Conversation timeline={timeline} scrollPolicy={params.has("natural") ? "natural" : "response-placement"}
        onConversationScrollApiChange={(api) => { probe.scrollApi = api; }}
        footer={<div style={{ height: 80 }}>Composer</div>} />
    </TimelineBlockRendererProvider>
  </div>;
  return (
    <main style={{ width: 720, padding: 32 }}>
      <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
        <div key={generation}>
          {slots.map((unit) =>
            unit.type === "agent-activity" ? (
              <AgentActivity
                key={unit.id}
                unit={unit}
                persistedCollapsed={choice}
                onCollapsedChange={setChoice}
              />
            ) : unit.type === "assistant-content" ? (
              <p key={unit.id} data-final>
                {unit.block.type === "text" ? unit.block.text : ""}
              </p>
            ) : null,
          )}
        </div>
      </TimelineBlockRendererProvider>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Demo />);
