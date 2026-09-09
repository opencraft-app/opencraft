import type { Context } from "@deepseek-ai/cordis";
import type { TimelineBlock } from "@opencraft/chat-core";
import type { TimelineBlockRendererRegistration } from "@opencraft/timeline-render-react";

import { webBuiltinTimelineRendererComponents as component } from "../conversation";

const builtinTimelineRenderers: readonly TimelineBlockRendererRegistration[] = [
  { name: "user-message", priority: 0, types: ["user-message"], component: component.userMessage },
  { name: "text", priority: 0, types: ["text"], component: component.text },
  { name: "reasoning", priority: 0, types: ["reasoning"], component: component.reasoning },
  { name: "realtime-transcript", priority: 0, types: ["realtime-transcript"], component: component.realtimeTranscript },
  { name: "command", priority: 0, types: ["command-execution"], component: component.command },
  { name: "patch", priority: 0, types: ["patch"], component: component.patch },
  { name: "turn-diff", priority: 0, types: ["turn-diff"], component: component.turnDiff },
  { name: "automation-update", priority: 0, types: ["automation-update"], component: component.automationUpdate },
  {
    name: "image-view-tool",
    priority: 100,
    types: ["tool-call"],
    matches: (block: TimelineBlock) => block.type === "tool-call" && block.kind === "image-view",
    component: component.imageViewTool,
  },
  { name: "tool-call", priority: 0, types: ["tool-call"], component: component.toolCall },
  { name: "automatic-approval-review", priority: 0, types: ["automatic-approval-review"], component: component.automaticApprovalReview },
  { name: "auto-review-warning", priority: 0, types: ["auto-review-interruption-warning"], component: component.autoReviewWarning },
  { name: "plan", priority: 0, types: ["plan"], component: component.plan },
  { name: "plan-implementation", priority: 0, types: ["plan-implementation"], component: component["plan-implementation"] },
  { name: "todo", priority: 0, types: ["todo"], component: component.todo },
  { name: "subagent", priority: 0, types: ["subagent"], component: component.subagent },
  { name: "interaction", priority: 0, types: ["approval", "question", "option-picker", "elicitation"], component: component.interaction },
  { name: "error", priority: 0, types: ["error"], component: component.error },
  { name: "compaction", priority: 0, types: ["compaction"], component: component.compaction },
  { name: "image", priority: 0, types: ["image"], component: component.image },
  { name: "unknown", priority: 0, types: ["unknown"], component: component.unknown },
];

export const BuiltinTimelineRendererPlugin = Object.assign(
  function BuiltinTimelineRendererPlugin(ctx: Context): void {
    const disposers = builtinTimelineRenderers.map((renderer) => ctx.timelineBlockRenderers.register(renderer));
    ctx.effect(() => () => disposers.reverse().forEach((dispose) => dispose()));
  },
  { inject: ["timelineBlockRenderers"] },
);
