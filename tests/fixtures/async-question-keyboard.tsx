import React, { useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline, renderAsyncQuestionReply, type AsyncQuestion } from "@opencraft/chat-core";
import { buildOpenCraftThemeCssProperties, opencraftCanvasThemePalette, lavenderThemePalette, frostThemePalette } from "@opencraft/design-system/theme-engine";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { createIntlTestRoot as createRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

// Real Conversation owns drafts, pending/error state and the synchronous send
// guard. Only its external answer port is replaced; no real message is sent.
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) document.documentElement.style.setProperty(key, value);
const registry = createDefaultTimelineProjectorRegistry();
const params = new URLSearchParams(location.search);
const locale = params.get("locale") ?? "en-US";
const design = params.has("design");
const question: AsyncQuestion = { id: JSON.stringify(["request_user_input_async", "question", 0]), title: design ? "这次提交需要确认发言人身份。确认后才能沿用对应姓名和邮箱；我会先继续修复和验证。请选择本次提交使用的身份。" : "How should we proceed?",
  options: design ? ["是，沿用当前提交身份", "使用其他提交身份"] : params.has("suggested") ? ["Suggested answer"] : [] };
type Mode = "pending" | "queued" | "disconnected" | "answered" | "dismissed" | "unconfirmed";
let settle: ((failed: boolean) => void) | undefined;
const probe = window as typeof window & {
  answers: { id: string; text: string }[];
  setQuestionMode: (mode: Mode) => void;
  settleAnswer: (failed: boolean) => void;
  setQuestionPalette: (palette: string, mode: "light" | "dark") => void;
};
probe.answers = [];
probe.setQuestionPalette = (palette, mode) => {
  const definition = palette === "lavender" ? lavenderThemePalette : palette === "frost" ? frostThemePalette : opencraftCanvasThemePalette;
  document.documentElement.dataset.theme = mode;
  for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(mode, definition[mode]))) document.documentElement.style.setProperty(key, value);
};
if (design) probe.setQuestionPalette(params.get("palette") ?? "canvas", theme);
probe.settleAnswer = (failed) => settle?.(failed);

function Demo() {
  const [mode, setMode] = useState<Mode>("pending");
  probe.setQuestionMode = setMode;
  const items: { id: string; type: string; payload: Record<string, unknown> }[] = [{ id: "question", type: "agentMessage", payload: { id: "question", type: "agentMessage", phase: "finalAnswer", delivery: "async",
    content: [{ type: "text", text: question.title }], questions: [{ title: question.title, options: question.options }] } }];
  if (mode === "answered" || mode === "dismissed" || mode === "unconfirmed") items.push({ id: "reply", type: "steeringUserMessage", payload: {
    type: "steeringUserMessage", deliveryStatus: mode === "unconfirmed" ? "unknown" : undefined, content: [{ type: "text", text: mode !== "dismissed" ? renderAsyncQuestionReply(question, "Already answered") : "A later instruction" }],
  } });
  const timeline = projectTimeline({ key: createConversationKey("fixture", "thread"), revision: 1, authoritative: true, phase: "live",
    turns: [{ id: "turn", status: "streaming", items }] }, registry);
  return <div style={{ width: "100vw", height: "100dvh" }}>
    <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      <Conversation scrollPolicy="response-placement" timeline={timeline} queuedAsyncQuestionIds={mode === "queued" ? [question.id] : []}
        onAnswerAsyncQuestion={mode === "disconnected" ? undefined : async (item, text) => {
          probe.answers.push({ id: item.id, text });
          await new Promise<void>((resolve, reject) => { settle = (failed) => { settle = undefined; if (failed) reject(new Error("Please retry")); else resolve(); }; });
        }} />
    </TimelineBlockRendererProvider>
  </div>;
}
createRoot(document.getElementById("root")!, undefined, locale).render(<Demo />);
