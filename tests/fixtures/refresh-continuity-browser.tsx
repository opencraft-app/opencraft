import React, { useLayoutEffect, useMemo, useState } from "react";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { Context } from "@deepseek-ai/cordis";
import { createIntlTestRoot } from "./intl-root";
import { createConversationDisplayContinuity } from "@opencraft/workbench-runtime";
import { createConversationKey, asTurnId, type TimelineSnapshot } from "@opencraft/chat-core";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { useConversationDisplay } from "../../apps/workbench-web/src/runtime/use-conversation-display";
import "../../apps/workbench-web/src/styles/app.scss";
const mode = new URL(location.href).searchParams.get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = mode;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(mode)))
  document.documentElement.style.setProperty(key, value);
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const key = createConversationKey("host", "refresh");
const command = (id: string) => ({
  type: "command-execution" as const,
  id,
  sourceItemIds: [id],
  command: "npm run verify",
  callId: "call-" + id,
  cwd: "/fixture",
  processId: null,
  startedAtMs: null,
  turnInProgress: false,
  output: "PRIVATE RESULT",
  exitCode: 0,
  durationMs: 120,
  actions: [],
  automaticApprovalReviews: [],
  status: "complete" as const,
});
const source: TimelineSnapshot = {
  key,
  revision: 1,
  phase: "live",
  authoritative: true,
  anchorFrameIds: new Map(),
  frames: [
    {
      id: "assistant",
      turnId: asTurnId("turn"),
      type: "assistant",
      status: "complete",
      durationMs: 60000,
      displayDurationMs: 60000,
      workStatus: { type: "worked-for", status: "worked", startedAtMs: 100, completedAtMs: 60100 },
      hookStats: null,
      anchors: [],
      blocks: [
        {
          type: "reasoning",
          id: "reason",
          sourceItemIds: [],
          summary: "Reviewing refresh continuity",
          detail: null,
          streaming: false,
        },
        command("first"),
        command("second"),
        {
          type: "text",
          id: "progress",
          sourceItemIds: [],
          text: "工具验证完成，正在核对缓存和真实历史的交接。",
          streaming: false,
          phase: "commentary",
          completed: true,
        },
        command("third"),
        {
          type: "text",
          id: "answer",
          sourceItemIds: [],
          text: "刷新后正文保持稳定。\n\n- 工具摘要完整\n- 标题同步恢复\n- 不重新淡入",
          streaming: false,
          phase: "final_answer",
          completed: true,
        },
      ],
    },
  ],
};
const values = new Map<string, string>();
const storage = {
  load: async (k: string) => values.get(k) ?? null,
  save: async (k: string, v: string) => {
    values.set(k, v);
  },
  remove: async (k: string) => {
    values.delete(k);
  },
};
await createConversationDisplayContinuity({ namespace: "fixture", storage }).observe(source, false, {
  title: "排查刷新连续性",
  project: "fixture",
});
// This owner has no resident data: its first paint really comes from storage.
const owner = createConversationDisplayContinuity({ namespace: "fixture", storage });
const continuity = { ...owner, getScope: () => "fixture", subscribe: () => () => {} };
const commits: unknown[] = [];
function App() {
  const [live, setLive] = useState<TimelineSnapshot | null>(null);
  const [selectedKey, setKey] = useState(key);
  const header = useMemo(
    () => (live?.authoritative ? { title: "排查刷新连续性", project: "fixture" } : undefined),
    [live],
  );
  const display = useConversationDisplay(continuity, selectedKey, live, false, header);
  const title = header?.title ?? display.header?.title;
  useLayoutEffect(() => {
    commits.push({ title, source: display.selection.source, frames: display.selection.timeline?.frames.length ?? 0 });
  }, [title, display.selection]);
  (window as any).refreshTest = {
    commits,
    live: () => setLive(source),
    partial: () =>
      setLive({
        ...source,
        authoritative: false,
        frames: source.frames.map((f) => ({ ...f, blocks: f.blocks.filter((b) => b.type !== "command-execution") })),
      }),
    other: () => {
      setKey(createConversationKey("host", "other"));
      setLive(null);
    },
    empty: () => setLive({ ...source, frames: [] }),
  };
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <header style={{ height: 50, flexShrink: 0, padding: "10px 16px" }}>
        <strong>{title}</strong>
      </header>
      <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
        <Conversation
          timeline={display.selection.timeline}
          historyPresentation={display.selection.source === "history" ? "none" : "warm-loading"}
          threadDetailLevel="STEPS_PROSE"
          scrollPolicy="response-placement"
          initialRestoreSnapshot={{
            distanceFromBottomPx: 0,
            virtualizedTurnList: null,
            agentActivityCollapsedById: {
              "turn:slot:agent-activity": false,
              "agent-activity-group:first": false,
            },
          }}
          footer={<textarea aria-label="Draft" defaultValue="保留我的草稿" />}
        />
      </TimelineBlockRendererProvider>
    </div>
  );
}
createIntlTestRoot(document.getElementById("root")).render(<App />);
