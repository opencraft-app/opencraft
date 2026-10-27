import React, { useState } from "react";
import { createIntlTestRoot as createRoot } from "./intl-root";
import { Context } from "@deepseek-ai/cordis";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import {
  createConversationKey,
  createDefaultTimelineProjectorRegistry,
  projectTimeline,
  summarizeHookRuns,
  type TimelineSourceTurn,
  type ConversationDetailLevel,
} from "@opencraft/chat-core";
import {
  TimelineBlockRendererProvider,
  TimelineBlockRendererRegistryService,
} from "@opencraft/timeline-render-react";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import "../../apps/workbench-web/src/styles/app.scss";

const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
document.documentElement.dataset.theme = "light";
for (const [key, value] of Object.entries(
  buildOpenCraftThemeCssProperties("light"),
))
  document.documentElement.style.setProperty(key, value);
const probe = window as any;
const planText =
  "# Release plan\n\n" +
  Array.from(
    { length: 18 },
    (_, index) => `${index + 1}. Verify **step ${index + 1}**`,
  ).join("\n");
function Demo() {
  const [turn, setTurn] = useState<TimelineSourceTurn>({
    id: "turn",
    status: "streaming",
    items: [{ id: "plan", type: "plan", payload: { text: planText } }],
  });
  const [detail, setDetail] =
    useState<ConversationDetailLevel>("STEPS_COMMANDS");
  const [generation, setGeneration] = useState(0);
  probe.hooks = () => {
    setGeneration(value => value + 1);
    setTurn({ id: "hook-turn", status: "complete",
      items: [{ id: "hook-answer", type: "agentMessage", payload: { text: "Hook result", completed: true } }],
      hookStats: summarizeHookRuns([
        ...["one", "two"].map(id => ({ id, eventName: "userPromptSubmit", source: "project", status: "blocked",
          entries: [{ kind: "context", text: "hidden context" }, { kind: "feedback", text: "Add a test." }] })),
        { id: "failed", eventName: "postToolUse", source: "user", status: "failed", entries: [{ kind: "error", text: "Audit failed." }] },
      ]),
    });
  };
  probe.complete = () => setTurn((turn) => ({ ...turn, status: "complete" }));
  probe.restore = () => setGeneration((value) => value + 1);
  probe.detail = setDetail;
  probe.scenario = (scenario: string) => {
    if (scenario === "single-unrelated" || scenario === "single-voice") {
      setGeneration(value => value + 1);
      setTurn({ id: "single-input-turn", status: "complete", items: scenario === "single-unrelated" ? [
        { id: "local", type: "steeringUserMessage", payload: { input: { type: "text", text: "Keep the draft" }, status: "accepted" } },
        { id: "server", type: "userMessage", payload: { content: { type: "text", text: "Delete the draft" } } },
      ] : [{ id: "realtime-delegation-fixture", type: "userMessage", payload: { content: { type: "text", text: "<realtime_delegation><transcript_delta>assistant: Ready</transcript_delta><input>Hello voice</input></realtime_delegation>" } } }] });
      return;
    }
    setGeneration((value) => value + 1);
    setTurn({
      id: "turn",
      status: scenario === "answer" ? "failed" : "streaming",
      items:
        scenario === "skill"
          ? [{ id: "skill-read", type: "commandExecution", payload: {
              command: "cat SKILL.md", status: "inProgress",
              commandActions: [{ type: "read", command: "cat SKILL.md", name: "SKILL.md", path: "/workspace/.agents/skills/review/SKILL.md" }],
            } }]
          : scenario === "todo"
          ? [
              {
                id: "todo-old",
                type: "todo-list",
                payload: {
                  explanation: "Inspect first",
                  plan: [
                    { step: "Inspect source", status: "inProgress" },
                    { step: "Test rendering", status: "pending" },
                    { step: "Ship", status: "pending" },
                  ],
                },
              },
              {
                id: "todo-latest",
                type: "todo-list",
                payload: {
                  explanation: "Inspect first",
                  plan: [
                    { step: "Inspect source", status: "completed" },
                    { step: "Test rendering", status: "inProgress" },
                    { step: "Ship", status: "pending" },
                  ],
                },
              },
            ]
          : scenario === "compaction"
            ? [
                {
                  id: "compact",
                  type: "contextCompaction",
                  payload: { source: "manual", completed: false },
                },
              ]
            : scenario === "command"
              ? [
                  {
                    id: "cmd",
                    type: "commandExecution",
                    payload: { command: "npm test", status: "inProgress" },
                  },
                ]
              : [
                  {
                    id: "answer",
                    type: "agentMessage",
                    payload: {
                      text: "**Answer** with `code`.\n\n- First\n- Second",
                      phase: "final_answer",
                      startedAtMs: 1_700_000_000_000,
                    },
                  },
                ],
    });
  };
  const timeline = projectTimeline(
    {
      key: createConversationKey("fixture", "thread"),
      revision: generation,
      authoritative: true,
      phase: "live",
      turns: [turn],
    },
    createDefaultTimelineProjectorRegistry(),
  );
  return (
    <div style={{ width: 900, height: 760 }}>
      <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
        <Conversation
          scrollPolicy="response-placement"
          key={generation}
          timeline={timeline}
          threadDetailLevel={detail}
          footer={<div style={{ height: 48 }}>Composer fixture</div>}
        />
      </TimelineBlockRendererProvider>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Demo />);
