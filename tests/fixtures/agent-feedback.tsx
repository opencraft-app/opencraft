import React, { useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline, type TimelineSourceItem } from "@opencraft/chat-core";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { initializeAppearanceTheme } from "../../apps/workbench-web/src/appearance-theme";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const context = new Context(); await context.plugin(TimelineBlockRendererRegistryService); await context.plugin(BuiltinTimelineRendererPlugin);
const registry = createDefaultTimelineProjectorRegistry();
function Fixture() {
  const [continued, setContinued] = useState(false);
  const [handoffStarted, setHandoffStarted] = useState(false);
  const [failedCode, setFailedCode] = useState<"acpPromptFailed" | "acpAccountMismatch" | null>(null);
  Object.assign(window, {
    feedbackFixture: {
      fail: (code: "acpPromptFailed" | "acpAccountMismatch" = "acpPromptFailed") => {
        setContinued(false);
        setHandoffStarted(false);
        setFailedCode(code);
      },
    },
  });
  const failed = failedCode !== null;
  const items: TimelineSourceItem[] = [
    { id: "user", type: "userMessage", payload: { content: [{ type: "text", text: "Show progress" }] } },
    { id: "plan", type: "todo-list", payload: { plan: [{ step: "Check usage", status: "completed" }, { step: "Verify refresh", status: "inProgress" }] } },
    ...(continued ? [{ id: "reply", type: "agentMessage", payload: { text: "CONTINUED_OK" } }] : failed ? [{ id: "failure", type: "error", payload: { code: failedCode, message: failedCode } }] : []),
  ];
  const timeline = projectTimeline({ key: createConversationKey("fixture", "feedback"), revision: Number(continued) + Number(failed) + Number(handoffStarted) + (failedCode === "acpAccountMismatch" ? 10 : 0), authoritative: true, phase: "live", turns: [{ id: "turn", status: continued ? "complete" : failed ? "failed" : "streaming", items }] }, registry);
  return <div style={{ width: "100vw", height: "100dvh" }}><TimelineBlockRendererProvider registry={context.timelineBlockRenderers}>
    <Conversation
      timeline={timeline}
      scrollPolicy="natural"
      continuableTurnId={continued || failedCode === "acpAccountMismatch" ? null : "turn"}
      onContinueTurn={() => setContinued(true)}
      documentContext={{ conversationId: "feedback", cwd: "/fixture", hostId: "fixture", theme: "light", onStartHandoff: () => setHandoffStarted(true) }}
      footer={<>{handoffStarted ? <div>HANDOFF_STARTED</div> : null}<textarea aria-label="Unsent draft" defaultValue="preserved feedback draft" /></>}
    />
  </TimelineBlockRendererProvider></div>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, new URLSearchParams(location.search).get("locale") ?? "en-US").render(<Fixture />);
