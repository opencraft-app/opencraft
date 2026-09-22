import type { DuplexTransport } from "@opencraft/appserver-client/transport";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import {
  HOST_PROFILE_CONTRIBUTION_CHANNEL,
  type HostConnectionJson,
  type HostConnectionProvider,
  type HostConnectionProviderContext,
} from "@opencraft/workbench-runtime";
import { LocalAgentSettingsService, type HostProtocolRequest } from "./local-agent-settings-service";
import { ModelServicesController } from "./model-services/controller";
import { createModelServicesView } from "./model-services/view";
import { CodexAccountsService } from "./codex-accounts/service";
import { createCodexAccountsView } from "./codex-accounts/view";

type LocalAgentConfig = Readonly<Record<string, never>>;

function validate(value: HostConnectionJson): LocalAgentConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Local Agent connection config must be an object");
  return Object.freeze({});
}

export interface BuiltinAgentsExtensionOptions {
  readonly requestHost: HostProtocolRequest;
  readonly createTransport: (hostId: string) => DuplexTransport;
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
      const service = new LocalAgentSettingsService(options.requestHost, "local");
      const controller = new ModelServicesController(service);
      const codexAccounts = new CodexAccountsService(options.requestHost, "local-codex");
      api.views.register({ id: "vela.builtin-agents.model-services-view", title: "模型服务", viewType: "vela.builtin-agents.model-services", platforms: ["electron"] });
      api.settings.registerPage({ id: "vela.builtin-agents.model-services", title: "模型服务", viewId: "vela.builtin-agents.model-services-view", layout: "master-detail", group: "本机", icon: "brain", platforms: ["electron"] });
      api.internal.register("platformViewRenderer", { viewType: "vela.builtin-agents.model-services", Component: createModelServicesView(controller) });
      api.views.register({ id: "vela.builtin-agents.codex-accounts-view", title: "Codex 账户", viewType: "vela.builtin-agents.codex-accounts", platforms: ["electron"] });
      api.settings.registerPage({ id: "vela.builtin-agents.codex-accounts", title: "Codex 账户", viewId: "vela.builtin-agents.codex-accounts-view", group: "本机", icon: "user-round-cog", platforms: ["electron"] });
      api.internal.register("platformViewRenderer", { viewType: "vela.builtin-agents.codex-accounts", Component: createCodexAccountsView(codexAccounts) });
      api.subscriptions.add(() => { codexAccounts.dispose(); controller.dispose(); service.dispose(); });
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
      api.internal.register(HOST_PROFILE_CONTRIBUTION_CHANNEL, {
        profile: {
          hostId: "local-codex",
          displayName: "Codex",
          providerId: hostProvider.id,
          providerConfig: config,
          providerConfigVersion: 1,
          hostKind: "local",
          enabled: true,
          autoConnect: false,
          includeInSidebar: true,
          credentialRef: null,
          transportEndpoint: "OpenCraft Daemon",
          executionLocation: "This device · Codex",
          workspaceBrowseRoots: [],
          revision: 0,
        },
      });
    },
  };
}
