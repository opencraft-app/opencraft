import { useIntl } from "@opencraft/i18n/react";
import type { BotContribution, ExtensionPlatform, ViewContribution } from "@opencraft/extension-contract";
import type { ExtensionContributionStore } from "@opencraft/extension-runtime";
import type {
  ExtensionSettingsViewProps,
  PlatformAccountContribution,
  PlatformAccountSnapshot,
  PlatformViewHost,
  PlatformViewRendererRegistry,
} from "@opencraft/extension-react";
import {
  createSidebarEntityKey,
  type SidebarEntity,
} from "@opencraft/sidebar-layout";
import { useCallback, useMemo, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

import type {
  SidebarActionItem,
  SidebarCatalogItem,
} from "../components/sidebar";
import type { ApplicationRoute } from "./workbench-navigation";
import type { PlatformAccountContributionRegistry } from "./platform-account-contributions";
import { isInternalAudienceVisible } from "../internal-developer-mode";

import { createConnectorManagementAction } from "./connector-management-action";

import { useOptionalAsyncNotices } from "../components/async-notices";
import { useDismissSidebarAfterSelection } from "../components/shell-presentation";

const EMPTY_ACCOUNT_SNAPSHOT: PlatformAccountSnapshot = Object.freeze({
  revision: 0,
  phase: "anonymous",
  name: null,
  avatarUrl: null,
  planLabel: null,
  usageRemainingPercent: null,
  error: null,
});
const subscribeEmptyAccount = (): (() => void) => () => undefined;
const readEmptyAccount = (): PlatformAccountSnapshot => EMPTY_ACCOUNT_SNAPSHOT;

export interface ExtensionAccountProjection {
  readonly provider: PlatformAccountContribution;
  readonly snapshot: PlatformAccountSnapshot;
  readonly content: ReactNode;
  renderSignIn(flowId: string): ReactNode;
  renderEnvironmentCreation(onDismiss: () => void): ReactNode;
}

export interface ExtensionWorkbenchProjection {
  readonly manageConnectors?: () => void;
  readonly primaryActions: readonly SidebarActionItem[];
  readonly footerActions: readonly SidebarActionItem[];
  readonly catalogs: readonly SidebarCatalogItem[];
  readonly bots: readonly SidebarEntity[];
  readonly activeView: ViewContribution | null;
  readonly routeFamilies: ReadonlyMap<string, string>;
  readonly activeViewNode: ReactNode;
  readonly emptyWorkbenchNode: ReactNode;
  readonly connectionInterventions: readonly {
    readonly providerId: string;
    readonly intervention: "authentication-required" | "configuration-required";
    readonly node: ReactNode;
  }[];
  readonly account: ExtensionAccountProjection | null;
}

export interface ExtensionWorkbenchProjectionOptions {
  readonly contributions: ExtensionContributionStore;
  readonly renderers: PlatformViewRendererRegistry;
  readonly accounts: PlatformAccountContributionRegistry;
  readonly host: PlatformViewHost;
  readonly regions?: ExtensionSettingsViewProps["regions"];
  readonly applicationRoute: ApplicationRoute;
  readonly internalDeveloperMode: boolean;
  readonly openSettings: (pageId: string) => void;
  readonly openView: (viewId: string, resourceUri?: string | null) => void;
}

function supportsPlatform(
  value: { readonly platforms?: readonly ExtensionPlatform[] },
  platform: ExtensionPlatform,
): boolean {
  return value.platforms?.includes(platform) ?? true;
}

function byOrderThenId(
  left: { readonly order?: number; readonly id: string },
  right: { readonly order?: number; readonly id: string },
): number {
  return (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id);
}

function SidebarExtensionView({ component: Component, ...props }: ExtensionSettingsViewProps & {
  component: ComponentType<ExtensionSettingsViewProps>;
}) {
  const dismiss = useDismissSidebarAfterSelection();
  const host = useMemo<PlatformViewHost>(() => ({
    ...props.host,
    openView(viewId, resourceUri) {
      props.host.openView(viewId, resourceUri);
      dismiss?.();
    },
  }), [dismiss, props.host]);
  return <Component {...props} host={host} />;
}

/**
 * Projects framework-free extension declarations into host-owned React
 * surfaces. Public and renderer registries are observed independently, while
 * the activation transaction guarantees renderers commit before declarations
 * become visible and declarations retire before renderers are disposed.
 */
export function useExtensionWorkbenchProjection({
  contributions,
  renderers,
  accounts,
  host,
  regions,
  applicationRoute,
  internalDeveloperMode,
  openSettings,
  openView,
}: ExtensionWorkbenchProjectionOptions): ExtensionWorkbenchProjection {
  const intl = useIntl();
  const notices = useOptionalAsyncNotices();
  const reportError = useCallback((notice: { key: string; message: string }) => notices?.error(notice), [notices]);
  const contributionSnapshot = useSyncExternalStore(
    contributions.subscribe,
    contributions.getSnapshot,
    contributions.getSnapshot,
  );
  const rendererSnapshot = useSyncExternalStore(
    renderers.subscribe,
    renderers.getSnapshot,
    renderers.getSnapshot,
  );
  const accountRegistrySnapshot = useSyncExternalStore(
    accounts.subscribe,
    accounts.getSnapshot,
    accounts.getSnapshot,
  );
  const accountProvider = accountRegistrySnapshot.contribution;
  const accountSnapshot = useSyncExternalStore(
    accountProvider?.subscribe ?? subscribeEmptyAccount,
    accountProvider?.getSnapshot ?? readEmptyAccount,
    accountProvider?.getSnapshot ?? readEmptyAccount,
  );

  return useMemo(() => {
    const identity = accountSnapshot.phase === "authenticated" ? accountSnapshot.identity : null;
    const viewHost: PlatformViewHost = { ...host, activeView: applicationRoute.kind === "extension-view" ? applicationRoute : undefined,
      currentUser: accountProvider && identity
      ? { providerId: accountProvider.id, id: identity.id, handle: identity.handle } : null };
    const views = new Map(
      contributionSnapshot.views
        .map(({ contribution }) => contribution)
        .filter((view) =>
          supportsPlatform(view, host.platform)
          && isInternalAudienceVisible(view.audience, internalDeveloperMode))
        .map((view) => [view.id, view] as const),
    );
    const renderView = (viewId: string, {
      resourceUri = null, onDismiss, authenticationFlowId, sidebar = false, route = false,
    }: {
      resourceUri?: string | null;
      onDismiss?: () => void;
      authenticationFlowId?: string;
      sidebar?: boolean;
      route?: boolean;
    } = {}): ReactNode => {
      const view = views.get(viewId);
      if (view === undefined) return null;
      const Component = renderers.resolve(view.viewType);
      if (Component === null) return null;
      const props: ExtensionSettingsViewProps = {
        activation: { viewId, resourceUri }, contribution: view, host: viewHost,
        reportError, onDismiss, authenticationFlowId, regions: route ? regions : undefined,
      };
      return sidebar ? <SidebarExtensionView {...props} component={Component} /> : <Component {...props} />;
    };
    const invokeTarget = (
      target: (typeof contributionSnapshot.navigation)[number]["contribution"]["target"],
    ) => {
      if (target.kind === "command") {
        void contributions.executeCommand(target.commandId).catch((error) => {
          console.error(`Extension command ${target.commandId} failed`, error);
        });
      } else if (target.kind === "settings") {
        openSettings(target.pageId);
      } else {
        openView(target.viewId);
      }
    };
    const invokeBot = (bot: BotContribution) => {
      if (bot.action.kind === "command") {
        const commandId = bot.action.commandId;
        void contributions.executeCommand(commandId).catch((error) => {
          console.error(`Bot action ${commandId} failed`, error);
        });
      } else if (bot.action.kind === "view") {
        openView(bot.action.viewId, bot.action.resourceUri ?? null);
      } else {
        window.open(bot.action.url, "_blank", "noopener,noreferrer");
      }
    };
    const bots: SidebarEntity[] = internalDeveloperMode ? [
      ...contributionSnapshot.bots
        .map(({ contribution }) => contribution)
        .filter((bot) => supportsPlatform(bot, host.platform))
        .map((bot) => {
          const identity = Object.freeze({
            kind: "bot" as const,
            hostId: null,
            entityId: bot.id,
          });
          return Object.freeze({
            key: createSidebarEntityKey(identity),
            identity,
            title: bot.name,
            ...(bot.subtitle === undefined ? {} : { subtitle: bot.subtitle }),
            avatar: bot.avatar,
            availability: bot.availability ?? "available",
            ...(bot.defaultPinned === undefined ? {} : { defaultPinned: bot.defaultPinned }),
            ...(bot.order === undefined ? {} : { order: bot.order }),
            invoke: () => invokeBot(bot),
          });
        }),
    ] : [];
    bots.sort((left, right) =>
      (left.order ?? 0) - (right.order ?? 0)
      || left.title.localeCompare(right.title)
      || left.key.localeCompare(right.key));
    const navigation = contributionSnapshot.navigation
      .map(({ contribution }) => contribution)
      .filter((item) =>
        supportsPlatform(item, host.platform)
        && isInternalAudienceVisible(item.audience, internalDeveloperMode))
      .sort(byOrderThenId);
    const actionFor = (item: (typeof navigation)[number]): SidebarActionItem => ({
        id: item.id,
        title: item.titleMessage ? intl.formatMessage(item.titleMessage) : item.title,
        shortTitle: item.shortTitleMessage ? intl.formatMessage(item.shortTitleMessage) : undefined,
        badge: item.badgeMessage ? intl.formatMessage(item.badgeMessage) : undefined,
        icon: item.icon,
        active:
          (item.target.kind === "settings" &&
            applicationRoute.kind === "settings" &&
            applicationRoute.slug === item.target.pageId) ||
          (item.target.kind === "view" &&
            applicationRoute.kind === "extension-view" &&
            applicationRoute.viewId === item.target.viewId),
        onInvoke: () => invokeTarget(item.target),
      });
    const catalogs = contributionSnapshot.sidebarCatalogs
      .map(({ contribution }) => contribution)
      .filter((catalog) => supportsPlatform(catalog, host.platform))
      .sort(byOrderThenId)
      .flatMap((catalog): readonly SidebarCatalogItem[] => {
        const content = renderView(catalog.viewId, { sidebar: true });
        return content === null ? [] : [{
          id: catalog.id,
          title: catalog.titleMessage ? intl.formatMessage(catalog.titleMessage) : catalog.title,
          icon: catalog.icon,
          initiallyCollapsed: catalog.initiallyCollapsed,
          presentation: catalog.presentation,
          action: catalog.actionViewId ? renderView(catalog.actionViewId, { sidebar: true }) : null,
          content,
        }];
      });
    const activeView = applicationRoute.kind === "extension-view"
      ? views.get(applicationRoute.viewId) ?? null
      : null;
    const emptySurface = contributionSnapshot.workbenchSurfaces
      .map(({ contribution }) => contribution)
      .filter(
        (surface) =>
          surface.surface === "empty-workbench" &&
          supportsPlatform(surface, host.platform),
      )
      .sort(byOrderThenId)[0] ?? null;
    const connectionInterventions = contributionSnapshot.workbenchSurfaces
      .map(({ contribution }) => contribution)
      .filter(
        (surface) =>
          supportsPlatform(surface, host.platform),
      )
      .sort(byOrderThenId)
      .flatMap((surface) => surface.surface === "host-connection-intervention"
        ? [{
            providerId: surface.providerId,
            intervention: surface.intervention,
            node: renderView(surface.viewId),
          }]
        : []);
    const accountContent = accountProvider === null ? null : renderView(accountProvider.viewId);

    return {
      manageConnectors: createConnectorManagementAction(contributions, renderers, host.platform, internalDeveloperMode, openSettings),
      primaryActions: navigation
        .filter((item) => item.surface === "sidebar-primary")
        .map(actionFor),
      footerActions: navigation
        .filter((item) => item.surface === "sidebar-footer")
        .map(actionFor),
      catalogs,
      bots,
      activeView,
      routeFamilies: new Map([...views.values()].filter(view => view.routeFamily !== undefined)
        .map(view => [view.id, JSON.stringify([view.routeFamily, view.viewType])])),
      activeViewNode: activeView === null
        ? null
        : renderView(
            activeView.id,
            { resourceUri: applicationRoute.kind === "extension-view" ? applicationRoute.resourceUri : null, route: true },
          ),
      emptyWorkbenchNode: emptySurface === null ? null : renderView(emptySurface.viewId),
      connectionInterventions,
      account: accountProvider === null || accountContent === null
        ? null
        : { provider: accountProvider, snapshot: accountSnapshot, content: accountContent,
          renderSignIn: flowId => accountProvider.signInViewId ? renderView(accountProvider.signInViewId, { authenticationFlowId: flowId }) : null,
          renderEnvironmentCreation: onDismiss => accountProvider.environmentCreation ? renderView(accountProvider.environmentCreation.viewId, { onDismiss }) : null },
    };
  }, [
    applicationRoute,
    accountProvider,
    accountSnapshot,
    contributionSnapshot,
    contributions,
    host,
    internalDeveloperMode,
    intl,
    openSettings,
    openView,
    reportError,
    regions,
    rendererSnapshot,
    renderers,
  ]);
}
