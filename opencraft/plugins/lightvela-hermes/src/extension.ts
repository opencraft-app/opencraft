import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import type { AppServerProfileSkillsService } from "@opencraft/profile-skills-appserver";
import type { AppServerClientRegistryService } from "@opencraft/appserver-client";

import {
  LightVelaAccountService,
  type LightVelaAccountServiceOptions,
} from "@opencraft/plugin-lightvela-platform";
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
import type { HermesProfileDirectory } from "./settings/hermes-skills-management-view";

export interface LightVelaHermesExtensionOptions extends LightVelaAccountServiceOptions {
  /** Application-owned account shared with other first-party LightVela extensions. */
  readonly account?: LightVelaAccountService;
  readonly sessionTokenCache?: HermesSessionTokenCache;
  readonly connectorRelease?: ConnectorRelease;
  readonly profileSkills?: AppServerProfileSkillsService;
  readonly appServerClients?: AppServerClientRegistryService;
  readonly profileDirectory?: HermesProfileDirectory;
}

export function createLightVelaHermesExtension(
  options: LightVelaHermesExtensionOptions = {},
): TrustedExtensionDefinition {
  const ownsAccount = options.account === undefined;
  const ownsSessionTokenCache = options.sessionTokenCache === undefined;
  const {
    account: injectedAccount,
    sessionTokenCache = new IndexedDbHermesSessionTokenCache(),
    connectorRelease,
    profileSkills,
    profileDirectory,
    appServerClients,
    ...accountOptions
  } = options;
  const account = injectedAccount ?? new LightVelaAccountService({
    ...accountOptions,
    ...(appServerClients === undefined ? {} : {
      runtimeCommands: new AppServerLightVelaRuntimeCommandPort(appServerClients),
    }),
  });
  const SettingsView = createLightVelaHermesSettingsView(account);
  const EmptyView = createLightVelaHermesEmptyView(account);
  const ConnectorsView = createConnectorsSettingsView(account, connectorRelease ?? connectorTestRelease);
  const managementPages = [
    { key: "channels", title: "Channels", icon: "message-circle", scope: "agent", order: 301, layout: "document" },
    { key: "models", title: "Models", icon: "brain", scope: "agent", order: 302, layout: "document" },
    { key: "skills", title: "Skills", icon: "sparkles", scope: "agent", order: 303, layout: "edge-to-edge" },
    { key: "memory", title: "Soul & Memory", icon: "cpu", scope: "agent", order: 304, layout: "document" },
    { key: "schedules", title: "Scheduled Tasks", icon: "calendar", scope: "agent", order: 305, layout: "document" },
    { key: "runtime", title: "Runtime & connection", icon: "server", scope: "host", order: 306, layout: "document" },
    { key: "storage", title: "Cloud Storage", icon: "cloud", scope: "host", order: 307, layout: "document" },
    { key: "diagnostics", title: "Diagnostics", icon: "activity", scope: "host", order: 308, layout: "document" },
  ] as const satisfies readonly {
    readonly key: LightVelaHermesManagementPage;
    readonly title: string;
    readonly icon: string;
    readonly scope: "agent" | "host";
    readonly order: number;
    readonly layout: "document" | "edge-to-edge";
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
        const audience = page.key === "storage" ? "internal" : "public";
        api.views.register({
          id: viewId,
          title: page.title,
          viewType,
          audience,
          icon: page.icon,
          platforms: ["web", "electron"],
        });
        api.settings.registerPage({
          id: `lightvela.hermes.${page.key}`,
          title: page.title,
          viewId,
          audience,
          icon: page.icon,
          order: page.order,
          layout: page.layout,
          platforms: ["web", "electron"],
          management: { familyId: "lightvela.hermes.manage", scope: page.scope },
        });
        api.internal.register("platformViewRenderer", {
          viewType,
          Component: createLightVelaHermesManagementView(
            account,
            page.key,
            profileSkills,
            profileDirectory,
          ),
        });
      }
      api.workbench.registerSurface({
        id: "lightvela.hermes.authentication-required",
        viewId: "lightvela.hermes.empty-view",
        surface: "host-connection-intervention",
        providerId: "lightvela.hermes",
        intervention: "authentication-required",
        order: 100,
        platforms: ["web", "electron"],
      });
      api.workbench.registerSurface({
        id: "lightvela.hermes.configuration-required",
        viewId: "lightvela.hermes.empty-view",
        surface: "host-connection-intervention",
        providerId: "lightvela.hermes",
        intervention: "configuration-required",
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
      if (ownsAccount) api.subscriptions.add(() => account.dispose());
      if (ownsSessionTokenCache) {
        api.subscriptions.add(() => sessionTokenCache.close?.());
      }
    },
  };
}
