import React, { useState } from "react";
import { createIntlTestRoot } from "./intl-root";
import { Context } from "@deepseek-ai/cordis";
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from "@opencraft/chat-core";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { Conversation } from "../../apps/workbench-web/src/components/conversation";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { ConversationUnavailableState, ConversationArchivedBadge } from "../../apps/workbench-web/src/components/conversation-archived";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
import { AppShellHeader } from "../../apps/workbench-web/src/components/app-shell-header";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import { useAsyncNotices } from "../../apps/workbench-web/src/components/async-notices";
import "../../apps/workbench-web/src/styles/app.scss";
initializeAppearanceTheme();
setThemePreference(new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light");
const ctx = new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const timeline = projectTimeline({ key: createConversationKey("fixture", "archived"), revision: 1,
  authoritative: false, phase: "live", turns: Array.from({length: 8}, (_, i) => ({id: `turn-${i}`, status: "complete" as const, items: [
    {id: `user-${i}`, type: "userMessage", payload: {content: [{type: "input_text", text: `历史问题 ${i + 1}：请帮我检查这份设计。`}]}},
    {id: `answer-${i}`, type: "agentMessage", payload: {text: `历史回复 ${i + 1}：已检查布局和交互。归档后这段内容仍应保留。`, phase: "final_answer", completed: true}},
  ]})) }, createDefaultTimelineProjectorRegistry());
const noop = () => {};
function Fixture() {
  const [archived, setArchived] = useState(true), [pending, setPending] = useState(false);
  const notices = useAsyncNotices();
  const restore = async () => {
    setPending(true);
    const success = await new Promise<boolean>(resolve => { (window as any).settleRestore = resolve; });
    if (success) setArchived(false);
    else notices.error({key: "restore", message: "恢复会话失败，请重试。"});
    setPending(false);
  };
  return <AppShell layoutScope="conversation-archived" mainContentLayout="default"
    windowChrome={{kind: "browser", platform: "linux", safeArea: {left: 0, right: 0}}}
    sidebarOpen={false} sidebarWidth={232} onSidebarCollapse={noop} onSidebarExpand={noop} onSidebarResizeEnd={noop}
    rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={noop} floatingSidebarHeader={() => null}
    header={<AppShellHeader title="设计讨论" project={null}
      titleContent={<span className="conversation-appearance-heading"><span className="thread-header-copy"><strong>设计讨论</strong></span>{archived ? <ConversationArchivedBadge /> : null}</span>}
      sidebarOpen={false} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false}
      onToggleSidebar={noop} onToggleRightPanel={noop} onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={[]} />}>
    <div className="local-conversation-page"><TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
      <Conversation timeline={timeline} scrollPolicy="natural" threadDetailLevel="STEPS_COMMANDS"
        readOnlyTurnIds={archived ? new Set(timeline.frames.map(frame => frame.turnId)) : undefined}
        footer={archived ? <ConversationUnavailableState reason="archived" onRestore={restore} restoring={pending} /> : <textarea aria-label="继续对话" defaultValue="保留的草稿" />} />
    </TimelineBlockRendererProvider></div>
  </AppShell>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, "zh-CN").render(<Fixture />);
