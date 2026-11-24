import React, { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createIntlTestRoot } from "./intl-root.tsx";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell.tsx";
import { AppShellToolbarSelect } from "../../apps/workbench-web/src/components/app-shell-toolbar-select.tsx";
import { ToolbarDock } from "../../apps/workbench-web/src/components/toolbar-dock.tsx";
import { ChoiceSelect } from "@opencraft/design-system-web/choice-select";
import {
  ShareIcon,
  PaletteIcon,
  PermissionShieldIcon,
  EditIcon,
  PinIcon,
  ForkIcon,
  ArchiveIcon,
} from "@opencraft/design-system-web/action-icons";
import { useUiPreferencesRuntime } from "../../apps/workbench-web/src/runtime/ui-preferences-runtime.tsx";
import { bindInteractionDensity } from "../../apps/workbench-web/src/runtime/interaction-density.ts";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme.ts";
import "../../apps/workbench-web/src/styles/app.scss";
import "../../apps/workbench-web/src/styles/context-menu.scss";
import "@opencraft/design-system-web/choice-select.web";

initializeAppearanceTheme();
const noop = () => {};
const client = new QueryClient();
const names = ["Linked tasks", "Share link", "Change icon", "Make private", "Rename", "Pin", "New branch", "Archive"];
const icons = [ShareIcon, ShareIcon, PaletteIcon, PermissionShieldIcon, EditIcon, PinIcon, ForkIcon, ArchiveIcon];

function Fixture() {
  const preferences = useUiPreferencesRuntime();
  const [value, setValue] = useState("gitlab");
  const [host, setHost] = useState("local");
  useEffect(() => {
    (window as any).fixture = {
      setTouch: (mode: string) => preferences.set("interface.touchFriendly", mode),
      setTheme: setThemePreference,
    };
    return bindInteractionDensity(document, preferences);
  }, [preferences]);
  const actions = names.map((label, i) => ({
    id: "action-" + i,
    label,
    section: i < 2 ? "collaboration" : i < 7 ? "conversation" : "lifecycle",
    icon: React.createElement(icons[i]!, { size: 16 }),
    invoke: () => ((window as any).invoked = label),
  }));
  return (
    <QueryClientProvider client={client}>
      <AppShell
        layoutScope="touch-menu-rhythm"
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
        header={
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 16px",
              width: "100%",
            }}
          >
            <span>Connectors</span>
            <ToolbarDock
              scope="touch-menu-rhythm"
              dockId="test-menu"
              actions={actions as any}
              label="Conversation actions"
              onActionTrigger={noop}
              returnFocus={() => null}
            />
          </div>
        }
        floatingSidebarHeader={() => null}
        leftPanel={null}
      >
        <section style={{ padding: 16, maxWidth: 520 }}>
          <h2>Resources</h2>
          <p>Choose where work runs and which account it uses.</p>
          <AppShellToolbarSelect
            label="Choose environment"
            title="Environment"
            value={host}
            onValueChange={setHost}
            options={[
              { value: "local", label: "Current server", visual: "local" },
              { value: "remote", label: "Dedicated cloud environment", visual: "remote" },
              { value: "disabled", label: "Unavailable", visual: "remote", disabled: true },
            ]}
          />
          <ChoiceSelect
            label="Choose service"
            value={value}
            onValueChange={setValue}
            options={[
              { value: "gitlab", label: "GitLab" },
              { value: "github", label: "GitHub" },
              { value: "long", label: "A dedicated workspace and code account for the current assistant only" },
            ]}
          />
          <label>
            Draft
            <input aria-label="Draft" defaultValue="Unsaved content" />
          </label>
        </section>
      </AppShell>
    </QueryClientProvider>
  );
}

createIntlTestRoot(document.getElementById("root")!).render(<Fixture />);
