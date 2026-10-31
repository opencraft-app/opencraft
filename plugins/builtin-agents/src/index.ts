import { SERVER_CONNECTIONS_ID, SERVER_SSH_SETTINGS_ID, SERVER_CODEX_ACCOUNTS_SETTINGS_ID } from "./server-connection-identity";
import { createDeferredView } from "@opencraft/extension-react";
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
import { CodexAccountsService } from "./codex-accounts/service";
import { SshConnectionsController } from "./ssh-connections/controller";
export { SshConnectionsController, type SshDiscoveryLifecycle } from "./ssh-connections/controller";

type LocalAgentConfig = Readonly<Record<string, never>>;

function validate(value: HostConnectionJson): LocalAgentConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Local Agent connection config must be an object");
  return Object.freeze({});
}

export type BuiltinAgentsExtensionOptions =
  | {
      readonly platform?: "electron";
      readonly requestHost: HostProtocolRequest;
      readonly createTransport: (hostId: string) => DuplexTransport;
    }
  | {
      readonly platform: "web";
      /** Server deployments contribute their own account page. */
      readonly includeCodexAccounts?: boolean;
      readonly requestHost: HostProtocolRequest;
    };

export interface HeadlessServerExtensionOptions {
  readonly requestHost: HostProtocolRequest;
  readonly createTransport: (hostId: string) => DuplexTransport;
  readonly workspaceBrowseRoots: readonly string[];
  readonly sshServers?: readonly { readonly serverId: string; readonly displayName: string; readonly workspaceBrowseRoots: readonly string[]; readonly hideFromNewChat?: boolean }[];
  readonly sshManagement?: SshConnectionsController;
}

export function createHeadlessModelServicesExtension(options: {
  readonly fetcher?: typeof fetch;
  readonly requestHost: HostProtocolRequest;
  readonly hostId: string;
}): TrustedExtensionDefinition {
  return {
    manifest: {
      manifestVersion: 1,
      id: "opencraft.headless-model-services",
      name: "Server Model Services",
      description: "Configures models on the OpenCraft server that owns execution.",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web"],
      activationEvents: ["onStartupFinished"],
    },
    async activate(api) {
      let active=true;
      api.subscriptions.add(()=>{active=false;});
      await import('./model-policy-view').then(async module=>{
        // Keep this optional authorization probe inside the fulfilled import.
        // Vite reports rejections returned from a preload callback as
        // `vite:preloadError`; allowing a 401/403/404/transport failure to
        // escape here makes the release-recovery bootstrap mistake a business
        // request failure for a missing JavaScript chunk and replace the app.
        const document=await module.readModelPolicy(options.fetcher).catch(()=>null);
        if(!active || !document?.canManage)return;
        api.views.register({id:'opencraft.headless-model-services.policy.view',title:'Model usage restrictions',viewType:'opencraft.headless-model-services.policy',platforms:['web']});
        api.settings.registerPage({id:'opencraft.headless-model-services.policy',title:'Model usage restrictions',titleMessage:{id:'modelPolicy.title',defaultMessage:'Model usage restrictions'},viewId:'opencraft.headless-model-services.policy.view',group:'Server',groupMessage:{id:'settings.groups.server',defaultMessage:'Server'},icon:'brain',platforms:['web']});
        api.internal.register('platformViewRenderer',{viewType:'opencraft.headless-model-services.policy',Component:module.createModelPolicyView(options.requestHost,options.hostId,options.fetcher)});
      }).catch(()=>{});
      const service = new LocalAgentSettingsService(options.requestHost, options.hostId);
      const controller = new ModelServicesController(service);
      api.views.register({ id: "opencraft.headless-model-services.view", title: "模型服务", viewType: "opencraft.headless-model-services", platforms: ["web"] });
      api.settings.registerPage({ id: "opencraft.headless-model-services", title: "Model services", titleMessage: { id: "settings.contributions.modelServices", defaultMessage: "Model services" }, viewId: "opencraft.headless-model-services.view", layout: "master-detail", targetHostId: options.hostId, modelConfiguration: true, modelReadiness: true, group: "Server", groupMessage: { id: "settings.groups.server", defaultMessage: "Server" }, icon: "brain", platforms: ["web"] });
      api.internal.register("platformViewRenderer", { viewType: "opencraft.headless-model-services", Component: createDeferredView(async () => (await import("./model-services/view")).createModelServicesView(controller)) });
      api.subscriptions.add(() => { controller.dispose(); service.dispose(); });
    },
  };
}

export function createHeadlessServerExtension(options: HeadlessServerExtensionOptions): TrustedExtensionDefinition {
  const config = validate({});
  const hostProvider: HostConnectionProvider = Object.freeze({
    id: SERVER_CONNECTIONS_ID,
    label: "Server",
    targets: ["web"] as const,
    configVersion: 1,
    validate,
    createTransport(_config: HostConnectionJson, context: HostConnectionProviderContext) {
      return options.createTransport(context.hostId);
    },
  });
  return {
    manifest: {
      manifestVersion: 1,
      id: SERVER_CONNECTIONS_ID,
      name: "Server Connections",
      description: "Connects the browser Workbench to the server-owned AppHost.",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web"],
      activationEvents: ["onStartupFinished"],
    },
    activate(api) {
      const accounts = new CodexAccountsService(options.requestHost, "local-codex");
      const sshManagement = options.sshManagement;
      if (sshManagement && sshManagement.getSnapshot().available !== false) {
        api.views.register({ id: `${SERVER_SSH_SETTINGS_ID}-view`, title: "远程连接", viewType: SERVER_SSH_SETTINGS_ID, platforms: ["web"] });
        api.settings.registerPage({ id: SERVER_SSH_SETTINGS_ID, title: "Remote connections", titleMessage: { id: "settings.contributions.remoteConnections", defaultMessage: "Remote connections" }, viewId: `${SERVER_SSH_SETTINGS_ID}-view`, group: "Server", groupMessage: { id: "settings.groups.server", defaultMessage: "Server" }, icon: "server", platforms: ["web"] });
        api.internal.register("platformViewRenderer", { viewType: SERVER_SSH_SETTINGS_ID, Component: createDeferredView(async () => (await import("./ssh-connections/view")).createSshConnectionsView(sshManagement)) });
      }
      api.views.register({ id: `${SERVER_CODEX_ACCOUNTS_SETTINGS_ID}-view`, title: "Codex 账户", viewType: SERVER_CODEX_ACCOUNTS_SETTINGS_ID, platforms: ["web"] });
      api.settings.registerPage({ id: SERVER_CODEX_ACCOUNTS_SETTINGS_ID, title: "Codex accounts", titleMessage: { id: "settings.contributions.codexAccounts", defaultMessage: "Codex accounts" }, viewId: `${SERVER_CODEX_ACCOUNTS_SETTINGS_ID}-view`, group: "Server", groupMessage: { id: "settings.groups.server", defaultMessage: "Server" }, icon: "user-round-cog", platforms: ["web"] });
      api.internal.register("platformViewRenderer", { viewType: SERVER_CODEX_ACCOUNTS_SETTINGS_ID, Component: createDeferredView(async () => (await import("./codex-accounts/view")).createCodexAccountsView(accounts, { allowImport: false, credentialLocation: "服务器" })) });
      api.subscriptions.add(() => accounts.dispose());
      api.internal.register("hostConnectionProvider", hostProvider);
      api.internal.register(HOST_PROFILE_CONTRIBUTION_CHANNEL, {
        profile: {
          hostId: "local-codex",
          displayName: "Server",
          providerId: hostProvider.id,
          providerConfig: config,
          providerConfigVersion: 1,
          hostKind: "durable",
          enabled: true,
          autoConnect: true,
          includeInSidebar: true,
          credentialRef: null,
          transportEndpoint: "Server",
          executionLocation: "This server",
          workspaceBrowseRoots: options.workspaceBrowseRoots,
          revision: 0,
        },
      });
      for (const server of options.sshServers ?? []) api.internal.register(HOST_PROFILE_CONTRIBUTION_CHANNEL, {
        profile: {
          hostId: server.serverId,
          displayName: server.displayName,
          providerId: hostProvider.id,
          providerConfig: config,
          providerConfigVersion: 1,
          hostKind: "remote-ssh",
          hideFromNewChat: server.hideFromNewChat,
          enabled: true,
          autoConnect: false,
          includeInSidebar: true,
          credentialRef: null,
          transportEndpoint: null,
          executionLocation: server.displayName,
          workspaceBrowseRoots: server.workspaceBrowseRoots,
          revision: 0,
        },
      });
    },
  };
}

export function createBuiltinAgentsExtension(options: BuiltinAgentsExtensionOptions): TrustedExtensionDefinition {
  const platform = options.platform ?? "electron";
  const config = validate({});
  const hostProvider: HostConnectionProvider | null = options.platform === "web" ? null : Object.freeze({
    id: "opencraft.builtin-agents",
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
      id: "opencraft.builtin-agents",
      name: "Built-in Agents",
      description: "Connects the workbench to the OpenCraft-owned local AppServer host.",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: [platform],
      activationEvents: ["onStartupFinished"],
    },
    activate(api) {
      const service = new LocalAgentSettingsService(options.requestHost, "local");
      const controller = new ModelServicesController(service);
      const codexAccounts = options.platform === "web" && options.includeCodexAccounts === false
        ? null : new CodexAccountsService(options.requestHost, "local-codex");
      api.views.register({ id: "opencraft.builtin-agents.model-services-view", title: "模型服务", viewType: "opencraft.builtin-agents.model-services", platforms: [platform] });
      api.settings.registerPage({ id: "opencraft.builtin-agents.model-services", title: "Model services", titleMessage: { id: "settings.contributions.modelServices", defaultMessage: "Model services" }, viewId: "opencraft.builtin-agents.model-services-view", layout: "master-detail", targetHostId: service.hostId, modelConfiguration: true, modelReadiness: true, order: 0, icon: "brain", platforms: [platform] });
      api.internal.register("platformViewRenderer", { viewType: "opencraft.builtin-agents.model-services", Component: createDeferredView(async () => (await import("./model-services/view")).createModelServicesView(controller)) });
      if (codexAccounts !== null) {
        api.views.register({ id: "opencraft.builtin-agents.codex-accounts-view", title: "Codex 账户", viewType: "opencraft.builtin-agents.codex-accounts", platforms: [platform] });
        api.settings.registerPage({ id: "opencraft.builtin-agents.codex-accounts", title: "Codex accounts", titleMessage: { id: "settings.contributions.codexAccounts", defaultMessage: "Codex accounts" }, viewId: "opencraft.builtin-agents.codex-accounts-view", targetHostId: codexAccounts.hostId, modelConfiguration: true, order: 1, icon: "user-round-cog", platforms: [platform] });
        api.internal.register("platformViewRenderer", { viewType: "opencraft.builtin-agents.codex-accounts", Component: createDeferredView(async () => (await import("./codex-accounts/view")).createCodexAccountsView(codexAccounts)) });
      }
      api.subscriptions.add(() => { codexAccounts?.dispose(); controller.dispose(); service.dispose(); });
      if (hostProvider === null) return;
      api.internal.register("hostConnectionProvider", hostProvider);
      api.internal.register(HOST_PROFILE_CONTRIBUTION_CHANNEL, {
        profile: {
          hostId: "local",
          displayName: "OpenCraft",
          providerId: hostProvider.id,
          providerConfig: config,
          providerConfigVersion: 1,
          hostKind: "local",
          enabled: true,
          autoConnect: true,
          includeInSidebar: true,
          credentialRef: null,
          transportEndpoint: "OpenCraft Daemon",
          executionLocation: null,
          workspaceBrowseRoots: [],
          revision: 0,
        },
      });
      api.internal.register(HOST_PROFILE_CONTRIBUTION_CHANNEL, {
        profile: {
          hostId: "local-codex",
          displayName: "Server",
          providerId: hostProvider.id,
          providerConfig: config,
          providerConfigVersion: 1,
          hostKind: "local",
          enabled: true,
          autoConnect: true,
          includeInSidebar: true,
          credentialRef: null,
          transportEndpoint: "OpenCraft Daemon",
          executionLocation: null,
          workspaceBrowseRoots: [],
          revision: 0,
        },
      });
    },
  };
}
