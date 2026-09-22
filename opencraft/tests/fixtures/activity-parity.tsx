import React, { useState } from "react";
import { createIntlTestRoot as createRoot } from "./intl-root";
import { flushSync } from "react-dom";
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
import {
  ReferenceActivity,
  isFinalAnswerPhase,
} from "virtual:codex-activity-reference";
import "../../apps/workbench-web/src/styles/app.scss";
import "./activity-reference.css";

const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
ctx.timelineBlockRenderers.register({
  name: "activity-parity-body",
  types: ["text"],
  component: ({ block }) => (
    <div style={{ lineHeight: "22px" }}>
      {block.type === "text" ? block.text : ""}
    </div>
  ),
});
for (const [key, value] of Object.entries(
  buildCodexThemeCssProperties("light"),
))
  document.documentElement.style.setProperty(key, value);
const start = Date.now() - 41_000;
const initial: TimelineSourceTurn = {
  id: "turn",
  status: "streaming",
  startedAtMs: start,
  firstTurnWorkItemStartedAtMs: start,
  items: [
    { id: "reason", type: "reasoning", payload: { summary: [] } },
    {
      id: "work",
      type: "agentMessage",
      payload: {
        text: "Checking the request",
        phase: "commentary",
        completed: true,
      },
    },
  ],
};
function Demo() {
  const [turn, setTurn] = useState(initial);
  const [choice, setChoice] = useState<boolean>();
  (window as any).activityProbe = {
    event(kind: string) {
      flushSync(() => {
        if (kind === "reset") {
          setTurn(initial);
          setChoice(undefined);
          return;
        }
        if (kind === "expand") {
          setChoice(false);
          return;
        }
        if (kind === "collapse") {
          setChoice(true);
          return;
        }
        setTurn((current) => ({
          ...current,
          status: kind === "complete" ? "complete" : "streaming",
          finalAssistantStartedAtMs:
            kind === "final-no-clock" ? null : start + 41_000,
          items: [
            ...initial.items,
            {
              id: "answer",
              type: "agentMessage",
              payload: {
                text: kind === "grow" ? "Answer ".repeat(30) : "Answer",
                phase: kind === "unphased" ? undefined : "final_answer",
                completed: kind === "complete",
              },
            },
          ],
        }));
      });
    },
  };
  const timeline = projectTimeline(
    {
      key: createConversationKey("fixture", "activity"),
      revision: 1,
      phase: "live",
      authoritative: true,
      turns: [turn],
    },
    createDefaultTimelineProjectorRegistry(),
  );
  const frame = timeline.frames.find((f) => f.type === "assistant")!;
  if (frame.type !== "assistant") throw new Error("Missing frame");
  const unit = createAssistantTurnPresentationPlan(frame).slots.find(
    (u) => u.type === "agent-activity",
  )!;
  if (unit.type !== "agent-activity") throw new Error("Missing activity");
  const originalUnits = unit.contentUnits.map((u) => ({
    kind: u.type === "group" ? "group" : "standalone",
    key: u.id,
    vela: u,
    ...(u.type === "group"
      ? { items: u.blocks.map((block) => ({ item: block })) }
      : {
          item: {
            item:
              u.type === "worked-for"
                ? u.item
                : {
                    ...u.block,
                    type:
                      u.block.type === "text"
                        ? "assistant-message"
                        : u.block.type,
                  },
          },
        }),
  }));
  // Do not reuse the candidate's final/collapse verdict in the reference.
  const final = turn.items.some(
    (i) =>
      i.type === "agentMessage" &&
      isFinalAnswerPhase({
        ...(i.payload as any),
        content: (i.payload as any).text ?? "",
      }),
  );
  return (
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      <div className="parity-side" id="candidate">
        <AgentActivity
          unit={unit}
          persistedCollapsed={choice}
          onCollapsedChange={setChoice}
        />
      </div>
      <div className="parity-side reference" id="reference">
        <ReferenceActivity
          items={originalUnits}
          agentActivityProps={{}}
          hasFinalAssistantStarted={final}
          isTurnCancelled={false}
          persistedCollapsed={choice}
          onSetCollapsed={setChoice}
        />
      </div>
    </TimelineBlockRendererProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Demo />);
