#!/usr/bin/env node
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import {openWorkspaceExecutionService} from './workspaces/execution-service.js';
import {openHeadlessAssetsStorage} from './headless-assets-storage.js';
import {humanGitRuntimeDirectory,createHumanGitExecution} from './human-git-execution.js';
import { openHumanAssets } from '@opencraft/plugin-local-account/assets-server';
import { externalConversationPort, openServiceIngress } from './service-ingress.mjs';
import { readPublishedEnvironmentIssuer } from '@opencraft/execution-environment/environment-issuer-publication';
import {workspaceTurnOutputContext} from './workspace-turn-output-context.mjs';
import { restoreWorkspaceQueuedContext } from '@opencraft/opencraft-daemon/workspace-queued-context';
import { HostWorkspaceCatalogTransport } from './host-workspace-catalog-transport.ts';
import { createCodexWorkspaceHooks, validateCodexWorkspaceHooks, hasCodexWorkspaceHooks, configuredWorkspaceExecution } from './codex-workspace-hooks.mjs';
import { configuredModelGatewayPath, CodexCoreControlClient } from "@opencraft/account-pool-host";
import { createAssistantModelSource } from '@opencraft/local-agent-host/model-config/assistant';
import { createPersonalAssistantHost, spawnAssistant } from '@opencraft/personal-assistant/host';
import { LocalAttachmentStagingService } from '@opencraft/local-agent-host/attachments/local-staging';
import { deploymentOperator } from "@opencraft/access-control/deployment-operator";
import { localExecutionCli } from "@opencraft/session-capabilities/execution-cli";
import { executionCliSourceToken } from '@opencraft/session-capabilities/credentials';
import { codexAdmissionPaused,createServerCodexBridge,openCodexRollbackHistory,readCodexBridgeConfiguration } from '@opencraft/opencraft-daemon/bridge-execution-admission';
import { CodexHostServices, codexAccountsService, codexModelsService, codexPinsService, codexTasksService } from '@opencraft/opencraft-daemon/codex-host-services';
import { CodexNativeReader } from '@opencraft/opencraft-daemon/codex-native-reader';
import { startCodexEngineHost } from '@opencraft/opencraft-daemon/codex-bridge-stack';
import { createServerCodexBridgeHost, resolveCodexPermissions } from '@opencraft/opencraft-daemon/codex-bridge-host';
import { codexBridgeConversationTools, codexBridgeCreationTools } from '@opencraft/opencraft-daemon/codex-bridge-conversation-tools';
import { openServerCoreOwner } from "@opencraft/storage-node/server-owner";
import { prepareProductServerMigrations } from "@opencraft/storage-node/server-composition";
import { ownerEntry } from '@opencraft/worker-owner';
import { ModelPolicyTransport } from '@opencraft/model-usage-policy/transport';
import { assembleAccount } from './assembly/account.mjs';
import { nodeAccountInputs } from './assembly/account-node.mjs';
import { assembleNodeLocal } from './assembly/node-local.mjs';
import { assembleInstallation } from './assembly/installation.mjs';
import { assembleWorkspaceHost } from './assembly/workspace-host.mjs';
import { assembleClientSession } from './assembly/client-session.mjs';
import { assembleEdge } from './assembly/edge.mjs';
import { createHeadlessLifecycle, createLateBinding } from './assembly/lifecycle.mjs';
import { ExecutionEnvironmentTransport } from './execution-environment-transport.ts';
import { EnvironmentMetadataTransport } from './environment-metadata-transport.ts';
import { codexExecutionGit } from './codex-environment-launch.ts';
import { composeHostTerminalSelector, createHandsTerminalService, HostTerminalSession, HostTerminalTransport } from './host-terminal-transport.js';
import { createHostFileSystem } from './host-filesystem.js';
import { composeHostFileSelector, HostFileSystemSession, HostFileSystemTransport } from './host-filesystem-transport.js';
import { HeadlessConnectors } from "@opencraft/connector-host/headless";
import { SessionCapabilities } from "@opencraft/session-capabilities";
import { SessionCapabilityMcp } from "@opencraft/session-capabilities/mcp";
import { fileKeyMaterial, fileSecretStore } from "@opencraft/secret-storage/file";
import { timeoutOwnerWake } from "@opencraft/owner-wake";
import { ConversationResourceTransport } from './conversation-resource-transport.js';
import { RemoteBrowserService } from './remote-browser-service.mjs';
import { connectBrowserOwner } from './remote-browser-owner.mjs';

import { access, chmod, mkdir, mkdtemp, stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireOwnerLock } from "@opencraft/sqlite-node/writer-lock";

import { loadSshIngressConfiguration } from "@opencraft/ssh-http-ingress/server";

import { openMcpAppsService } from "@opencraft/mcp-apps/node";
import { McpAppsTransport } from "@opencraft/mcp-apps/transport";
import { AppServerIdentityOverlay } from "@opencraft/opencraft-daemon/appserver-identity-overlay";
import { TokenUsageQueryTransport } from "@opencraft/opencraft-daemon/token-usage-query-transport";
import { TokenUsageQueryService } from "@opencraft/opencraft-daemon/token-usage-query-service";
import { CodexEngineAdapter } from "@opencraft/opencraft-daemon/codex-engine-adapter";
import { defaultWorkspace } from "@opencraft/opencraft-daemon/workspace-host";
import { MachineIdentityTransport } from "@opencraft/opencraft-daemon/machine-transport";
import { ExecutionOwnershipTransport } from "@opencraft/opencraft-daemon/execution-ownership-transport";
import { ExecutionLeaseStore } from "@opencraft/opencraft-daemon/execution-lease-store";
import { ThreadIdentityDatabase } from "@opencraft/opencraft-daemon/thread-identity-database";
import { observeNativeExecutionProcess, reportedExecutionProcess } from "@opencraft/opencraft-daemon/native-execution-origin";
import { createWebSocketExecutionTurnInspector } from "@opencraft/opencraft-daemon/native-execution-inspector";
import { AgentDriverTransport } from "@opencraft/opencraft-daemon/agent-driver-transport";
import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import { WebSocket } from 'ws';
import { readSshCodexServerBindings, createSshCodexEngineAdapter } from "@opencraft/opencraft-daemon/ssh-codex-connections";
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
import { readTaskCodexConversations } from "./tasks-conversation-catalog.mjs";
import { assertHeadlessWebRelease } from "./headless-web-release.mjs";
import { ModelConfigurationRepository, ModelCredentialRepository } from "@opencraft/local-agent-host/model-config/repository";
import { communicationExtensionModule } from '@opencraft/access-control/communication-extension';
import { openPushStore, TurnPushService, PushObservationTransport } from '@opencraft/web-push-node';
import { readImConfiguration, startImPlugins, createChannelSyncDependencies, channelSyncContext } from './im-plugins.mjs';
import { ImChannelsAppServer } from './im-channels-appserver.mjs';
import { createNodePasswordHasher } from '@opencraft/plugin-local-account/password-hash-node';
import { readPrivateJson } from '@opencraft/identity-core/node';
import { createCommitFenceBuffer, sharedMemoryCommitFence } from '@opencraft/access-control/commit-fence/shared-memory';
import { nodeRootInputs } from './assembly/root-inputs-node.mjs';
import { validateLoginAdmission, environmentLaunchOwner, environmentDeliveryOptions } from "./headless-identity.mjs";
import { openLoginAdmissionPolicy } from '@opencraft/plugin-login-admission/server';
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
  return { help: false, host, port, ...(hubTargetPort === undefined ? {} : { hubTargetPort }), ...(engineHostDescriptor ? {engineHostDescriptor} : {}), ...environmentDeliveryOptions(env), ...(engines.length !== 1 || engines[0] !== "dsh" ? { engines, defaultEngine } : {}), dataDirectory: resolve(dataDirectory), allowUnauthenticatedPublic,
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
  const configuredCodexBridge=options.codexAgentBridge??await readCodexBridgeConfiguration(options.codexAgentBridgeFile);
  // The server's own Codex Engine Host: every Codex Thread runs through the provider bridge,
  // new ones from creation, existing ones from their next turn (their IDs and history kept).
  // Its provider takes broker auth from the account Core; with a workspace-owned Codex runtime
  // it reaches native Codex through that runtime's native endpoint instead of the Core's health.
  if(options.codexBridgePrograms!==undefined&&(configuredCodexBridge||!options.codexCoreEndpoint||!isAbsolute(options.codexBridgePrograms)))
    throw new Error('A server Codex Engine Host requires an existing Core endpoint and no external bridge configuration');
  if(options.codexBridgePrograms!==undefined&&options.codexRuntime!==undefined&&options.codexRuntime.nativeSocket===undefined)
    throw new Error('A server Codex Engine Host needs the workspace Codex runtime native endpoint');
  const agentBridge=options.agentBridge??(options.agentBridgeFile?await readPrivateJson(options.agentBridgeFile):undefined);
  if(agentBridge!==undefined&&(!agentBridge||typeof agentBridge!=='object'||Array.isArray(agentBridge)))throw new Error('Invalid private agent bridge configuration');
  if(configuredCodexBridge&&!options.codexCoreEndpoint)throw new Error('Codex bridge requires an existing Core endpoint');
  const localAccess = await loadLocalMachineAccess(options.localAccessFile);
  if (composition.createIdentity !== undefined && typeof composition.createIdentity !== "function") throw new Error("Invalid Headless identity factory");
  if (composition.createServiceIngress !== undefined && typeof composition.createServiceIngress !== "function") throw new Error("Invalid Headless service ingress factory");
  if (composition.selectHostTerminalService !== undefined && typeof composition.selectHostTerminalService !== "function") throw new Error("Invalid Headless terminal selector");
  if (composition.selectHostFiles !== undefined && typeof composition.selectHostFiles !== "function") throw new Error("Invalid Headless workspace file selector");
  if(composition.workspaceOutputIdentity!==undefined&&typeof composition.workspaceOutputIdentity!=='function')throw Error('Invalid Headless workspace output identity selector');
  validateCodexWorkspaceHooks(composition);
  const workspaceExecution = configuredWorkspaceExecution(options);
  if (composition.close !== undefined && typeof composition.close !== "function") throw new Error("Invalid Headless disposer");
  if (composition.isHuman !== undefined && typeof composition.isHuman !== "function") throw new Error("Invalid Headless human qualification");
  const loginAdmissionScope = validateLoginAdmission(composition.loginAdmission);
  const runtimePluginConfiguration = validateRuntimePluginOptions(composition.runtimePlugins);
  const migrationComposition = prepareProductServerMigrations(composition.serverMigrations);
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
  const productPluginAssets = await prepareProductPluginRelease({ releaseRoot: options.productPluginRelease?.root ?? root, webRoot,
    cacheDirectory: process.env.OPENCRAFT_PRODUCT_PLUGIN_CACHE_DIRECTORY || join(dataDirectory, 'product-plugin-packs'),
    metadata: options.productPluginRelease ? options.productPluginRelease.metadata : releaseManifest.productPlugins ?? null });
  // The identity commit fence's shared buffer: the core owner Worker passes it,
  // this thread serves it (the commit fence port's shared-memory adapter).
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
      migrationComposition,
      data: { identityFence, ...(communicationExtensionModule() ? { communicationExtensionModule: communicationExtensionModule() } : {}) } });
  } catch (error) { releaseExtensions(); throw error; }
  // Identity, admission, collaboration and deployment-level services over the
  // core SQL owner; creating it opens nothing, each step and disposer keeps
  // its original position.
  const installation = assembleInstallation({ serverStorage, identityFence: sharedMemoryCommitFence(identityFence),
    isHuman: principal => composition.isHuman?.(principal) });
  const orchestrationStorage = installation.openOrchestrationStorage();
  const releaseLock = async () => { await installation.closeOrchestrationStorage(); await serverStorage.close(); releaseExtensions(); };
  let account;
  let workspaceRouting;
  const fileSystem = options.fileSystemOwner ? createHostFileSystem(options.fileSystemOwner) : null;
  let personalAssistantHost;
  const capabilities = new SessionCapabilities();
  let capabilitiesReadyResolve;
  const capabilitiesReady = new Promise(resolve => { capabilitiesReadyResolve = resolve; });
  let hubController;
  let usageQueries;
  // Explicit ports for shutdown state and for values constructed after the
  // closures that read them; assembly modules receive these instead of the
  // root's bindings (docs/architecture/platform/gateway-split.md §4.1.1).
  const lifecycle = createHeadlessLifecycle();
  // The client session's App Host server is bound where it is constructed; the
  // module owns that late binding and installation and workspace-host read it.
  const clientSession = assembleClientSession();
  const lateCapabilityKey = createLateBinding('Capability signing key');
  // A configured external bridge is known now; the server's own Engine Host
  // publishes its bridge only once it has started.
  const lateCodexBridge = createLateBinding('Codex agent bridge');
  if (options.codexBridgePrograms === undefined) lateCodexBridge.bind(configuredCodexBridge);
  const lateTurnPush = createLateBinding('Turn push');
  const lateSshManagement = createLateBinding('SSH management');
  const lateImPlugins = createLateBinding('IM plugins');
  // Node-only services; creating the module opens nothing, each step runs at
  // its original position and each disposer at its original shutdown step.
  const nodeLocal = assembleNodeLocal({ dataDirectory });
  // Execution delivery, the capability surface a workspace's runs call, the
  // engines, execution observation and conversation resources; creating it
  // opens nothing, each step and disposer keeps its original position.
  const workspaceHost = assembleWorkspaceHost({ lifecycle, capabilities, appHost: clientSession.appHost, codexBridge: lateCodexBridge, fileSystem });
  // Runtime plugins, the Web server's options and the listener; creating it
  // opens nothing, each step and disposer keeps its original position.
  const edge = assembleEdge();
  // Deployment-level periodic owner work runs on the owner wake-up port (gateway-split.md §4.2).
  const ownerWake = options.ownerWake ?? timeoutOwnerWake();
  // The lifecycle publishes the shared promise before invoking any disposer
  // (including a synchronous failure or reentrant close). Retire listeners before stores.
  const close = (update = null) => lifecycle.shutdown(async () => {
    const results = [];
    const settle = async disposers => {
      results.push(...await Promise.allSettled(disposers.map(dispose => Promise.resolve().then(dispose))));
    };
    capabilitiesReadyResolve();
    workspaceHost.closeResourceReconciliation();
    await settle([workspaceHost.closeConversationResources]);
    let entryClosing;
    const closeEntry = () => entryClosing ??= settle([
      () => hubController?.close(), nodeLocal.closeRelay, nodeLocal.closeSshIngress, nodeLocal.closeSshNativeRpc,
      workspaceHost.closeReadiness, workspaceHost.closeUsageQueries,
      async () => { workspaceHost.withdrawGitStatus(); await workspaceHost.closeBrowserCapabilities(); await workspaceHost.closeRemoteBrowser(); },
      workspaceHost.closeFileDownloads, nodeLocal.closeDesktop, installation.closeTurnPush,
      nodeLocal.closeAvailabilityNotification, () => lateImPlugins.current()?.close(),
    ]);
    await settle([() => edge.closeWeb(update, closeEntry)]);
    // Custom Web adapters need not implement the optional carrier phase.
    await closeEntry();
    // Plugins stop after the listener stopped accepting and before any owner
    // their authority or handlers may still call (admission, identity, stores).
    await settle([edge.closeRuntimePlugins]);
    await settle([edge.closeServiceIngress]);
    await settle([installation.closePersonalSshKeys]);
    await settle([nodeLocal.closeObservability]);
    await settle([installation.closeProjectAutomations]);
    await settle([installation.closeThreadOrchestration]);
    await settle([() => personalAssistantHost?.close()]);
    await settle([clientSession.closeAppHost]);
    await settle([workspaceHost.closeCodexEngineHost]);
    workspaceHost.closeTerminals();
    workspaceHost.closeFileSystem();
    await settle([installation.closeThreadOrchestration, installation.closeConnectors, installation.closeCollaboration, installation.closeThreadAccess, installation.closeServerSpaces]);
    await settle([installation.closeOrchestrationStorage]);
    await settle([workspaceHost.closeEngine, workspaceHost.closeDsh, workspaceHost.closeExecutionCli, workspaceHost.closeCapabilityMcp]);
    if (workspaceHost.holdsPiOwner()) await settle([workspaceHost.releasePiOwner]);
    await settle([workspaceHost.closeExecutionRecovery, workspaceHost.closeIdentityOverlay]);
    // Each writer finishes before the root kernel lock is released. A failed
    // disposer is reported, but must not skip the remaining flushes.
    for (const dispose of [workspaceHost.closeExecutionDatabase,
      () => account?.close(), installation.closeMcpApps, nodeLocal.closeSshManagement, installation.closeIdentityExecutionEnvironment, installation.closeIdentity, installation.closeLoginAdmission,

      workspaceHost.closeWorkspaceRouting, workspaceHost.closeBotProvider, workspaceHost.closeBotAdmission, workspaceHost.closeHumanGitExecution, workspaceHost.closeHumanAssets, workspaceHost.closeAssetsStorage, () => composition.close?.(), installation.closeAccountApplication, installation.closeAccountManagement, installation.closeHumanAuth, installation.closeHumanAccounts,
      installation.closeIdentityWrites, installation.closeCapabilityBindings, installation.closeActorStore, installation.closeMembership]) {
      await settle([dispose]);
    }
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    // A rejected flush is not a release receipt. The gateway exits nonzero;
    // only actual process death then releases the kernel writer lock.
    if (failures.length > 0) throw new AggregateError(failures, "OpenCraft server shutdown failed");
    await releaseLock();
  });
  try {
    const ingressConfiguration = options.sshConfig ? await loadSshIngressConfiguration(options.sshConfig) : null;
    // Invalid configured credentials fail startup before any execution resource is created.
    // Root inputs through their port; the Node adapter reads the same files, each at its original moment.
    const rootInputs = nodeRootInputs({ dataDirectory, machineName: options.machineName, humanAuthConfig: options.humanAuthConfig,
      relayConnectFile: options.relayConnectFile, relayAssertionOptions: composition.relayAssertionOptions });
    const relayConfiguration = await rootInputs.relayConnection();
    const humanConfiguration = await rootInputs.humanAuthConfiguration();
    const imConfiguration = await readImConfiguration(options.imConfigFile);
    hubController = await createHubController(rootInputs.hubState);
    const membership = installation.openMembership({ hub: hubController.node, accessControl: options.accessControl,
      accessMemberProviders: options.accessMemberProviders, humanConfiguration, relayConfiguration });
    const machineIdentity = await rootInputs.machineIdentity();
    // The account takes its storage as ports; the Node inputs are the data directory's files (account-node.mjs).
    const accountInputs = nodeAccountInputs({ dataDirectory, codexCoreEndpoint: options.codexCoreEndpoint, codexCoreAuthToken: options.codexCoreAuthToken });
    account = assembleAccount(accountInputs);
    const { modelPolicyPath } = accountInputs;
    const { actorStore, identity, environmentDelivered } = await installation.openIdentity({
      // The Node data directory reaches only the identity composition, first as before.
      createIdentity: composition.createIdentity && (input => composition.createIdentity({ dataDirectory, ...input })),
      hub: hubController.node, machineIdentity, relayConfiguration, workspaceExecution, sshIngressEnabled: !!ingressConfiguration,
      environmentDelivery: options.environmentDelivery, environmentIssuer: options.environmentIssuer,
      engineHostDescriptor: options.engineHostDescriptor, capabilities });
    // One installation has one ENV owner; configuring two fails here. An
    // identity composition's `environmentLaunch` is the owner; otherwise, with
    // delivery, core's assets vault Worker is. Never both, never a fallback.
    const environmentOwner = environmentLaunchOwner(options.environmentDelivery, identity);
    const coreEnvironmentLaunch = environmentOwner === 'core';
    // An independent engine host pins the issuer only from its supervisor,
    // which reads the key the vault owner publishes; never from this Gateway.
    // The identity owner publishes it itself; a publication that is missing or
    // names another key would leave every delivery failing, so it is refused.
    if (environmentOwner === 'identity' && environmentDelivered && options.environmentIssuer?.publish !== undefined
      && await readPublishedEnvironmentIssuer(options.environmentIssuer.publish).catch(() => null) !== identity.environmentLaunch.issuer)
      throw new Error('Environment delivery requires the identity vault owner to publish its issuer');
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
    const { humanAccounts, humanAuth, accountApplication, loginAdmission, instanceAccess } = await installation.openAdmission({
      hub: hubController.node, relayConfiguration, humanConfiguration, accessMemberProviders: options.accessMemberProviders,
      createPasswordHasher: createNodePasswordHasher,
      readSetupToken: humanConfiguration?.setupTokenFile ? () => readPrivateJson(humanConfiguration.setupTokenFile) : undefined,
      openLoginAdmission: loginAdmissionScope
        ? () => openLoginAdmissionPolicy({ ...loginAdmissionScope, path: join(dataDirectory, 'login-admission.sqlite') }) : undefined });
    const { assetsStorage, botAdmission, installedBotProvider, workspaceRouting: deliveryRouting, assetsService,
      gitExecutionOwner, humanGitExecution, environmentLaunch, codexEnvironmentLaunch } = await workspaceHost.openExecutionDelivery({
      identity, workspaceExecution, workspaceRouting, coreEnvironmentLaunch, environmentIssuer: options.environmentIssuer,
      terminalOwner: options.terminalOwner, machineIdentity, actorStore, instanceAccess, humanAuth, serverStorage,
      codexCoreEndpoint: options.codexCoreEndpoint, readAssistantSandboxConfig: () => process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG,
      openAssetsStorage: assetsOptions => openHeadlessAssetsStorage(dataDirectory, assetsOptions),
      openWorkspaceExecution: openWorkspaceExecutionService, spawnAssistant,
      openHumanAssets: assetsOptions => openHumanAssets({ directory: dataDirectory, ...assetsOptions }),
      createHumanGitExecution: gitOptions => createHumanGitExecution({directory:dataDirectory,
        runtimeDirectory:humanGitRuntimeDirectory(join(dataDirectory,'git-runtime'),'gateway'),workerFile:options.gitWorkerFile??fileURLToPath(new URL('./personal-git-worker.mjs',import.meta.url)),
        ...gitOptions}) });
    workspaceRouting = deliveryRouting;
    if (environmentLaunch) await options.awaitEnvironmentPin?.(environmentLaunch.issuer);
    const actorAccess = installation.openActorAccess();
    const engines = options.engines ?? ["dsh"];
    const conversationExecution = workspaceHost.openConversationExecution({ engines,
      engineHostDescriptor: options.engineHostDescriptor, machineIdentity });
    const { serverSpaces, threadAccess, threadNotes } = await installation.openSpaces();
    // Configuration, never missing request credentials, selects the anonymous authority.
    const anonymousDeployment = !membership && !humanConfiguration && !composition.createIdentity
      && !relayConfiguration && !!hubController.node
      && !hubController.node.origin && !hubController.node.authority;
    const operator = deploymentOperator(actorStore, anonymousDeployment, () => !serverSpaces.initialized
      && !hubController.node.origin && !hubController.node.authority);
    const anonymousHandoff = () => !!operator.context();
    const signExecutionCli = session => executionCliSourceToken(lateCapabilityKey.get(), session);
    const anonymousDriver = (transport, hostId) => anonymousDeployment
      ? new AgentDriverTransport(transport, actorCollaboration,
        threadId => conversationExecution.serverForHost(hostId, threadId), signExecutionCli, operator.context)
      : transport;
    // Access sessions for App Host RPC and Web's App Server socket; opening them opens nothing.
    const { accessServerForHost } = clientSession.openAccessSessions({ machineIdentity, conversationExecution, threadAccess, threadNotes,
      serverSpaces, membership, actorStore, instanceAccess, identity, anonymousHandoff });
    const { actorCollaboration, threadOrchestration, actorCollaborationApi } = await installation.openCollaboration({
      conversationExecution, operator, anonymousHandoff, appHost: clientSession.appHost, engines,
      // The server's own Engine Host starts later (after the capability listener); automations reach it when they run.
      codexBridge: () => options.codexBridgePrograms!==undefined?{get url(){return lateCodexBridge.current()?.url??'http://127.0.0.1:1/';},get token(){return lateCodexBridge.current()?.token??'';}}:lateCodexBridge.get() });
    const desktop = await nodeLocal.startDesktop({ enabled: options.localDesktop, control: options.desktopControl, access: desktopAccess });
    const connectorService = installation.openConnectors({
      createConnectors: ({ access, hosts, admitted, resolveServer }) => new HeadlessConnectors(join(dataDirectory, "connectors"), access,
        hosts, capabilities, admitted, undefined, resolveServer, ownerWake),
      machineId: machineIdentity.machineId, defaultEngine: options.defaultEngine ?? (engines.includes("dsh") ? "dsh" : "pi"), conversationExecution });
    const { remoteBrowser, browserCapabilities } = workspaceHost.openBrowser({
      createRemoteBrowser: browserOptions => new RemoteBrowserService({ root, dataDirectory,
        allowNoSandbox: process.env.OPENCRAFT_BROWSER_ALLOW_NO_SANDBOX === '1', ...browserOptions }),
      ownerConnector: browserOwnerSocket ? () => connectBrowserOwner(browserOwnerSocket) : undefined,
      conversationExecution, actorStore, instanceAccess, threadAccess, actorCollaboration, anonymousDeployment, operator });
    const capabilityBindings = await installation.openCapabilityBindings();
    workspaceHost.assertEnvironmentAdmission();
    const capabilityKey=lateCapabilityKey.bind(await installation.openCapabilitySigningKey(fileKeyMaterial(dataDirectory)));
    const { capabilityMcp, connectedExecutionCli, codexEngineHost, bridgeSessionMcp } = await workspaceHost.openCapabilityMcp({
      capabilityKey, capabilityBindings, conversationExecution, anonymousDeployment, actorCollaboration, threadOrchestration,
      createCapabilityMcp: (registry, key, bindings, handlers) => new SessionCapabilityMcp(registry, key, bindings, {
        descriptorPath:join(dataDirectory,'session-capabilities.json'), retainEndpoint: true,
        cliDirectory:options.threadCliDirectory ?? join(dataDirectory,'thread-cli'), ...handlers }),
      openExecutionCli: ({ endpoint, key }) => localExecutionCli({directory:join(dataDirectory,"connected-execution-cli"),endpoint,key}),
      startCodexEngineHost: options.codexBridgePrograms!==undefined ? ({ cliEndpoint }) => startCodexEngineHost({programs:options.codexBridgePrograms,node:process.execPath,
        coreEndpoint:options.codexCoreEndpoint,coreToken:options.codexCoreAuthToken,
        ...(options.codexRuntime?{coreNativeSocket:options.codexRuntime.nativeSocket}:{}),
        runtimeDirectory:join(dataDirectory,'codex'),stateDirectory:join(dataDirectory,'codex-bridge'),
        cli:{directory:join(dataDirectory,'codex-bridge','cli'),signingKey:join(dataDirectory,'session-capabilities.key'),endpoint:cliEndpoint},
        serverId:`server:${machineIdentity.machineId}:codex`,
        log:line=>console.error(line)}) : undefined });
    const codexRollbackHistory = options.codexCoreEndpoint && !lateCodexBridge.get()
      ? await openCodexRollbackHistory(join(dataDirectory, "codex-bridge", "engine-host.sqlite"), `server:${machineIdentity.machineId}:codex`)
      : undefined;
    const startAgent = options.startAgentHost ?? startLocalAgentHost;
    const defaultEngine = options.defaultEngine ?? (engines.includes("dsh") ? "dsh" : "pi");
    // The engines' processes, files and locks are Node constructions; the module decides which run and when.
    const agent = await workspaceHost.openEngines({ engines, machineIdentity, actorCollaboration, threadOrchestration,
      readTaskConversations: readTaskCodexConversations,
      startDsh: ({ executionCli, sessionCapabilities, prepareArtifact, taskConversationCatalog }) => startAgent({
        executionCli,
        modelPolicyPath,
        nativePi: !engines.includes("pi"),
        sessionCapabilities: sessionCapabilities(),
        dshExecutable: options.dshExecutable ?? (process.env.OPENCRAFT_DSH_EXECUTABLE?.trim() || join(root, "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js")),
        dshCapabilityPlugin: options.dshCapabilityPlugin ?? join(root, "runtime/dsh/opencraft-capability-plugin.mjs"),
        runtimeDirectory: options.runtimeDirectory ?? join(root, "runtime"),
        dataDirectory: join(dataDirectory, "agent"),
        artifactDirectory: join(dataDirectory,"artifacts"),
        prepareArtifact,
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
        taskConversationCatalog,
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
      }),
      attachIndependentEngine: options.engineHostDescriptor ? () => attachEngineHost(options.engineHostDescriptor, dataDirectory, machineIdentity.machineId,
        engines, defaultEngine) : undefined,
      // Shared with the independent engine host: one in-process or independent Pi owner per data directory.
      acquirePiOwner: () => acquireOwnerLock(join(dataDirectory, "pi-owner.lock")),
      createPiEngine: async ({ executionCli, executionGit, sessionCapabilities }) => {
        const piModels = await createPiModelConfiguration(new ModelConfigurationRepository(fileStateDocumentStore(join(dataDirectory, "models"))), new ModelCredentialRepository(fileSecretStore(join(dataDirectory, "models"))), fileStateDocumentStore(join(dataDirectory, "pi")));
        const piAttachments=new LocalAttachmentStagingService(join(dataDirectory,"agent","attachments"),join(dataDirectory,"artifacts"));
        const piPrepareInput=(threadId,input)=>piAttachments.prepareInput(input,threadId,fileSystem?(artifact,owner,signal)=>fileSystem.prepareArtifact(artifact,owner,signal):undefined);
        const piEngine = new PiEngine({ executionCli, prepareAttachmentInput:piPrepareInput, modelPolicyPath, ...piModels, executionEnvironment: identity?.executionEnvironment,executionGit, sessionCapabilities: sessionCapabilities(), dataDirectory, directory: join(dataDirectory, "pi"), attachmentDirectory: join(dataDirectory, "agent", "attachments"), cwd: options.runtimeDirectory ?? join(root, "runtime") });
        const closePi=piEngine.close.bind(piEngine);
        piEngine.close=async()=>{try {await closePi();} finally {await piAttachments.close();}};
        return piEngine;
      },
      startPiEngineHost: ({ piEngine, startDsh }) => startEngineHost({
        providers: [piEngine],
        defaultEngine, machine: machineIdentity,
        resources: { artifactDirectory:join(dataDirectory,"artifacts"), projectDirectory: join(dataDirectory, "projects"), attachmentDirectory: join(dataDirectory, "agent", "attachments") },
        ...(engines.includes("dsh") ? { legacy: { id: "dsh", label: "DeepSeek Harness", start: startDsh } } : {}),
      }) });
    const codexStorageOutcomes = new Map();
    const storageOpened = hostId => outcomes => codexStorageOutcomes.set(hostId, outcomes.map(({ name, outcome }) => ({
      hostId, name, status: outcome.status, appliedVersion: outcome.appliedVersion,
      ...(outcome.backupPath ? { backupPath: outcome.backupPath } : {}), movedAside: outcome.movedAsidePaths.length > 0,
    })));
    const createThreadMetadata = identity?.createThreadMetadata;
    const { agentIdentity, executionStore, resolveExecutionNative } = await workspaceHost.openExecutionObservation({ createThreadMetadata,
      createIdentityOverlay: overlay => new AppServerIdentityOverlay({ directory: join(dataDirectory, "thread-identities", "opencraft-server"), ...overlay }),
      openExecutionLeases: () => {
        const database = new ThreadIdentityDatabase(join(dataDirectory,'thread-identities','opencraft-server'));
        return { database, store: new ExecutionLeaseStore(database.database) };
      },
      reportedExecutionProcess, observeOwnProcess: () => observeNativeExecutionProcess(process.pid),
      createExecutionRecovery: createWebSocketExecutionTurnInspector });
    const mcpApps = installation.openMcpApps(() => openMcpAppsService(join(dataDirectory, "mcp-apps.sqlite")));
    // Reuse the deployment's existing Codex ledger without starting a Codex
    // transport or opening/migrating its writer from the DSH/Pi entry.
    // Packages bundle the query worker beside this module; source runs use the TypeScript entry.
    const bundledQueryWorker = fileURLToPath(new URL('./token-usage-query-worker.mjs', import.meta.url));
    const tokenUsageQueryWorkerEntry = await access(bundledQueryWorker).then(() => bundledQueryWorker,
      () => fileURLToPath(new URL('../../opencraft-daemon/src/token-usage-query-worker.ts', import.meta.url)));
    usageQueries = workspaceHost.openUsageQueries(() => new TokenUsageQueryService({
      entry: tokenUsageQueryWorkerEntry,
      databasePath: join(dataDirectory, 'codex', 'token-usage.sqlite'),
      serverId: `server:${machineIdentity.machineId}:codex`,
      ...(process.env.OPENCRAFT_TOKEN_USAGE_SOURCE === 'ledger' ? {} : {rollout:{nativeHome:join(dataDirectory,'codex','runtime')}}),
    }));
    const { terminalService, resourceAuthority, terminalScope } = await workspaceHost.openConversationResources({
      createTerminalService: options.terminalOwner ? terminalOptions => createHandsTerminalService({ ...options.terminalOwner, ...terminalOptions }) : undefined,
      identity, actorStore, instanceAccess, serverStorage, ownerWake });
    // Trusted embedding may replace native startup without reconstructing or
    // dropping the Host's execution authority and domain tool composition.
    const createCodexTransport = configuration => options.createCodexTransport?.(configuration) ?? new CodexEngineAdapter(configuration);
    const createRemoteCodexTransport = (binding, hostId) => {
      // The remote Host's native execution authority is the workspace host's; the SSH adapter stays Node-only.
      const { authority, nativeTool } = workspaceHost.remoteExecution(accessServerForHost(hostId, ''), hostId);
      return createSshCodexEngineAdapter(binding, dataDirectory, createThreadMetadata, storageOpened(hostId), {
        executionAuthority: authority, nativeTool }, createCodexTransport);
    };
    // The workspace-host layers of the local Hosts' transports, over the root's Node transport classes.
    const hostTransports = workspaceHost.openHostTransports({
      transports: {
        executionEnvironment: (transport, runtime, hostId) => new ExecutionEnvironmentTransport(transport, runtime, hostId),
        environmentMetadata: (transport, metadata, hostId) => new EnvironmentMetadataTransport(transport, metadata, hostId),
        workspaceCatalog: (transport, readCatalog, readFileScope) => new HostWorkspaceCatalogTransport(transport, readCatalog, readFileScope),
        terminals: (transport, service, scope, hostId, select) => new HostTerminalTransport(transport, service, scope,
          composeHostTerminalSelector(hostId, service, select)),
        files: (transport, files, authority, select) => new HostFileSystemTransport(transport, files, authority,
          composeHostFileSelector(files, authority, select)),
        conversationResources: (transport, hostId, resources) => new ConversationResourceTransport(transport, hostId, resources),
      },
      selectHostTerminalService: composition.selectHostTerminalService, selectHostFiles: composition.selectHostFiles });
    // The App Host server: the client-session module dispatches each Host id to its
    // transport. Each Host's inner engine transport, and the account and push layers
    // around it, are Node constructions (gateway-split §4.1.1 "client-session").
    const appHostServer = clientSession.openAppHost({
      transports: {
        channels: () => new ImChannelsAppServer(() => actorCollaboration),
        server: () => new TokenUsageQueryTransport(new MachineIdentityTransport(machineIdentity,'OpenCraft',async () => {
          const engine = new WebSocketTransport({
            url: agent.resolveWebsocketUrl ? await agent.resolveWebsocketUrl() : agent.websocketUrl,
            createSocket: url => new WebSocket(url),
          });
          const transport = agentIdentity?.wrapTransport(engine) ?? engine;
          return new AgentDriverTransport(new ExecutionOwnershipTransport(new ModelCapabilityTransport(new ImageModelTransport(transport, new ImageGenerationConfiguration(fileStateDocumentStore(join(dataDirectory,'models')), new ModelCredentialRepository(fileSecretStore(join(dataDirectory,'models'))))), {read:()=>new ModelConfigurationRepository(fileStateDocumentStore(join(dataDirectory,'models'))).read(),credential:async ref=>(await new ModelCredentialRepository(fileSecretStore(join(dataDirectory,'models'))).resolve(ref))??process.env[ref]}), executionStore, resolveExecutionNative), actorCollaboration,
            threadId => conversationExecution.serverForHost('opencraft-server', threadId), signExecutionCli, operator.context);
        }), usageQueries, actorId => actorStore.get(actorId)),
        remoteCodex: (binding, hostId) => new MachineIdentityTransport(null, "Codex", () => createRemoteCodexTransport(binding, hostId)),
        localCodex: hostId => {
        // Host-owned dynamic tools (browser), for local and bridge Threads alike.
        const codexNativeTool = (context, tool, args, signal) => browserCapabilities.invokeNative({
          serverId: conversationExecution.serverForThread(context.threadId),
          threadId: context.threadId,
          execution: { turnId: context.turnId, callId: context.callId },
        }, tool, args, signal);
        const serverCodexAdmission = {
          admit:async (threadId,inputId,input,context)=>{
            if(context.collaborationRequestId) {
              if(inputId!=='actor-input:'+context.collaborationRequestId)throw Error('Invalid admitted input');
            } else if(!context.commitExecution) {
              // An anonymous deployment's input carries no actor of its own: the agent driver admits it
              // as the deployment operator, which this admission then authorizes as it would a login.
              const actor=context.actorContext??operator.context();
              if(!actor)throw Error('Execution admission required');
              actorCollaboration.authorizeExecution(actor,threadId,inputId,input);
            }
            // Continuation uses the previous Turn's recorded delegation.
            await actorCollaboration.admittedExecution(threadId,inputId);
            return {serverId:conversationExecution.serverForThread(threadId),threadId,
              execution:{inputId,executionId:createHash('sha256').update(JSON.stringify([threadId,inputId])).digest('hex')}};
          },
          sign:session=>executionCliSourceToken(capabilityKey,session),
          ...bridgeSessionMcp,
          started:(threadId,inputId,turnId)=>actorCollaboration.executionStarted(threadId,inputId,turnId),
        };
        if (lateCodexBridge.get() && options.codexCoreEndpoint && !hasCodexWorkspaceHooks(workspaceRouting ?? composition) && !options.createCodexTransport) {
          return anonymousDriver(new McpAppsTransport(new MachineIdentityTransport(machineIdentity, "Codex", () => createServerCodexBridgeHost({
            coreEndpoint: options.codexCoreEndpoint,
            coreAuthToken: options.codexCoreAuthToken,
            ...(options.codexRuntime ? { coreRuntime: options.codexRuntime } : {}),
            bridge: lateCodexBridge.get(),
            admission: serverCodexAdmission,
            codexDataDirectory: join(dataDirectory, "codex"),
            artifactDirectory: join(dataDirectory, "artifacts"),
            prepareArtifact: fileSystem ? (artifact, owner, signal) => fileSystem.prepareArtifact(artifact, owner, signal) : undefined,
            readGeneratedFile: fileSystem ? (path, signal) => fileSystem.openFile(path, false, signal ?? new AbortController().signal) : undefined,
            createThreadMetadata,
            ...(gitExecutionOwner ? { createExecutionGit: codexExecutionGit(gitExecutionOwner, {
              directory: dataDirectory, runtimeDirectory: humanGitRuntimeDirectory(join(dataDirectory, 'codex-git-runtime'), 'codex'),
              workerFile: options.gitWorkerFile ?? fileURLToPath(new URL('./personal-git-worker.mjs', import.meta.url)),
              authorize: scope => {
                const actorId = scope.account.slice('actor:'.length), actor = actorStore.get(actorId);
                return !lifecycle.closing() && actor?.enabled === true && actor.kind === 'human'
                  && actor.generation === scope.actorGeneration && instanceAccess.admitsActor(actorId);
              },
            }) } : {}),
            tokenUsage: {
              queryWorkerEntry: tokenUsageQueryWorkerEntry,
              serverId: `server:${machineIdentity.machineId}:codex`,
              ...(process.env.OPENCRAFT_TOKEN_USAGE_SOURCE === 'ledger' ? {} : { derivedQueries: usageQueries }),
              actor: context => actorStore.isCurrent(context) ? actorStore.get(context.actorId) : null,
              person: actorId => actorStore.get(actorId),
              submission: (threadId, inputId) => actorCollaboration.usageSubmission(threadId, inputId),
            },
            collaboration: {
              capabilities: actorCollaboration.capabilities,
              command: (context, body, submission) => actorCollaboration.command(context, body, submission),
              authorize: (context, threadId, inputId, input) => actorCollaboration.authorizeExecution(context, threadId, inputId, input),
              prepare: (context, input) => actorCollaboration.referenceContext(context, input),
              topology: threadId => actorCollaboration.threadTopology(threadId),
            },
            collaborationInput: {
              mode: id => actorCollaboration.inputMode(id),
              authorize: (threadId, id, mode, expectedTurnId) => actorCollaboration.authorizeInput(threadId, id, mode, expectedTurnId),
            },
            nativeTool: codexBridgeConversationTools(actorCollaboration, codexNativeTool),
            creationTools: codexBridgeCreationTools,
            filterGatewayModelCatalog: serverStorage.call.filterGatewayModelCatalog,
            modelViewer: context => context.actorContext && actorStore.isCurrent(context.actorContext)
              ? actorStore.get(context.actorContext.actorId)?.id ?? null : null,
            desktop,
            storageOpened: storageOpened(hostId),
          })), mcpApps), hostId);
        }
        // Host-wide duties (tasks first) are answered by the services front before Thread routing.
        let codexAdapterStorage = [], codexFront, codexRouting;
        const codexReader = options.codexCoreEndpoint
          ? new CodexNativeReader(options.codexCoreEndpoint, options.codexCoreAuthToken, undefined, options.codexRuntime)
          : undefined;
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
              return !lifecycle.closing() && actor?.enabled === true && actor.kind === 'human'
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
          ...(codexRollbackHistory ? { rollbackHistory: codexRollbackHistory } : {}),
          ...(codexEngineHost ? { bridgeThreadRequest: (method, params, commitExecution) =>
            codexFront.request(method, params, 45_000, { sender: null, commitExecution }) } : {}),
          observationComponent: 'gateway',
          ...createCodexWorkspaceHooks(workspaceRouting ?? composition, hostId),
          nativeCodexHomeDirectory: join(dataDirectory, "native-codex"),
          desktop,
        }), lateCodexBridge.get(), serverCodexAdmission, {admissionPaused:()=>codexAdmissionPaused(join(dataDirectory,"codex")),
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
          ...(codexReader ? [codexModelsService(codexReader, context => context.actorContext && actorStore.isCurrent(context.actorContext) ? actorStore.get(context.actorContext.actorId)?.id ?? null : null, serverStorage.call.filterGatewayModelCatalog),
            codexPinsService(codexReader, clients, {
              toNative: id => codexRouting?.threadIdentities?.()?.toNative(id),
              toPublic: id => codexRollbackHistory?.toPublic(id) ?? codexRouting?.threadIdentities?.()?.toPublic(id),
              pinRefusal: id => codexRollbackHistory?.rejection("opencraft/thread-pins/set", { threadId: id }),
            }),
            { handles: () => false, request: () => null, close: () => codexReader.close() }] : [])])), mcpApps), hostId);
        },
      },
      layers: {
        modelPolicy: (transport, engine) => new ModelPolicyTransport(transport, modelPolicyPath, engine, serverStorage.call.projectModelCatalog),
        modelGatewaySettings: () => {
          const gatewayPath=configuredModelGatewayPath();
          return gatewayPath ? transport => new ModelGatewaySettingsTransport(transport,gatewayPath,join(dataDirectory,'models'),context=>{
          const actor=context.actorContext;
          if(!actor || !actorStore.isCurrent(actor) || actorStore.get(actor.actorId)?.kind!=='human' || instanceAccess && !instanceAccess.admitsActor(actor.actorId))return null;
          const role=context.tokenUsageAuthority?.();
          return {actor:actor.actorId,administrator:role?.actorId===actor.actorId && role.administrator===true};
          }) : undefined;
        },
        pushObservation: (transport, hostId) => new PushObservationTransport(transport, value => {
          const turnPush = lateTurnPush.current();
          if (!turnPush || actorStore.get(value.actorId)?.kind !== 'human') return;
          void Promise.resolve(turnPush.store.watch(value.actorId, conversationExecution.serverForHost(hostId, value.threadId), hostId, value.threadId, value.inputId)).catch(() => {});
        }),
      },
      hostTransports, remoteServers, sshManagement: lateSshManagement });
    const { serverInformationService } = installation.openServerInformation(fileStateDocumentStore(dataDirectory));
    const { accountModelDefaultsService, threadReadReceiptsService, personalSshKeys, actorSshKeysService } = await installation.openPersonalServices({ sshLogin: !!ingressConfiguration });
    const turnPush = lateTurnPush.bind(await installation.openTurnPush({
      openStore: () => openPushStore(join(dataDirectory, 'web-push.sqlite')),
      createService: (store, pushOptions) => new TurnPushService(store, { ...pushOptions, wake: ownerWake }),
      appHost: clientSession.appHost, imPlugins: lateImPlugins, conversationExecution }));
    await turnPush.initialize();
    const sshManagement = lateSshManagement.bind(await nodeLocal.openSshManagement({
      enabled: host === "127.0.0.1" || options.sshPublicAccess, publicAccess: options.sshPublicAccess, accessFile: options.sshAccessFile,
      requireAccessKey: options.sshRequireAccessKey, appHost: appHostServer, sshServers,
    }));
    const observability = await nodeLocal.startObservability({ configFile: process.env.OPENCRAFT_OBSERVE_INGRESS_CONFIG,
      access: instanceAccess, actors: actorStore, executionHealth: options.getExecutionHealth, wake: ownerWake });
    const fileDownloads = workspaceHost.openFileDownloads({ createFileDownloads: resolve => new HostFileDownloads(resolve),
      remoteServers, sshManagement });
    // Explicit opt-in only: loaded once instance authentication and admission exist,
    // before the listener opens so declared routes are mounted from the first request.
    await edge.startRuntimePlugins(runtimePluginConfiguration ? () => startHeadlessRuntimePlugins(runtimePluginConfiguration,
      { dataDirectory, fileSystemOwner: options.fileSystemOwner, instanceAccess, authService: humanAuth }) : undefined);
    // The Web server: the route table and its socket are Node constructions; the
    // edge module assembles their options from every module's services.
    await edge.startServiceIngress(composition.createServiceIngress && (() => openServiceIngress(composition.createServiceIngress, {
      conversation: externalConversationPort(orchestrationStorage, conversationExecution),
    })));
    await edge.openWeb({ createWebServer: options.createWebServer ?? createWorkbenchWebServer,
      webRoot, userPluginDirectory, productPluginAssets, workbenchAssetsPlugin: options.workbenchAssetsPlugin,
      webRelease, isolateBrowserStorage: options.isolateBrowserStorage, machineIdentity,
      observability, ownerWake, getExecutionHealth: options.getExecutionHealth, hostReadiness: workspaceHost.hostReadiness,
      // The App Server, driver, query and Hands sessions for the server's own Host.
      sessions: clientSession.openWebSessions({ actorCollaboration, conversationExecution, signExecutionCli, operator, usageQueries, actorStore,
        terminalService: options.terminalOwner ? terminalService : undefined, terminalScope, fileSystem, resourceAuthority,
        selectHostTerminalService: composition.selectHostTerminalService, selectHostFiles: composition.selectHostFiles,
        sessions: {
          terminal: (service, scope, hostId, select) => new HostTerminalSession(service, scope, composeHostTerminalSelector(hostId, service, select)),
          files: (files, authority, select) => new HostFileSystemSession(files, authority, composeHostFileSelector(files, authority, select)),
        } }),
      agent, agentIdentity, mcpApps, imPlugins: lateImPlugins, connectorService, loopbackOnly: host === "127.0.0.1", localAccess,
      appHostServer, sshServers, sshManagement, fileDownloads, turnPush, serverStorage, remoteBrowser, identity, loginAdmission,
      codexStorageOutcomes, desktop, desktopAccess, account, actorAccess, actorStore, instanceAccess, assetsService, actorCollaborationApi,
      serverInformationService, accountModelDefaultsService, threadReadReceiptsService, actorSshKeysService, humanAuth, accountApplication,
      hubController });
    workspaceHost.startResourceReconciliation({ appHostServer, ownerWake });
    const listenHost = options.listenHost ?? host;
    if (!["127.0.0.1", "0.0.0.0"].includes(listenHost)) throw new Error("Invalid listener host");
    // With SSH ingress the Web server listens privately and the node-local ingress owns the address.
    const address = await edge.listen({ host: listenHost, port, sshIngress: ingressConfiguration ? httpPort => nodeLocal.listenSshIngress({
      configuration: ingressConfiguration, httpPort, appHost: appHostServer, identitySshAccess: identity?.sshAccess, personalSshKeys,
      codexExecutable: options.codexExecutable ?? join(root, "runtime/codex/bin/codex"), host: listenHost, port }) : undefined });
    nodeLocal.connectRelay(relayConfiguration, address.port);
    hubController.node?.start(hubTargetPort ?? address.port);
    workspaceHost.maintainReadiness(appHostServer, Boolean(options.codexCoreEndpoint));
    // Per-Actor sources replace the installation-wide provider; an identity
    // composition's providers are merged after them, as before. Without Actor
    // admission the installed source is published under the Worker's
    // deployment-registered backends; the installation selects one of them.
    const environmentProviders=installedBotProvider&&!botAdmission?Object.fromEntries(assetsStorage.botBackends.map(id=>[id,installedBotProvider])):{};
    const environmentProvidersFor=botAdmission?async context=>({...await installedBotProvider.forContext(context),
      ...(await identity?.environmentProvidersFor?.(context) ?? {})}):identity?.environmentProvidersFor;
    personalAssistantHost = await createPersonalAssistantHost({directory:dataDirectory,service:actorCollaboration,environmentProviders,environmentProvidersFor,
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
    lateImPlugins.bind(await startImPlugins(imConfiguration,{dataDirectory,capabilities,prepareCapabilities: tools => capabilityMcp.prepare(tools),actors:actorStore,collaboration:actorCollaboration,actorAccess,getAppHost:() => appHostServer,admittedActor:actorId => !instanceAccess || instanceAccess.admitsActor(actorId),...await createChannelSyncDependencies(composition,channelSyncContext({collaboration:actorCollaboration,relayConnectFile:relayConfiguration ? options.relayConnectFile : undefined}))}));
    await nodeLocal.startAvailabilityNotification({ configFile: process.env.OPENCRAFT_AVAILABILITY_NOTIFICATION_CONFIG,
      getImService: () => lateImPlugins.current() });
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
