import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";

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

export interface LightVelaHermesExtensionOptions extends LightVelaAccountServiceOptions {
  readonly sessionTokenCache?: HermesSessionTokenCache;
  readonly connectorRelease?: ConnectorRelease;
}

export function createLightVelaHermesExtension(
  options: LightVelaHermesExtensionOptions = {},
): TrustedExtensionDefinition {
  const ownsSessionTokenCache = options.sessionTokenCache === undefined;
  const {
    sessionTokenCache = new IndexedDbHermesSessionTokenCache(),
    connectorRelease,
    ...accountOptions
  } = options;
  const account = new LightVelaAccountService(accountOptions);
  const SettingsView = createLightVelaHermesSettingsView(account);
  const EmptyView = createLightVelaHermesEmptyView(account);
  const ConnectorsView = createConnectorsSettingsView(account, connectorRelease ?? connectorTestRelease);
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
      const acceptedOAuthCallback = account.bootstrapOAuthFragment();
      if (acceptedOAuthCallback || account.hasStoredSession()) {
        void account.refreshBots().catch(() => undefined);
      }
      api.views.register({ id: "lightvela.hermes.connectors-view", title: "连接器", viewType: "lightvela.hermes.connectors", icon: "server", platforms: ["web", "electron"] });
      api.settings.registerPage({ id: "lightvela.hermes.connectors", title: "连接器", viewId: "lightvela.hermes.connectors-view", icon: "server", order: 310, platforms: ["web", "electron"] });
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
          Component: createLightVelaHermesManagementView(account, page.key),
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
