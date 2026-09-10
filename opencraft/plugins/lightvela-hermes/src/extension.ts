import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import type { PlatformAccountContribution } from "@opencraft/extension-react";
import type { AppServerProfileSkillsService } from "@opencraft/profile-skills-appserver";
import type { AppServerClientRegistryService } from "@opencraft/appserver-client";

import { LightVelaAccountService, type LightVelaAccountServiceOptions } from "./account/lightvela-account-service";
import { createLightVelaHermesHostProvider } from "./host/lightvela-hermes-host-provider";
import {
  IndexedDbHermesSessionTokenCache,
  type HermesSessionTokenCache,
} from "./lib/hermes-session-token-cache";
import { createLightVelaHermesSettingsView } from "./settings/lightvela-hermes-settings-view";
import {
  createLightVelaHermesManagementView,
  type LightVelaHermesManagementPage,
} from "./settings/lightvela-hermes-management-view";
import { createLightVelaHermesEmptyView } from "./settings/lightvela-hermes-empty-view";
import { createConnectorsSettingsView } from "./connectors/connectors-settings-view";
import type { ConnectorRelease } from "./connectors/connector-client";
import { connectorTestRelease } from "./connectors/test-release";
import { AppServerLightVelaRuntimeCommandPort } from "./account/lightvela-runtime-command-port";
import { createLightVelaAccountView } from "./account/lightvela-account-view";

export interface LightVelaHermesExtensionOptions extends LightVelaAccountServiceOptions {
  readonly sessionTokenCache?: HermesSessionTokenCache;
  readonly connectorRelease?: ConnectorRelease;
  readonly profileSkills?: AppServerProfileSkillsService;
  readonly appServerClients?: AppServerClientRegistryService;
}

export function createLightVelaHermesExtension(
  options: LightVelaHermesExtensionOptions = {},
): TrustedExtensionDefinition {
  const ownsSessionTokenCache = options.sessionTokenCache === undefined;
  const {
    sessionTokenCache = new IndexedDbHermesSessionTokenCache(),
    connectorRelease,
    profileSkills,
    appServerClients,
    ...accountOptions
  } = options;
  const account = new LightVelaAccountService({
    ...accountOptions,
    ...(appServerClients === undefined ? {} : {
      runtimeCommands: new AppServerLightVelaRuntimeCommandPort(appServerClients),
    }),
  });
  const SettingsView = createLightVelaHermesSettingsView(account);
  const EmptyView = createLightVelaHermesEmptyView(account);
  const ConnectorsView = createConnectorsSettingsView(account, connectorRelease ?? connectorTestRelease);
  const AccountView = createLightVelaAccountView(account);
  const managementPages = [
    { key: "channels", title: "Channels", icon: "message-circle", scope: "agent", order: 301 },
    { key: "models", title: "Models", icon: "brain", scope: "agent", order: 302 },
    { key: "skills", title: "Skills", icon: "sparkles", scope: "agent", order: 303 },
    { key: "memory", title: "Soul & Memory", icon: "cpu", scope: "agent", order: 304 },
    { key: "schedules", title: "Scheduled tasks", icon: "calendar", scope: "agent", order: 305 },
    { key: "runtime", title: "Runtime & connection", icon: "server", scope: "host", order: 306 },
    { key: "storage", title: "Cloud storage", icon: "cloud", scope: "host", order: 307 },
    { key: "diagnostics", title: "Diagnostics", icon: "activity", scope: "host", order: 308 },
  ] as const satisfies readonly {
    readonly key: LightVelaHermesManagementPage;
    readonly title: string;
    readonly icon: string;
    readonly scope: "agent" | "host";
    readonly order: number;
  }[];
  return {
    manifest: {
      manifestVersion: 1,
      id: "lightvela.hermes",
      name: "LightVela Hermes",
      description: "Connects a LightVela Bot's Hermes runtime as a OpenCraft Host.",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web", "electron"],
      activationEvents: ["onStartupFinished"],
    },
    activate(api) {
      let authGeneration = account.getSnapshot().authGeneration;
      api.subscriptions.add(account.subscribe(() => {
        const next = account.getSnapshot().authGeneration;
        if (next === authGeneration) return;
        authGeneration = next;
        void sessionTokenCache.clear?.().catch(() => undefined);
      }));
      // OAuth returns to whichever Workbench route initiated sign-in. Callback
      // ownership therefore belongs to the extension activation lifetime, not
      // to an optional Settings or empty-state View that may never mount on
      // that route.
      const refreshAuthenticatedAccount = (): void => {
        if (!account.bootstrapOAuthFragment()) return;
        void account.refreshBots().catch(() => undefined);
        void account.refreshAccountDetails().catch(() => undefined);
      };
      refreshAuthenticatedAccount();
      if (account.hasStoredSession()) {
        void account.refreshBots().catch(() => undefined);
        void account.refreshAccountDetails().catch(() => undefined);
      }
      // Some browser containers restore the Workbench document and deliver
      // the OAuth fragment as a same-document navigation. Extension activation
      // has already happened in that case, so retain an explicit callback
      // owner for the whole extension lifetime.
      globalThis.addEventListener?.("hashchange", refreshAuthenticatedAccount);
      api.subscriptions.add(() => {
        globalThis.removeEventListener?.("hashchange", refreshAuthenticatedAccount);
      });
      api.views.register({
        id: "lightvela.hermes.account-view",
        title: "Account Settings",
        viewType: "lightvela.hermes.account",
        icon: "user",
        platforms: ["web", "electron"],
      });
      api.internal.register("platformViewRenderer", {
        viewType: "lightvela.hermes.account",
        Component: AccountView,
      });
      let accountSurfaceSourceRevision = -1;
      let accountSurfaceSnapshot: ReturnType<PlatformAccountContribution["getSnapshot"]> | null = null;
      api.internal.register("platformAccount", {
        id: "lightvela.hermes.account",
        viewId: "lightvela.hermes.account-view",
        getSnapshot: () => {
          const snapshot = account.getSnapshot();
          if (snapshot.revision === accountSurfaceSourceRevision && accountSurfaceSnapshot !== null) {
            return accountSurfaceSnapshot;
          }
          const details = snapshot.details;
          const total = details.pass?.creditsTotal ?? 0;
          const available = details.pass?.creditsAvailable ?? 0;
          accountSurfaceSourceRevision = snapshot.revision;
          accountSurfaceSnapshot = Object.freeze({
            revision: snapshot.revision,
            phase: snapshot.phase,
            name: details.profile?.pendingName || details.profile?.name || null,
            avatarUrl: details.profile?.avatarUrl ?? null,
            planLabel: details.pass?.bundleName || details.subscription?.code || null,
            usageRemainingPercent: total > 0
              ? Math.max(0, Math.min(100, Math.round((available / total) * 100)))
              : null,
            error: details.error ?? snapshot.error,
          });
          return accountSurfaceSnapshot;
        },
        subscribe: account.subscribe,
        refresh: () => account.refreshAccountDetails(),
        signOut: () => account.signOut(),
      } satisfies PlatformAccountContribution);
      api.views.register({ id: "lightvela.hermes.connectors-view", title: "连接器", viewType: "lightvela.hermes.connectors", icon: "server", platforms: ["web", "electron"] });
      api.settings.registerPage({
        id: "lightvela.hermes.connectors",
        title: "连接器",
        viewId: "lightvela.hermes.connectors-view",
        icon: "server",
        order: 310,
        platforms: ["web", "electron"],
        audience: "internal",
      });
      api.internal.register("platformViewRenderer", { viewType: "lightvela.hermes.connectors", Component: ConnectorsView });
      api.views.register({
        id: "lightvela.hermes.settings-view",
        title: "LightVela",
        viewType: "lightvela.hermes.settings",
        icon: "server",
        platforms: ["web", "electron"],
      });
      api.views.register({
        id: "lightvela.hermes.empty-view",
        title: "LightVela",
        viewType: "lightvela.hermes.empty-workbench",
        icon: "server",
        platforms: ["web", "electron"],
      });
      api.settings.registerPage({
        id: "lightvela.hermes.settings",
        title: "Overview",
        viewId: "lightvela.hermes.settings-view",
        icon: "bot",
        order: 300,
        platforms: ["web", "electron"],
        management: { familyId: "lightvela.hermes.manage", scope: "agent" },
      });
      for (const page of managementPages) {
        const viewId = `lightvela.hermes.${page.key}-view`;
        const viewType = `lightvela.hermes.${page.key}`;
        api.views.register({
          id: viewId,
          title: page.title,
          viewType,
          icon: page.icon,
          platforms: ["web", "electron"],
        });
        api.settings.registerPage({
          id: `lightvela.hermes.${page.key}`,
          title: page.title,
          viewId,
          icon: page.icon,
          order: page.order,
          platforms: ["web", "electron"],
          management: { familyId: "lightvela.hermes.manage", scope: page.scope },
        });
        api.internal.register("platformViewRenderer", {
          viewType,
          Component: createLightVelaHermesManagementView(account, page.key, profileSkills),
        });
      }
      api.workbench.registerSurface({
        id: "lightvela.hermes.empty-workbench",
        viewId: "lightvela.hermes.empty-view",
        surface: "empty-workbench",
        order: 100,
        platforms: ["web", "electron"],
      });
      api.workbench.registerSurface({
        id: "lightvela.hermes.authentication-required",
        viewId: "lightvela.hermes.empty-view",
        surface: "host-connection-intervention",
        providerId: "lightvela.hermes",
        intervention: "authentication-required",
        order: 100,
        platforms: ["web", "electron"],
      });
      api.internal.register("platformViewRenderer", {
        viewType: "lightvela.hermes.settings",
        Component: SettingsView,
      });
      api.internal.register("platformViewRenderer", {
        viewType: "lightvela.hermes.empty-workbench",
        Component: EmptyView,
      });
      api.internal.register(
        "hostConnectionProvider",
        createLightVelaHermesHostProvider(account, sessionTokenCache),
      );
      api.subscriptions.add(() => account.dispose());
      if (ownsSessionTokenCache) {
        api.subscriptions.add(() => sessionTokenCache.close?.());
      }
    },
  };
}
