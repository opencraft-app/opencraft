import type { DuplexTransport } from "@opencraft/appserver-client/transport";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import {
  HOST_PROFILE_CONTRIBUTION_CHANNEL,
  type HostConnectionJson,
  type HostConnectionProvider,
  type HostConnectionProviderContext,
} from "@opencraft/workbench-runtime";

import { LocalAgentSettingsService, type HostProtocolRequest } from "./local-agent-settings-service";
import { createLocalAgentSettingsView, createLocalAgentDefaultModelView } from "./local-agent-settings-view";

type LocalAgentConfig = Readonly<Record<string, never>>;

function validate(value: HostConnectionJson): LocalAgentConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Local Agent connection config must be an object");
  return Object.freeze({});
}

export interface BuiltinAgentsExtensionOptions {
  readonly createTransport: (hostId: string) => DuplexTransport;
  readonly requestHost: HostProtocolRequest;
}

export function createBuiltinAgentsExtension(options: BuiltinAgentsExtensionOptions): TrustedExtensionDefinition {
  const config = validate({});
  const hostProvider: HostConnectionProvider = Object.freeze({
    id: "vela.builtin-agents",
    label: "OpenCraft Local Agent",
    targets: ["electron"] as const,
    configVersion: 1,
    validate,
    createTransport(_config: HostConnectionJson, context: HostConnectionProviderContext) {
      return options.createTransport(context.hostId);
    },
  });
  const settings = new LocalAgentSettingsService(options.requestHost);
  const SettingsView = createLocalAgentSettingsView(settings);
  return {
    manifest: {
      manifestVersion: 1,
      id: "vela.builtin-agents",
      name: "Built-in Agents",
      description: "Connects the workbench to the OpenCraft-owned local AppServer host.",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["electron"],
      activationEvents: ["onStartupFinished"],
    },
    activate(api) {
      api.views.register({
        id: "vela.builtin-agents.settings-view",
        title: "Model services",
        viewType: "vela.builtin-agents.settings",
        icon: "bot",
        platforms: ["electron"],
      });
      api.settings.registerPage({
        id: "vela.builtin-agents.settings",
        title: "Model services",
        viewId: "vela.builtin-agents.settings-view",
        icon: "bot",
        order: 250,
        layout: "master-detail",
        group: "Local Agent",
        platforms: ["electron"],
      });
      api.internal.register("platformViewRenderer", {
        viewType: "vela.builtin-agents.settings",
        Component: SettingsView,
      });
      api.views.register({ id: "vela.builtin-agents.defaults-view", title: "Default model", viewType: "vela.builtin-agents.defaults", platforms: ["electron"] });
      api.settings.registerPage({ id: "vela.builtin-agents.defaults", title: "Default model", viewId: "vela.builtin-agents.defaults-view", order: 249, group: "Local Agent", platforms: ["electron"] });
      api.internal.register("platformViewRenderer", { viewType: "vela.builtin-agents.defaults", Component: createLocalAgentDefaultModelView(settings) });
      api.internal.register("hostConnectionProvider", hostProvider);
      api.internal.register(HOST_PROFILE_CONTRIBUTION_CHANNEL, {
        profile: {
          hostId: "local",
          displayName: "Local",
          providerId: hostProvider.id,
          providerConfig: config,
          providerConfigVersion: 1,
          hostKind: "local",
          enabled: true,
          autoConnect: true,
          includeInSidebar: true,
          credentialRef: null,
          transportEndpoint: "OpenCraft Daemon",
          executionLocation: "This device",
          workspaceBrowseRoots: [],
          revision: 0,
        },
      });
      api.subscriptions.add(() => settings.dispose());
    },
  };
}
