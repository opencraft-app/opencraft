import React, { useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline, type TimelineSourceItem } from "@opencraft/chat-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { initializeAppearanceTheme } from "../../apps/workbench-web/src/appearance-theme";
import { createComposerController } from "@opencraft/composer-core";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { ThreadComposerPresentation, FloatingComposerToggle } from "../../apps/workbench-web/src/components/thread-composer-presentation";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
import { WorkbenchPresentationActivityProvider } from "../../apps/workbench-web/src/components/workbench-presentation-activity";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";
initializeAppearanceTheme();
const context = new Context();
await context.plugin(TimelineBlockRendererRegistryService);
await context.plugin(BuiltinTimelineRendererPlugin);
const registry = createDefaultTimelineProjectorRegistry();
const key = createConversationKey("test", "same-thread");
const controller = createComposerController({ type: "existing-thread", key }, { now: Date.now, createId: () => crypto.randomUUID() });
const documentContext = { theme: "light" as const, hostId: key.hostId, conversationId: key.threadId, cwd: "/work" };
const touch = new URLSearchParams(location.search).has("touch");
if (touch) document.documentElement.dataset.uiDensity = "touch";
function Demo() {
  const [overlay, setOverlay] = useState(false);
  const [count, setCount] = useState(100);
  const [tool, setTool] = useState("terminal:one");
  Object.assign(window, { overlayProbe: { setOverlay, setTool, append: () => setCount(value => value + 1) } });
  const items: TimelineSourceItem[] = [{ id: "prompt", type: "userMessage", payload: { content: [{ type: "inputText", text: "Same thread prompt" }] } }];
  for (let index = 0; index < count; index++) {
    items.push({ id: `cmd-${index}`, type: "commandExecution", payload: { command: `echo activity-${index}`, status: "completed", exitCode: 0, aggregatedOutput: `Output ${index}` } });
    items.push({ id: `reason-${index}`, type: "reasoning", payload: { summary: [`Thought ${index}\n\nReasoning detail ${index}`], content: [`Reasoning detail ${index}`], completed: true } });
    if (index === 20) items.push({ id: "commentary", type: "agentMessage", payload: { text: "Visible commentary in the same thread", phase: "commentary", completed: true } });
  }
  const timeline = projectTimeline({ key, revision: count, authoritative: true, phase: "live", turns: [{ id: "turn", status: "streaming", items }] }, registry);
  const composer = <ThreadComposerPresentation scopeId="overlay-content" controller={controller} activeTabId={tool} enabled timeline={timeline} documentContext={documentContext}>
    <div className="thread-composer-region"><OpenCraftComposer controller={controller} placeholder="Draft" onSubmit={() => false} onCancel={() => {}} /></div>
  </ThreadComposerPresentation>;
  return <WorkbenchPresentationActivityProvider active><TimelineBlockRendererProvider registry={context.timelineBlockRenderers}>
    <AppShell floatingSidebarHeader={() => null} layoutScope="overlay-content" mainContentLayout="default" header={<button onClick={() => setOverlay(!overlay)}>Toggle tool</button>}
      onSidebarCollapse={() => {}} onSidebarExpand={() => {}} onSidebarResizeEnd={() => {}} sidebarOpen={false} sidebarWidth={275} leftPanel={null} rightPanel={<div>Tool content <FloatingComposerToggle activeTabId={tool} /></div>} rightPanelOpen={overlay} rightPanelFullWidth={overlay}
      windowChrome={{ kind: "browser", platform: "linux", safeArea: { left: 0, right: 0 } }}>
      <Conversation timeline={timeline} scrollPolicy="natural" documentContext={documentContext} footer={composer} />
    </AppShell>
  </TimelineBlockRendererProvider></WorkbenchPresentationActivityProvider>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Demo />);
