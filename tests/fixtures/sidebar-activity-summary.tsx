import React, { useState } from "react";
import { createIntlTestRoot } from "./intl-root";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
import { AppShellHeader, AppShellNavigationControls } from "../../apps/workbench-web/src/components/app-shell-header";
import { Sidebar, type SidebarThread } from "../../apps/workbench-web/src/components/sidebar";
import { SidebarLayoutStore } from "@opencraft/sidebar-layout";
import { legacyDirectServerProjectionFromHost } from "@opencraft/workbench-runtime";
import {
  UiPreferencesProvider,
  openWorkbenchUiPreferences,
} from "../../apps/workbench-web/src/runtime/ui-preferences-runtime";
import { initializeAppearanceTheme } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const preferences = await openWorkbenchUiPreferences();
const layout = await SidebarLayoutStore.open({ load: async () => null, save: async (_, value) => value });
const base = legacyDirectServerProjectionFromHost({ hostId: "local", hostKind: "local", label: "Local" });
let order = 0;
const thread = (id: string, overrides: Partial<SidebarThread> = {}): SidebarThread => ({
  id,
  title: id,
  project: "",
  status: "ready",
  updatedAt: Date.now() / 1000 - order++,
  connectionHostId: "local",
  connectionHostLabel: "Local",
  ...base,
  ...overrides,
});
const initial = [
  thread("pin-blue", { title: "置顶未读", pinned: true, unread: true }),
  thread("pin-run", { title: "置顶进行中", pinned: true, status: "running" }),
  thread("pin-parent", { title: "置顶含派生会话", pinned: true }),
  thread("pin-goal", { title: "置顶持续目标", pinned: true, goalActive: true }),
  ...Array.from({ length: 3 }, (_, i) => thread(`pin-idle-${i}`, { pinned: true })),
  thread("pin-later", { title: "后续分页未读", pinned: true, unread: true }),
  thread("pin-wait", { parentThreadId: "pin-parent", status: "review" }),
  thread("pin-error", { parentThreadId: "pin-parent", status: "error" }),
  thread("pin-child-run", { parentThreadId: "pin-parent", status: "running" }),
  thread("pin-blue", {
    title: "另一台服务器",
    pinned: true,
    unread: true,
    connectionHostId: "remote",
    connectionHostLabel: "Remote",
    ...legacyDirectServerProjectionFromHost({ hostId: "remote", hostKind: "remote", label: "Remote" }),
  }),
  thread("hidden-pin", { pinned: true, status: "running", visibility: "hidden" }),
  thread("recent-run", { title: "最近进行中", status: "running" }),
  ...Array.from({ length: 12 }, (_, i) =>
    thread(`recent-${i}`, { title: `最近会话 ${i}`, unread: i === 0 || i === 11 }),
  ),
  thread("nonparticipant", { unread: true }),
  thread("standalone-wait", { status: "review" }),
  thread("standalone-error", { status: "error" }),
  thread("private", { title: "私密会话", accessMode: "private", unread: true }),
];
const grouping = {
  subscribe: () => () => {},
  getSnapshot: () => snapshot,
  watch: () => () => {},
  filterThreads: (refs: any) => refs,
  isParticipant: (ref: any) => ref.threadId !== "nonparticipant",
  project: () => [],
  toggleGroup() {},
  setMode() {},
};
const snapshot = { revision: 0, mode: null, modes: [], hideRowBadge: false, notice: null };

function Fixture() {
  const [rows, setRows] = useState(initial),
    [open, setOpen] = useState(true),
    [active, setActive] = useState("recent-0");
  (window as any).sidebarSummaryFixture = {
    initial,
    setRows,
    preferences,
    patch: (id: string, changes: Partial<SidebarThread>) =>
      setRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...changes } : row))),
  };
  return (
    <UiPreferencesProvider runtime={preferences}>
      <AppShell
        navigation={{
          layout: "unified",
          settingsActive: false,
          onOpenSettings() {},
          account: {
            snapshot: { phase: "anonymous", name: null, avatarUrl: null },
            onOpen() {},
            onRefresh: async () => {},
            onSignOut: async () => {},
          },
          actions: [],
        }}
        layoutScope="sidebar-summary"
        sidebarOpen={open}
        sidebarWidth={335}
        onSidebarCollapse={() => setOpen(false)}
        onSidebarExpand={() => setOpen(true)}
        onSidebarResizeEnd={() => {}}
        windowChrome={{ kind: "browser", platform: "linux", safeArea: { left: 0, right: 0 } }}
        rightPanel={null}
        rightPanelOpen={false}
        rightPanelFullWidth={false}
        onRightPanelOpenChange={() => {}}
        header={
          <AppShellHeader
            title={null}
            project={null}
            sidebarOpen={open}
            rightPanelOpen={false}
            rightPanelFullWidth={false}
            showRightPanelAction={false}
            onToggleSidebar={() => setOpen(!open)}
            onToggleRightPanel={() => {}}
            onHome={() => {}}
            canGoBack={false}
            canGoForward={false}
            onBack={() => {}}
            onForward={() => {}}
            navigationActions={["sidebar-toggle"]}
          />
        }
        floatingSidebarHeader={(dock) => (
          <AppShellNavigationControls
            hostRole="transient"
            sidebarOpen={false}
            canGoBack={false}
            canGoForward={false}
            onToggleSidebar={dock}
            onHome={() => {}}
            onBack={() => {}}
            onForward={() => {}}
            actions={["sidebar-toggle"]}
          />
        )}
        leftPanel={
          <Sidebar
            threads={rows}
            activeHostId="local"
            activeThreadId={active}
            sidebarLayout={layout}
            threadListGrouping={grouping}
            onSelectThread={(_, id) => setActive(id)}
            onNewTask={() => {}}
            onOpenSettings={() => {}}
            showStart={false}
            showFooter={false}
          />
        }
      >
        <textarea aria-label="Main draft" defaultValue="保留草稿" />
      </AppShell>
    </UiPreferencesProvider>
  );
}
createIntlTestRoot(document.getElementById("root")!, undefined, "zh-CN").render(<Fixture />);
