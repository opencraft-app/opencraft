import {
  Activity,
  ArrowLeft,
  Blocks,
  Bot,
  Brain,
  Cable,
  CalendarClock,
  Cloud,
  Cpu,
  Database,
  FlaskConical,
  MessageCircle,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { FormEvent } from "react";
import { useMemo, useState, useSyncExternalStore } from "react";

import type { ThemePreference } from "@opencraft/design-system/theme";
import type { ExtensionContributionStore, ExtensionManager } from "@opencraft/extension-runtime";
import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsListItem,
  SettingsNotice,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsTextInput,
  type PlatformViewRendererRegistry,
  type ProvisionHostInput,
} from "@opencraft/extension-react";
import type { HostConnectionProfile } from "@opencraft/workbench-runtime";
import type { AppearanceThemeDescriptor } from "../appearance-theme";
import { useInternalDeveloperMode } from "../internal-developer-mode";

export type SettingsSection = "appearance" | "connections" | "laboratory" | "plugins" | string;

export interface SettingsContentProps {
  readonly section: SettingsSection;
  readonly onSectionChange: (section: SettingsSection) => void;
  readonly profiles: readonly HostConnectionProfile[];
  readonly activeHostId: string;
  readonly themes: readonly AppearanceThemeDescriptor[];
  readonly themeId: string;
  readonly themePreference: ThemePreference;
  readonly onThemeChange: (themeId: string) => void;
  readonly onThemePreferenceChange: (preference: ThemePreference) => void;
  readonly onOpenAnnouncementLab: () => void;
  readonly onAdd: (input: {
    readonly displayName: string;
    readonly url: string;
    readonly workspaceBrowseRoots?: readonly string[];
  }) => Promise<HostConnectionProfile>;
  readonly onRemove: (hostId: string) => Promise<boolean>;
  readonly onProvisionHost: (input: ProvisionHostInput) => Promise<HostConnectionProfile>;
  readonly onOpenView: (viewId: string, resourceUri?: string | null) => void;
  readonly onReplaceViewResource: (viewId: string, resourceUri: string) => void;
  readonly extensionContributions: ExtensionContributionStore;
  readonly extensionManager: ExtensionManager;
  readonly platformViewRenderers: PlatformViewRendererRegistry;
}

export interface SettingsNavigationProps {
  readonly section: SettingsSection;
  readonly onSectionChange: (section: SettingsSection) => void;
  readonly extensionContributions: ExtensionContributionStore;
  readonly profiles: readonly HostConnectionProfile[];
  readonly activeHostId: string;
  readonly onBack: () => void;
  readonly presentation?: "route" | "dialog";
}

function providerUrl(profile: HostConnectionProfile): string {
  if (
    typeof profile.providerConfig !== "object"
    || profile.providerConfig === null
    || Array.isArray(profile.providerConfig)
  ) return profile.transportEndpoint ?? "";
  const url = (profile.providerConfig as Readonly<Record<string, unknown>>).url;
  return typeof url === "string" ? url : (profile.transportEndpoint ?? "");
}

function useSettingsExtensionPages(
  extensionContributions: ExtensionContributionStore,
  platform: "web" | "electron",
) {
  const internalDeveloperMode = useInternalDeveloperMode();
  const contributionSnapshot = useSyncExternalStore(
    extensionContributions.subscribe,
    extensionContributions.getSnapshot,
    extensionContributions.getSnapshot,
  );
  return useMemo(
    () =>
      contributionSnapshot.settingsPages
        .map(({ contribution }) => contribution)
        .filter(
          (page) => (page.platforms?.includes(platform) ?? true)
            && (page.audience !== "internal" || internalDeveloperMode),
        )
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0)),
    [contributionSnapshot, internalDeveloperMode, platform],
  );
}

function currentPlatform(): "web" | "electron" {
  return (globalThis as typeof globalThis & { opencraftDesktop?: { readonly kind?: string } })
    .opencraftDesktop?.kind === "electron" ? "electron" : "web";
}

/** Route-owned navigation content for the one physical AppShell left slot. */
export function SettingsNavigation({
  section,
  onSectionChange,
  extensionContributions,
  profiles,
  activeHostId,
  onBack,
  presentation = "route",
}: SettingsNavigationProps) {
  const [managementQuery, setManagementQuery] = useState("");
  const extensionPages = useSettingsExtensionPages(extensionContributions, currentPlatform());
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
        <nav aria-label="Agent management">
          {presentation === "route" ? (
            <>
              <button type="button" className="settings-page__back" onClick={onBack}>
                <ArrowLeft size={15} />
                <span>Back to workbench</span>
              </button>

              <div className="management-navigation__subject" aria-label="Current agent">
                <span className="management-navigation__avatar"><Bot size={19} /></span>
                <span className="management-navigation__subject-copy">
                  <strong>{activeProfile?.displayName ?? "My Hermes"}</strong>
                  <small><i aria-hidden="true" /> Agent · via {activeProfile?.hostId ?? "Hermes cloud"}</small>
                </span>
              </div>

              <div className="management-navigation__mode" role="group" aria-label="Workbench mode">
                <button type="button" onClick={onBack}>Work</button>
                <button type="button" aria-current="page">Manage</button>
              </div>
            </>
          ) : (
            <>
              <div className="management-navigation__dialog-title">
                {activeProfile?.displayName ?? "My Hermes"}
              </div>
              <label className="management-navigation__search">
                <Search size={15} aria-hidden="true" />
                <span className="sr-only">Search agent settings</span>
                <input
                  type="search"
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
            <p className="management-navigation__empty">No matching settings</p>
          ) : null}
        </nav>
      </div>
    );
  }

  return (
    <div className="settings-page__navigation" data-selection="chrome">
      <nav aria-label="Settings sections">
        <button type="button" className="settings-page__back" onClick={onBack}>
          <ArrowLeft size={15} />
          <span>Back to app</span>
        </button>
        <div className="settings-page__navigation-heading">Settings</div>
        <div className="settings-page__navigation-list">
          <button
            type="button"
            aria-current={section === "appearance" ? "page" : undefined}
            onClick={() => onSectionChange("appearance")}
          >
            <Palette size={16} />
            <span>Appearance</span>
          </button>
          <button
            type="button"
            aria-current={section === "connections" ? "page" : undefined}
            onClick={() => onSectionChange("connections")}
          >
            <Cable size={16} />
            <span>Connections</span>
          </button>
          <button
            type="button"
            aria-current={section === "plugins" ? "page" : undefined}
            onClick={() => onSectionChange("plugins")}
          >
            <Blocks size={16} />
            <span>Plugins</span>
          </button>
          <button
            type="button"
            aria-current={section === "laboratory" ? "page" : undefined}
            onClick={() => onSectionChange("laboratory")}
          >
            <FlaskConical size={16} />
            <span>Laboratory</span>
          </button>
          {extensionPages.filter((page) => page.management === undefined).map((page, index, pages) => (
            <div key={page.id}>
            {page.group && pages[index - 1]?.group !== page.group ? <div className="settings-page__navigation-heading">{page.group}</div> : null}
            <button
              key={page.id}
              type="button"
              aria-current={section === page.id ? "page" : undefined}
              onClick={() => onSectionChange(page.id)}
            >
              <Blocks size={16} />
              <span>{page.title}</span>
            </button>
            </div>
          ))}
        </div>
      </nav>
    </div>
  );
}

function settingsNavigationIcon(icon: string | undefined) {
  const Icon = icon === "bot" ? Bot
    : icon === "message-circle" ? MessageCircle
      : icon === "brain" ? Brain
        : icon === "sparkles" ? Sparkles
          : icon === "calendar" ? CalendarClock
            : icon === "database" ? Database
              : icon === "activity" ? Activity
                : icon === "cloud" ? Cloud
                  : icon === "cpu" ? Cpu
                    : icon === "sliders" ? SlidersHorizontal
                      : icon === "server" ? Server
                        : Blocks;
  return <Icon size={16} />;
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
      <div className="settings-page__navigation-list">
        {pages.map((page) => (
          <button
            key={page.id}
            type="button"
            aria-current={section === page.id ? "page" : undefined}
            onClick={() => onSectionChange(page.id)}
          >
            {settingsNavigationIcon(page.icon)}
            <span>{page.title}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Route-owned settings body. The shell chooses document or shared master-detail
 * scrolling; extensions contribute content, never application geometry.
 */
export function SettingsContent({
  section,
  onSectionChange,
  profiles,
  activeHostId,
  themes,
  themeId,
  themePreference,
  onThemeChange,
  onThemePreferenceChange,
  onOpenAnnouncementLab,
  onAdd,
  onRemove,
  onProvisionHost,
  extensionContributions,
  extensionManager,
  platformViewRenderers,
  onOpenView,
  onReplaceViewResource,
}: SettingsContentProps) {
  const [displayName, setDisplayName] = useState("");
  const [url, setUrl] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("/workspace/projects");
  const [pending, setPending] = useState(false);
  const [removingHostId, setRemovingHostId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [extensionUrl, setExtensionUrl] = useState("");
  const [extensionOperation, setExtensionOperation] = useState<string | null>(null);
  const platform = currentPlatform();
  const extensionPages = useSettingsExtensionPages(extensionContributions, platform);
  const contributionSnapshot = useSyncExternalStore(
    extensionContributions.subscribe,
    extensionContributions.getSnapshot,
    extensionContributions.getSnapshot,
  );
  const extensionManagerSnapshot = useSyncExternalStore(
    extensionManager.subscribe,
    extensionManager.getSnapshot,
    extensionManager.getSnapshot,
  );
  useSyncExternalStore(
    platformViewRenderers.subscribe,
    platformViewRenderers.getSnapshot,
    platformViewRenderers.getSnapshot,
  );
  const selectedExtensionPage = extensionPages.find((page) => page.id === section) ?? null;
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
    activeHostId,
    profiles,
    provisionHost: onProvisionHost,
    removeHost: onRemove,
    openView: onOpenView,
    replaceViewResource: onReplaceViewResource,
  }), [activeHostId, onOpenView, onProvisionHost, onRemove, onReplaceViewResource, platform, profiles]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    void onAdd({
      displayName,
      url,
      workspaceBrowseRoots: workspaceRoot.trim().length === 0 ? [] : [workspaceRoot],
    })
      .then(() => {
        setDisplayName("");
        setUrl("");
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setPending(false));
  };

  return (
    <div className="settings-page__viewport" data-selection="chrome" data-layout={selectedExtensionPage?.layout ?? "document"}>
            <div className="settings-page__content">
              {selectedExtensionView !== null ? (
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
                  />
                )
              ) : section === "appearance" ? (
                <>
                  <SettingsPageHeader title="Appearance" description="Choose how OpenCraft looks across the workbench." />

                  <SettingsSection title="Interface" description="Shared display preferences apply across every Workbench view.">
                    <SettingsGroup>
                      <SettingsRow
                        label="Appearance"
                        description="Follow the system or keep one appearance."
                        controlWidth="compact"
                      >
                        <SettingsSegmented
                          label="Appearance mode"
                          value={themePreference}
                          onValueChange={(value) => onThemePreferenceChange(value as ThemePreference)}
                          options={(["light", "dark", "system"] as const).map((preference) => ({
                            value: preference,
                            label: preference[0]!.toUpperCase() + preference.slice(1),
                          }))}
                        />
                      </SettingsRow>
                      <SettingsRow
                        label="Theme"
                        description="Semantic palettes define every surface, border, and interaction state."
                        layout="stacked"
                        controlWidth="wide"
                      >
                        <div className="settings-theme-grid" role="radiogroup" aria-label="Theme">
                          {themes.map((theme) => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={theme.id === themeId}
                              className="settings-theme-card"
                              key={theme.id}
                              onClick={() => onThemeChange(theme.id)}
                            >
                              <span
                                className="settings-theme-card__preview"
                                data-theme-preview={theme.id}
                                aria-hidden="true"
                              >
                                <span />
                                <span />
                                <span />
                              </span>
                              <span className="settings-theme-card__copy">
                                <strong>{theme.label}</strong>
                                <small>{theme.description ?? "Semantic OpenCraft palette"}</small>
                              </span>
                              <span className="settings-theme-card__mark" aria-hidden="true" />
                            </button>
                          ))}
                        </div>
                      </SettingsRow>
                    </SettingsGroup>
                  </SettingsSection>
                </>
              ) : section === "laboratory" ? (
                <>
                  <SettingsPageHeader title="Laboratory" description="Preview experimental Workbench platform capabilities." />

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
                <>
                  <SettingsPageHeader title="Plugins" description="Install and manage trusted OpenCraft extensions." />

                  <SettingsSection title="Installed" description="Enabled plugins activate only after their entry and manifest validate.">
                    {extensionManagerSnapshot.extensions.length === 0 ? (
                      <div className="settings-empty-state">No URL plugins installed.</div>
                    ) : (
                      <SettingsGroup aria-label="Installed plugins">
                        {extensionManagerSnapshot.extensions.map(({ installation, status, error: pluginError }) => {
                          const manifest = installation.lastResolvedManifest;
                          const busy = extensionOperation === installation.extensionId;
                          return (
                            <SettingsListItem
                              key={installation.extensionId}
                              icon={<Blocks size={16} />}
                              label={manifest?.name ?? installation.extensionId}
                              description={installation.source.url}
                              metadata={<>{manifest?.version ?? "Unresolved"} · {status}</>}
                              error={pluginError}
                              actions={(
                                <>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    title="Reload entry"
                                    aria-label={`Reload ${manifest?.name ?? installation.extensionId}`}
                                    onClick={() => {
                                      setExtensionOperation(installation.extensionId);
                                      setError(null);
                                      void extensionManager.reload(installation.extensionId)
                                        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                                        .finally(() => setExtensionOperation(null));
                                    }}
                                  >
                                    <RefreshCw size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => {
                                      setExtensionOperation(installation.extensionId);
                                      setError(null);
                                      void extensionManager.setEnabled(installation.extensionId, !installation.enabled)
                                        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                                        .finally(() => setExtensionOperation(null));
                                    }}
                                  >
                                    {installation.enabled ? "Disable" : "Enable"}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    title="Remove plugin"
                                    aria-label={`Remove ${manifest?.name ?? installation.extensionId}`}
                                    onClick={() => {
                                      setExtensionOperation(installation.extensionId);
                                      setError(null);
                                      void extensionManager.remove(installation.extensionId)
                                        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                                        .finally(() => setExtensionOperation(null));
                                    }}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </>
                              )}
                            />
                          );
                        })}
                      </SettingsGroup>
                    )}
                  </SettingsSection>

                  <SettingsSection
                    title="Install from URL"
                    icon={<Plus size={15} />}
                    description="Trusted developer channel. The URL must serve a self-contained ESM entry with CORS enabled; installed state survives refresh."
                  >
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (extensionOperation !== null) return;
                        setExtensionOperation("install");
                        setError(null);
                        void extensionManager.installModuleUrl(extensionUrl)
                          .then(() => setExtensionUrl(""))
                          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                          .finally(() => setExtensionOperation(null));
                      }}
                    >
                      <SettingsGroup>
                        <SettingsRow label="ES module URL" htmlFor="plugin-module-url">
                          <SettingsTextInput
                          id="plugin-module-url"
                          required
                          inputMode="url"
                          value={extensionUrl}
                          onChange={(event) => setExtensionUrl(event.target.value)}
                          placeholder="https://plugins.example.com/my-plugin.js"
                          />
                        </SettingsRow>
                      </SettingsGroup>
                      {extensionManagerSnapshot.installationLoadErrors.length === 0 ? null : (
                        <SettingsNotice tone="error">
                          {extensionManagerSnapshot.installationLoadErrors.length} invalid installation record(s) were isolated.
                        </SettingsNotice>
                      )}
                      {error === null ? null : <SettingsNotice tone="error">{error}</SettingsNotice>}
                      <SettingsActions>
                        <SettingsButton type="submit" variant="primary" disabled={extensionOperation !== null}>
                          {extensionOperation === "install" ? "Installing…" : "Install and enable"}
                        </SettingsButton>
                      </SettingsActions>
                    </form>
                  </SettingsSection>
                </>
              ) : section === "connections" ? (
                <>
                  <SettingsPageHeader title="Connections" description="Manage the AppServer hosts available to this device." />

                  <SettingsSection title="AppServer hosts" description="Each host owns an independent transport, history cursor, and replica namespace.">
                    <SettingsGroup aria-label="Configured hosts">
                      {profiles.map((profile) => {
                        const active = profile.hostId === activeHostId;
                        return (
                          <SettingsListItem
                            key={profile.hostId}
                            icon={<Server size={16} />}
                            label={profile.displayName}
                            description={providerUrl(profile)}
                            metadata={(
                              <>
                                {profile.providerId} · {profile.hostKind}
                                {active ? " · Active" : ""}
                              </>
                            )}
                            actions={(
                              <button
                                type="button"
                                className="settings-control-list-item__danger-action"
                                disabled={active || profiles.length <= 1 || removingHostId !== null}
                                title={active
                                  ? "Switch away from this Host before removing it"
                                  : "Remove Host"}
                                aria-label={`Remove ${profile.displayName}`}
                                onClick={() => {
                                  setRemovingHostId(profile.hostId);
                                  setError(null);
                                  void onRemove(profile.hostId)
                                    .catch((cause) => {
                                      setError(cause instanceof Error ? cause.message : String(cause));
                                    })
                                    .finally(() => setRemovingHostId(null));
                                }}
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          />
                        );
                      })}
                    </SettingsGroup>
                  </SettingsSection>

                  <SettingsSection title="Add WebSocket host" icon={<Plus size={15} />} description="Connect another Codex-compatible AppServer endpoint.">
                    <form onSubmit={submit}>
                      <SettingsGroup>
                        <SettingsRow label="Name" htmlFor="connection-display-name">
                          <SettingsTextInput
                          id="connection-display-name"
                          required
                          value={displayName}
                          onChange={(event) => setDisplayName(event.target.value)}
                          placeholder="Build server"
                          />
                        </SettingsRow>
                        <SettingsRow label="AppServer WebSocket URL" htmlFor="connection-url">
                          <SettingsTextInput
                          id="connection-url"
                          required
                          inputMode="url"
                          value={url}
                          onChange={(event) => setUrl(event.target.value)}
                          placeholder="wss://node.example/appserver"
                          />
                        </SettingsRow>
                        <SettingsRow label="Initial workspace root" htmlFor="connection-workspace-root">
                          <SettingsTextInput
                          id="connection-workspace-root"
                          value={workspaceRoot}
                          onChange={(event) => setWorkspaceRoot(event.target.value)}
                          placeholder="/workspace/projects"
                          />
                        </SettingsRow>
                      </SettingsGroup>
                      {error === null ? null : (
                        <SettingsNotice tone="error">{error}</SettingsNotice>
                      )}
                      <SettingsActions>
                        <SettingsButton type="submit" variant="primary" disabled={pending}>
                          {pending ? "Verifying connection…" : "Verify and add host"}
                        </SettingsButton>
                      </SettingsActions>
                    </form>
                  </SettingsSection>
                </>
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
  );
}
