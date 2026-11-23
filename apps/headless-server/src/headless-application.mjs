#!/usr/bin/env node
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import {openWorkspaceExecutionService} from './workspaces/execution-service.js';
import {openHeadlessAssetsStorage} from './headless-assets-storage.js';
import {humanGitRuntimeDirectory,createHumanGitExecution} from './human-git-execution.js';
import { openHumanAssets } from '@opencraft/plugin-local-account/assets-server';
import {workspaceTurnOutputContext} from './workspace-turn-output-context.mjs';
import { restoreWorkspaceQueuedContext } from '@opencraft/opencraft-daemon/workspace-queued-context';
import { HostWorkspaceCatalogTransport } from './host-workspace-catalog-transport.ts';
import { createCodexWorkspaceHooks, validateCodexWorkspaceHooks, hasCodexWorkspaceHooks, configuredWorkspaceExecution } from './codex-workspace-hooks.mjs';
import { ServerInformationStore, serverInformationHttp } from './server-information.mjs';
import { accountModelDefaultsHttp, humanActorAccess } from './account-model-defaults-http.ts';
import { configuredModelGatewayPath, modelGatewayHttp, CodexCoreControlClient } from "@opencraft/account-pool-host";
import { gatewayContributions } from "@opencraft/local-agent-host/model-config";
import { createAssistantModelSource } from '@opencraft/local-agent-host/model-config/assistant';
import { createWorkspaceBotProvider } from './workspaces/bot-client.js';
import { createPersonalAssistantHost } from '@opencraft/personal-assistant/host';
import { LocalAttachmentStagingService } from '@opencraft/local-agent-host/attachments/local-staging';
import { deploymentOperator } from "@opencraft/access-control/deployment-operator";
import { localExecutionCli } from "@opencraft/session-capabilities/execution-cli";
import { ServerSpacesRuntime } from '@opencraft/access-control/server-spaces';
import { ServerSpacesSession } from '@opencraft/access-control/server-spaces-session';
import { createProjectAutomations } from './project-automations.mjs';
import { executionCliSourceToken } from '@opencraft/session-capabilities/credentials';
import { waitForExecutionCliBinding } from '@opencraft/session-capabilities/execution-cli';
import { codexAdmissionPaused,createServerCodexBridge,readCodexBridgeConfiguration,createBridgeSessionMcp } from '@opencraft/opencraft-daemon/bridge-execution-admission';
import { CodexHostServices, codexAccountsService, codexModelsService, codexPinsService, codexTasksService } from '@opencraft/opencraft-daemon/codex-host-services';
import { CodexNativeReader } from '@opencraft/opencraft-daemon/codex-native-reader';
import { startCodexEngineHost } from '@opencraft/opencraft-daemon/codex-bridge-stack';
import { resolveCodexPermissions } from '@opencraft/opencraft-daemon/codex-bridge-host';
import { codexBridgeConversationTools, codexBridgeCreationTools } from '@opencraft/opencraft-daemon/codex-bridge-conversation-tools';
import { openServerCoreOwner } from "@opencraft/storage-node/server-owner";
import { ownerEntry } from '@opencraft/worker-owner';
import { ModelPolicyStore } from '@opencraft/model-usage-policy';
import { modelPolicyHttp } from '@opencraft/model-usage-policy/http';
import { ModelPolicyTransport } from '@opencraft/model-usage-policy/transport';
import { startAvailabilityNotification } from './availability-notification.mjs';
import { ExecutionEnvironmentTransport } from './execution-environment-transport.ts';
import { EnvironmentMetadataTransport } from './environment-metadata-transport.ts';
import { createHostEnvironmentLaunch } from './host-environment-launch.ts';
import { coreCodexEnvironmentLaunch, codexExecutionGit } from './codex-environment-launch.ts';
import { createEnvironmentAdmissionHandoff } from './environment-admission-handoff.ts';
import { composeHostTerminalSelector, createHandsTerminalService, HostTerminalSession, HostTerminalTransport, terminalResourceOwnerId } from './host-terminal-transport.js';
import { createHostFileSystem } from './host-filesystem.js';
import { composeHostFileSelector, HostFileSystemSession, HostFileSystemTransport } from './host-filesystem-transport.js';
import { HeadlessConnectors } from "@opencraft/connector-host/headless";
import { CapabilityBindingProjection } from "@opencraft/session-capabilities/binding-projection";
import { SessionCapabilities } from "@opencraft/session-capabilities";
import { SessionCapabilityMcp, capabilitySigningKey } from "@opencraft/session-capabilities/mcp";
import { fileKeyMaterial, fileSecretStore } from "@opencraft/secret-storage/file";
import { ConversationResourceLifecycle } from './conversation-resource-lifecycle.mjs';
import { ConversationResourceTransport } from './conversation-resource-transport.js';
import { RemoteBrowserService } from './remote-browser-service.mjs';
import { RemoteBrowserCapabilities } from './remote-browser/capabilities.ts';
import { createCapabilityContextResolver } from './capability-execution-context.ts';
import { createGitStatusCapability } from './git-status-capability.ts';
import { createBrowserGrantResolver } from './remote-browser/execution-grant.ts';
import { connectBrowserOwner } from './remote-browser-owner.mjs';

import { createObservabilityIngress } from "./observability-ingress.mjs";

import { access, chmod, mkdir, mkdtemp, stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import lockfile from "proper-lockfile";
import { createSshHttpIngress, loadSshIngressConfiguration } from "@opencraft/ssh-http-ingress/server";
import { createSshNativeRpcGateway } from "./ssh-native-rpc-gateway.mjs";
import { createSshCodexControl } from "./ssh-codex-control.mjs";

import { McpAppsService } from "@opencraft/mcp-apps/server";
import { McpAppsTransport } from "@opencraft/mcp-apps/transport";
import { AppHostServer } from "@opencraft/app-host-server";
import { AppServerIdentityOverlay } from "@opencraft/opencraft-daemon/appserver-identity-overlay";
import { TokenUsageQuerySession, TokenUsageQueryTransport } from "@opencraft/opencraft-daemon/token-usage-query-transport";
import { TokenUsageQueryService } from "@opencraft/opencraft-daemon/token-usage-query-service";
import { CodexEngineAdapter } from "@opencraft/opencraft-daemon/codex-engine-adapter";
import { defaultWorkspace } from "@opencraft/opencraft-daemon/workspace-host";
import { MachineIdentityTransport } from "@opencraft/opencraft-daemon/machine-transport";
import { ExecutionOwnershipTransport } from "@opencraft/opencraft-daemon/execution-ownership-transport";
import { ExecutionLeaseStore } from "@opencraft/opencraft-daemon/execution-lease-store";
import { ThreadIdentityDatabase } from "@opencraft/opencraft-daemon/thread-identity-database";
import { observeNativeExecutionProcess } from "@opencraft/opencraft-daemon/native-execution-origin";
import { createWebSocketExecutionTurnInspector } from "@opencraft/opencraft-daemon/native-execution-inspector";
import { AgentDriverTransport, AgentDriverSession } from "@opencraft/opencraft-daemon/agent-driver-transport";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { WebSocket } from 'ws';
import { readDaemonMachineIdentity } from "@opencraft/opencraft-daemon/machine-identity";
import { readSshCodexServerBindings, createSshCodexEngineAdapter } from "@opencraft/opencraft-daemon/ssh-codex-connections";
import { SshManagement } from "@opencraft/opencraft-daemon/ssh-management";
import { HostFileDownloads } from "@opencraft/opencraft-daemon/host-file-downloads";
import { startLocalAgentHost } from "@opencraft/local-agent-host";
import { startEngineHost } from "@opencraft/local-agent-host/engine-host";
import {ModelCapabilityTransport} from "@opencraft/local-agent-host/model-capability-transport";
import {ModelGatewaySettingsTransport} from "@opencraft/local-agent-host/model-gateway-settings-transport";
import {ImageModelTransport} from "@opencraft/local-agent-host/image-model-transport";
import {ImageGenerationConfiguration} from "@opencraft/local-agent-host/model-config/image-generation";
import { createPiModelConfiguration } from "@opencraft/local-agent-host/model-config/pi-adapter";
import { attachEngineHost } from './server-deployment/engine-host-client.mjs';
import { PiEngine } from "@opencraft/plugin-pi-engine";
import { createWorkbenchWebServer } from "./serve-workbench-web.mjs";
import { prepareProductPluginRelease } from './web-deployment/product-plugin-packs.mjs';
import { loadLocalMachineAccess } from './local-machine-access.mjs';
import { maintainHeadlessCodexHost } from "./headless-host-readiness.mjs";
import { readTaskCodexConversations } from "./tasks-conversation-catalog.mjs";
import { assertHeadlessWebRelease } from "./headless-web-release.mjs";
import { LocalDesktopService } from "@opencraft/local-agent-host/desktop";
import { createNativeObserver, localDesktopMachineIdentity } from "@opencraft/local-agent-host/desktop-native";
import { createNativeDesktopControl } from "@opencraft/local-agent-host/desktop/native-control";
import { ModelConfigurationRepository, ModelCredentialRepository } from "@opencraft/local-agent-host/model-config/repository";
import { SpeechModelConfiguration } from "@opencraft/local-agent-host/model-config/speech";
import { SpeechTranscriptionService } from "./speech-transcription-service.mjs";
import { MembershipStore, InstanceAccess } from '@opencraft/access-control';
import { ActorStore } from '@opencraft/access-control/actors';
import { ThreadAccessStore, ThreadAccessSession } from '@opencraft/access-control/thread-access';
import { ActorAccess } from '@opencraft/access-control/actor-access';
import { Collaboration, CollaborationError, CollaborationHttpApi } from '@opencraft/access-control/collaboration';
import { OrchestrationRuntimeWorker } from '@opencraft/access-control/orchestration-runtime-store';
import { communicationExtensionModule } from '@opencraft/access-control/communication-extension';
import { ThreadOrchestrationBroker } from '@opencraft/access-control/thread-orchestration-broker';
import { createThreadOrchestrationExecution, driverForThread } from './thread-orchestration-execution.mjs';
import { THREAD_ORCHESTRATION_TOOLS } from '@opencraft/appserver-protocol/collaboration';
import { createRoutedConversationExecution, conversationAccessServer, callConversationHost, readConversationCurrentTurn } from './conversation-execution.mjs';
import { openPushStore, TurnPushService, PushObservationTransport } from '@opencraft/web-push-node';
import { NativeExecutionAuthority } from './native-execution-authority.ts';
import { readImConfiguration, startImPlugins, createChannelSyncDependencies, channelSyncContext } from './im-plugins.mjs';
import { ImChannelsAppServer } from './im-channels-appserver.mjs';
import { CHANNELS_HOST_ID } from '@opencraft/appserver-protocol/channels';
import { HumanAccounts } from '@opencraft/access-control/human-accounts';
import { LocalAccountServerPlugin } from '@opencraft/plugin-local-account/server';
import { createNodePasswordHasher } from '@opencraft/plugin-local-account/password-hash-node';
import { LocalAccountApplication } from '@opencraft/plugin-local-account/application';
import { readPrivateJson } from '@opencraft/identity-core/node';
import { HumanAccountManagement } from '@opencraft/access-control/account-management';
import { HumanAuth, readHumanAuthConfiguration } from '@opencraft/access-control/human-auth';
import { IdentityWrites } from '@opencraft/access-control/identity-writes';
import { createCommitFenceBuffer } from '@opencraft/access-control/commit-fence';
import { humanLoginPage } from './human-login-page.ts';
import { connectRelay, loadRelayConnection } from '@opencraft/plugin-relay-connect/server';
import { validateHeadlessIdentity, validateEnvironmentDelivery } from "./headless-identity.mjs";
import { startHeadlessRuntimePlugins, validateRuntimePluginOptions } from "./runtime-plugins.mjs";
import { installHeadlessExtensions, loadHeadlessExtensions, validateHeadlessExtensions } from "./headless-extensions.mjs";
import { createHubController } from '@opencraft/hub-network/controller';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(port) !== String(value)) {
    throw new Error("--port must be an integer from 0 to 65535");
  }
  return port;
}

function parseHubTargetPort(value) {
  const port = parsePort(value);
  if (port === 0) throw new Error("Hub target requires a nonzero loopback port");
  return port;
}

export function parseHeadlessArguments(argv, env = process.env, getHomeDirectory = homedir) {
  let port = 10000;
  let host = "127.0.0.1";
  let hubTargetPort;
  let isolateBrowserStorage = false;
  let allowUnauthenticatedPublic = false;
  let localDesktop = false;
  let trustedInternalDesktop = false;
  let desktopControl = false;
  let dataDirectory = env.OPENCRAFT_SERVER_DATA_DIR;
  let machineName = env.OPENCRAFT_MACHINE_NAME;
  let engines = ["dsh"];
  let defaultEngine;
  let codexAgentBridgeFile;
  let codexBridgePrograms;
  let agentBridgeFile;
  let sshServersFile;
  let sshConfig;
  let sshPublicAccess = false;
  let sshAccessFile;
  let sshRequireAccessKey = false;
  let accessControl = false;
  const accessMemberProviders = [];
  let relayConnectFile;
  let humanAuthConfig;
  let localAccessFile = env.OPENCRAFT_LOCAL_ACCESS_FILE;
  const engineHostDescriptor = env.OPENCRAFT_ENGINE_HOST_DESCRIPTOR;
  let imConfigFile = env.OPENCRAFT_IM_CONFIG_FILE;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--port") {
      port = parsePort(argv[++index]);
    } else if (argument === "--hub-target-port") {
      hubTargetPort = parseHubTargetPort(argv[++index]);
    } else if (argument === "--host") {
      host = argv[++index];
      if (host !== "127.0.0.1" && host !== "0.0.0.0") throw new Error("--host must be 127.0.0.1 or 0.0.0.0");
    } else if (argument === "--allow-unauthenticated-public") {
      allowUnauthenticatedPublic = true;
    } else if (argument === "--local-desktop") {
      localDesktop = true;
    } else if (argument === "--trusted-internal-desktop") {
      trustedInternalDesktop = true;
    } else if (argument === "--desktop-control") {
      desktopControl = true;
    } else if (argument === "--engines") {
      engines = (argv[++index] ?? "").split(",");
      if (!engines.length || new Set(engines).size !== engines.length || engines.some(id => !["dsh", "pi", "dsh-acp", "acp", "claude-code"].includes(id))) throw new Error("Invalid execution engine selection");
    } else if(argument==='--codex-agent-bridge-config') {
      codexAgentBridgeFile=argv[++index];
      if(!codexAgentBridgeFile||!isAbsolute(codexAgentBridgeFile))throw new Error('--codex-agent-bridge-config requires an absolute private file');
    } else if(argument==='--codex-bridge-programs') {
      codexBridgePrograms=argv[++index];
      if(!codexBridgePrograms||!isAbsolute(codexBridgePrograms))throw new Error('--codex-bridge-programs requires an absolute directory');
    } else if(argument==='--agent-bridge-config') {
      agentBridgeFile=argv[++index];
      if(!agentBridgeFile||!isAbsolute(agentBridgeFile))throw new Error('--agent-bridge-config requires an absolute private file');
    } else if (argument === "--default-engine") {
      defaultEngine = argv[++index];
    } else if (argument === "--machine-name") {
      machineName = argv[++index];
      if (!machineName?.trim() || machineName.startsWith("--")) throw new Error("--machine-name requires a name");
    } else if (argument === "--data-dir") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--data-dir requires a path");
      dataDirectory = value;
    } else if (argument === '--isolate-browser-storage') {
      isolateBrowserStorage = true;
    } else if (argument === '--local-access-file') {
      localAccessFile = argv[++index];
      if (!localAccessFile?.startsWith('/')) throw new Error('--local-access-file requires an absolute private file');
    } else if (argument === '--access-control') {
      accessControl = true;
    } else if (argument === '--access-member-provider') {
      const provider = argv[++index];
      if (typeof provider !== 'string' || !/^[a-z][a-z0-9._-]{0,127}$/u.test(provider) || accessMemberProviders.includes(provider)) throw new Error('--access-member-provider requires a unique provider identifier');
      accessMemberProviders.push(provider); accessControl = true;
    } else if (argument === '--im-config') {
      imConfigFile = argv[++index];
      if (!imConfigFile?.startsWith('/')) throw new Error('--im-config requires an absolute private JSON path');
    } else if (argument === '--human-auth-config') {
      humanAuthConfig = argv[++index];
      if (!humanAuthConfig?.startsWith('/')) throw new Error('--human-auth-config requires an absolute private JSON path');
    } else if (argument === '--relay-connect-file') {
      relayConnectFile = argv[++index];
      if (!relayConnectFile?.startsWith('/')) throw new Error('--relay-connect-file requires an absolute private path');
    } else if (argument === "--ssh-config") {
      sshConfig = argv[++index];
      if (!sshConfig?.startsWith("/")) throw new Error("--ssh-config requires an absolute private configuration path");
    } else if (argument === "--ssh-servers") {
      sshServersFile = argv[++index];
      if (!sshServersFile || !sshServersFile.startsWith("/")) throw new Error("--ssh-servers requires an absolute private configuration path");
    } else if (argument === "--ssh-public-access") {
      sshPublicAccess = true;
    } else if (argument === "--ssh-require-access-key") {
      sshRequireAccessKey = true;
    } else if (argument === "--ssh-access-file") {
      sshAccessFile = argv[++index];
      if (!sshAccessFile?.startsWith("/")) throw new Error("--ssh-access-file requires a private absolute path");
    } else {
      throw new Error(`Unknown option ${argument}`);
    }
  }
  if (hubTargetPort === undefined && env.OPENCRAFT_HUB_TARGET_PORT !== undefined) hubTargetPort = parseHubTargetPort(env.OPENCRAFT_HUB_TARGET_PORT);
  if (!dataDirectory) {
    try { dataDirectory = join(getHomeDirectory(), ".opencraft-server"); }
    catch { throw new Error("--data-dir is required when this user has no home directory"); }
  }
  if (host === "0.0.0.0" && !allowUnauthenticatedPublic && !accessControl && !relayConnectFile) {
    throw new Error("--host 0.0.0.0 requires --allow-unauthenticated-public");
  }
  if (host !== "0.0.0.0" && allowUnauthenticatedPublic) {
    throw new Error("--allow-unauthenticated-public requires --host 0.0.0.0");
  }
  if (sshServersFile && host !== "127.0.0.1" && !sshPublicAccess) throw new Error("SSH Servers require a protected listener");
  if (localDesktop && trustedInternalDesktop) throw new Error("Choose either local or trusted-internal desktop access");
  // Authentication may come from persisted Hub enrollment; validate provider
  // availability after private configuration is loaded, before starting execution.
  if (desktopControl && !localDesktop && !trustedInternalDesktop) throw new Error("Desktop control requires an explicit desktop access policy");
  if (localDesktop && host !== "127.0.0.1") throw new Error("Local desktop requires a loopback-only listener");
  defaultEngine ??= engines[0];
  if (!engines.includes(defaultEngine)) throw new Error("Default engine must be enabled");
  return { help: false, host, port, ...(hubTargetPort === undefined ? {} : { hubTargetPort }), ...(engineHostDescriptor ? {engineHostDescriptor} : {}), ...(engines.length !== 1 || engines[0] !== "dsh" ? { engines, defaultEngine } : {}), dataDirectory: resolve(dataDirectory), allowUnauthenticatedPublic,
    ...(codexAgentBridgeFile ? {codexAgentBridgeFile} : {}),
    ...(codexBridgePrograms ? {codexBridgePrograms} : {}),
    ...(agentBridgeFile ? {agentBridgeFile} : {}),
    ...(machineName ? { machineName } : {}),
    ...(isolateBrowserStorage ? { isolateBrowserStorage } : {}),
    ...(sshConfig ? { sshConfig } : {}),
    ...(accessControl ? { accessControl } : {}), ...(relayConnectFile ? { relayConnectFile } : {}),
    ...(humanAuthConfig ? { humanAuthConfig } : {}),
    ...(localAccessFile ? { localAccessFile } : {}),
    ...(imConfigFile ? { imConfigFile } : {}),
    ...(accessMemberProviders.length ? { accessMemberProviders } : {}),
    ...(localDesktop || trustedInternalDesktop ? { localDesktop: true } : {}),
    ...(trustedInternalDesktop ? { desktopAccess: "trusted-internal" } : {}),
    ...(desktopControl ? { desktopControl: true } : {}),
    ...(sshServersFile ? { sshServersFile } : {}), ...(sshPublicAccess ? { sshPublicAccess: true } : {}), ...(sshAccessFile ? { sshAccessFile } : {}), ...(sshRequireAccessKey ? { sshRequireAccessKey: true } : {}) };
}

async function secureDataDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await stat(path);
  if (!info.isDirectory() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("OpenCraft server data directory must be private to its owner (mode 0700)");
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

export async function startHeadlessServer(options = {}, composition = {}) {
  if (options.fileSystemOwner && !['endpoint', 'tokenFile'].every(key =>
    typeof options.fileSystemOwner[key] === 'string' && isAbsolute(options.fileSystemOwner[key]) && resolve(options.fileSystemOwner[key]) !== '/'))
    throw new Error('File owner requires absolute private paths');
  if (options.terminalOwner && !['directory', 'endpoint', 'tokenFile'].every(key =>
    typeof options.terminalOwner[key] === 'string' && isAbsolute(options.terminalOwner[key]) && resolve(options.terminalOwner[key]) !== '/'))
    throw new Error('Terminal owner requires absolute private paths');
  if (options.threadCliDirectory !== undefined && (!isAbsolute(options.threadCliDirectory) || resolve(options.threadCliDirectory) === '/'))
    throw new Error('Thread CLI directory must be an absolute non-root execution path');
  // A composition (e.g. a workspace endpoint listener) or the environment names the remote browser owner.
  const browserOwnerSocket = options.browserOwnerSocket ?? process.env.OPENCRAFT_BROWSER_OWNER_SOCKET;
  if (browserOwnerSocket && !isAbsolute(browserOwnerSocket))
    throw new Error('OPENCRAFT_BROWSER_OWNER_SOCKET must be an absolute private socket path');
  if (options.codexRuntime !== undefined && (!options.codexCoreEndpoint || !isAbsolute(options.codexRuntime.endpoint ?? '')
    || !['string', 'function'].includes(typeof options.codexRuntime.token) || options.codexRuntime.nativeSocket !== undefined && !isAbsolute(options.codexRuntime.nativeSocket)))
    throw new Error('Codex runtime endpoints require absolute private sockets beside the account Core');
  let codexAgentBridge=options.codexAgentBridge??await readCodexBridgeConfiguration(options.codexAgentBridgeFile);
  // The server's own Codex Engine Host: every Codex Thread runs through the provider bridge,
  // new ones from creation, existing ones from their next turn (their IDs and history kept).
  // Its provider reaches native Codex through the Core it attaches to, so a workspace-owned
  // Codex runtime (reached through its own endpoint) cannot be combined with it.
  if(options.codexBridgePrograms!==undefined&&(codexAgentBridge||!options.codexCoreEndpoint||!isAbsolute(options.codexBridgePrograms)))
    throw new Error('A server Codex Engine Host requires an existing Core endpoint and no external bridge configuration');
  if(options.codexBridgePrograms!==undefined&&options.codexRuntime!==undefined)
    throw new Error('A server Codex Engine Host cannot attach to a workspace Codex runtime endpoint');
  let codexEngineHost;
  const agentBridge=options.agentBridge??(options.agentBridgeFile?await readPrivateJson(options.agentBridgeFile):undefined);
  if(agentBridge!==undefined&&(!agentBridge||typeof agentBridge!=='object'||Array.isArray(agentBridge)))throw new Error('Invalid private agent bridge configuration');
  if(codexAgentBridge&&!options.codexCoreEndpoint)throw new Error('Codex bridge requires an existing Core endpoint');
  const localAccess = await loadLocalMachineAccess(options.localAccessFile);
  if (composition.createIdentity !== undefined && typeof composition.createIdentity !== "function") throw new Error("Invalid Headless identity factory");
  if (composition.selectHostTerminalService !== undefined && typeof composition.selectHostTerminalService !== "function") throw new Error("Invalid Headless terminal selector");
  if (composition.selectHostFiles !== undefined && typeof composition.selectHostFiles !== "function") throw new Error("Invalid Headless workspace file selector");
  if(composition.workspaceOutputIdentity!==undefined&&typeof composition.workspaceOutputIdentity!=='function')throw Error('Invalid Headless workspace output identity selector');
  validateCodexWorkspaceHooks(composition);
  const workspaceExecution = configuredWorkspaceExecution(options);
  if (composition.close !== undefined && typeof composition.close !== "function") throw new Error("Invalid Headless disposer");
  if (composition.isHuman !== undefined && typeof composition.isHuman !== "function") throw new Error("Invalid Headless human qualification");
  const runtimePluginConfiguration = validateRuntimePluginOptions(composition.runtimePlugins);
  // Extension modules are imported and validated before startup creates any resource.
  const extensions = await loadHeadlessExtensions(validateHeadlessExtensions(composition.extensions));
  const root = resolve(options.root ?? packageRoot);
  const dataDirectory = resolve(options.dataDirectory ?? join(homedir(), ".opencraft-server"));
  const webRoot = resolve(options.webRoot ?? join(root, "web"));
  const userPluginDirectory = options.userPluginDirectory === null ? null
    : options.userPluginDirectory ?? process.env.OPENCRAFT_USER_PLUGIN_DIRECTORY ?? join(dataDirectory, 'user-plugins');
  if (userPluginDirectory !== null && (!isAbsolute(userPluginDirectory) || resolve(userPluginDirectory) === '/'))
    throw new Error('User plugin directory must be an absolute non-root path');
  const port = options.port ?? 10000;
  const host = options.host ?? "127.0.0.1";
  parsePort(port);
  const hubTargetPort = options.hubTargetPort === undefined ? undefined : parseHubTargetPort(options.hubTargetPort);
  if (host !== "127.0.0.1" && host !== "0.0.0.0") throw new Error("Invalid headless listener host");
  if (host === "0.0.0.0" && options.allowUnauthenticatedPublic !== true
    && !options.accessControl && !options.accessMemberProviders?.length && !options.relayConnectFile) {
    throw new Error("Public headless listener requires explicit unauthenticated-public acknowledgement");
  }
  const sshServers = options.sshServers ?? (options.sshServersFile ? await readSshCodexServerBindings(options.sshServersFile) : []);
  if (sshServers.length && host !== "127.0.0.1" && !options.sshPublicAccess) throw new Error("SSH Servers cannot be exposed through an unauthenticated public listener");
  const remoteServers = new Map(sshServers.map(binding => [binding.descriptor.serverId, binding]));
  if (remoteServers.size !== sshServers.length) throw new Error("Duplicate SSH Server identity");
  const desktopAccess = options.desktopAccess ?? "loopback";
  if (!["loopback", "trusted-internal"].includes(desktopAccess)) throw new Error("Invalid desktop access policy");
  if (options.desktopAccess !== undefined && options.localDesktop !== true) throw new Error("Desktop access requires local desktop");
  if (options.desktopControl && options.localDesktop !== true) throw new Error("Desktop control requires local desktop");
  if (options.localDesktop && desktopAccess === "loopback" && host !== "127.0.0.1") throw new Error("Local desktop requires a loopback-only listener");
  await access(join(webRoot, "index.html"));
  const webRelease = await assertHeadlessWebRelease(webRoot);
  await secureDataDirectory(dataDirectory);
  const releaseManifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}'; throw error;
  }));
  const productPluginAssets = await prepareProductPluginRelease({ releaseRoot: root, webRoot,
    cacheDirectory: process.env.OPENCRAFT_PRODUCT_PLUGIN_CACHE_DIRECTORY || join(dataDirectory, 'product-plugin-packs'),
    metadata: releaseManifest.productPlugins ?? null });
  const identityFence = createCommitFenceBuffer();
  // Installed before the storage owners: the Server core owner Worker (which runs
  // orchestration) receives the communication module, and every later owner reads
  // the installed extensions. Released only once both owners have closed.
  const releaseExtensions = installHeadlessExtensions(extensions);
  // One writer for opencraft-server.sqlite: orchestration, communication and
  // Server spaces run on the owner Worker's connection, FIFO with its domains.
  let serverStorage;
  try {
    serverStorage = await openServerCoreOwner(dataDirectory, { entry: ownerEntry(import.meta.url, 'server-core'),
      data: { identityFence, ...(communicationExtensionModule() ? { communicationExtensionModule: communicationExtensionModule() } : {}) } });
  } catch (error) { releaseExtensions(); throw error; }
  const orchestrationStorage = new OrchestrationRuntimeWorker(serverStorage);
  const releaseLock = async () => { await orchestrationStorage.close(); await serverStorage.close(); releaseExtensions(); };
  let agent;
  let dshAgent;
  let releasePiOwner;
  let web;
  let appHostServer;
  let sshManagement;
  let fileDownloads;
  let desktop;
  let identity;
  let agentIdentity;
  let executionDatabase, executionStore, executionRecovery;
  let resolveExecutionNative = async () => null;
  let mcpApps;
  let ingress;
  let instanceAccess;
  let modelPolicy;
  let membership;
  let assetsService;
  let assetsStorage;
  let installedBotProvider;
  let workspaceRouting;
  let ownedWorkspaceRouting;
  let humanGitExecution;
  let withdrawGitStatus;
  // The one opaque ENV vault-owner port: a downstream port or the core vault Worker.
  let environmentLaunch;
  // Non-secret ENV metadata (bindings, creators, catalog) on that vault owner.
  let environmentMetadata;
  // The live Actor/lease handoff ENV delivery seals against.
  let environmentHandoff;
  // The one personal Git execution owner (core assets Worker or identity port).
  let gitExecutionOwner;
  // Codex creation and Turn ENV delivery to the split Codex Core.
  let codexEnvironmentLaunch;
  let actorStore;
  const terminalServices = new Map();
  const fileSystem = options.fileSystemOwner ? createHostFileSystem(options.fileSystemOwner) : null;
  let actorCollaboration;
  let personalAssistantHost;
  let threadOrchestration;
  let projectAutomations;
  let actorCollaborationApi;
  let actorAccess;
  let serverSpaces;
  let threadAccess;
  let threadNotes;
  let identityWrites;
  let humanAccounts;
  let localAccountPlugin;
  let imPlugins, availabilityNotification;
  let connectorService;
  const capabilities = new SessionCapabilities();
  let capabilityMcp;
  let capabilityBindings;
  let capabilitiesReadyResolve;
  const capabilitiesReady = new Promise(resolve => { capabilitiesReadyResolve = resolve; });
  let humanAuth;
  let accountManagement;
  let accountApplication;
  let relay;
  let hubController;
  let sshNativeRpc;
  let codexReadiness;
  let usageQueries;
  let remoteBrowser;
  let conversationResources;
  let resourceReconciliationTimer;
  let browserCapabilities;
  const remoteExecutionAuthorities = new Map();
  let observability;
  let turnPush;
  let connectedExecutionCli;
  let runtimePlugins;
  let closing = null;
  const close = (update = null) => {
    if (closing !== null) return closing;
    // Publish the shared promise before invoking any disposer (including a
    // synchronous failure or reentrant close). Retire listeners before stores.
    closing = Promise.resolve().then(async () => {
      const results = [];
      const settle = async disposers => {
        results.push(...await Promise.allSettled(disposers.map(dispose => Promise.resolve().then(dispose))));
      };
      capabilitiesReadyResolve();
      clearInterval(resourceReconciliationTimer);
      await settle([() => conversationResources?.close()]);
      let entryClosing;
      const closeEntry = () => entryClosing ??= settle([
        () => hubController?.close(), () => relay?.close(), () => ingress?.close(), () => sshNativeRpc?.close(),
        () => codexReadiness?.close(), () => usageQueries?.close(), async () => { withdrawGitStatus?.(); await browserCapabilities?.close(); await remoteBrowser?.close(); },
        () => fileDownloads?.close(), () => desktop?.close(), () => turnPush?.close(),
        () => availabilityNotification?.close(), () => imPlugins?.close(),
      ]);
      await settle([() => web?.close(update, closeEntry)]);
      // Custom Web adapters need not implement the optional carrier phase.
      await closeEntry();
      // Plugins stop after the listener stopped accepting and before any owner
      // their authority or handlers may still call (admission, identity, stores).
      await settle([() => runtimePlugins?.close()]);
      await settle([() => observability?.close()]);
      await settle([() => projectAutomations?.close()]);
      await settle([() => threadOrchestration?.close()]);
      await settle([() => personalAssistantHost?.close()]);
      await settle([() => appHostServer?.close()]);
      await settle([() => codexEngineHost?.close()]);
      for (const service of terminalServices.values()) service.close();
      terminalServices.clear();
      fileSystem?.close();
      await settle([() => threadOrchestration?.close(), () => connectorService?.close(), () => actorCollaboration?.close(), () => threadAccess?.close(), () => serverSpaces?.close()]);
      await settle([() => orchestrationStorage.close()]);
      await settle([() => agent?.close(), async () => (await dshAgent?.catch(() => undefined))?.close(), () => connectedExecutionCli?.close(), () => capabilityMcp?.close()]);
      if (releasePiOwner) await settle([() => releasePiOwner()]);
      await settle([() => executionRecovery?.close(), () => agentIdentity?.close()]);
      // Each writer finishes before the root kernel lock is released. A failed
      // disposer is reported, but must not skip the remaining flushes.
      for (const dispose of [() => executionDatabase?.close(),
        () => modelPolicy?.close(), () => mcpApps?.close(), () => sshManagement?.close(), () => identity?.executionEnvironment?.close(), () => identity?.close?.(),

        () => ownedWorkspaceRouting?.close(), () => installedBotProvider?.close(), () => humanGitExecution?.close(), () => assetsService?.close(), () => assetsStorage?.close(), () => composition.close?.(), () => accountApplication?.close(), () => accountManagement?.close(), () => humanAuth?.close(), () => humanAccounts?.close(),
        () => identityWrites?.close(), () => capabilityBindings?.close(), () => actorStore?.close(), () => membership?.close()]) {
        await settle([dispose]);
      }
      const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      // A rejected flush is not a release receipt. The gateway exits nonzero;
      // only actual process death then releases the kernel writer lock.
      if (failures.length > 0) throw new AggregateError(failures, "OpenCraft server shutdown failed");
      await releaseLock();
    });
    return closing;
  };
  try {
    const ingressConfiguration = options.sshConfig ? await loadSshIngressConfiguration(options.sshConfig) : null;
    // Invalid configured credentials fail startup before any execution resource is created.
    const relayConfiguration = options.relayConnectFile ? await loadRelayConnection(options.relayConnectFile, composition.relayAssertionOptions) : null;
    const humanConfiguration = options.humanAuthConfig ? await readHumanAuthConfiguration(options.humanAuthConfig) : null;
    const imConfiguration = await readImConfiguration(options.imConfigFile);
    hubController = await createHubController(join(dataDirectory, 'hub-network-controller.json'), join(dataDirectory, 'hub-network.json'));
    if (options.accessControl || humanConfiguration?.setupTokenFile || options.accessMemberProviders?.length || relayConfiguration || hubController.node?.store.state.origin)
      membership = new MembershipStore(serverStorage);
    const machineIdentity = await readDaemonMachineIdentity(dataDirectory, options.machineName);
    const modelPolicyPath = join(dataDirectory, 'model-usage-policy.sqlite');
    modelPolicy = new ModelPolicyStore(modelPolicyPath);
    // Identity adapters can bind their own credentials to this stable Human authority.
    actorStore = new ActorStore(serverStorage);
    if (composition.createIdentity) {
      identity = await composition.createIdentity({ dataDirectory, membership, relayConfiguration, workspaceExecution,
        hubAuthority: hubController.node?.store.state.authority ?? null,
        resolveIdentity: request => instanceAccess?.authenticate(request) ?? null,
        getInstanceAccess: () => instanceAccess, machineIdentity, actors: actorStore, sshIngressEnabled: !!ingressConfiguration });
      validateHeadlessIdentity(identity);
      if (identity?.codexWorkspaceRouting !== undefined)
        validateCodexWorkspaceHooks(identity.codexWorkspaceRouting);
      for (const provider of identity?.capabilityProviders ?? []) capabilities.register(provider);
    }
    // One installation has one ENV owner; configuring two fails here.
    const coreEnvironmentLaunch = validateEnvironmentDelivery(options.environmentDelivery, identity);
    workspaceRouting = identity?.codexWorkspaceRouting;
    if (workspaceExecution && workspaceRouting && (typeof workspaceRouting.createCodexWorkspaceHooks !== 'function'
      || typeof workspaceRouting.readCatalog !== 'function'))
      throw new Error('Configured workspace authority has incomplete identity-owned routing');
    if (workspaceExecution && !workspaceRouting && hasCodexWorkspaceHooks(composition))
      throw Error('Default workspace routing cannot share custom Native hooks');
    if (workspaceExecution && !workspaceRouting && identity?.assistantEnvironmentConfigurationManaged)
      throw new Error('Managed workspace configuration requires its matching identity-owned routing');
    if (!workspaceExecution && identity?.codexWorkspaceRouting !== undefined)
      throw new Error('Identity workspace routing requires matched Core configuration');
    if (options.accessMemberProviders?.length && !identity?.providers.length && !relayConfiguration && !humanConfiguration && !hubController.node?.store.state.authority)
      throw new Error('Authenticated membership requires an identity provider');
    // This identity authority is persistent even without an external human identity provider.
    // Creating it does not enable instance admission or change legacy resource ownership.
    const externalProviders = [
      ...(identity?.providers ?? []), ...(relayConfiguration ? [relayConfiguration.provider] : []),
      ...(hubController.node ? [hubController.node] : []),
    ];
    const externalHuman = request => {
      const identities = externalProviders.map(provider => provider.authenticate(request)).filter(Boolean);
      const principal = identities.length === 1 ? identities[0] : null;
      return principal && (composition.isHuman?.(principal) ?? true) ? principal : null;
    };
    if (humanConfiguration) {
      humanAccounts = new HumanAccounts(serverStorage, actorStore);
      if (humanConfiguration.local) {
        const localAccounts = new LocalAccountServerPlugin(humanAccounts.localAccountRepository, createNodePasswordHasher());
        humanAccounts.registerLocalAccounts(localAccounts);
        localAccountPlugin = localAccounts;
      } else humanAccounts.disableLocalAccounts();
      humanAuth = new HumanAuth(humanAccounts, actorStore, humanConfiguration, humanLoginPage, externalHuman);
      if (humanConfiguration.local && membership) {
        let setupToken;
        if (humanConfiguration.setupTokenFile) {
          const input = await readPrivateJson(humanConfiguration.setupTokenFile);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
            || typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(input.token)) throw new Error('Invalid private setup token file');
          setupToken = input.token;
        }
        accountManagement = new HumanAccountManagement(serverStorage, humanAccounts, actorStore, membership);
        accountApplication = new LocalAccountApplication({ auth: humanAuth, management: accountManagement, setupToken });
      }
    }
    const providers = [...(humanAuth ? [humanAuth] : []), ...externalProviders];
    if (membership) instanceAccess = new InstanceAccess(membership, providers, actorStore, options.accessMemberProviders ?? [], identity?.admissionPolicy);
    // An identity product that owns configurations keeps its route and legacy partitions.
    // Never start a second resource writer alongside that composition.
    if (!identity?.assistantEnvironmentConfigurationManaged) {
      if (workspaceExecution && !workspaceRouting && !instanceAccess)
        throw Error('Workspace execution requires Human instance authority');
      assetsStorage = await openHeadlessAssetsStorage(dataDirectory, {...(workspaceExecution && !workspaceRouting ? {
        workspaceMachineId: machineIdentity.machineId,
        ...(options.terminalOwner ? {terminalOwner: options.terminalOwner} : {}),
      } : {}), ...(coreEnvironmentLaunch ? {environmentLaunch: true} : {})});
      if (!assetsStorage.botExecution) throw Error('Assets Bot execution owner unavailable');
      if (process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG) {
        try { await assetsStorage.store.adoptWorkspaceInstallation(process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG); }
        catch { console.warn('assistant_environment_configuration_unavailable'); }
      }
      installedBotProvider = createWorkspaceBotProvider({port:assetsStorage.store,
        onCleanupUnconfirmed:()=>console.warn('assistant_environment_reconciliation_required')});
      if (workspaceExecution && !workspaceRouting) {
        if (!assetsStorage.workspaceExecution) throw Error('Assets Native execution owner unavailable');
        ownedWorkspaceRouting = await openWorkspaceExecutionService({port:assetsStorage.store,
          actors:actorStore, access:instanceAccess, ...workspaceExecution,
          assertThreadActive:threadId=>{if(!conversationResources)throw Error('Workspace lifecycle is starting');conversationResources.assertActive('local-codex',threadId);},
          onCleanupUnconfirmed:()=>console.warn('workspace_cleanup_unconfirmed')});
        workspaceRouting = ownedWorkspaceRouting;
      }
    }
    // Live checks shared by every Actor/lease handoff: the Actor is current and
    // admitted, and the lease is active for the live native process.
    const authorizeExecutionHandoff=scope=>{
      const actorId=scope.account.slice('actor:'.length),actor=actorStore.get(actorId);
      return !closing&&actor?.enabled===true&&actor.kind==='human'&&actor.generation===scope.actorGeneration&&instanceAccess.admitsActor(actorId);
    };
    const inspectExecutionHandoff=async handoff=>{
      const native=await resolveExecutionNative?.(handoff.scope.threadId);
      if(closing||!executionRecovery||!native||native.incarnation!==handoff.native.incarnation)return false;
      const state=await executionRecovery.inspect({threadId:handoff.scope.threadId,inputId:handoff.scope.inputId,
        executionId:handoff.scope.executionId,generation:handoff.scope.leaseGeneration,turnId:handoff.native.turnId,
        engineIncarnation:handoff.native.incarnation,principal:null,ownership:'unknown',admittedAtMs:0,endedAtMs:null});
      return state==='active'&&!closing&&(await resolveExecutionNative(handoff.scope.threadId))?.incarnation===native.incarnation;
    };
    if (humanAuth && instanceAccess && !identity?.assistantEnvironmentConfigurationManaged) {
      assetsService = await openHumanAssets({ directory: dataDirectory, auth: humanAuth, actors: actorStore, access: instanceAccess,
        openStorage: async () => ({...assetsStorage, close:async()=>{}}) });
      if(!assetsService.gitAuthority)throw Error('Assets execution authority unavailable');
    }
    const identityLaunch = identity?.environmentLaunch;
    // One personal Git execution owner: core's assets vault Worker, or the
    // identity composition that owns the vault. Both hand off sealed grants only.
    if (identityLaunch?.git && assetsService) throw new Error('Personal Git execution cannot have two owners');
    if (identityLaunch?.git && !instanceAccess) throw new Error('Personal Git execution requires Human instance authority');
    gitExecutionOwner = assetsService ? Object.freeze({hosts:assetsService.gitHosts,authority:assetsService.gitAuthority,
      grant:locator=>assetsService.executionGitGrant(locator),reservation:locator=>assetsService.executionGitReservation(locator)})
      : identityLaunch?.git && Object.freeze({hosts:Object.freeze([...identityLaunch.git.hosts]),authority:identityLaunch.git.authority,
        grant:locator=>identityLaunch.git.grant(locator),reservation:locator=>identityLaunch.git.reservation(locator)});
    if (gitExecutionOwner) {
      humanGitExecution=createHumanGitExecution({directory:dataDirectory,
        runtimeDirectory:humanGitRuntimeDirectory(join(dataDirectory,'git-runtime'),'gateway'),workerFile:options.gitWorkerFile??fileURLToPath(new URL('./personal-git-worker.mjs',import.meta.url)),
        hosts:gitExecutionOwner.hosts,authority:gitExecutionOwner.authority,grant:gitExecutionOwner.grant,
        authorize:authorizeExecutionHandoff,inspect:inspectExecutionHandoff,
      });
      // The personal Git status tool exists only where the human Git owner does.
      withdrawGitStatus=capabilities.register(createGitStatusCapability(humanGitExecution));
    }
    environmentLaunch = identityLaunch ?? assetsStorage?.environmentLaunch;
    if (coreEnvironmentLaunch && !assetsStorage?.environmentLaunch) throw new Error('Environment delivery requires the sole vault owner');
    // A vault-owner port from the identity composition may bring its own
    // metadata port; core relays it exactly as for its own vault Worker.
    environmentMetadata = coreEnvironmentLaunch ? assetsStorage.environmentMetadata : identityLaunch?.metadata;
    if (coreEnvironmentLaunch && !environmentMetadata) throw new Error('Environment delivery requires the sole vault owner');
    // The same owner signs personal Git grants; Main never holds the vault key.
    if (coreEnvironmentLaunch && !assetsStorage.personalGitSeal) throw new Error('Environment delivery requires the sole vault owner');
    if (identityLaunch?.admission) {
      // Core's own vault Worker already owns the Actor/lease handoff.
      if (assetsService) throw new Error('Execution admission cannot have two owners');
      // The composition owns the durable read; core keeps the live checks.
      if (!instanceAccess) throw new Error('Environment delivery requires Human instance authority');
      environmentHandoff = createEnvironmentAdmissionHandoff({ admission: locator => identityLaunch.admission(locator),
        authorize: authorizeExecutionHandoff, inspect: inspectExecutionHandoff, closed: () => closing });
    } else if (environmentLaunch && humanGitExecution) environmentHandoff = locator => humanGitExecution.handoff(locator);
    // Codex: the split Codex Core receives creation and Turn ENV sealed for
    // core's durable records, and the adapter's Git owner hands off grants.
    codexEnvironmentLaunch = coreCodexEnvironmentLaunch(environmentLaunch, serverStorage,
      options.codexCoreEndpoint, `server:${machineIdentity.machineId}:codex`,
      actor => authorizeExecutionHandoff({account:`actor:${actor.actorId}`,actorGeneration:actor.actorGeneration}));
    // Missing delivery fails closed: a configured vault owner never lets Codex
    // run human Turns without its personal ENV or Git.
    if (environmentLaunch && options.codexCoreEndpoint && (!codexEnvironmentLaunch || !gitExecutionOwner))
      throw new Error('Codex environment delivery requires launch, creation admission and a personal Git owner');
    const authenticateHuman = request => {
      if (instanceAccess) return instanceAccess.authenticate(request);
      const identities = providers.map(provider => provider.authenticate(request)).filter(Boolean);
      if (identities.length === 1) return identities[0];
      const ids = identities.map(p => actorStore.findHuman(p)?.id);
      return ids[0] && ids.every(id => id === ids[0]) ? identities[0] : null;
    };
    actorAccess = new ActorAccess(actorStore, {
      authenticateHuman: request => {
        const principal = authenticateHuman(request);
        return principal && (['local', 'oidc'].includes(principal.provider)
          || (composition.isHuman?.(principal) ?? true)) ? principal : null;
      },
      isHumanCurrent: principal => ['local', 'oidc'].includes(principal.provider) ? humanAuth?.isCurrent(principal) === true : true,
      rejectHumanRequest: request => humanAuth?.invalidSession(request)
        || (humanAuth?.hasSessionCookie(request) && request.headers.authorization !== undefined),
      admitted: principal => !instanceAccess || instanceAccess.role(principal) !== null,
      administrator: principal => instanceAccess?.role(principal) === 'admin',
      trustedOrigin: request => instanceAccess?.trustedOrigin(request) ?? humanAuth?.trustedOrigin(request) ?? null,
    });
    // Login sessions, identity bindings and Actor administration commit in the
    // Server owner Worker; reads stay on this thread's permission projection.
    identityWrites = new IdentityWrites(serverStorage.call, actorStore, humanAccounts, identityFence, membership);
    actorAccess.useOwnerWrites(identityWrites);
    // Login-time password record upgrades commit in the owner Worker too.
    localAccountPlugin?.useOwnerWrites(identityWrites);
    humanAuth?.useOwnerWrites(identityWrites);
    instanceAccess?.useOwnerWrites(identityWrites);
    accountManagement?.useOwnerWrites(identityWrites);
    const engines = options.engines ?? ["dsh"];
    if (engines.some(engine => !['dsh','pi'].includes(engine)) && !options.engineHostDescriptor)
      throw new Error('ACP and Claude execution require an independent Engine Host descriptor');
    // Pi inside Main cannot host a receiver: delivered ENV must not reach this
    // process. With delivery, Pi runs only in the independent Engine Host.
    if (environmentLaunch && engines.includes('pi') && !options.engineHostDescriptor)
      throw new Error('Environment delivery requires the independent Pi engine host');
    let piEngine;
    let independentEngine;
    const conversationExecution = createRoutedConversationExecution(() => appHostServer, {machineId:machineIdentity.machineId,engines,modelCatalog:true,
      connectedAgentsOwner: engines.includes('dsh') ? 'dsh' : undefined,
      getInputs:async engine => {
        const inputs = engine !== 'dsh' ? (independentEngine?.inputs ?? (engine === 'pi' ? piEngine?.inputs : undefined)) : (await startDsh()).inputs;
        if (!inputs) return undefined;
        return {receipt: (...args) => inputs.receipt(...args), submit: async (threadId,inputId,text,canAdmit) => {
          if (!executionStore) throw new Error('Execution ownership unavailable');
          const native = await resolveExecutionNative(threadId);
          return inputs.submit(threadId,inputId,text,async () => {
            if (!await canAdmit()) return false;
            // This explicit Host input is an agent, schedule or goal, not the
            // person currently viewing the Thread.
            executionStore.capture(threadId,inputId,{principal:null,ownership:'unowned'},'accepted','system');
            executionStore.begin(threadId,inputId,native?.incarnation);
            return true;
          }).then(receipt => {
            if (receipt?.state === 'delivered' && receipt.turnId) executionStore.started(threadId,receipt.turnId,inputId,native?.incarnation);
            return receipt;
          });
        }};
      }});
    serverSpaces = new ServerSpacesRuntime({owner:serverStorage,bootstrapInstance:true});
    await serverSpaces.ready;
    threadAccess = new ThreadAccessStore(serverStorage, actorStore, { permissionOwner: serverStorage.database,
      spaces:{allows:(actorId,serverId,threadId)=>!serverSpaces.initialized||actorId&&actorStore.get(actorId)?.kind==='session'||serverSpaces.allows(actorId,serverId,threadId),subscribe:listener=>serverSpaces.subscribe(listener)} });
    // Configuration, never missing request credentials, selects the anonymous authority.
    const anonymousDeployment = !membership && !humanConfiguration && !composition.createIdentity
      && !relayConfiguration && !!hubController.node
      && !hubController.node.store.state.origin && !hubController.node.store.state.authority;
    const operator = deploymentOperator(actorStore, anonymousDeployment, () => !serverSpaces.initialized
      && !hubController.node.store.state.origin && !hubController.node.store.state.authority);
    const anonymousHandoff = () => !!operator.context();
    const signExecutionCli = session => executionCliSourceToken(capabilityKey, session);
    const anonymousDriver = (transport, hostId) => anonymousDeployment
      ? new AgentDriverTransport(transport, actorCollaboration,
        threadId => conversationExecution.serverForHost(hostId, threadId), signExecutionCli, operator.context)
      : transport;
    // Shared notes run in the Server owner Worker (Yjs merge and SQL off this thread).
    threadNotes = { exchange: (serverId, threadId, update, vector) => serverStorage.call.exchangeThreadNote(serverId, threadId, update, vector) };
    const accessServerForHost = (hostId, threadId) => conversationAccessServer(conversationExecution, machineIdentity.machineId, hostId, threadId);
    const createThreadPolicySession = (hostId, context, emit) => new ThreadAccessSession(threadAccess,
      (threadId, serverId, method) => {
        if (method === 'opencraft/token-usage/query' && serverId === undefined) return `server:${machineIdentity.machineId}:codex`;
        if (serverId?.startsWith('server:')) return serverId;
        const target = serverId === 'local-codex' || serverId === 'opencraft-server' ? serverId : hostId;
        return accessServerForHost(target, threadId);
      }, context.actorContext, emit, async threadId => {
        if (context.actorContext && identity?.isThreadCreator && await identity.isThreadCreator(hostId, threadId, context,
          (method, params) => callConversationHost(appHostServer,{hostId,threadId:''},'thread-creator',method,params)))
          threadAccess.created(accessServerForHost(hostId,threadId),threadId,context.actorContext);
      }, () => {
        context.resourceOwner?.assertCurrent();
        if (context.actorContext && (!actorStore.isCurrent(context.actorContext) || instanceAccess && !instanceAccess.admitsActor(context.actorContext.actorId)))
          throw new Error('Conversation access expired');
      }, threadNotes, false, () => ['local-codex','opencraft-server'].includes(hostId) && anonymousHandoff());
    const createThreadAccessSession=(hostId,context,emit)=>{
      // Anonymous installations retain their legacy path until an explicit human
      // administrator initializes collaboration membership.
      if(!context.actorContext)return createThreadPolicySession(hostId,context,emit);
      const session=new ServerSpacesSession(serverSpaces,context.actorContext,
        id=>conversationExecution.serverForHost(hostId,id),emit,createThreadPolicySession(hostId,context,emit),(serverId,threadId)=>threadAccess.allows(serverId,threadId,context.actorContext),()=>{
          context.resourceOwner?.assertCurrent();
          if(!actorStore.isCurrent(context.actorContext)||instanceAccess&&!instanceAccess.admitsActor(context.actorContext.actorId))throw new Error('Server access expired');
        },threadId=>callConversationHost(appHostServer,{hostId,threadId:''},'server-space-history','thread/read',{threadId,includeTurns:false}));
      return {
        async receive(frame){
          if(!serverSpaces.initialized&&instanceAccess?.admitsActor(context.actorContext.actorId)&&membership.actorMembership(context.actorContext.actorId)?.role==='admin')
            await serverSpaces.bootstrap(context.actorContext.actorId);
          return session.receive(frame);
        },rewrite:frame=>session.rewrite(frame),prepare:frame=>session.prepare(frame),project:frame=>session.project(frame),close:()=>session.close(),
      };
    };
    actorCollaboration = new Collaboration(serverStorage, actorStore,
      conversationExecution, Date.now, actorId => operator.owns(actorId) ? anonymousHandoff() : !instanceAccess || instanceAccess.admitsActor(actorId), orchestrationStorage,
      (context, ref) => threadAccess.allows(ref.serverId, ref.threadId, operator.owns(context.actorId) ? undefined : context), serverStorage.call, serverStorage.call.readConversationOwner);
    // Inbox team commands go to the Server space ledger, the only writer of team membership.
    actorCollaboration.attachSpaces({command:(context,command)=>serverSpaces.command(context,command)});

    threadOrchestration = new ThreadOrchestrationBroker(actorCollaboration, createThreadOrchestrationExecution(() => appHostServer, {
      enabled: ['codex', ...engines.filter(engine => engine !== 'dsh')], prepared: id => actorCollaboration.spawnPreparation(id),
    }), Date.now, orchestrationStorage);
    threadOrchestration.enableAssistantThreads(threadAccess);
    await threadOrchestration.initializeAssistantThreads();
    threadOrchestration.childScope = async (parent, child) => {
      if (serverSpaces.initialized) await serverSpaces.inherit(parent, child);
      threadAccess.acceptCreated(await orchestrationStorage.inheritChildCreator(parent, child));
    };
    threadOrchestration.legacySchedule=async threadId=>{const serverId=conversationExecution.serverForThread(threadId),hostId=conversationExecution.hostForServer(serverId);return (await callConversationHost(appHostServer,{hostId,threadId},'automation-schedule-inspect','opencraft/schedules/read',{threadId})).schedule;};
    // The server's own Engine Host starts later (after the capability listener); automations reach it when they run.
    projectAutomations=createProjectAutomations(orchestrationStorage,threadOrchestration,actorCollaboration,
      options.codexBridgePrograms!==undefined?{get url(){return codexAgentBridge?.url??'http://127.0.0.1:1/';},get token(){return codexAgentBridge?.token??'';}}:codexAgentBridge);
    actorCollaborationApi=new CollaborationHttpApi(actorCollaboration,actorAccess,projectAutomations);
    await projectAutomations.start();
    actorCollaboration.start();
    threadOrchestration.start();
    if (options.localDesktop === true) {
      const observer = createNativeObserver();
      const incarnation = await observer.inspect(AbortSignal.timeout(5_000));
      const control = options.desktopControl ? createNativeDesktopControl() : undefined;
      if (control && await control.inspect(AbortSignal.timeout(5_000)) !== incarnation) throw new Error("Desktop control incarnation mismatch");
      const environmentId = await localDesktopMachineIdentity();
      const principalId = `local-owner:${process.getuid()}`;
      const serverId = `local-codex:${createHash("sha256").update(JSON.stringify([dataDirectory, principalId])).digest("hex")}`;
      desktop = new LocalDesktopService({ serverId, environmentId, principalId, observer, control,
        transport: desktopAccess === "trusted-internal" ? "same-origin-trusted-internal" : "same-origin-loopback" });
    }
    connectorService = new HeadlessConnectors(join(dataDirectory, "connectors"), actorAccess,
      { "local-codex": `server:${machineIdentity.machineId}:codex`, "opencraft-server": `server:${machineIdentity.machineId}:${options.defaultEngine ?? (engines.includes("dsh") ? "dsh" : "pi")}` },
      capabilities, actorId => !instanceAccess || instanceAccess.admitsActor(actorId), undefined,
      (hostId, threadId) => {
        return conversationExecution.serverForHost(hostId, threadId);
      });
    remoteBrowser = new RemoteBrowserService({ root, dataDirectory,
      allowNoSandbox: process.env.OPENCRAFT_BROWSER_ALLOW_NO_SANDBOX === '1',
      ...(browserOwnerSocket ? { ownerConnector: () => connectBrowserOwner(browserOwnerSocket) }
        : ownedWorkspaceRouting ? {ownerConnector: async () => { throw Error('Local Hands browser owner unavailable'); }} : {}),
    });
    workspaceRouting?.connectBrowserRouting?.({ service: remoteBrowser,
      assertThreadAccess: ({ownerId, hostId, threadId}) => {
        const serverId = threadId === null ? null : conversationExecution.serverForHost(hostId, threadId);
        if (closing || !actorStore.get(ownerId)?.enabled || !instanceAccess?.admitsActor(ownerId)
          || (threadId !== null && !threadAccess.allowsActor(serverId, threadId, ownerId)))
          throw Error('Browser conversation authority revoked');
      },
    });
    const authorizeBrowserExecution = (context, serverId, threadId) => {
        if (closing || !actorStore.isCurrent(context) || actorStore.get(context.actorId)?.kind !== 'human'
          || instanceAccess && !instanceAccess.admitsActor(context.actorId) || !threadAccess.allows(serverId, threadId, context))
          throw new Error('Browser execution authority revoked');
    };
    browserCapabilities = new RemoteBrowserCapabilities(capabilities, remoteBrowser, createBrowserGrantResolver({
      serverForThread: (threadId, requested) => remoteExecutionAuthorities.has(requested) ? requested : conversationExecution.serverForThread(threadId),
      hostForServer: serverId => remoteExecutionAuthorities.get(serverId)?.hostId ?? conversationExecution.hostForServer(serverId),
      source: async (threadId, execution, serverId) => remoteExecutionAuthorities.has(serverId)
        ? remoteExecutionAuthorities.get(serverId).authority.source(threadId, execution)
        : actorCollaboration.executionContext(threadId, execution),
      authorize: authorizeBrowserExecution,
      owner: context => anonymousDeployment && operator.owns(context.actorId) ? 'local-anonymous' : context.actorId,
      currentTurn: async (hostId, threadId, context) => {
        return readConversationCurrentTurn(appHostServer, { hostId, threadId }, { sender: null, actorContext: context });
      },
    }));
    // Providers read the run's Host, verified human Actor and active lease from
    // these owners instead of parsing serverId or opening execution stores.
    capabilities.resolveContext(createCapabilityContextResolver({
      route: (serverId, threadId) => {
        const remote = remoteExecutionAuthorities.get(serverId);
        if (remote) return { hostId: remote.hostId, engine: 'codex' };
        const server = conversationExecution.servers.find(row => row.serverId === serverId);
        try { if (!server || conversationExecution.serverForHost(server.hostId, threadId) !== serverId) return undefined; } catch { return undefined; }
        return { hostId: server.hostId, engine: server.engine ?? 'codex' };
      },
      source: async (serverId, threadId, execution) => remoteExecutionAuthorities.has(serverId)
        ? remoteExecutionAuthorities.get(serverId).authority.source(threadId, execution)
        : actorCollaboration.executionContext(threadId, execution),
      current: (context, serverId, threadId) => { try { authorizeBrowserExecution(context, serverId, threadId); return true; } catch { return false; } },
      bindings: actorId => actorStore.bindings(actorId),
      lease: async locator => humanGitExecution ? humanGitExecution.handoff(locator) : null,
    }));
    // Bindings are read from memory; the Server owner Worker commits each write in order.
    capabilityBindings = new CapabilityBindingProjection(await serverStorage.call.capabilityBindings(),
      write => serverStorage.call.applyCapabilityBinding(write),
      error => console.error('[capability-bindings] unavailable', error.message));
    // Opaque ENV delivery needs the same live Actor/lease handoff as Git; a
    // configured vault owner without it fails here, not at every command.
    if (environmentLaunch && !environmentHandoff) throw new Error('Environment delivery requires execution admission');
    const capabilityKey=await capabilitySigningKey(fileKeyMaterial(dataDirectory));
    capabilityMcp = new SessionCapabilityMcp(capabilities, capabilityKey, capabilityBindings, {
      descriptorPath:join(dataDirectory,'session-capabilities.json'), retainEndpoint: true,
      cliDirectory:options.threadCliDirectory ?? join(dataDirectory,'thread-cli'),
      hostGit:async session=>{
        if(session.serverId!==conversationExecution.serverForHost('opencraft-server',session.threadId)
          ||conversationExecution.hostForServer(session.serverId)!=='opencraft-server'||(!session.execution?.inputId&&!session.execution?.turnId))
          throw Error('git_execution_unavailable');
        // Only explicit installation-level anonymous mode can run without a
        // personal authority. Missing login/observer/issuer is never fallback.
        if(!humanGitExecution){if(anonymousDeployment)return {mode:'anonymous'};throw Error('git_execution_unavailable');}
        const grant=await humanGitExecution.handoff({hostId:'opencraft-server',threadId:session.threadId,...(session.execution.inputId?{inputId:session.execution.inputId}:{turnId:session.execution.turnId})});
        return {authority:gitExecutionOwner.authority,hosts:gitExecutionOwner.hosts,grant};
      },
      ...(environmentLaunch ? {hostEnvironment:createHostEnvironmentLaunch({port:environmentLaunch,
        handoff:environmentHandoff,
        routes:session=>!closing&&session.serverId===conversationExecution.serverForHost('opencraft-server',session.threadId)
          &&conversationExecution.hostForServer(session.serverId)==='opencraft-server'})} : {}),
      authorizeExecution:async session=>{
        if(session.serverId!==conversationExecution.serverForThread(session.threadId))throw new CollaborationError(403,'execution_delegation_required');
        await actorCollaboration.admittedExecution(session.threadId,session.execution.inputId);
      },
      threadCli:async(session,request)=>{
        await waitForExecutionCliBinding(()=>actorCollaboration.admittedExecution(session.threadId,session.execution.inputId));
        return threadOrchestration.cli(session,request);
      },
      authorizeInput:(session,inputId)=>actorCollaboration.authorizeInput(session.threadId,inputId,'queue',undefined,session.serverId),
      orchestration: async (session, request) => {
        const fields = ['turnId','callId','name','arguments','inputId','incarnation','toolCallKey'];
        if (Object.keys(request).some(key => !fields.includes(key))
          || !['turnId','callId','name','incarnation'].every(key => typeof request[key] === 'string' && request[key].length > 0 && request[key].length <= 512)
          || !request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)
          || request.inputId !== undefined && (typeof request.inputId !== 'string' || request.inputId.length > 512)
          || session.serverId !== conversationExecution.serverForThread(session.threadId)) throw new CollaborationError(400, 'invalid_orchestration_source');
        if (request.inputId) actorCollaboration.executionStarted(session.threadId, request.inputId, request.turnId);
        const key = JSON.stringify([session.serverId, request.incarnation, session.threadId, request.turnId, request.callId]);
        const result = await threadOrchestration.invoke(session.threadId, request.turnId, key, request.name, request.arguments, undefined, request.incarnation);
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
      },
    });
    await capabilityMcp.listen();
    connectedExecutionCli = await localExecutionCli({directory:join(dataDirectory,"connected-execution-cli"),endpoint:capabilityMcp.cliEndpoint,key:capabilityKey});
    if(options.codexBridgePrograms!==undefined) {
      // After the capability listener: the Engine Host forwards its execution CLI (thread
      // spawn/tell/wait from a turn's shell) to this Server's /thread-cli, signed by its key.
      codexEngineHost=await startCodexEngineHost({programs:options.codexBridgePrograms,node:process.execPath,
        coreEndpoint:options.codexCoreEndpoint,coreToken:options.codexCoreAuthToken,
        runtimeDirectory:join(dataDirectory,'codex'),stateDirectory:join(dataDirectory,'codex-bridge'),
        cli:{directory:join(dataDirectory,'codex-bridge','cli'),signingKey:join(dataDirectory,'session-capabilities.key'),endpoint:capabilityMcp.cliEndpoint},
        serverId:`server:${machineIdentity.machineId}:codex`,
        log:line=>console.error(line)});
      codexAgentBridge=codexEngineHost.bridge;
    }
    const bridgeSessionMcp=createBridgeSessionMcp(capabilityMcp,
      threadId=>({serverId:conversationExecution.serverForThread(threadId),threadId}),
      session=>capabilities.refresh(session));
    const startAgent = options.startAgentHost ?? startLocalAgentHost;
    const startDsh = () => dshAgent ??= startAgent({
      executionCli: connectedExecutionCli,
      modelPolicyPath,
      nativePi: !engines.includes("pi"),
      sessionCapabilities: capabilities.scoped(`server:${machineIdentity.machineId}:dsh`),
      dshExecutable: options.dshExecutable ?? (process.env.OPENCRAFT_DSH_EXECUTABLE?.trim() || join(root, "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js")),
      dshCapabilityPlugin: options.dshCapabilityPlugin ?? join(root, "runtime/dsh/opencraft-capability-plugin.mjs"),
      runtimeDirectory: options.runtimeDirectory ?? join(root, "runtime"),
      dataDirectory: join(dataDirectory, "agent"),
      artifactDirectory: join(dataDirectory,"artifacts"),
      prepareArtifact: fileSystem ? (artifact,owner,signal)=>fileSystem.prepareArtifact(artifact,owner,signal) : undefined,
      modelStorageDirectory: join(dataDirectory, "models"),
      speechModelManagement: true,
      projectStorageDirectory: join(dataDirectory, "projects"),
      environmentDataDirectory: identity?.executionEnvironment ? dataDirectory : undefined,
      executionContext:identity?.executionEnvironment?'legacy':'assets',
      gitExecution:identity?.executionEnvironment?undefined:{directory:dataDirectory,machineId:machineIdentity.machineId,
        workerFile:options.gitWorkerFile??fileURLToPath(new URL('./personal-git-worker.mjs',import.meta.url)),
        ...(environmentLaunch?{environmentIssuer:environmentLaunch.issuer,
          admissionWorkerFile:join(dirname(options.gitWorkerFile??fileURLToPath(new URL('./personal-git-worker.mjs',import.meta.url))),'execution-admission-worker.mjs')}:{})},
      projectlessWorkspaceDirectory: join(dataDirectory, "workspaces"),
      skillsDirectory: join(dataDirectory, "skills"),
      taskSkillDirectories: [join(dataDirectory, "codex/runtime/skills")],
      taskServerId: "opencraft-server",
      taskConversationCatalog: (serverId, search, limit, cursor) => {
        if (serverId !== "local-codex" || !appHostServer) throw new Error("Task conversation server is unavailable");
        return readTaskCodexConversations(appHostServer, search, limit, cursor);
      },
      machineIdentity,
      ...(agentBridge?.['claude-code'] ? { bridge: { claudeCode: (() => {
        const row = agentBridge['claude-code'];
        if (!row || typeof row !== 'object' || Array.isArray(row)
          || !['url','token','serverId','inboxPath'].every(key => typeof row[key] === 'string')) throw new Error('Invalid Claude agent bridge configuration');
        return { id: 'claude-code', label: 'Claude', engine: 'claude-code',
          threadPrefix: row.threadPrefix ?? 'claude_bridge_', modelPrefix: row.modelPrefix ?? 'claude-code:',
          defaultCwd: row.defaultCwd ?? (options.runtimeDirectory ?? join(root, 'runtime')),
          ...(typeof row.defaultModel === 'string' ? { defaultModel: row.defaultModel } : {}),
          ...(Array.isArray(row.models) ? { models: row.models } : {}),
          ...(typeof row.generation === 'string' ? { generation: row.generation } : {}),
          gateway: { url: row.url, token: row.token, serverId: row.serverId, inboxPath: row.inboxPath } };
      })() } } : {}),
    }).catch(error => {dshAgent=undefined;throw error;});
    if (options.engineHostDescriptor) {
      independentEngine = await attachEngineHost(options.engineHostDescriptor, dataDirectory, machineIdentity.machineId,
        engines, options.defaultEngine ?? (engines.includes("dsh") ? "dsh" : "pi"));
      agent = independentEngine;
    } else if (engines.includes("pi")) {
      releasePiOwner = await lockfile.lock(join(dataDirectory, "pi-owner"), {realpath:false,retries:0});
      const piModels = await createPiModelConfiguration(new ModelConfigurationRepository(fileStateDocumentStore(join(dataDirectory, "models"))), new ModelCredentialRepository(fileSecretStore(join(dataDirectory, "models"))), fileStateDocumentStore(join(dataDirectory, "pi")));
      const piAttachments=new LocalAttachmentStagingService(join(dataDirectory,"agent","attachments"),join(dataDirectory,"artifacts"));
      const piPrepareInput=(threadId,input)=>piAttachments.prepareInput(input,threadId,fileSystem?(artifact,owner,signal)=>fileSystem.prepareArtifact(artifact,owner,signal):undefined);
      piEngine = new PiEngine({ executionCli: connectedExecutionCli, prepareAttachmentInput:piPrepareInput, modelPolicyPath, ...piModels, executionEnvironment: identity?.executionEnvironment,executionGit:humanGitExecution, sessionCapabilities: capabilities.scoped(`server:${machineIdentity.machineId}:pi`), dataDirectory, directory: join(dataDirectory, "pi"), attachmentDirectory: join(dataDirectory, "agent", "attachments"), cwd: options.runtimeDirectory ?? join(root, "runtime") });
      const closePi=piEngine.close.bind(piEngine);
      piEngine.close=async()=>{try {await closePi();} finally {await piAttachments.close();}};
      // The in-process standalone mode has the same trusted port. Shared-server
      // deployments attach the independent owner through its descriptor instead.
      piEngine.setOrchestration({ tools: THREAD_ORCHESTRATION_TOOLS, call: async (threadId, turnId, callId, name, args, _signal, inputId) => {
        if (inputId) actorCollaboration.executionStarted(threadId, inputId, turnId);
        const result = await threadOrchestration.invoke(threadId, turnId, JSON.stringify(['pi', piEngine.orchestrationIncarnation, threadId, turnId, callId]), name, args, undefined, piEngine.orchestrationIncarnation);
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
      } });
      agent = await startEngineHost({
        providers: [piEngine],
        defaultEngine: options.defaultEngine ?? (engines.includes("dsh") ? "dsh" : "pi"), machine: machineIdentity,
        resources: { artifactDirectory:join(dataDirectory,"artifacts"), projectDirectory: join(dataDirectory, "projects"), attachmentDirectory: join(dataDirectory, "agent", "attachments") },
        ...(engines.includes("dsh") ? { legacy: { id: "dsh", label: "DeepSeek Harness", start: startDsh } } : {}),
      });
    } else agent = await startDsh();
    const codexStorageOutcomes = new Map();
    const storageOpened = hostId => outcomes => codexStorageOutcomes.set(hostId, outcomes.map(({ name, outcome }) => ({
      hostId, name, status: outcome.status, appliedVersion: outcome.appliedVersion,
      ...(outcome.backupPath ? { backupPath: outcome.backupPath } : {}), movedAside: outcome.movedAsidePaths.length > 0,
    })));
    const createThreadMetadata = identity?.createThreadMetadata;
    if (createThreadMetadata) agentIdentity = new AppServerIdentityOverlay({
      directory: join(dataDirectory, "thread-identities", "opencraft-server"),
      resolveTarget: async () => agent.resolveWebsocketUrl ? await agent.resolveWebsocketUrl() : agent.websocketUrl,
      createMetadata: createThreadMetadata,
      resolveExecutionNative: threadId => resolveExecutionNative(threadId),
    });
    if (agentIdentity) executionStore = agentIdentity.executions;
    else {
      executionDatabase = new ThreadIdentityDatabase(join(dataDirectory,'thread-identities','opencraft-server'));
      executionStore = new ExecutionLeaseStore(executionDatabase.database);
    }
    executionStore.suspend();
    resolveExecutionNative = async threadId => {
      try {
        let pid;
        if (agent.getExecutionIdentity) pid = (await agent.getExecutionIdentity(threadId)).pid;
        else if (threadId.startsWith('pi_') && piEngine) pid = process.pid;
        else {
          const dsh = await startDsh();
          pid = dsh.getIdentity ? (await dsh.getIdentity()).enginePid : dsh.engineProcessId;
        }
        return pid ? await observeNativeExecutionProcess(pid) : null;
      } catch { return null; }
    };
    executionRecovery = await createWebSocketExecutionTurnInspector(async () => agent.resolveWebsocketUrl ? agent.resolveWebsocketUrl() : agent.websocketUrl);
    // A finite read-only reconciliation restores the original pre-send lease,
    // including tools born before Gateway loss; failure stays unknown.
    for (const threadId of executionStore.unsettledThreads().slice(0,256)) {
      try {
        const native = await resolveExecutionNative(threadId);
        const observation = agent.getExecutionIdentity ? await agent.getExecutionIdentity(threadId) : null;
        if (native && observation?.turn && observation.pid === native.pid) {
          const turn = observation.turn;
          executionStore.reconcile(threadId,[{id:turn.id,status:turn.status,items:turn.inputId ? [{type:'userMessage',clientId:turn.inputId}] : []}],native.incarnation);
        } else {
          const result = await executionRecovery.readThread(threadId);
          if (native && Array.isArray(result?.thread?.turns)) executionStore.reconcile(threadId,result.thread.turns,native.incarnation);
        }
      } catch { /* Authority cannot be inferred from a failed recovery read. */ }
    }
    mcpApps = new McpAppsService(join(dataDirectory, "mcp-apps.sqlite"));
    // Reuse the deployment's existing Codex ledger without starting a Codex
    // transport or opening/migrating its writer from the DSH/Pi entry.
    // Packages bundle the query worker beside this module; source runs use the TypeScript entry.
    const bundledQueryWorker = fileURLToPath(new URL('./token-usage-query-worker.mjs', import.meta.url));
    const tokenUsageQueryWorkerEntry = await access(bundledQueryWorker).then(() => bundledQueryWorker,
      () => fileURLToPath(new URL('../../opencraft-daemon/src/token-usage-query-worker.ts', import.meta.url)));
    usageQueries = new TokenUsageQueryService({
      entry: tokenUsageQueryWorkerEntry,
      databasePath: join(dataDirectory, 'codex', 'token-usage.sqlite'),
      serverId: `server:${machineIdentity.machineId}:codex`,
      ...(process.env.OPENCRAFT_TOKEN_USAGE_SOURCE === 'ledger' ? {} : {rollout:{nativeHome:join(dataDirectory,'codex','runtime')}}),
    });
    const unavailableTerminal = {probe:async()=>{throw Error('Local Hands terminal unavailable');},
      subscribe:()=>()=>{}, dispatch:async()=>{throw Error('Local Hands terminal unavailable');}, close() {}};
    const unavailableFiles = {request:async()=>{throw Error('Local Hands files unavailable');}};
    const terminalService = hostId => {
      if (!options.terminalOwner) return unavailableTerminal;
      let service = terminalServices.get(hostId);
      if (!service) {
        // A vault owner that admits terminal launches delivers ENV to the Hands
        // terminal owner as capsules; otherwise the synchronous path is unchanged.
        service = createHandsTerminalService({ ...options.terminalOwner, environment: identity?.executionEnvironment,
          ...(typeof environmentLaunch?.terminalActor === 'function' ? {environmentLaunch} : {}) });
        terminalServices.set(hostId, service);
      }
      return service;
    };
    conversationResources = await ConversationResourceLifecycle.open(serverStorage, {
      terminal: async row => {
        if (options.terminalOwner) {
          if (!remoteBrowser) throw Error('Resource bindings are starting');
          const aliases = (await remoteBrowser.threadAliases(row.hostId, row.threadId))
            .map(value => ({owner:terminalResourceOwnerId(value.actorId,row.hostId),resourceOwnerId:value.resourceOwnerId}));
          await terminalService(row.hostId).releaseThread(row.hostId, row.threadId, row.state === 'active', aliases);
        }
      },
      browser: async row => {
        if (!remoteBrowser) throw Error('Browser owner is starting');
        await remoteBrowser.releaseThread(row.hostId, row.threadId);
      },
      ...(ownedWorkspaceRouting ? {workspace:row=>ownedWorkspaceRouting.releaseConversation(row)} : {}),
    }, { diagnose: value => console.warn('[conversation-resources]', JSON.stringify(value)),
      ...(ownedWorkspaceRouting ? {dependencies:{workspace:['browser']},replayOwners:['browser','workspace']} : {}),
    });
    if (remoteBrowser) remoteBrowser.conversationLifecycle = conversationResources;
    const resourceAuthority = context => {
      context.resourceOwner?.assertCurrent();
      const actor = context.actorContext;
      if (!actor || !actorStore.isCurrent(actor) || actorStore.get(actor.actorId)?.kind !== 'human'
        || instanceAccess && !instanceAccess.admitsActor(actor.actorId)
        || context.executionPrincipal && (!Number.isFinite(context.validUntil) || context.validUntil <= Date.now()))
        throw new Error('Host resource authority expired');
    };
    const terminalScope = hostId => (context, params) => {
      resourceAuthority(context);
      const actor = context.actorContext;
      conversationResources.assertActive(hostId, params.threadId);
      const scope = identity?.executionEnvironment?.scope(context, hostId, params);
      for (const name of ['threadId', 'projectId']) if (params[name] != null && (typeof params[name] !== 'string' || !params[name] || params[name].length > 512)) throw new Error('Invalid terminal scope');
      return { account: scope?.account ?? `actor:${actor.actorId}`, actorId: actor.actorId, hostId,
        threadId: params.threadId ?? null, projectId: scope?.projectId ?? params.projectId ?? null };
    };
    // Trusted embedding may replace native startup without reconstructing or
    // dropping the Host's execution authority and domain tool composition.
    const createCodexTransport = configuration => options.createCodexTransport?.(configuration) ?? new CodexEngineAdapter(configuration);
    const createRemoteCodexTransport = (binding, hostId) => {
      const serverId = accessServerForHost(hostId, '');
      remoteExecutionAuthorities.get(serverId)?.authority.invalidate();
      const authority = new NativeExecutionAuthority((context, threadId) => authorizeBrowserExecution(context, serverId, threadId));
      remoteExecutionAuthorities.set(serverId, {hostId, authority});
      return createSshCodexEngineAdapter(binding, dataDirectory, createThreadMetadata, storageOpened(hostId), {
        executionAuthority: authority,
        nativeTool: (context, tool, args, signal) => remoteExecutionAuthorities.get(serverId)?.authority !== authority
          ? Promise.reject(new Error('Native execution authority replaced')) : browserCapabilities.invokeNative({
          serverId, threadId: context.threadId,
          execution: {turnId:context.turnId, callId:context.callId},
        }, tool, args, signal),
      }, createCodexTransport);
    };
    appHostServer = new AppHostServer({
      createRpcAccessSession: createThreadAccessSession,
      logicalClientRouting: true,
      physicalHostLifetime: "server",
      createTransport(hostId) {
        if (hostId === CHANNELS_HOST_ID) return new ImChannelsAppServer(() => actorCollaboration);
        const transport = new ModelPolicyTransport((() => {
        if (hostId === 'opencraft-server') return new TokenUsageQueryTransport(new MachineIdentityTransport(machineIdentity,'OpenCraft',async () => {
          const engine = new WebSocketTransport({
            url: agent.resolveWebsocketUrl ? await agent.resolveWebsocketUrl() : agent.websocketUrl,
            createSocket: url => new WebSocket(url),
          });
          const transport = agentIdentity?.wrapTransport(engine) ?? engine;
          return new AgentDriverTransport(new ExecutionOwnershipTransport(new ModelCapabilityTransport(new ImageModelTransport(transport, new ImageGenerationConfiguration(fileStateDocumentStore(join(dataDirectory,'models')), new ModelCredentialRepository(fileSecretStore(join(dataDirectory,'models'))))), {read:()=>new ModelConfigurationRepository(fileStateDocumentStore(join(dataDirectory,'models'))).read(),credential:async ref=>(await new ModelCredentialRepository(fileSecretStore(join(dataDirectory,'models'))).resolve(ref))??process.env[ref]}), executionStore, resolveExecutionNative), actorCollaboration,
            threadId => conversationExecution.serverForHost('opencraft-server', threadId), signExecutionCli, operator.context);
        }), usageQueries, actorId => actorStore.get(actorId));
        const remote = remoteServers.get(hostId);
        if (remote) return new MachineIdentityTransport(null, "Codex", () => createRemoteCodexTransport(remote, hostId));
        if (hostId.startsWith("ssh:")) {
          const binding = sshManagement.store.binding(hostId);
          return new MachineIdentityTransport(null, "Codex", () => createRemoteCodexTransport(binding, hostId));
        }
        if (hostId !== "local-codex") throw new Error(`Unknown server Host ${hostId}`);
        // Host-wide duties (tasks first) are answered by the services front before Thread routing.
        let codexAdapterStorage = [], codexFront, codexRouting;
        const codexReader = options.codexCoreEndpoint ? new CodexNativeReader(options.codexCoreEndpoint, options.codexCoreAuthToken) : undefined;
        // Host-owned dynamic tools (browser), for local and bridge Threads alike.
        const codexNativeTool = (context, tool, args, signal) => browserCapabilities.invokeNative({
          serverId: conversationExecution.serverForThread(context.threadId),
          threadId: context.threadId,
          execution: { turnId: context.turnId, callId: context.callId },
        }, tool, args, signal);
        const reportLocalCodexStorage = () => storageOpened(hostId)([...codexAdapterStorage, ...(codexFront?.storage() ?? [])]);
        return anonymousDriver(new McpAppsTransport(new MachineIdentityTransport(machineIdentity, "Codex", () => codexFront = new CodexHostServices(codexRouting = createServerCodexBridge(createCodexTransport({
          historyImageResources: process.env.OPENCRAFT_HISTORY_IMAGE_RESOURCES === "1",
          externalTasks: true,
          createSessionMcp: async () => {
            await capabilitiesReady;
            const reservation = capabilityMcp.prepareExecution();
            return { configuration: reservation.configuration,
              bindThread: threadId => reservation.bindThread({ serverId: actorCollaboration.execution.serverId, threadId }),
              bind: (threadId, inputId, executionId) => reservation.bind({ serverId: actorCollaboration.execution.serverId,
                threadId, execution: { inputId, executionId } }),
              cancel: () => reservation.cancel() };
          },
          restoreSessionMcp: async threadId => {
            await capabilitiesReady;
            const reservation = capabilityMcp.restoreExecution({ serverId: actorCollaboration.execution.serverId, threadId });
            return reservation && { configuration: reservation.configuration,
              bindThread: id => reservation.bindThread({ serverId: actorCollaboration.execution.serverId, threadId: id }),
              bind: (id, inputId, executionId) => reservation.bind({ serverId: actorCollaboration.execution.serverId,
                threadId: id, execution: { inputId, executionId } }), cancel: () => reservation.cancel() };
          },
          sessionMcp: async (threadId, inputId, executionId) => {
            await capabilitiesReady;
            const session = {serverId:actorCollaboration.execution.serverId, threadId, ...(inputId ? {execution:{inputId, ...(executionId ? {executionId} : {})}} : {})};
            await capabilities.refresh(session);
            return capabilityMcp.config(session);
          },
          createThreadMetadata,
          nativeTool: codexNativeTool,
          executionEnvironment: identity?.executionEnvironment,
          // Vault owner (core or identity): Codex Core opens the capsules; this
          // process relays them and writes creation reservations through the Server owner.
          ...(codexEnvironmentLaunch && gitExecutionOwner ? {environmentLaunch: codexEnvironmentLaunch} : {}),
          ...(gitExecutionOwner ? {createExecutionGit: codexExecutionGit(gitExecutionOwner, {
            directory: dataDirectory, runtimeDirectory: humanGitRuntimeDirectory(join(dataDirectory, 'codex-git-runtime'), 'codex'),
            workerFile: options.gitWorkerFile ?? fileURLToPath(new URL('./personal-git-worker.mjs', import.meta.url)),
            authorize: scope => {
              const actorId = scope.account.slice('actor:'.length), actor = actorStore.get(actorId);
              return !closing && actor?.enabled === true && actor.kind === 'human'
                && actor.generation === scope.actorGeneration && instanceAccess.admitsActor(actorId);
            },
          })} : {}),
          // Ingress has already authorized shared Thread participation. This
          // delegates native Turn input, not terminal access, ENV or payer identity.
          sharedTurnInput: true,
          modelActor: context => actorStore.isCurrent(context) ? actorStore.get(context.actorId) : null,
          tokenUsage: {
            queryWorkerEntry: tokenUsageQueryWorkerEntry,
            serverId: `server:${machineIdentity.machineId}:codex`,
            ...(process.env.OPENCRAFT_TOKEN_USAGE_SOURCE === 'ledger' ? {} : {derivedQueries:usageQueries}),
            actor: context => actorStore.isCurrent(context) ? actorStore.get(context.actorId) : null,
            person: actorId => actorStore.get(actorId),
            submission: (threadId,inputId) => actorCollaboration.usageSubmission(threadId,inputId),
          },
          collaboration: {
            workspaceTurnContext: (threadId,turnId) => workspaceTurnOutputContext({collaboration:actorCollaboration,actors:actorStore,threadId,turnId,selectIdentity:composition.workspaceOutputIdentity}),
            restoreWorkspaceSubmission: (thread, inputId, submission) => restoreWorkspaceQueuedContext(thread, inputId, submission, {
              actors: actorStore,
              executionContext: (id, execution) => actorCollaboration.executionContext(id, execution),
              authority: (id, input) => actorCollaboration.modelExecutionAuthority(id, input),
            }),
            modelExecutionAuthority: (thread,inputId) => actorCollaboration.modelExecutionAuthority(thread,inputId),
    topology: threadId => actorCollaboration.threadTopology(threadId),
            queuedContext: (thread,inputId,input) => actorCollaboration.queuedReferenceContext(thread,inputId,input),
            continued: (thread,previous,turn) => actorCollaboration.executionContinued(thread,previous,turn),
            continuing: (thread,previous,inputId) => actorCollaboration.executionContinuing(thread,previous,inputId),
            inputDelegation: (thread,inputId,expected) => actorCollaboration.inputDelegation(thread,inputId,expected),
            prepare: (context,input) => actorCollaboration.referenceContext(context,input),
            canCancel: (context, id) => actorCollaboration.canCancel(context, id),
            capabilities: actorCollaboration.capabilities,
            command: (context, body, submission) => actorCollaboration.command(context, body, submission),
            authorize: (context, threadId, inputId, input) => actorCollaboration.authorizeExecution(context, threadId, inputId, input),
            started: (threadId, inputId, turnId) => actorCollaboration.executionStarted(threadId, inputId, turnId),
            tool: (threadId, turnId, name, args) => actorCollaboration.tool(threadId, turnId, name, args),
            orchestration: { available: () => threadOrchestration.available, tool: (threadId,turnId,key,name,args,delegationId,callbackIncarnation) => threadOrchestration.invoke(threadId,turnId,key,name,args,delegationId,callbackIncarnation), observed: snapshot => threadOrchestration.observe(snapshot) },
          },
          collaborationInput: {
            available: () => actorCollaboration.available,
            mode: id => actorCollaboration.inputMode(id),
            authorize: (threadId, id, mode, expectedTurnId) => actorCollaboration.authorizeInput(threadId, id, mode, expectedTurnId),
          },
          onStorageOpened: outcomes => { codexAdapterStorage = outcomes; reportLocalCodexStorage(); },
          executable: options.codexExecutable ?? join(root, "runtime/codex/bin/codex"),
          runtimeDirectory: options.runtimeDirectory ?? join(root, "runtime"),
          dataDirectory: join(dataDirectory, "codex"),
          // The Gateway assembles exactly one WorkspaceHost: `default`, at today's `$DATA/codex` (no data migration).
          workspace: defaultWorkspace(join(dataDirectory, "codex")),
          artifactDirectory: join(dataDirectory, "artifacts"),
          readGeneratedFile: fileSystem ? (path, signal) => fileSystem.openFile(path, false, signal ?? new AbortController().signal) : undefined,
          prepareArtifact: fileSystem ? (artifact, owner, signal) => fileSystem.prepareArtifact(artifact, owner, signal) : undefined,
          modelPolicyPath,
          filterGatewayModelCatalog: serverStorage.call.filterGatewayModelCatalog,
          coreEndpoint: options.codexCoreEndpoint,
          coreAuthToken: options.codexCoreAuthToken,
          ...(options.codexRuntime ? { coreRuntime: options.codexRuntime } : {}),
          coreHostOverlays: options.codexCoreEndpoint !== undefined,
          observationComponent: 'gateway',
          ...createCodexWorkspaceHooks(workspaceRouting ?? composition, hostId),
          nativeCodexHomeDirectory: join(dataDirectory, "native-codex"),
          desktop,
        }), codexAgentBridge, {
          admit:async (threadId,inputId,input,context)=>{
            if(context.collaborationRequestId) {
              if(inputId!=='actor-input:'+context.collaborationRequestId)throw Error('Invalid admitted input');
            } else {
              // An anonymous deployment's input carries no actor of its own: the agent driver admits it
              // as the deployment operator, which this admission then authorizes as it would a login.
              const actor=context.actorContext??operator.context();
              if(!actor)throw Error('Execution admission required');
              actorCollaboration.authorizeExecution(actor,threadId,inputId,input);
            }
            await actorCollaboration.admittedExecution(threadId,inputId);
            return {serverId:conversationExecution.serverForThread(threadId),threadId,
              execution:{inputId,executionId:createHash('sha256').update(JSON.stringify([threadId,inputId])).digest('hex')}};
          },
          sign:session=>executionCliSourceToken(capabilityKey,session),
          ...bridgeSessionMcp,
          started:(threadId,inputId,turnId)=>actorCollaboration.executionStarted(threadId,inputId,turnId),
        },{admissionPaused:()=>codexAdmissionPaused(join(dataDirectory,"codex")),
          // Bridge Threads get the conversation tools the local Host gives its own, then the browser tools.
          nativeTool:codexBridgeConversationTools(actorCollaboration,codexNativeTool),creationTools:codexBridgeCreationTools,
          ...(codexEngineHost&&codexReader?{adoptExisting:true,newThreads:true,
            resolvePermissions:(selection,cwd)=>resolveCodexPermissions(codexReader,selection,cwd),
            projectlessWorkspace:async()=>{
              const projectless=process.env.OPENCRAFT_CODEX_PROJECTLESS_DIR||join(dataDirectory,'codex','projectless-workspaces');
              await mkdir(projectless,{recursive:true,mode:0o700});
              return mkdtemp(join(projectless,'thread-'));
            }}:{})}), clients => [codexTasksService(join(dataDirectory, "codex", "tasks.sqlite"), clients, reportLocalCodexStorage),
          ...(options.codexCoreEndpoint ? [codexAccountsService(new CodexCoreControlClient(options.codexCoreEndpoint, options.codexCoreAuthToken))] : []),
          ...(codexReader ? [codexModelsService(codexReader, context => context.actorContext && actorStore.isCurrent(context.actorContext) ? actorStore.get(context.actorContext.actorId)?.id ?? null : null),
            codexPinsService(codexReader, clients, { toNative: id => codexRouting?.threadIdentities?.()?.toNative(id), toPublic: id => codexRouting?.threadIdentities?.()?.toPublic(id) }),
            { handles: () => false, request: () => null, close: () => codexReader.close() }] : [])])), mcpApps), hostId);
        })(), modelPolicyPath, hostId === 'opencraft-server' ? 'dsh' : 'codex', serverStorage.call.projectModelCatalog);
        let scopedTransport = !['local-codex', 'opencraft-server'].includes(hostId) ? transport
          : identity?.executionEnvironment ? new ExecutionEnvironmentTransport(transport, identity.executionEnvironment, hostId)
            : environmentMetadata ? new EnvironmentMetadataTransport(transport, environmentMetadata, hostId) : transport;
        if (hostId === 'local-codex' && workspaceRouting)
          scopedTransport = new HostWorkspaceCatalogTransport(scopedTransport,
            context => workspaceRouting.readCatalog(hostId, context),
            typeof workspaceRouting.readFileScope === "function"
              ? (context,threadId) => workspaceRouting.readFileScope(hostId,context,threadId) : undefined);
        const gatewayPath=configuredModelGatewayPath();
        if(gatewayPath && ['local-codex','opencraft-server'].includes(hostId)) scopedTransport=new ModelGatewaySettingsTransport(scopedTransport,gatewayPath,join(dataDirectory,'models'),context=>{
          const actor=context.actorContext;
          if(!actor || !actorStore.isCurrent(actor) || actorStore.get(actor.actorId)?.kind!=='human' || instanceAccess && !instanceAccess.admitsActor(actor.actorId))return null;
          const role=context.tokenUsageAuthority?.();
          return {actor:actor.actorId,administrator:role?.actorId===actor.actorId && role.administrator===true};
        });
        if (['local-codex', 'opencraft-server'].includes(hostId)) {
          const ordinary = hostId === 'local-codex' ? ownedWorkspaceRouting : undefined;
          if (options.terminalOwner || ordinary)
            scopedTransport = new HostTerminalTransport(scopedTransport, terminalService(hostId), terminalScope(hostId),
              composeHostTerminalSelector(hostId, terminalService(hostId), ordinary
                ? (scope,context,local)=>ordinary.selectHostTerminalService(hostId,scope,context,
                  composition.selectHostTerminalService ? (s,c)=>composition.selectHostTerminalService(hostId,s,c,local) : local)
                : composition.selectHostTerminalService ? (scope,context,local)=>composition.selectHostTerminalService(hostId,scope,context,local) : undefined));
          if (fileSystem || ordinary) {
            const localFiles = fileSystem ?? unavailableFiles;
            scopedTransport = new HostFileSystemTransport(scopedTransport, localFiles, resourceAuthority,
              composeHostFileSelector(localFiles, resourceAuthority, ordinary
                ? (context,params,local)=>ordinary.selectHostFiles(hostId,context,params,
                  composition.selectHostFiles ? (c,p)=>composition.selectHostFiles(hostId,c,p,local) : local)
                : composition.selectHostFiles ? (context,params,local)=>composition.selectHostFiles(hostId,context,params,local) : undefined));
          }
        }
        if (['local-codex', 'opencraft-server'].includes(hostId))
          scopedTransport = new ConversationResourceTransport(scopedTransport, hostId, conversationResources);
        return ['local-codex', 'opencraft-server'].includes(hostId) ? new PushObservationTransport(scopedTransport, value => {
          if (!turnPush || actorStore.get(value.actorId)?.kind !== 'human') return;
          void Promise.resolve(turnPush.store.watch(value.actorId, conversationExecution.serverForHost(hostId, value.threadId), hostId, value.threadId, value.inputId)).catch(() => {});
        }) : scopedTransport;
      },
    });
    const serverInformation = new ServerInformationStore(fileStateDocumentStore(dataDirectory));
    const serverInformationService = serverInformationHttp(serverInformation, request => {
      const context = actorAccess.authenticate(request);
      if (!context || context.credentialId !== null || actorStore.get(context.actorId)?.kind !== 'human'
        || instanceAccess && !instanceAccess.admitsActor(context.actorId)) return null;
      const principal = instanceAccess?.authenticate(request);
      return { actorId: context.actorId, administrator: !!principal && actorStore.findHuman(principal)?.id === context.actorId && instanceAccess.role(principal) === 'admin',
        origin: actorAccess.options.trustedOrigin?.(request) ?? null };
    });
    const accountModelDefaultsService = accountModelDefaultsHttp(serverStorage.call, humanActorAccess({
      authenticate: request => actorAccess.authenticate(request),
      refused: request => actorAccess.legacyAdmissionStatus(request) === 403,
      isCurrentHuman: context => actorStore.isCurrent(context) && actorStore.get(context.actorId)?.kind === 'human',
      admits: instanceAccess ? actorId => instanceAccess.admitsActor(actorId) : null,
      trustedOrigin: request => actorAccess.options.trustedOrigin?.(request) ?? null,
    }));
    turnPush = new TurnPushService(await openPushStore(join(dataDirectory, 'web-push.sqlite')), {
      hosts: ['local-codex', 'opencraft-server'],
      publicBaseUrl: async () => (await serverInformation.read()).publicUrl,
      defaultTarget: identity?.notificationDefaultTarget,
      imTargets: async binding => imPlugins?.notificationTargets(binding.context.actorId) ?? [],
      sendIm: async (binding,target,message) => {
        if(!imPlugins)throw Error('notification_unavailable');
        const send=imPlugins.prepareDirectNotification(target.channelId,target.senderId,binding.context.actorId);
        await send([message.title,message.body,message.url].join('\n'),message.id);
      },
      authenticate: request => {
        const context = actorAccess.authenticate(request);
        return context && actorStore.get(context.actorId)?.kind === 'human'
          ? { context, loginDigest: humanAuth?.notificationLoginDigest(request) } : null;
      },
      current: binding => actorStore.isCurrent(binding.context) && actorStore.get(binding.context.actorId)?.kind === 'human'
        && (!instanceAccess || instanceAccess.admitsActor(binding.context.actorId))
        && (!binding.loginDigest || !!humanAccounts?.byDigest(binding.loginDigest)),
      trustedOrigin: request => actorAccess.options.trustedOrigin?.(request) ?? null,
      canRead: (actorId, hostId, threadId) => threadAccess.allowsActor(conversationExecution.serverForHost(hostId, threadId), threadId, actorId),
      read: (hostId, method, params) => callConversationHost(appHostServer, {hostId, threadId:params.threadId}, 'push-history', method, params, undefined, 10_000),
    });
    await turnPush.initialize();
    // Local anonymous features remain usable. Public remote access is enabled
    // only with explicit operator opt-in; all remote sockets require a session.
    if (host === "127.0.0.1" || options.sshPublicAccess) sshManagement = await SshManagement.open({
      directory: join(dataDirectory, "ssh"), publicAccess: options.sshPublicAccess, accessFile: options.sshAccessFile,
      accessMode: options.sshRequireAccessKey || options.sshAccessFile ? "access-key" : "shared",
      resetConnection: id => appHostServer.resetHost(id), connectionState: id => appHostServer.hostState(id),
      connectConnection: (id, assertAdmission) => appHostServer.ensureHostConnected(id, assertAdmission),
      legacyServers: sshServers.map(binding => binding.descriptor),
    });
    try {
      observability = await createObservabilityIngress(process.env.OPENCRAFT_OBSERVE_INGRESS_CONFIG, { access: instanceAccess, actors: actorStore, executionHealth: options.getExecutionHealth });
    } catch {
      process.stderr.write('Observability configuration unavailable; workbench continues without observation ingress.\n');
    }
    fileDownloads = new HostFileDownloads(hostId => {
      if (hostId === "local-codex" && ownedWorkspaceRouting && !fileSystem) throw Error('Local Hands file downloads unavailable');
      if (hostId === "opencraft-server" || hostId === "local-codex") return fileSystem ?? "local";
      const binding = remoteServers.get(hostId) ?? (hostId.startsWith("ssh:") ? sshManagement?.store.binding(hostId) : null);
      if (!binding) throw new Error("Unknown file Host");
      return binding.connection;
    });
    // Explicit opt-in only: loaded once instance authentication and admission exist,
    // before the listener opens so declared routes are mounted from the first request.
    if (runtimePluginConfiguration) runtimePlugins = await startHeadlessRuntimePlugins(runtimePluginConfiguration,
      { dataDirectory, instanceAccess, authService: humanAuth });
    const createWeb = options.createWebServer ?? createWorkbenchWebServer;
    web = await createWeb({
      root: webRoot,
      userPluginDirectory,
      productPluginAssets,
      instanceId: options.isolateBrowserStorage ? machineIdentity.machineId : null,
      assetVersion: options.isolateBrowserStorage ? webRelease.buildId : null,
      observability,
      getExecutionHealth: options.getExecutionHealth,
      getHostReadiness: () => codexReadiness ? { "local-codex": codexReadiness.snapshot() } : {},
      createAppServerAccessSession: (context, emit) => createThreadAccessSession("opencraft-server", context, emit),
      createAppServerDriverSession: emit => new AgentDriverSession(actorCollaboration,
        threadId => conversationExecution.serverForHost('opencraft-server', threadId), emit,
        signExecutionCli, operator.context),
      createAppServerQuerySession: emit => new TokenUsageQuerySession(usageQueries, emit, actorId => actorStore.get(actorId)),
      createTerminalSession: options.terminalOwner || fileSystem ? emit => {
        const sessions = [
          ...(options.terminalOwner ? [new HostTerminalSession(terminalService('opencraft-server'), terminalScope('opencraft-server'),
            composeHostTerminalSelector('opencraft-server', terminalService('opencraft-server'),
              composition.selectHostTerminalService ? (scope, context, local) => composition.selectHostTerminalService('opencraft-server', scope, context, local) : undefined))] : []),
          ...(fileSystem ? [new HostFileSystemSession(fileSystem, resourceAuthority,
            composeHostFileSelector(fileSystem, resourceAuthority,
              composition.selectHostFiles ? (context, params, local) => composition.selectHostFiles('opencraft-server', context, params, local) : undefined))] : []),
        ];
        for (const session of sessions) session.subscribeMessage(emit);
        return {
          connect: () => Promise.all(sessions.map(session => session.connect())),
          close: () => { for (const session of sessions) session.close(); },
          project: frame => sessions.reduce((value, session) => value === null ? null : session.project(value), frame),
          receive: async (frame, context) => { for (const session of sessions) if (await session.receive(frame, context)) return true; return false; },
        };
      } : null,
      appServerTarget: agent.websocketUrl,
      resolveAppServerTarget: agent.resolveWebsocketUrl,
      appServerIdentity: agentIdentity ?? null,
      mcpAppsService: mcpApps,
      getImService: () => imPlugins,
      connectorService,
      loopbackOnly: host === "127.0.0.1",
      localAccess,
      appHostServer,
      sshServerDescriptors: sshServers.map(binding => binding.descriptor),
      sshManagement,
      fileDownloads,
      getPluginHealth: () => ({...(imPlugins ? {'opencraft.im':imPlugins.states()} : {}),...(turnPush ? {'opencraft.push':turnPush.health} : {}),
        ...(runtimePlugins ? {'opencraft.runtime-plugins':runtimePlugins.health()} : {})}),
      getStorageOutcomes: () => [
        { name: 'server-core', status: serverStorage.outcome.status, appliedVersion: serverStorage.outcome.appliedVersion,
          movedAside: false, productVersion: serverStorage.contract.productVersion, contractHash: serverStorage.contract.hash },
        ...(imPlugins ? [{name:'im-switchboard',status:imPlugins.outcome.status,appliedVersion:imPlugins.outcome.appliedVersion,movedAside:imPlugins.outcome.movedAsidePaths.length>0}] : []),
        ...(imPlugins ? [{name:'im-posts',status:imPlugins.postOutcome.status,appliedVersion:imPlugins.postOutcome.appliedVersion,movedAside:imPlugins.postOutcome.movedAsidePaths.length>0}] : []),
        ...(agent.storageOutcomes ?? []),
        ...(remoteBrowser?.storageOutcomes() ?? []),
        ...(connectorService?.outcomes() ?? []),
        ...(turnPush ? [{name:'web-push',status:turnPush.store.outcome.status,appliedVersion:turnPush.store.outcome.appliedVersion,movedAside:turnPush.store.outcome.movedAsidePaths.length>0}] : []),
        {name:"mcp-apps",status:mcpApps.outcome.status,appliedVersion:mcpApps.outcome.appliedVersion,movedAside:mcpApps.outcome.movedAsidePaths.length>0},
        ...(agentIdentity ? [{ name: "thread-identity", hostId: "opencraft-server", status: agentIdentity.store.outcome.status,
          appliedVersion: agentIdentity.store.outcome.appliedVersion, backupPath: agentIdentity.store.outcome.backupPath,
          movedAside: agentIdentity.store.outcome.movedAsidePaths.length > 0 }] : []),
        ...(identity?.getStorageOutcomes?.() ?? []), ...[...codexStorageOutcomes.values()].flat(),
        ...(sshManagement ? [{ name: "ssh-connections", status: sshManagement.store.outcome.status,
          appliedVersion: sshManagement.store.outcome.appliedVersion, backupPath: sshManagement.store.outcome.backupPath,
          movedAside: sshManagement.store.outcome.movedAsidePaths.length > 0 }] : []),
      ],
      desktopService: desktop ?? null,
      desktopAccess,
      modelPolicyService: (() => {
        const gatewayPath = configuredModelGatewayPath();
        const contributions=gatewayPath?gatewayContributions(join(dataDirectory,"models"),gatewayPath):null;
        const subscriptionCore=options.codexCoreEndpoint&&options.codexCoreAuthToken?new CodexCoreControlClient(options.codexCoreEndpoint,options.codexCoreAuthToken):null;
        const gateway = gatewayPath ? modelGatewayHttp({path:gatewayPath,
          ...contributions,
          subscription:subscriptionCore?async(actor,input,assertCurrent)=>{
            assertCurrent();
            const result=await subscriptionCore.accountRequest('opencraft/codex/accounts/personal/'+input.operation,{actor,sessionId:input.sessionId});
            assertCurrent();
            if(result.status==='complete')return {status:'complete',...await contributions.connectSubscription(actor,result.connection,assertCurrent)};
            return result;
          }:undefined,
          authority: request => {
            const context = actorAccess.authenticate(request);
            if (!context || actorStore.get(context.actorId)?.kind !== 'human') return null;
            const principal = instanceAccess?.authenticate(request);
            return {actor:context.actorId,administrator:!!principal && instanceAccess.role(principal)==='admin',
              origin:actorAccess.options.trustedOrigin?.(request) ?? null};
          }}) : null;
        const policy = modelPolicyHttp(modelPolicy, request => {
        const principal=instanceAccess?.authenticate(request);
        if(!principal || !instanceAccess.role(principal)) return null;
        return {actor:JSON.stringify([principal.provider,principal.subject]),administrator:instanceAccess.role(principal)==='admin',origin:instanceAccess.trustedOrigin(request)};
        });
        return async (request,response) => gateway && await gateway(request,response) || await policy(request,response);
      })(),
      assetsService,
      identityService: identity?.service ?? null,
      ...(runtimePlugins ? { runtimePluginService: runtimePlugins } : {}),
      accessService: instanceAccess ?? null,
      actorService: actorAccess,
      allowSessionChannels: true,
      actorCollaborationService: actorCollaborationApi,
      turnPushService: turnPush,
      serverInformationService,
      accountModelDefaultsService,
      authService: humanAuth ?? null,
      accountService: accountApplication ?? null,
      hubService: hubController,
      remoteBrowserService: remoteBrowser,
      speechService: new SpeechTranscriptionService({ configuration: new SpeechModelConfiguration(
        new ModelConfigurationRepository(fileStateDocumentStore(join(dataDirectory, "models"))), new ModelCredentialRepository(fileSecretStore(join(dataDirectory, "models")))) }),
    });
    conversationResources.retry();
    const reconciledResourceHosts = new Map();
    let resourceInventoryRunning = false;
    const reconcileResources = async () => {
      if (closing || resourceInventoryRunning) return;
      resourceInventoryRunning = true;
      try {
        const scopes = [...await remoteBrowser.threadScopes(), ...(ownedWorkspaceRouting?.conversationScopes() ?? []),
          ...(options.terminalOwner ? await terminalService('local-codex').threadScopes() : [])];
        const hosts = new Set(scopes.map(scope => scope.hostId).filter(id => ['local-codex', 'opencraft-server'].includes(id)));
        // No resources means no reason to cold-start an execution engine merely
        // to inspect its archive catalog. Read metadata only for actual owners.
        for (const hostId of hosts) if (reconciledResourceHosts.get(hostId) !== conversationResources.hostRevision(hostId)) {
          const revision = conversationResources.hostRevision(hostId);
          const ok = await conversationResources.reconcileArchived(hostId, cursor => callConversationHost(appHostServer,
            { hostId, threadId: '' }, 'resource-archive-reconciliation', 'thread/list',
            { archived: true, cursor, limit: 200 }, undefined, 10_000));
          if (ok) reconciledResourceHosts.set(hostId, revision);
        }
      } catch { if (!closing) console.warn('[conversation-resources] inventory unavailable; will retry'); }
      finally { resourceInventoryRunning = false; }
    };
    void reconcileResources();
    resourceReconciliationTimer = setInterval(() => { void reconcileResources(); }, 60_000); resourceReconciliationTimer.unref();
    const listenHost = options.listenHost ?? host;
    if (!["127.0.0.1", "0.0.0.0"].includes(listenHost)) throw new Error("Invalid listener host");
    let address;
    if (ingressConfiguration) {
      const privateAddress = await web.listen({ host: "127.0.0.1", port: 0 });
      sshNativeRpc = await createSshNativeRpcGateway(appHostServer);
      ingress = createSshHttpIngress({ ...ingressConfiguration, httpPort: privateAddress.port,
        ...(identity?.sshAccess ? {
          resolveAuthorizedKeys: username => identity.sshAccess.publicKeys(username),
          authorizeSession: (username, key) => identity.sshAccess.authorize(username, key),
          createNativeSession: authorization => createSshNativeRpcGateway(appHostServer, authorization),
        } : {}),
        codexPort: sshNativeRpc.port, codexControl: createSshCodexControl(appHostServer,
          options.codexExecutable ?? join(root, "runtime/codex/bin/codex")) });
      address = await ingress.listen({ host: listenHost, port });
    } else address = await web.listen({ host: listenHost, port });
    if (relayConfiguration) relay = connectRelay({ ...relayConfiguration.options, targetPort: relayConfiguration.options.targetPort ?? address.port });
    hubController.node?.start(hubTargetPort ?? address.port);
    if (options.codexCoreEndpoint) codexReadiness = maintainHeadlessCodexHost(appHostServer);
    // The Worker's deployment-registered backends; the installation selects one of them.
    const environmentProviders=installedBotProvider?Object.fromEntries(assetsStorage.botBackends.map(id=>[id,installedBotProvider])):{};
    personalAssistantHost = await createPersonalAssistantHost({directory:dataDirectory,service:actorCollaboration,environmentProviders,environmentProvidersFor:identity?.environmentProvidersFor,
      modelSource:createAssistantModelSource(join(dataDirectory,'models'),modelPolicyPath,{
        fetch:async(input,init)=>{
          const request=new Request(input,init);
          if(/^http:\/\/127\.0\.0\.1:[0-9]+\/personal\/[a-f0-9]{64}\/v1\/(responses|models)$/.test(request.url)&&options.codexCoreEndpoint&&options.codexCoreAuthToken)
            return new CodexCoreControlClient(options.codexCoreEndpoint,options.codexCoreAuthToken).subscriptionRequest(request);
          return fetch(request);
        },
      }),
      codexBinary:options.codexExecutable ?? join(root,'runtime/codex/bin/codex'),
      // Explicit local preview composition only (scripts/dev/preview-crew.ts); the CLI never sets it.
      ...(composition.personalAssistantHost ?? {})});
    imPlugins = await startImPlugins(imConfiguration,{dataDirectory,capabilities,prepareCapabilities: tools => capabilityMcp.prepare(tools),actors:actorStore,collaboration:actorCollaboration,actorAccess,getAppHost:() => appHostServer,admittedActor:actorId => !instanceAccess || instanceAccess.admitsActor(actorId),...await createChannelSyncDependencies(composition,channelSyncContext({collaboration:actorCollaboration,relayConnectFile:relayConfiguration ? options.relayConnectFile : undefined}))});
    try { availabilityNotification = await startAvailabilityNotification(process.env.OPENCRAFT_AVAILABILITY_NOTIFICATION_CONFIG, () => imPlugins); }
    catch { console.warn('[availability-notification] startup-unavailable'); }
    capabilitiesReadyResolve();
    return { url: `http://127.0.0.1:${address.port}`, listenHost, listenPort: address.port, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

export async function runHeadlessCli({ parseArguments = parseHeadlessArguments, startServer = startHeadlessServer, help = [] } = {}) {
    const args = parseArguments(process.argv.slice(2));
    if (args.help) {
      process.stdout.write('Optional IM server plugins: --im-config ABSOLUTE_PRIVATE_JSON (also OPENCRAFT_IM_CONFIG_FILE); requires verified human sender bindings.\n');
      process.stdout.write('Optional instance-owned membership: --access-control (opencraft-server.sqlite under --data-dir); administer with access-admin. --access-member-provider PROVIDER admits verified identities from that provider as ordinary members; explicit revocations and admin roles remain authoritative. --relay-connect-file ABSOLUTE_PRIVATE_JSON enables an outbound relay and requires instance membership.\n');
      process.stdout.write('Optional human login (bundled opencraft.account plugin for local accounts): --human-auth-config ABSOLUTE_PRIVATE_JSON (local accounts and OIDC); initialize new instances at /setup with a private setupTokenFile, or recover with human-account. setupTokenFile enables instance membership; otherwise add --access-control explicitly.\n');
      process.stdout.write('Optional same-machine managed Web workspace: --local-access-file ABSOLUTE_PRIVATE_FILE (also OPENCRAFT_LOCAL_ACCESS_FILE); the same private key file must be configured at the outer managed Web entry.\n');
      for (const line of help) process.stdout.write(line + '\n');
      process.stdout.write("Usage: opencraft-server [--host 127.0.0.1|0.0.0.0] [--port 10000] [--hub-target-port PORT] [--data-dir PATH] [--isolate-browser-storage] [--machine-name NAME] [--codex-agent-bridge-config PRIVATE_JSON] [--engines dsh,pi|pi|dsh] [--default-engine dsh|pi] [--ssh-servers PRIVATE_JSON] [--ssh-public-origin HTTPS_ORIGIN | --ssh-public-access] [--ssh-require-access-key] [--ssh-access-file PRIVATE_FILE] [--allow-unauthenticated-public] [--local-desktop | --trusted-internal-desktop] [--desktop-control]\nDefault: loopback only; SSH management uses shared installation access without an extra key. --ssh-require-access-key or --ssh-access-file enables key protection. Public SSH requires explicit opt-in; every permitted visitor can use saved connections in shared mode. HTTP provides no transport encryption. Desktop requires an installed verified observer. Trusted-internal desktop trusts everyone able to access this deployment; operator-owned network admission is required. Optional desktop control requires a separate installed private native executor.\n");
      return;
    }
    const server = await startServer(args);
    process.stdout.write(`OpenCraft WebUI: ${server.url}\n`);
    if (server.listenHost === "0.0.0.0") process.stdout.write(`${args.accessControl || args.relayConnectFile ? 'Protected' : 'Unauthenticated'} public listener: 0.0.0.0:${server.listenPort}\n`);
    const shutdown = () => void server.close().then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}
