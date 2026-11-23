import React, { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createIntlTestRoot } from "./intl-root.tsx";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell.tsx";
import { ConversationTaskMenu } from "../../apps/workbench-web/src/components/conversation-task-menu.tsx";
import { ThreadRowMenu, useThreadActionOwner } from "../../apps/workbench-web/src/components/thread-management.tsx";
import { ConversationAppearanceProvider } from "../../apps/workbench-web/src/components/conversation-appearance.tsx";
import { useUiPreferencesRuntime } from "../../apps/workbench-web/src/runtime/ui-preferences-runtime.tsx";
import { bindInteractionDensity } from "../../apps/workbench-web/src/runtime/interaction-density.ts";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme.ts";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const client = new QueryClient();
const noop = () => {};
const done = async () => {};
const taskPort = { request: async () => ({ tasks: [] }) };
const access = {
  read: async () => ({ accessMode: "shared", revision: 1, canChangeAccess: true }),
  set: async () => ({ accessMode: "private", revision: 2, canChangeAccess: true }),
};

function SidebarExample() {
  const [open, setOpen] = useState<string | null>(null);
  const owner = useThreadActionOwner({
    onRename: done,
    onFork: done,
    onArchive: done,
    onDelete: done,
    onCopyReference: done,
    onSetPinned: done,
  } as any);
  return (
    <div style={{ padding: 16 }}>
      <div className="sidebar-brand">
        <strong>OpenCraft</strong>
      </div>
      <div className="sidebar-thread-group-heading">Today</div>
      <ThreadRowMenu
        target={{ hostId: "local", threadId: "demo", title: "Container distribution" } as any}
        owner={owner}
        capabilities={{ rename: true, archive: true, fork: true, delete: false, pin: true, reference: true } as any}
        openMenuKind={open as any}
        onOpenMenuChange={(kind: string, value: boolean) => setOpen(value ? kind : null)}
      >
        <button type="button" className="sidebar-activity-item">
          <span>Container distribution</span>
        </button>
      </ThreadRowMenu>
      <p style={{ color: "var(--color-text-secondary)" }}>Turn notifications</p>
    </div>
  );
}

function Fixture() {
  const preferences = useUiPreferencesRuntime();
  const [kind, setKind] = useState("chat");
  useEffect(() => {
    (window as any).fixture = {
      setTouch: (mode: string) => preferences.set("interface.touchFriendly", mode),
      setTheme: setThemePreference,
      setKind,
    };
    return bindInteractionDensity(document, preferences);
  }, [preferences]);
  return (
    <ConversationAppearanceProvider scope="menu-refinement" routeKey="menu-refinement">
      <AppShell
        layoutScope="menu-refinement"
        mainContentLayout="thread-edge-scroll"
        sidebarOpen={false}
        sidebarWidth={280}
        onSidebarCollapse={noop}
        onSidebarExpand={noop}
        onSidebarResizeEnd={noop}
        windowChrome={{ kind: "browser", platform: "darwin", safeArea: { left: 0, right: 0 } } as any}
        rightPanel={null}
        rightPanelOpen={false}
        rightPanelFullWidth={false}
        onRightPanelOpenChange={noop}
        floatingSidebarHeader={() => null}
        leftPanel={null}
        header={
          <div
            style={{
              padding: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
            }}
          >
            <span>Turn notifications</span>
            {kind === "chat" ? (
              <ConversationTaskMenu
                {...({
                  scope: "menu-refinement",
                  serverId: "local",
                  threadId: "demo",
                  title: "Turn notifications",
                  appearanceHostId: "local",
                  shareUrl: "https://example.test/conversation",
                  port: taskPort,
                  access,
                  verifyConversation: done,
                  onOpenTasks: noop,
                  onRename: done,
                  onSetPinned: async () => {
                    (window as any).invoked = "pin";
                  },
                  onFork: done,
                  onArchive: done,
                  project: "OpenCraft",
                  workspaceDirectory: "/workspace",
                  schedules: { request: async () => ({ schedules: [] }) },
                  im: { fetcher: fetch, openSettings: noop },
                } as any)}
              />
            ) : null}
          </div>
        }
      >
        {kind === "sidebar" ? (
          <SidebarExample />
        ) : (
          <section style={{ padding: 20 }}>
            <p>Menus keep their touch targets while the hierarchy and material stay light.</p>
            <textarea aria-label="Draft" defaultValue="Unsent draft" />
          </section>
        )}
      </AppShell>
    </ConversationAppearanceProvider>
  );
}

createIntlTestRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <Fixture />
  </QueryClientProvider>,
);
