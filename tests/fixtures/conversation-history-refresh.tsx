import { useCallback, useMemo, useState } from "react";
import { createIntlTestRoot } from "./intl-root";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
import { AppShellHeader } from "../../apps/workbench-web/src/components/app-shell-header";
import { EditableThreadTitle } from "../../apps/workbench-web/src/components/editable-thread-title";
import type { ConversationPresentationProvider } from "../../apps/workbench-web/src/runtime/conversation-presentation";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";
initializeAppearanceTheme();
setThemePreference(new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light");
import { PresentationActivity, PresentationActivityProvider } from "@opencraft/react-runtime";
const activity = new PresentationActivity();
import type { AppServerThreadRuntimeLease } from "@opencraft/workbench-runtime";
import { useConversationHistoryRefresh } from "../../apps/workbench-web/src/components/conversation-history-refresh";

let externalRows = ["原有外部消息", "原有回复"];
let reads = 0;
let applied = 0;
const source = { park(active: boolean) { activity.setActive(active); }, append() { externalRows = [...externalRows, "新的外部消息", "新的回复"]; }, get reads() { return reads; }, get applied() { return applied; } };
Object.assign(window, { externalConversationFixture: source });
const noop = () => {};
const presentation: ConversationPresentationProvider = context => ({
  subtitle: context.extra === "external" ? "外部会话 · 示例" : undefined,
  beforeComposer: <p data-presentation-before="true">可在原会话继续输入</p>,
  afterComposer: <p data-presentation-after="true">消息仍发送到原会话</p>,
  refreshHistory: context.extra === "external",
});
function Fixture() {
  const [title, rename] = useState("示例会话");
  const [messages, setMessages] = useState(externalRows);
  const [enabled, setEnabled] = useState(true);
  const lease = useMemo(() => ({
    async refreshHistory(signal: AbortSignal) {
      reads++;
      if (signal.aborted || applied === externalRows.length) return false;
      applied = externalRows.length;
      setMessages(externalRows);
      return true;
    },
  }) as unknown as AppServerThreadRuntimeLease, []);
  const onChanged = useCallback(async () => {}, []);
  const contribution = presentation({ hostId: "fixture", threadId: "external", extra: enabled ? "external" : null,
    ready: true, authoritative: true, canFork: false, readExtra: async () => null, fork: async () => {} });
  useConversationHistoryRefresh(lease, contribution?.refreshHistory === true, onChanged);
  return <AppShell layoutScope="conversation-presentation" mainContentLayout="default"
    windowChrome={{ kind: "browser", platform: "linux", safeArea: { left: 0, right: 0 } }}
    sidebarOpen={false} sidebarWidth={232} onSidebarCollapse={noop} onSidebarExpand={noop}
    onSidebarResizeEnd={noop} rightPanel={null} rightPanelOpen={false} rightPanelFullWidth={false}
    onRightPanelOpenChange={noop} floatingSidebarHeader={() => null}
    header={<AppShellHeader title={title} project={null} subtitle={contribution?.subtitle}
      titleContent={<EditableThreadTitle title={title} onRename={async value => rename(value)} />}
      sidebarOpen={false} rightPanelOpen={false} rightPanelFullWidth={false} showRightPanelAction={false}
      onToggleSidebar={noop} onToggleRightPanel={noop} onHome={noop} canGoBack={false} canGoForward={false}
      onBack={noop} onForward={noop} navigationActions={[]} />}>
    <main style={{ padding: 16 }}>
    <div aria-label="聊天内容" style={{ height: 240, overflow: "auto", overflowAnchor: "none" }}>
      {Array.from({ length: 12 }, (_, i) => <p key={i} style={{ height: 40 }}>较早消息 {i}</p>)}
      {messages.map((text, i) => <p key={i} style={{ height: 40 }}>{text}</p>)}
    </div>
    {contribution?.beforeComposer}
    <textarea aria-label="待发送草稿" defaultValue="未发送的草稿" />
    {contribution?.afterComposer}
    <button onClick={() => setEnabled(false)}>离开外部会话</button>
  </main></AppShell>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, "zh-CN").render(<PresentationActivityProvider source={activity}><Fixture /></PresentationActivityProvider>);
