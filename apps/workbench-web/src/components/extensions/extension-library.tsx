import { lazy, Suspense, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { projectExtensionCatalog, type ExtensionManager, type ExtensionSupervisor } from "@opencraft/extension-runtime";
import {
  SettingsPageHeader,
  type ExtensionSettingsViewProps,
  type PlatformViewHost,
  type PlatformViewRendererRegistry,
} from "@opencraft/extension-react";
import { useAppearanceTheme } from "../../appearance-theme";
import { useInternalDeveloperMode } from "../../internal-developer-mode";
import { requestMobileConfirmDialog, requestMobileHaptic } from "../../runtime/mobile-valdi-bridge";
import "../valdi-surfaces.scss";
import "./extension-library.scss";

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

const LazyValdiPluginsSettings = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function PluginsSettingsMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").PluginsSettingsProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.PluginsSettingsSurface}
        viewModel={viewModel}
        className="valdi-plugins-settings-surface"
        data-testid="valdi-plugins-settings-surface"
      />
    );
  }
  return { default: PluginsSettingsMount };
});

function resolvePluginIcon(id: string, capabilities: readonly string[]): import("@opencraft/design-system-web/valdi").IconName {
  const lower = `${id} ${capabilities.join(" ")}`.toLowerCase();
  if (lower.includes("voice") || lower.includes("image") || lower.includes("theme") || lower.includes("appearance")) {
    return "sparkle";
  }
  if (lower.includes("agent") || lower.includes("bot") || lower.includes("codex")) return "bot";
  if (lower.includes("server") || lower.includes("ssh") || lower.includes("cloud") || lower.includes("hypernode")) {
    return "server";
  }
  if (lower.includes("task") || lower.includes("schedule")) return "list";
  if (lower.includes("im") || lower.includes("chat")) return "chat";
  return "puzzle";
}

function resolveStatusTone(status: string): "active" | "inactive" | "warning" | "danger" {
  if (status === "active") return "active";
  if (status === "failed") return "danger";
  if (status === "incompatible" || status === "loading" || status === "activating" || status === "deactivating") {
    return "warning";
  }
  return "inactive";
}

export function ExtensionLibrary({
  supervisor,
  manager,
  settingsHost,
  renderers,
  reportError,
  standalone = false,
}: {
  readonly settingsHost?: PlatformViewHost;
  readonly renderers?: PlatformViewRendererRegistry;
  readonly reportError?: ExtensionSettingsViewProps["reportError"];
  readonly supervisor: Pick<ExtensionSupervisor, "subscribe" | "getSnapshot" | "contributions">;
  readonly manager: ExtensionManager;
  readonly standalone?: boolean;
}) {
  const intl = useIntl();
  const appearance = useAppearanceTheme();
  const sameLanguage = useCallback(
    (text: string) => !intl.locale.toLowerCase().startsWith("zh") || /[\u4e00-\u9fff]/u.test(text),
    [intl.locale],
  );
  const runtime = useSyncExternalStore(supervisor.subscribe, supervisor.getSnapshot, supervisor.getSnapshot);
  const installations = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const contributions = useSyncExternalStore(
    supervisor.contributions.subscribe,
    supervisor.contributions.getSnapshot,
    supervisor.contributions.getSnapshot,
  );
  useSyncExternalStore<unknown>(
    renderers?.subscribe ?? emptySubscribe,
    renderers?.getSnapshot ?? emptySnapshot,
    renderers?.getSnapshot ?? emptySnapshot,
  );

  const catalog = useMemo(
    () => projectExtensionCatalog(runtime, installations, contributions),
    [runtime, installations, contributions],
  );
  const developer = useInternalDeveloperMode();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const change = useCallback(async (id: string, action: () => Promise<unknown>) => {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    setPending(new Set(inFlight.current));
    setErrors((current) => ({ ...current, [id]: "" }));
    try {
      await action();
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [id]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      inFlight.current.delete(id);
      setPending(new Set(inFlight.current));
    }
  }, []);

  const formatStatus = useCallback(
    (status: string): string => {
      switch (status) {
        case "active":
          return intl.formatMessage({ id: "settings.plugins.status.active", defaultMessage: "Active" });
        case "disabled":
          return intl.formatMessage({ id: "settings.plugins.status.disabled", defaultMessage: "Disabled" });
        case "loading":
          return intl.formatMessage({ id: "settings.plugins.status.loading", defaultMessage: "Loading" });
        case "activating":
          return intl.formatMessage({ id: "settings.plugins.status.activating", defaultMessage: "Starting" });
        case "deactivating":
          return intl.formatMessage({ id: "settings.plugins.status.deactivating", defaultMessage: "Stopping" });
        case "incompatible":
          return intl.formatMessage({ id: "settings.plugins.status.incompatible", defaultMessage: "Incompatible" });
        case "failed":
          return intl.formatMessage({ id: "settings.plugins.status.failed", defaultMessage: "Failed" });
        default:
          return status;
      }
    },
    [intl],
  );

  const builtinLabel = intl.formatMessage({ id: "settings.plugins.source.builtin", defaultMessage: "Built-in" });
  const installedLabel = intl.formatMessage({ id: "settings.plugins.source.installed", defaultMessage: "Installed" });

  const detailRow = catalog.find((row) => row.id === selected);
  const activeCount = catalog.filter((row) => row.status === "active").length;

  const confirmRemoveTitle = intl.formatMessage({
    id: "settings.plugins.removeTitle",
    defaultMessage: "Remove plugin",
  });
  const confirmRemoveMessage = intl.formatMessage({
    id: "settings.plugins.removeDescription",
    defaultMessage: "Remove this plugin and revoke its contributions. Saved plugin data is kept.",
  });
  const confirmRemoveConfirmLabel = intl.formatMessage({
    id: "settings.plugins.removeConfirm",
    defaultMessage: "Remove",
  });
  const confirmRemoveCancelLabel = intl.formatMessage({
    id: "mobile.cancel",
    defaultMessage: "Cancel",
  });

  const handleRequestRemove = useCallback(
    (id: string) => {
      const nativeDecision = requestMobileConfirmDialog({
        title: confirmRemoveTitle,
        message: confirmRemoveMessage,
        confirmLabel: confirmRemoveConfirmLabel,
        cancelLabel: confirmRemoveCancelLabel,
        destructive: true,
      });
      if (nativeDecision !== null) {
        void nativeDecision.then((confirmed) => {
          if (confirmed) void change(id, () => manager.remove(id));
        });
        return;
      }
      setConfirmRemoveId(id);
    },
    [change, confirmRemoveCancelLabel, confirmRemoveConfirmLabel, confirmRemoveMessage, confirmRemoveTitle, manager],
  );

  const items: readonly import("@opencraft/design-system-web/valdi").PluginCatalogItem[] = useMemo(
    () =>
      catalog.map((row) => {
        const sourceLabel = row.source === "builtin" ? builtinLabel : installedLabel;
        const statusLabel = formatStatus(row.status);
        const desc =
          (row.description && sameLanguage(row.description) ? row.description : "") ||
          row.capabilities.join(" · ") ||
          row.id;
        const updateFallback = row.updateError
          ? intl.formatMessage({
              id: "settings.plugins.updateFallback",
              defaultMessage: "Last operation failed; current version is still running.",
            })
          : undefined;
        return {
          id: row.id,
          name: row.name,
          version: row.version,
          source: row.source === "builtin" ? "builtin" : "installed",
          sourceLabel,
          statusTone: resolveStatusTone(row.status),
          statusLabel,
          description: desc,
          metadata: `${sourceLabel} · ${row.version} · ${statusLabel}`,
          icon: resolvePluginIcon(row.id, row.capabilities),
          enabled: row.enabled,
          canManage: row.canManage,
          busy: false,
          error: errors[row.id] || row.error || updateFallback,
          toggleLabel: `${row.name} (${statusLabel})`,
          openDetailLabel: row.name,
        };
      }),
    [builtinLabel, catalog, errors, formatStatus, installedLabel, intl, pending, sameLanguage],
  );

  const detailModel: import("@opencraft/design-system-web/valdi").PluginDetailModel | undefined = useMemo(
    () =>
      detailRow
        ? {
            id: detailRow.id,
            name: detailRow.name,
            versionMetadata: `${detailRow.version} · ${detailRow.source === "builtin" ? builtinLabel : installedLabel}`,
            statusLabel: formatStatus(detailRow.status),
            statusTone: resolveStatusTone(detailRow.status),
            statusError: detailRow.error ?? undefined,
            intentLabel: detailRow.enabled
              ? intl.formatMessage({ id: "settings.plugins.intent.enabled", defaultMessage: "Enabled" })
              : intl.formatMessage({ id: "settings.plugins.intent.disabled", defaultMessage: "Disabled" }),
            capabilitiesText: detailRow.capabilities.length
              ? detailRow.capabilities.join(" · ")
              : intl.formatMessage({
                  id: "settings.plugins.noCapabilities",
                  defaultMessage: "No public contributions registered",
                }),
            sourceUrl: detailRow.sourceUrl ?? undefined,
            updateError: detailRow.updateError ?? undefined,
            actionError: errors[detailRow.id] || undefined,
            canManage: detailRow.canManage,
            canReload: detailRow.canReload,
            canRemove: detailRow.canRemove,
            enabled: detailRow.enabled,
            busy: pending.has(detailRow.id),
            icon: resolvePluginIcon(detailRow.id, detailRow.capabilities),
          }
        : undefined,
    [builtinLabel, detailRow, errors, formatStatus, installedLabel, intl, pending],
  );

  const alerts = useMemo(() => {
    const list: string[] = [];
    if (installations.installationLoadErrors.length > 0) {
      list.push(
        intl.formatMessage(
          {
            id: "settings.plugins.isolatedRecords",
            defaultMessage: "{count} invalid plugin records were isolated.",
          },
          { count: installations.installationLoadErrors.length },
        ),
      );
    }
    for (const err of installations.discoveryErrors) {
      list.push(`${err.extensionId}: ${err.message}`);
    }
    return list;
  }, [installations.discoveryErrors, installations.installationLoadErrors.length, intl]);

  const pageTitle = intl.formatMessage({ id: "settings.plugins", defaultMessage: "Plugins" });
  const pageSubtitle = intl.formatMessage({
    id: "settings.plugins.description",
    defaultMessage: "View installed plugins and their current status.",
  });

  const handleSelectPlugin = useCallback((id: string | null) => setSelected(id), []);
  const handleTogglePlugin = useCallback(
    (id: string, enabled: boolean) => {
      void change(id, () => manager.setEnabled(id, enabled));
    },
    [change, manager],
  );
  const handleReloadPlugin = useCallback(
    (id: string) => {
      void change(id, () => manager.reload(id));
    },
    [change, manager],
  );
  const handleInstallUrl = useCallback(
    (url: string) => {
      void change("install", () => manager.installModuleUrl(url));
    },
    [change, manager],
  );
  const handleConfirmRemove = useCallback(
    (id: string) => {
      setConfirmRemoveId(null);
      setSelected((curr) => (curr === id ? null : curr));
      void change(id, () => manager.remove(id));
    },
    [change, manager],
  );
  const handleCancelRemove = useCallback(() => setConfirmRemoveId(null), []);
  const handleHaptic = useCallback((style: string) => {
    requestMobileHaptic(style === "warning" ? "warning" : style === "light" ? "light" : "selection");
  }, []);

  const viewModel: import("@opencraft/design-system-web/valdi").PluginsSettingsProps = useMemo(
    () => ({
      dark: appearance.resolvedTheme === "dark",
      showHeader: standalone,
      badgeLabel: intl.formatMessage(
        {
          id: "settings.plugins.badge",
          defaultMessage: "{total} Installed · {active} Active",
        },
        { total: catalog.length, active: activeCount },
      ),
      title: pageTitle,
      subtitle: pageSubtitle,
      searchLabel: intl.formatMessage({ id: "settings.plugins.search", defaultMessage: "Search plugins" }),
      searchPlaceholder: intl.formatMessage({
        id: "settings.plugins.searchPlaceholder",
        defaultMessage: "Search plugins by name or ID…",
      }),
      clearLabel: intl.formatMessage({ id: "mobile.connection.clear", defaultMessage: "Clear" }),
      sourceFilterLabel: intl.formatMessage({ id: "settings.plugins.sourceFilter", defaultMessage: "Plugin source" }),
      sourceAllLabel: intl.formatMessage({ id: "settings.plugins.source.all", defaultMessage: "All" }),
      sourceBuiltinLabel: builtinLabel,
      sourceInstalledLabel: installedLabel,
      listGroupTitle: intl.formatMessage({ id: "settings.plugins.listGroup", defaultMessage: "Installed extensions" }),
      emptyTitle: intl.formatMessage({ id: "settings.plugins.empty", defaultMessage: "No plugins installed." }),
      noMatchTitle: intl.formatMessage({ id: "settings.plugins.noMatch", defaultMessage: "No matching plugins." }),
      backLabel: intl.formatMessage({ id: "settings.plugins.backToList", defaultMessage: "Back to plugins" }),
      detailGroupTitle: intl.formatMessage({ id: "settings.plugins.detailGroup", defaultMessage: "Runtime & capabilities" }),
      statusRowTitle: intl.formatMessage({ id: "settings.plugins.row.status", defaultMessage: "Runtime status" }),
      intentRowTitle: intl.formatMessage({ id: "settings.plugins.row.intent", defaultMessage: "Activation intent" }),
      capabilitiesRowTitle: intl.formatMessage({
        id: "settings.plugins.row.capabilities",
        defaultMessage: "Contributions",
      }),
      sourceUrlRowTitle: intl.formatMessage({ id: "settings.plugins.row.sourceUrl", defaultMessage: "Source URL" }),
      updateFailedRowTitle: intl.formatMessage({
        id: "settings.plugins.row.updateFailed",
        defaultMessage: "Previous update incomplete",
      }),
      updateFailedRowDetail: intl.formatMessage({
        id: "settings.plugins.row.updateFailedDetail",
        defaultMessage: "The previous version remains active.",
      }),
      enableActionLabel: intl.formatMessage({ id: "settings.plugins.enable", defaultMessage: "Enable" }),
      disableActionLabel: intl.formatMessage({ id: "settings.plugins.disable", defaultMessage: "Disable" }),
      reloadActionLabel: intl.formatMessage({ id: "settings.plugins.reload", defaultMessage: "Reload from source" }),
      removeActionLabel: confirmRemoveTitle,
      builtinManagedTitle: intl.formatMessage({
        id: "settings.plugins.builtinManagedTitle",
        defaultMessage: "Managed with OpenCraft",
      }),
      builtinManagedMessage: intl.formatMessage({
        id: "settings.plugins.builtinManagedMessage",
        defaultMessage: "Built-in plugins update alongside OpenCraft and cannot be disabled or removed individually.",
      }),
      developerMode: developer,
      installGroupTitle: intl.formatMessage({
        id: "settings.plugins.installGroup",
        defaultMessage: "Install trusted module from URL",
      }),
      installUrlLabel: intl.formatMessage({ id: "settings.plugins.installUrlLabel", defaultMessage: "Module URL" }),
      installUrlPlaceholder: "https://example.com/extension.mjs",
      installActionLabel: intl.formatMessage({ id: "settings.plugins.installAction", defaultMessage: "Install plugin" }),
      installBusy: pending.has("install"),
      installError: errors.install || undefined,
      confirmRemoveTitle,
      confirmRemoveMessage,
      confirmRemoveConfirmLabel,
      confirmRemoveCancelLabel,
      alerts,
      items,
      detail: detailModel,
      onSelectPlugin: handleSelectPlugin,
      onTogglePlugin: handleTogglePlugin,
      onReloadPlugin: handleReloadPlugin,
      onRequestRemovePlugin: handleRequestRemove,
      onInstallUrl: handleInstallUrl,
      confirmingRemoveId: confirmRemoveId,
      onConfirmRemove: handleConfirmRemove,
      onCancelRemove: handleCancelRemove,
      onHaptic: handleHaptic,
    }),
    [
      activeCount,
      alerts,
      appearance.resolvedTheme,
      builtinLabel,
      catalog.length,
      confirmRemoveCancelLabel,
      confirmRemoveConfirmLabel,
      confirmRemoveMessage,
      confirmRemoveTitle,
      confirmRemoveId,
      detailModel,
      developer,
      errors.install,
      handleCancelRemove,
      handleConfirmRemove,
      handleHaptic,
      handleInstallUrl,
      handleReloadPlugin,
      handleRequestRemove,
      handleSelectPlugin,
      handleTogglePlugin,
      installedLabel,
      intl,
      items,
      pageSubtitle,
      pageTitle,
      pending,
      standalone,
    ],
  );

  const extensionDetailViews =
    detailRow && settingsHost && renderers
      ? contributions.settingsPages
          .filter(
            (entry) =>
              entry.owner.extensionId === detailRow.id &&
              entry.contribution.placement === "extension" &&
              (entry.contribution.audience !== "internal" || developer) &&
              (entry.contribution.platforms?.includes(settingsHost.platform) ?? true),
          )
          .map((entry) => {
            const view = contributions.views.find(
              (candidate) =>
                candidate.owner.extensionId === entry.owner.extensionId &&
                candidate.contribution.id === entry.contribution.viewId,
            )?.contribution;
            const Component = view ? renderers.resolve(view.viewType) : null;
            return view && Component ? (
              <Component
                key={entry.contribution.id}
                host={settingsHost}
                contribution={view}
                activation={{ viewId: view.id, resourceUri: null }}
                reportError={reportError}
              />
            ) : null;
          })
      : null;

  return (
    <section className="extension-library" aria-label={pageTitle}>
      <Suspense
        fallback={
          standalone ? <SettingsPageHeader title={pageTitle} description={pageSubtitle} /> : null
        }
      >
        <LazyValdiPluginsSettings viewModel={viewModel} />
      </Suspense>
      {extensionDetailViews}
    </section>
  );
}
