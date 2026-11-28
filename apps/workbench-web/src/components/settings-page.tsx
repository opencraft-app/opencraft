import { SidebarReturnToApp } from "./sidebar-return-to-app";
import { Button } from "@opencraft/design-system-web/button";
import { NavigationList, NavigationGroup, NavigationItem, NavigationEmpty, NavigationCount } from "@opencraft/design-system-web/navigation";
import { SearchIcon as Search } from "@opencraft/design-system-web/action-icons";
import "../styles/settings-page.scss";
import { useOptionalAsyncNotices } from "./async-notices";
import { WorkbenchIcon } from "./ui/workbench-icon";
import { useDismissSidebarAfterSelection } from "./shell-presentation";
import { ArchiveIcon as Archive, ArrowLeftIcon as ArrowLeft, ExtensionsIcon as Blocks, AgentIcon as Bot, CloudIcon as Cloud, DatabaseIcon as Database, LabIcon as FlaskConical, ServerIcon as Server, TerminalIcon as Terminal } from "@opencraft/design-system-web/action-icons";
import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { ShortcutsSettingsPage } from "./workbench-shortcut-help";
import { ChatSettings } from "./chat-settings";
import { AgentManagement, MachineAgentManagement } from "./agent-management";
import { AppearanceSettings } from "./appearance-settings";

const LazyRemoteAccessSettings = lazy(() =>
  import("./remote-access-settings").then((mod) => ({ default: mod.RemoteAccessSettings })),
);

function hasDesktopRelayBridge(): boolean {
  return Boolean(
    (globalThis as typeof globalThis & { opencraftDesktop?: { relay?: unknown } }).opencraftDesktop?.relay,
  );
}
import {
  getActivePersonalMachines,
  subscribeActivePersonalMachines,
  type PersonalMachinesController,
} from "../runtime/personal-machine-environment-source";
import { HubNetworkSettings } from "./hub-network-settings";
import { ServerInformationSettings } from "./server-information-settings";
import { SshKeysSettings } from "./ssh-keys-settings";
import { ExtensionLibrary } from "./extensions/extension-library";
import { mobileContainer } from "../runtime/mobile-container";
import { MobileConnectionSettings, mobileConnectionMessages } from "./mobile-connection-settings";

import { resolveThemePreference, type ThemePreference } from "@opencraft/design-system/theme";
import type { ExtensionContributionStore, ExtensionManager, ExtensionSupervisor } from "@opencraft/extension-runtime";
import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  type PlatformViewRendererRegistry,
  type PlatformViewRegions,
  type ProvisionHostInput,
} from "@opencraft/extension-react";
import type { HostConnectionProfile, WorkInMachine } from "@opencraft/workbench-runtime";
import type { AppearanceThemeDescriptor } from "../appearance-theme";
import { useInternalDeveloperMode } from "../internal-developer-mode";
import { WebUpdatesSettings, WebUpdatesNavigation, hasManagedWebUpdates } from "./web-updates-settings";
import { MachineConnectionsAvailable, SettingsMachine, SettingsMachineIdentity, SettingsMachines } from "./settings-machines";
import { replacementMachineSettingsSection, machineSettingsSection } from "../runtime/settings-machine-route";
import { SqliteDebugSettings } from "./sqlite-debug-settings";
import { DesktopWelcome } from "./desktop-welcome";
import { ValdiStyleLabSettingsSection } from "./valdi-style-lab";
import { valdiUiKitMessages } from "./valdi-ui-kit-messages";
import {
  ArchivedThreadsSettings,
  type ArchivedThreadsSettingsProps,
} from "./archived-conversations-settings";

export type SettingsSection = "appearance" | "laboratory" | "plugins" | string;

export interface SettingsContentProps {
  readonly section: SettingsSection;
  readonly onSectionChange: (section: SettingsSection, mode?: "push" | "replace") => void;
  readonly profiles: readonly HostConnectionProfile[];
  readonly machines: readonly WorkInMachine[];
  readonly observeMachineConnections?: boolean;
  readonly activeHostId: string;
  readonly themes: readonly AppearanceThemeDescriptor[];
  readonly themeId: string;
  readonly themePreference: ThemePreference;
  readonly onThemeChange: (themeId: string) => void;
  readonly onThemePreferenceChange: (preference: ThemePreference) => void;
  readonly onConnectDesktopServer?: (origin: string, signal: AbortSignal) => Promise<void>;
  readonly onOpenAnnouncementLab: () => void;
  readonly onRemove: (hostId: string) => Promise<boolean>;
  readonly onProvisionHost: (input: ProvisionHostInput) => Promise<HostConnectionProfile>;
  readonly onOpenView: (viewId: string, resourceUri?: string | null) => void;
  readonly onPushViewResource: (viewId: string, resourceUri: string) => void;
  readonly onReplaceViewResource: (viewId: string, resourceUri: string) => void;
  readonly extensionContributions: ExtensionContributionStore;
  readonly extensionManager: ExtensionManager;
  readonly extensionRuntime: Pick<ExtensionSupervisor, "subscribe" | "getSnapshot" | "contributions">;
  readonly platformViewRenderers: PlatformViewRendererRegistry;
  readonly regions?: PlatformViewRegions;
  readonly archivedConversations?: Omit<ArchivedThreadsSettingsProps, "hostId">;
  readonly personalMachines?: PersonalMachinesController | null;
  readonly onRetryMachineConnection?: (hostId: string) => Promise<void>;
}

export interface SettingsNavigationProps {
  readonly section: SettingsSection;
  readonly onSectionChange: (section: SettingsSection) => void;
  readonly extensionContributions: ExtensionContributionStore;
  readonly profiles: readonly HostConnectionProfile[];
  readonly machines: readonly WorkInMachine[];
  readonly activeHostId: string;
  readonly onBack: () => void;
  readonly presentation?: "route" | "dialog" | "sidebar";
  readonly showArchivedConversations?: boolean;
}

export function useSettingsExtensionPages(
  extensionContributions: ExtensionContributionStore,
  platform: "web" | "electron",
) {
  const intl = useIntl();
  const internalDeveloperMode = useInternalDeveloperMode();
  const contributionSnapshot = useSyncExternalStore(
    extensionContributions.subscribe,
    extensionContributions.getSnapshot,
    extensionContributions.getSnapshot,
  );
  return useMemo(
    () =>
      contributionSnapshot.settingsPages
        .map(({ contribution }) => ({
          ...contribution,
          title: contribution.titleMessage ? intl.formatMessage(contribution.titleMessage) : contribution.title,
          group: contribution.groupMessage ? intl.formatMessage(contribution.groupMessage) : contribution.group,
        }))
        .filter(
          (page) => page.placement !== 'extension' && (page.platforms?.includes(platform) ?? true)
            && (page.audience !== "internal" || internalDeveloperMode),
        )
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0)),
    [contributionSnapshot, internalDeveloperMode, platform, intl],
  );
}

export function currentPlatform(): "web" | "electron" {
  return (globalThis as typeof globalThis & { opencraftDesktop?: { readonly kind?: string } })
    .opencraftDesktop?.kind === "electron" ? "electron" : "web";
}

/** Route-owned navigation content for the one physical AppShell left slot. */
export function SettingsNavigation({
  section,
  onSectionChange: navigateToSection,
  extensionContributions,
  profiles,
  machines,
  activeHostId,
  onBack,
  presentation = "route",
  showArchivedConversations = false,
}: SettingsNavigationProps) {
  const intl = useIntl();
  const showBack = presentation === "route";
  const dismissSidebar = useDismissSidebarAfterSelection();
  const bottomReturn = presentation === "sidebar" ? <SidebarReturnToApp onReturn={onBack} /> : null;
  const onSectionChange = (nextSection: SettingsSection) => {
    navigateToSection(nextSection);
    // Only explicit category selection closes the drawer, including selecting
    // the current route. Route normalization and management dialogs do not.
    if (presentation === "sidebar") dismissSidebar?.();
  };
  const internalDeveloperMode = useInternalDeveloperMode();
  const [managementQuery, setManagementQuery] = useState("");
  const extensionPages = useSettingsExtensionPages(extensionContributions, currentPlatform());
  const runPages = extensionPages.filter(page => page.management === undefined && page.targetHostId !== undefined
    && profiles.some(profile => profile.enabled && profile.hostId === page.targetHostId));
  const selectedRunPage = runPages.some(page => page.id === section);
  const selectedPage = extensionPages.find((page) => page.id === section) ?? null;
  const managementFamilyId = selectedPage?.management?.familyId ?? null;
  const managementPages = managementFamilyId === null
    ? []
    : extensionPages.filter((page) => page.management?.familyId === managementFamilyId);
  // Compatibility projection until the AppServer directory supplies an
  // explicit selected Agent identity. The profile remains the Host authority;
  // it is used only as the visible label for today's single Agent deployment.
  const activeProfile = profiles.find((profile) => profile.hostId === activeHostId) ?? profiles[0] ?? null;

  if (managementFamilyId !== null) {
    const normalizedQuery = managementQuery.trim().toLocaleLowerCase();
    const visiblePages = normalizedQuery.length === 0
      ? managementPages
      : managementPages.filter((page) => page.title.toLocaleLowerCase().includes(normalizedQuery));
    const agentPages = visiblePages.filter((page) => page.management?.scope === "agent");
    const hostPages = visiblePages.filter((page) => page.management?.scope === "host");
    return (
      <div
        className={`settings-page__navigation settings-page__navigation--management settings-page__navigation--${presentation}`}
        data-selection="chrome"
      >
        {bottomReturn}
        <NavigationList inset={presentation === "sidebar" ? "sidebar" : undefined} label={intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })}>
          {presentation === "route" ? (
            <>
              <NavigationItem type="button" className="settings-page__back" onClick={onBack}>
                <ArrowLeft size={15} />
                <span data-navigation-label="">Back to workbench</span>
              </NavigationItem>

              <div className="management-navigation__subject" aria-label="Current agent">
                <span className="management-navigation__avatar"><Bot size={19} /></span>
                <span className="management-navigation__subject-copy">
                  <strong>{activeProfile?.displayName ?? "My Hermes"}</strong>
                  <small><i aria-hidden="true" /> Agent · via {activeProfile?.hostId ?? "Hermes cloud"}</small>
                </span>
              </div>

              <div className="management-navigation__mode" role="group" aria-label="Workbench mode">
                <NavigationItem type="button" onClick={onBack}>Work</NavigationItem>
                <NavigationItem type="button" aria-current="page">Manage</NavigationItem>
              </div>
            </>
          ) : (
            <>
              <div className="management-navigation__dialog-title">
                {activeProfile?.displayName ?? "My Hermes"}
              </div>
              <label className="management-navigation__search">
                <Search size={15} aria-hidden="true" />
                <input
                  type="search"
                  aria-label={intl.formatMessage({ id: "settings.searchAgentSettings", defaultMessage: "Search agent settings" })}
                  value={managementQuery}
                  onChange={(event) => setManagementQuery(event.currentTarget.value)}
                  placeholder="Search"
                />
              </label>
            </>
          )}

          <ManagementNavigationGroup
            title="Agent"
            pages={agentPages}
            section={section}
            onSectionChange={onSectionChange}
          />
          <ManagementNavigationGroup
            title="Host"
            pages={hostPages}
            section={section}
            onSectionChange={onSectionChange}
          />
          {visiblePages.length === 0 ? (
            <NavigationEmpty className="management-navigation__empty">No matching settings</NavigationEmpty>
          ) : null}
        </NavigationList>
      </div>
    );
  }

  return (
    <div className={`settings-page__navigation settings-page__navigation--${presentation}`} data-selection="chrome">
      {bottomReturn}
        <NavigationList inset={presentation === "sidebar" ? "sidebar" : undefined} label={intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })}>
        {showBack ? <NavigationItem type="button" className="settings-page__back" onClick={onBack}>
          <ArrowLeft size={15} />
          <span data-navigation-label=""><FormattedMessage id="settings.back" defaultMessage="Back to app" /></span>
        </NavigationItem> : null}
        <div className="settings-page__navigation-heading"><FormattedMessage id="settings.groups.application" defaultMessage="Application" /></div>
        <NavigationGroup className="settings-page__navigation-list">
          {mobileContainer() && <NavigationItem type="button" aria-current={section === "mobile-connection" ? "page" : undefined} onClick={() => onSectionChange("mobile-connection")}>
            <Server size={16} /><span data-navigation-label="">{intl.formatMessage(mobileConnectionMessages.title)}</span>
          </NavigationItem>}
          <NavigationItem
            type="button"
            aria-current={section === "chat" ? "page" : undefined}
            onClick={() => onSectionChange("chat")}
          >
            <WorkbenchIcon name="message-circle" />
            <span data-navigation-label=""><FormattedMessage id="settings.chat" defaultMessage="Chat" /></span>
          </NavigationItem>
          <NavigationItem
            type="button"
            aria-current={section === "appearance" ? "page" : undefined}
            onClick={() => onSectionChange("appearance")}
          >
            <WorkbenchIcon name="appearance" />
            <span data-navigation-label=""><FormattedMessage id="settings.appearance" defaultMessage="Appearance" /></span>
          </NavigationItem>
          <NavigationItem
            type="button"
            aria-current={section === "plugins" ? "page" : undefined}
            onClick={() => onSectionChange("plugins")}
          >
            <Blocks size={16} />
            <span data-navigation-label=""><FormattedMessage id="settings.plugins" defaultMessage="Plugins" /></span>
          </NavigationItem>
          <NavigationItem
            type="button"
            aria-current={section === "shortcuts" ? "page" : undefined}
            onClick={() => onSectionChange("shortcuts")}
          >
            <WorkbenchIcon name="keyboard" />
            <span data-navigation-label=""><FormattedMessage id="shortcuts.title" defaultMessage="Keyboard shortcuts" /></span>
          </NavigationItem>
          {currentPlatform() === "web" && hasManagedWebUpdates() ? <WebUpdatesNavigation selected={section === "updates"} onOpen={() => onSectionChange("updates")} /> : null}
          {currentPlatform() === 'web' && import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST === 'true' ? <NavigationItem type="button" aria-current={section === 'server-information' ? 'page' : undefined} onClick={() => onSectionChange('server-information')}>
            <Server size={16} /><span data-navigation-label="">{intl.formatMessage({ id: 'settings.serverInformation.title', defaultMessage: 'Server information' })}</span>
          </NavigationItem> : null}
          {currentPlatform() === 'web' && import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST === 'true' ? <NavigationItem type="button" aria-current={section === 'ssh-keys' ? 'page' : undefined} onClick={() => onSectionChange('ssh-keys')}>
            <Terminal size={16} /><span data-navigation-label="">{intl.formatMessage({ id: 'settings.sshKeys.title', defaultMessage: 'SSH keys' })}</span>
          </NavigationItem> : null}
          {currentPlatform() === 'web' && import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST === 'true' ? <NavigationItem type="button" aria-current={section === 'hub-network' ? 'page' : undefined} onClick={() => onSectionChange('hub-network')}>
            <Server size={16} /><span data-navigation-label="">{intl.formatMessage({ id: 'settings.hubNetwork', defaultMessage: 'Hub network' })}</span>
          </NavigationItem> : null}
          {showArchivedConversations ? <NavigationItem
            type="button"
            aria-current={section === "archived-conversations" ? "page" : undefined}
            onClick={() => onSectionChange("archived-conversations")}
          >
            <Archive size={16} />
            <span data-navigation-label=""><FormattedMessage id="settings.archived" defaultMessage="Archived conversations" /></span>
          </NavigationItem> : null}
          {internalDeveloperMode ? (
            <>
              <NavigationItem
                type="button"
                aria-current={section === "valdi-ui-kit" ? "page" : undefined}
                onClick={() => onSectionChange("valdi-ui-kit")}
              >
                <FlaskConical size={16} />
                <span data-navigation-label="">{intl.formatMessage(valdiUiKitMessages.navTitle)}</span>
              </NavigationItem>
              <NavigationItem
                type="button"
                aria-current={section === "laboratory" ? "page" : undefined}
                onClick={() => onSectionChange("laboratory")}
              >
                <FlaskConical size={16} />
                <span data-navigation-label=""><FormattedMessage id="settings.laboratory" defaultMessage="Laboratory" /></span>
              </NavigationItem>
            </>
          ) : null}
          {internalDeveloperMode && currentPlatform() === "electron" ? (
              <NavigationItem
              type="button"
              aria-current={section === "sqlite-debug" ? "page" : undefined}
              onClick={() => onSectionChange("sqlite-debug")}
            >
              <Database size={16} />
              <span data-navigation-label=""><FormattedMessage id="settings.sqliteInspector" defaultMessage="SQLite inspector" /></span>
            </NavigationItem>
          ) : null}
          {extensionPages.filter((page) => page.management === undefined && page.targetHostId === undefined).map((page, index, pages) => (
            <div key={page.id}>
            {page.group && pages[index - 1]?.group !== page.group ? <div className="settings-page__navigation-heading">{page.group}</div> : null}
            <NavigationItem
              key={page.id}
              type="button"
              aria-current={section === page.id ? "page" : undefined}
              onClick={() => onSectionChange(page.id)}
            >
              <WorkbenchIcon name={page.icon} purpose="settings-page" />
              <span data-navigation-label="">{page.title}</span>
            </NavigationItem>
            </div>
          ))}
          <div className="settings-page__navigation-heading"><FormattedMessage id="settings.machines.run" defaultMessage="Run" /></div>
          {runPages.map(page => <NavigationItem key={page.id} type="button"
            aria-current={section === page.id ? "page" : undefined} onClick={() => onSectionChange(page.id)}>
            <WorkbenchIcon name={page.icon} /><span data-navigation-label="">{page.title}</span>
          </NavigationItem>)}
          <NavigationItem type="button" aria-current={section === "machines" || section.startsWith("machine-") || (!selectedRunPage && selectedPage?.targetHostId !== undefined) ? "page" : undefined} onClick={() => onSectionChange("machines")}>
            <Server size={16} />
            <span data-navigation-label=""><FormattedMessage id="settings.machines.title" defaultMessage="Machines" /></span>
            <NavigationCount className="settings-machines-count">{machines.length}</NavigationCount>
          </NavigationItem>
          {hasDesktopRelayBridge() ? (
            <NavigationItem
              type="button"
              aria-current={section === "remote-access" ? "page" : undefined}
              onClick={() => onSectionChange("remote-access")}
            >
              <Cloud size={16} />
              <span data-navigation-label="">
                <FormattedMessage id="settings.remoteAccess.navTitle" defaultMessage="Remote Control" />
              </span>
            </NavigationItem>
          ) : null}
        </NavigationGroup>
      </NavigationList>
    </div>
  );
}

function ManagementNavigationGroup({
  title,
  pages,
  section,
  onSectionChange,
}: {
  readonly title: string;
  readonly pages: ReturnType<typeof useSettingsExtensionPages>;
  readonly section: SettingsSection;
  readonly onSectionChange: (section: SettingsSection) => void;
}) {
  if (pages.length === 0) return null;
  return (
    <section className="management-navigation__group">
      <div className="settings-page__navigation-heading">{title}</div>
      <NavigationGroup className="settings-page__navigation-list">
        {pages.map((page) => (
          <NavigationItem
            key={page.id}
            type="button"
            aria-current={section === page.id ? "page" : undefined}
            onClick={() => onSectionChange(page.id)}
          >
            <WorkbenchIcon name={page.icon} />
            <span data-navigation-label="">{page.title}</span>
          </NavigationItem>
        ))}
      </NavigationGroup>
    </section>
  );
}

/**
 * Route-owned settings body. The shell chooses document or shared master-detail
 * scrolling; extensions contribute content, never application geometry.
 */
export function SettingsContent({
  observeMachineConnections = true,
  section,
  onSectionChange,
  profiles,
  machines,
  activeHostId,
  themes,
  themeId,
  themePreference,
  onThemeChange,
  onThemePreferenceChange,
  onOpenAnnouncementLab,
  onRemove,
  onProvisionHost,
  onConnectDesktopServer,
  extensionContributions,
  extensionManager,
  extensionRuntime,
  platformViewRenderers,
  regions,
  archivedConversations,
  personalMachines = null,
  onRetryMachineConnection,
  onOpenView,
  onPushViewResource,
  onReplaceViewResource,
}: SettingsContentProps) {
  const notices = useOptionalAsyncNotices();
  const attachedPersonalMachines = useSyncExternalStore(
    subscribeActivePersonalMachines,
    getActivePersonalMachines,
    () => null,
  );
  const resolvedPersonalMachines = personalMachines === undefined ? attachedPersonalMachines : personalMachines;
  const resolvedRetryMachineConnection = onRetryMachineConnection ?? resolvedPersonalMachines?.retryConnection;
  const intl = useIntl();
  const internalDeveloperMode = useInternalDeveloperMode();
  const platform = currentPlatform();
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const extensionPages = useSettingsExtensionPages(extensionContributions, platform);
  const localProfile = profiles.find(profile => profile.enabled && profile.providerId === 'opencraft.builtin-agents');
  const localModelsPage = localProfile ? extensionPages.find(page => page.modelConfiguration && page.targetHostId === localProfile.hostId) : undefined;
  const contributionSnapshot = useSyncExternalStore(
    extensionContributions.subscribe,
    extensionContributions.getSnapshot,
    extensionContributions.getSnapshot,
  );
  useSyncExternalStore(
    platformViewRenderers.subscribe,
    platformViewRenderers.getSnapshot,
    platformViewRenderers.getSnapshot,
  );
  const movedToPlugin = contributionSnapshot.settingsPages.some(({contribution}) => contribution.id === section && contribution.placement === 'extension');
  useEffect(() => { if (movedToPlugin) onSectionChange('plugins'); }, [movedToPlugin, onSectionChange]);
  const selectedExtensionPage = extensionPages.find((page) => page.id === section) ?? null;
  const selectedMachine = machines.find(machine => machineSettingsSection(machine) === section) ?? null;
  const configurationHostId = selectedExtensionPage?.targetHostId;
  const configurationProfile = profiles.find(profile => profile.enabled && profile.hostId === configurationHostId) ?? null;
  const configurationMachine = machines.find(machine => machine.hosts.some(host => host.hostId === configurationHostId)) ?? null;
  const missingConfigurationHost = selectedExtensionPage?.targetHostId !== undefined && configurationProfile === null;
  const internalExtensionPage = contributionSnapshot.settingsPages.some(
    ({ contribution }) => contribution.id === section && contribution.audience === "internal",
  );
  useEffect(() => {
    const replacement = replacementMachineSettingsSection(section, machines);
    if (replacement !== null) onSectionChange(replacement, "replace");
  }, [section, machines, onSectionChange]);
  useEffect(() => {
    const hiddenSchedules = section === "opencraft.schedules" && import.meta.env.VITE_INCLUDE_SCHEDULES_PRESENTATION === "false";
    const internalOnly = internalExtensionPage || section === "laboratory" || section === "sqlite-debug" || section === "valdi-ui-kit";
    if (hiddenSchedules || (internalOnly && (!internalDeveloperMode || (section === "sqlite-debug" && platform !== "electron")))) {
      onSectionChange("appearance", "replace");
    }
  }, [internalDeveloperMode, internalExtensionPage, onSectionChange, platform, section]);
  const selectedExtensionView = selectedExtensionPage === null
    ? null
    : contributionSnapshot.views.find(
      ({ contribution }) => contribution.id === selectedExtensionPage.viewId,
    )?.contribution ?? null;
  const SelectedExtensionComponent = selectedExtensionView === null
    ? null
    : platformViewRenderers.resolve(selectedExtensionView.viewType);
  const extensionViewHost = useMemo(() => ({
    platform,
    activeHostId: configurationHostId ?? activeHostId,
    profiles,
    provisionHost: onProvisionHost,
    removeHost: onRemove,
    openView: onOpenView,
    pushViewResource: onPushViewResource,
    replaceViewResource: onReplaceViewResource,
  }), [activeHostId, configurationHostId, onOpenView, onProvisionHost, onPushViewResource, onRemove, onReplaceViewResource, platform, profiles]);

  return (
    <MachineConnectionsAvailable.Provider value={observeMachineConnections}><div className="settings-page__viewport" data-selection="chrome" data-layout={section === "valdi-ui-kit" ? "wide" : (selectedExtensionPage?.layout ?? "document")}>
            <div className="settings-page__content">
              {configurationMachine !== null ? <SettingsMachineIdentity machine={configurationMachine} platform={platform} onSectionChange={onSectionChange} /> : null}
              {section === "mobile-connection" ? <MobileConnectionSettings onProvisionHost={onProvisionHost} onCancel={!mobileContainer() ? () => onSectionChange("machines") : undefined} />
              : section === "machines" ? <SettingsMachines machines={machines} platform={platform} onSectionChange={onSectionChange} personalMachines={resolvedPersonalMachines} reportError={notices?.error} />
              : selectedMachine !== null ? <SettingsMachine machine={selectedMachine} pages={extensionPages.filter(page => page.management === undefined)} platform={platform} onSectionChange={onSectionChange} personalMachines={resolvedPersonalMachines} renderAgentManagement={hostId => <MachineAgentManagement hostId={hostId} />} onRetryConnection={resolvedRetryMachineConnection} reportError={notices?.error} />
              : section === 'server-information' && platform === 'web' && import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST === 'true' ? <ServerInformationSettings />
              : section === 'ssh-keys' && platform === 'web' && import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST === 'true' ? <SshKeysSettings />
              : section === 'hub-network' && platform === 'web' && import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST === 'true' ? <HubNetworkSettings />
              : section.startsWith("execution-") ? null
              : missingConfigurationHost || section.startsWith("machine-") ? <><SettingsPageHeader title={intl.formatMessage({ id: "settings.machines.unavailable", defaultMessage: "Machine unavailable" })} /><SettingsButton onClick={() => onSectionChange("machines")}>{intl.formatMessage({ id: "settings.machines.title", defaultMessage: "Machines" })}</SettingsButton></>
              : selectedExtensionView !== null ? (
                SelectedExtensionComponent === null ? (
                  <SettingsSection
                    title={selectedExtensionView.title}
                    description={`The extension renderer for ${selectedExtensionView.viewType} is unavailable.`}
                  />
                ) : (
                  <SelectedExtensionComponent
                    activation={{
                      viewId: selectedExtensionView.id,
                      resourceUri: null,
                    }}
                    contribution={selectedExtensionView}
                    host={extensionViewHost}
                    regions={regions}
                    reportError={notices?.error}
                  />
                )
              ) : section === "sqlite-debug" && internalDeveloperMode && platform === "electron" ? (
                <SqliteDebugSettings />
              ) : section === "archived-conversations" && archivedConversations !== undefined ? (
                <ArchivedThreadsSettings
                  hostId={activeHostId}
                  load={archivedConversations.load}
                  restore={archivedConversations.restore}
                />
              ) : section === "chat" ? (
                <ChatSettings agentManagement={activeHostId ? <AgentManagement /> : undefined}
                  onOpenImSettings={extensionPages.some(page => page.id === "opencraft.im.channels") ? () => onSectionChange("opencraft.im.channels") : undefined} />
              ) : section === "updates" && platform === "web" && hasManagedWebUpdates() ? (
                <WebUpdatesSettings />
              ) : section === "shortcuts" ? (
                <ShortcutsSettingsPage />
              ) : section === "valdi-ui-kit" ? (
                <ValdiStyleLabSettingsSection onThemePreferenceChange={onThemePreferenceChange} />
              ) : section === "remote-access" && hasDesktopRelayBridge() ? (
                <Suspense fallback={null}>
                  <LazyRemoteAccessSettings
                    resolvedTheme={resolveThemePreference(
                      themePreference,
                      typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
                    )}
                  />
                </Suspense>
              ) : section === "appearance" ? (
                <AppearanceSettings
                  themes={themes}
                  themeId={themeId}
                  themePreference={themePreference}
                  resolvedTheme={resolveThemePreference(
                    themePreference,
                    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
                  )}
                  onThemeChange={onThemeChange}
                  onThemePreferenceChange={onThemePreferenceChange}
                  onOpenUiKit={() => onSectionChange("valdi-ui-kit")}
                />
              ) : section === "laboratory" ? (
                <>
                  <SettingsPageHeader title="Laboratory" description="Preview experimental Workbench platform capabilities." />

                  {internalDeveloperMode && platform === 'electron' ? <SettingsSection title={intl.formatMessage({ id: 'welcome.developer.title', defaultMessage: 'First-use setup' })}>
                    <SettingsGroup><SettingsRow
                      label={intl.formatMessage({ id: 'welcome.developer.page', defaultMessage: 'Desktop welcome page' })}
                      description={intl.formatMessage({ id: 'welcome.developer.description', defaultMessage: 'Preview the initial configuration flow. Normal startup is unchanged.' })}
                      controlWidth="compact">
                      <SettingsButton onClick={() => setWelcomeOpen(true)}>{intl.formatMessage({ id: 'welcome.developer.open', defaultMessage: 'Open welcome page' })}</SettingsButton>
                    </SettingsRow></SettingsGroup>
                  </SettingsSection> : null}

                  <SettingsSection
                    title="Announcement window"
                    description="A renderer-neutral announcement descriptor projected through the platform ModalHost."
                  >
                    <SettingsGroup>
                      <SettingsRow
                        label="Announcement dialog"
                        description="Preview the same API available to trusted JavaScript extensions."
                        controlWidth="compact"
                      >
                        <SettingsButton type="button" variant="primary" onClick={onOpenAnnouncementLab}>
                          Preview announcement
                        </SettingsButton>
                      </SettingsRow>
                      <SettingsRow
                        label="JavaScript API"
                        description="Actions resolve as data; scripts never receive DOM, Portal, focus, or z-index ownership."
                        layout="stacked"
                        controlWidth="wide"
                      >
                        <pre className="settings-laboratory-code"><code>{`const result = await api.window.showAnnouncement({\n  id: \"acme.tools.release\",\n  title: \"What’s new\",\n  body: \"A short, useful update.\",\n  primaryAction: { id: \"continue\", label: \"Continue\" }\n});`}</code></pre>
                      </SettingsRow>
                    </SettingsGroup>
                  </SettingsSection>
                </>
              ) : section === "plugins" ? (
                <ExtensionLibrary standalone supervisor={extensionRuntime} manager={extensionManager} settingsHost={extensionViewHost} renderers={platformViewRenderers} reportError={notices?.error} />
              ) : (
                <SettingsSection
                  title="Settings section unavailable"
                  description={<>The plugin that owns <code>{section}</code> is not currently active.</>}
                >
                  <SettingsActions>
                    <SettingsButton type="button" onClick={() => onSectionChange("plugins")}>
                      Open Plugins
                    </SettingsButton>
                  </SettingsActions>
                </SettingsSection>
              )}
            </div>
    </div>
      {welcomeOpen && internalDeveloperMode && platform === 'electron' && section === 'laboratory' ? <DesktopWelcome
        onDismiss={() => setWelcomeOpen(false)}
        onConnectServer={onConnectDesktopServer}
        onConfigureLocal={localModelsPage ? () => { setWelcomeOpen(false); onSectionChange(localModelsPage.id); } : undefined}
      /> : null}
    </MachineConnectionsAvailable.Provider>
  );
}
