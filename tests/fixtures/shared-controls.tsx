import React, { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createIntlTestRoot } from "./intl-root";
import { SidebarLayoutStore } from "@opencraft/sidebar-layout";
import { Button, IconButton, DisclosureButton } from "@opencraft/design-system-web/button";
import { NavigationList, NavigationGroup, NavigationItem } from "@opencraft/design-system-web/navigation";
import { MessageIcon, GridIcon } from "@opencraft/design-system-web/action-icons";
import { SettingsButton } from "@opencraft/extension-react";
import { ScrollToBottomButton } from "../../apps/workbench-web/src/components/scroll-to-bottom-button";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
import { AppShellHeader } from "../../apps/workbench-web/src/components/app-shell-header";
import { Sidebar } from "../../apps/workbench-web/src/components/sidebar";
import { TouchDensitySetting } from "../../apps/workbench-web/src/components/touch-density-setting";
import { useUiPreferencesRuntime } from "../../apps/workbench-web/src/runtime/ui-preferences-runtime";
import { bindInteractionDensity } from "../../apps/workbench-web/src/runtime/interaction-density";
import { initializeAppearanceTheme, setThemePreference, setAppearanceThemeId, longingThemeId, coreThemeId } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const queryClient = new QueryClient();
const layout = await SidebarLayoutStore.open({ load: async () => null, save: async () => {} });
const noop = () => {};
let finish: (() => void) | undefined;
function Fixture() {
  const preferences = useUiPreferencesRuntime();
  const [sidebar, setSidebar] = useState(true);
  const [preview, setPreview] = useState(false);
  const [pending, setPending] = useState(false);
  const [destination, setDestination] = useState("chats");
  const [working, setWorking] = useState(false);
  useEffect(() => {
    Object.assign(window, { controlsFixture: {
      setTouch: (mode: "auto" | "on" | "off") => preferences.set("interface.touchFriendly", mode),
      setTheme: (mode: "light" | "dark", blue = false) => { setThemePreference(mode); setAppearanceThemeId(blue ? longingThemeId : coreThemeId); },
      finish: () => finish?.(),
      setWorking,
    } });
    return bindInteractionDensity(document, preferences);
  }, [preferences]);
  const save = async () => {
    setPending(true);
    await new Promise<void>(resolve => { finish = resolve; });
    setPending(false);
  };
  return <QueryClientProvider client={queryClient}><AppShell layoutScope="shared-controls"
    navigation={{ layout: "unified", actions: [
      { id: "shell.home", title: "Home", icon: "home", active: true, onInvoke: noop },
      { id: "shell.applications", title: "Applications", icon: "grid", active: false, onInvoke: noop },
    ], onOpenSettings: noop, account: null }}
    mainContentLayout="thread-edge-scroll" sidebarOpen={sidebar} sidebarWidth={280}
    windowChrome={{ kind: "browser", platform: "darwin", safeArea: { left: 0, right: 0 } }}
    onSidebarCollapse={() => setSidebar(false)} onSidebarExpand={() => setSidebar(true)} onSidebarResizeEnd={noop}
    rightPanel={<div>Preview content</div>} rightPanelOpen={preview} rightPanelFullWidth={false}
    onRightPanelOpenChange={setPreview}
    header={<AppShellHeader conversationHeader navigationBrand={<span className="application-brand">OpenCraft</span>}
      title="Workspace" project={null} sidebarOpen={sidebar} rightPanelOpen={preview} rightPanelFullWidth={false}
      onToggleSidebar={() => setSidebar(value => !value)} onToggleRightPanel={() => setPreview(value => !value)}
      onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={["sidebar-toggle"]} />}
    floatingSidebarHeader={() => null}
    leftPanel={<Sidebar threads={[]} activeHostId="local" activeThreadId={null} sidebarLayout={layout}
      onSelectThread={noop} onNewTask={noop} onOpenSettings={noop} showFooter={false} showStart={false} showNewChat />}>
    <section style={{ padding: 32, maxWidth: 700 }}>
      <h1>Workspace controls</h1>
      <div aria-label="Scroll action anchor" style={{ position: "relative", height: 80, width: 280 }}>
        <div className="thread-scroll-to-bottom-anchor" style={{ position: "absolute", insetInline: 0, bottom: 0 }}>
          <ScrollToBottomButton label="Positioned scroll action" show showWorkingDots={working} onClick={() => { (window as any).positionClicks = ((window as any).positionClicks ?? 0) + 1; }} />
        </div>
      </div>
      <IconButton surface="floating" className="fixture-fixed-control" aria-label="Fixed floating action"><MessageIcon /></IconButton><input aria-label="Retained draft" defaultValue="Keep draft" />
      <p>Integrated actions share the bar. Floating actions own one backdrop.</p>
      <SettingsButton loading={pending} onClick={() => void save()}>Save configuration</SettingsButton>
      <Button variant="primary" size="sm" loading={pending} onClick={() => void save()}>Save changes</Button>
      <div role="group" aria-label="Disclosure semantics">
        <IconButton aria-label="Expanded region" aria-expanded aria-haspopup={false}><MessageIcon /></IconButton>
        <IconButton aria-label="Open popup" aria-haspopup="menu" aria-expanded><MessageIcon /></IconButton>
        <DisclosureButton aria-expanded>Open disclosure</DisclosureButton>
        <Button variant="ghost" data-state="open">Open Radix popup</Button>
      </div>
      <NavigationList label="Workspace navigation">
        <NavigationGroup>
          <NavigationItem aria-current={destination === "chats" ? "page" : undefined} onClick={() => setDestination("chats")}><MessageIcon /><span>Chats</span></NavigationItem>
          <NavigationItem aria-current={destination === "tasks" ? "page" : undefined} onClick={() => setDestination("tasks")}><GridIcon /><span>Tasks</span></NavigationItem>
        </NavigationGroup>
      </NavigationList>
      <TouchDensitySetting />
    </section>
  </AppShell></QueryClientProvider>;
}
createIntlTestRoot(document.getElementById("root")!).render(<Fixture />);
