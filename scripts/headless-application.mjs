#!/usr/bin/env node
import { startAvailabilityNotification } from './availability-notification.mjs';
import { ExecutionEnvironmentTransport } from './execution-environment-transport.ts';
import { HeadlessConnectors } from "../packages/connector-host/src/headless.ts";
import { CapabilityBindings } from "../packages/session-capabilities/src/bindings.ts";
import { SessionCapabilities } from "../packages/session-capabilities/src/index.ts";
import { SessionCapabilityMcp, capabilitySigningKey } from "../packages/session-capabilities/src/mcp.ts";
import { RemoteBrowserService } from './remote-browser-service.mjs';

import { createObservabilityIngress } from "./observability-ingress.mjs";
import { existsSync } from "node:fs";

import { access, chmod, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import lockfile from "proper-lockfile";
import { createSshHttpIngress, loadSshIngressConfiguration } from "@opencraft/ssh-http-ingress/server";
import { createSshNativeRpcGateway } from "./ssh-native-rpc-gateway.mjs";
import { createSshCodexControl } from "./ssh-codex-control.mjs";

import { McpAppsService } from "../packages/mcp-apps/src/server.ts";
import { McpAppsTransport } from "../packages/mcp-apps/src/transport.ts";
import { AppHostServer } from "../packages/app-host-server/src/index.ts";
import { AppServerIdentityOverlay } from "../apps/opencraft-daemon/src/appserver-identity-overlay.ts";
import { TokenUsageQuerySession, TokenUsageQueryTransport } from "../apps/opencraft-daemon/src/token-usage-query-transport.ts";
import { TokenUsageQueryService } from "../apps/opencraft-daemon/src/token-usage-query-service.ts";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.ts";
import { MachineIdentityTransport } from "../apps/opencraft-daemon/src/machine-transport.ts";
import { ExecutionOwnershipTransport } from "../apps/opencraft-daemon/src/execution-ownership-transport.ts";
import { ExecutionLeaseStore } from "../apps/opencraft-daemon/src/execution-lease-store.ts";
import { ThreadIdentityDatabase } from "../apps/opencraft-daemon/src/thread-identity-database.ts";
import { observeNativeExecutionProcess } from "../apps/opencraft-daemon/src/native-execution-origin.ts";
import { createWebSocketExecutionTurnInspector } from "../apps/opencraft-daemon/src/native-execution-inspector.ts";
import { AgentDriverTransport } from "../apps/opencraft-daemon/src/agent-driver-transport.ts";
import { WebSocketTransport } from "../packages/appserver-transport-websocket/src/index.ts";
import { WebSocket } from 'ws';
import { readDaemonMachineIdentity } from "../apps/opencraft-daemon/src/machine-identity.ts";
import { readSshCodexServerBindings, createSshCodexEngineAdapter } from "../apps/opencraft-daemon/src/ssh-codex-connections.ts";
import { SshManagement } from "../apps/opencraft-daemon/src/ssh-management.ts";
import { HostFileDownloads } from "../apps/opencraft-daemon/src/host-file-downloads.ts";
import { startLocalAgentHost } from "../apps/local-agent-host/src/main.ts";
import { startEngineHost } from "../apps/local-agent-host/src/engine-host.ts";
import { createPiModelConfiguration } from "../apps/local-agent-host/src/model-config/pi-adapter.ts";
import { attachEngineHost } from './server-deployment/engine-host-client.mjs';
import { PiEngine } from "../plugins/pi-engine/src/index.ts";
import { createWorkbenchWebServer } from "./serve-workbench-web.mjs";
import { loadLocalMachineAccess } from './local-machine-access.mjs';
import { maintainHeadlessCodexHost } from "./headless-host-readiness.mjs";
import { readTaskCodexConversations } from "./tasks-conversation-catalog.mjs";
import { assertHeadlessWebRelease } from "./headless-web-release.mjs";
import { LocalDesktopService } from "../apps/local-agent-host/src/desktop/local-desktop-service.ts";
import { createNativeObserver, localDesktopMachineIdentity } from "../apps/local-agent-host/src/desktop/native-observer.ts";
import { createNativeDesktopControl } from "../apps/local-agent-host/src/desktop/native-control.ts";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../apps/local-agent-host/src/model-config/repository.ts";
import { SpeechModelConfiguration } from "../apps/local-agent-host/src/model-config/speech.ts";
import { SpeechTranscriptionService } from "./speech-transcription-service.mjs";
import { MembershipStore, InstanceAccess } from '../packages/access-control/src/index.ts';
import { ActorStore } from '../packages/access-control/src/actors.ts';
import { ActorAccess } from '../packages/access-control/src/actor-access.ts';
import { Collaboration, CollaborationError, CollaborationHttpApi } from '../packages/access-control/src/collaboration.ts';
import { ThreadOrchestrationBroker } from '../packages/access-control/src/thread-orchestration-broker.ts';
import { createThreadOrchestrationExecution, driverForThread } from './thread-orchestration-execution.mjs';
import { THREAD_ORCHESTRATION_TOOLS } from '../packages/appserver-protocol/src/collaboration.ts';
import { createRoutedConversationExecution, callConversationHost } from './conversation-execution.mjs';
import { PushStore, TurnPushService, PushObservationTransport } from '../packages/web-push-node/src/index.ts';
import { readImConfiguration, startImPlugins } from './im-plugins.mjs';
import { HumanAccounts } from '../packages/access-control/src/human-accounts.ts';
import { LocalAccountServerPlugin } from '../plugins/local-account/src/server.ts';
import { LocalAccountApplication } from '../plugins/local-account/src/application.ts';
import { readPrivateJson } from '../packages/identity-core/src/node.ts';
import { HumanAccountManagement } from '../packages/access-control/src/account-management.ts';
import { HumanAuth, readHumanAuthConfiguration } from '../packages/access-control/src/human-auth.ts';
import { humanLoginPage } from './human-login-page.ts';
import { connectRelay, loadRelayConnection } from '../plugins/relay-connect/src/server.ts';
import { validateHeadlessIdentity } from "./headless-identity.mjs";
import { createHubController } from '../packages/hub-network/src/controller.ts';

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
  let allowUnauthenticatedPublic = false;
  let localDesktop = false;
  let trustedInternalDesktop = false;
  let desktopControl = false;
  let dataDirectory = env.OPENCRAFT_SERVER_DATA_DIR;
  let machineName = env.OPENCRAFT_MACHINE_NAME;
  let engines = ["dsh"];
  let defaultEngine;
  let sshServersFile;
  let sshConfig;
  let sshPublicOrigin;
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
    } else if (argument === "--default-engine") {
      defaultEngine = argv[++index];
    } else if (argument === "--machine-name") {
      machineName = argv[++index];
      if (!machineName?.trim() || machineName.startsWith("--")) throw new Error("--machine-name requires a name");
    } else if (argument === "--data-dir") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--data-dir requires a path");
      dataDirectory = value;
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
    } else if (argument === "--ssh-public-origin") {
      sshPublicOrigin = argv[++index];
      const url = new URL(sshPublicOrigin);
      if (url.protocol !== "https:" || url.origin !== sshPublicOrigin) throw new Error("--ssh-public-origin requires a fixed HTTPS origin");
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
  if (sshPublicAccess && sshPublicOrigin) throw new Error("Choose either --ssh-public-access or --ssh-public-origin");
  if (sshServersFile && host !== "127.0.0.1" && !sshPublicOrigin && !sshPublicAccess) throw new Error("SSH Servers require a protected listener");
  if (localDesktop && trustedInternalDesktop) throw new Error("Choose either local or trusted-internal desktop access");
  // Authentication may come from persisted Hub enrollment; validate provider
  // availability after private configuration is loaded, before starting execution.
  if (desktopControl && !localDesktop && !trustedInternalDesktop) throw new Error("Desktop control requires an explicit desktop access policy");
  if (localDesktop && host !== "127.0.0.1") throw new Error("Local desktop requires a loopback-only listener");
  defaultEngine ??= engines[0];
  if (!engines.includes(defaultEngine)) throw new Error("Default engine must be enabled");
  return { help: false, host, port, ...(hubTargetPort === undefined ? {} : { hubTargetPort }), ...(engineHostDescriptor ? {engineHostDescriptor} : {}), ...(engines.length !== 1 || engines[0] !== "dsh" ? { engines, defaultEngine } : {}), dataDirectory: resolve(dataDirectory), allowUnauthenticatedPublic,
    ...(machineName ? { machineName } : {}),
    ...(sshConfig ? { sshConfig } : {}),
    ...(accessControl ? { accessControl } : {}), ...(relayConnectFile ? { relayConnectFile } : {}),
    ...(humanAuthConfig ? { humanAuthConfig } : {}),
    ...(localAccessFile ? { localAccessFile } : {}),
    ...(imConfigFile ? { imConfigFile } : {}),
    ...(accessMemberProviders.length ? { accessMemberProviders } : {}),
    ...(localDesktop || trustedInternalDesktop ? { localDesktop: true } : {}),
    ...(trustedInternalDesktop ? { desktopAccess: "trusted-internal" } : {}),
    ...(desktopControl ? { desktopControl: true } : {}),
    ...(sshServersFile ? { sshServersFile } : {}), ...(sshPublicOrigin ? { sshPublicOrigin } : {}), ...(sshPublicAccess ? { sshPublicAccess: true } : {}), ...(sshAccessFile ? { sshAccessFile } : {}), ...(sshRequireAccessKey ? { sshRequireAccessKey: true } : {}) };
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
  const localAccess = await loadLocalMachineAccess(options.localAccessFile);
  if (composition.createIdentity !== undefined && typeof composition.createIdentity !== "function") throw new Error("Invalid Headless identity factory");
  if (composition.isHuman !== undefined && typeof composition.isHuman !== "function") throw new Error("Invalid Headless human qualification");
  const root = resolve(options.root ?? packageRoot);
  const dataDirectory = resolve(options.dataDirectory ?? join(homedir(), ".opencraft-server"));
  const webRoot = resolve(options.webRoot ?? join(root, "web"));
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
  if (options.sshPublicAccess && options.sshPublicOrigin) throw new Error("Choose either SSH public access or a fixed origin");
  if (sshServers.length && host !== "127.0.0.1" && !options.sshPublicOrigin && !options.sshPublicAccess) throw new Error("SSH Servers cannot be exposed through an unauthenticated public listener");
  const remoteServers = new Map(sshServers.map(binding => [binding.descriptor.serverId, binding]));
  if (remoteServers.size !== sshServers.length) throw new Error("Duplicate SSH Server identity");
  const desktopAccess = options.desktopAccess ?? "loopback";
  if (!["loopback", "trusted-internal"].includes(desktopAccess)) throw new Error("Invalid desktop access policy");
  if (options.desktopAccess !== undefined && options.localDesktop !== true) throw new Error("Desktop access requires local desktop");
  if (options.desktopControl && options.localDesktop !== true) throw new Error("Desktop control requires local desktop");
  if (options.localDesktop && desktopAccess === "loopback" && host !== "127.0.0.1") throw new Error("Local desktop requires a loopback-only listener");
  await access(join(webRoot, "index.html"));
  await assertHeadlessWebRelease(webRoot);
  await secureDataDirectory(dataDirectory);
  const releaseLock = await lockfile.lock(join(dataDirectory, "server"), { realpath: false, retries: 0 });
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
  let membership;
  let actorStore;
  let actorCollaboration;
  let threadOrchestration;
  let actorCollaborationApi;
  let actorAccess;
  let humanAccounts;
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
  let observability;
  let turnPush;
  let closing = null;
  const close = () => {
    if (closing !== null) return closing;
    capabilitiesReadyResolve();
    codexReadiness?.close();
    usageQueries?.close();
    observability?.close();
    closing = (async () => {
      relay?.close();
      hubController?.close();
      remoteBrowser?.close();
      fileDownloads?.close();
      desktop?.close(); // Retire viewers before the execution provider; never stop the desktop.
      await turnPush?.close();
      // Retire admitted ingress clients before their Host provider.
      await availabilityNotification?.close();
      const entryResults = await Promise.allSettled([ ingress?.close(), sshNativeRpc?.close(), imPlugins?.close()]);
      threadOrchestration?.stop();
      await appHostServer?.close();
      await threadOrchestration?.close();
      entryResults.push(...await Promise.allSettled([connectorService?.close(), actorCollaboration?.close()]));
      const results = [...entryResults, ...await Promise.allSettled([web?.close(), appHostServer?.close(), agent?.close()])];
      if (releasePiOwner) results.push(...await Promise.allSettled([releasePiOwner()]));
      results.push(...await Promise.allSettled([(await dshAgent?.catch(() => undefined))?.close()]));
      results.push(...await Promise.allSettled([capabilityMcp?.close()]));
      executionRecovery?.close();
      results.push(...await Promise.allSettled([agentIdentity?.close()]));
      executionDatabase?.close();
      // Settle every provider/store before releasing the directory lock, even
      // when one disposer throws synchronously or returns a rejected promise.
      for (const dispose of [() => mcpApps?.close(), () => sshManagement?.close(), () => identity?.executionEnvironment?.close(), () => identity?.close?.(),
        () => accountApplication?.close(), () => accountManagement?.close(), () => humanAuth?.close(), () => humanAccounts?.close(),
        () => capabilityBindings?.close(), () => actorStore?.close(), () => membership?.close(), () => releaseLock()]) {
        results.push(...await Promise.allSettled([Promise.resolve().then(dispose)]));
      }
      const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "OpenCraft server shutdown failed");
    })();
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
      membership = new MembershipStore(join(dataDirectory, 'memberships.sqlite'));
    const machineIdentity = await readDaemonMachineIdentity(dataDirectory, options.machineName);
    // Identity adapters can bind their own credentials to this stable Human authority.
    actorStore = new ActorStore(join(dataDirectory, 'actors.sqlite'));
    if (composition.createIdentity) {
      identity = await composition.createIdentity({ dataDirectory, membership, relayConfiguration,
        hubAuthority: hubController.node?.store.state.authority ?? null,
        resolveIdentity: request => instanceAccess?.authenticate(request) ?? null,
        getInstanceAccess: () => instanceAccess, machineIdentity, actors: actorStore, sshIngressEnabled: !!ingressConfiguration });
      validateHeadlessIdentity(identity);
      for (const provider of identity?.capabilityProviders ?? []) capabilities.register(provider);
    }
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
      humanAccounts = new HumanAccounts(join(dataDirectory, 'human-logins.sqlite'), actorStore);
      if (humanConfiguration.local) {
        const localAccounts = new LocalAccountServerPlugin(humanAccounts.localAccountRepository);
        humanAccounts.registerLocalAccounts(localAccounts);
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
        accountManagement = new HumanAccountManagement(join(dataDirectory, 'account-onboarding.sqlite'), humanAccounts, actorStore, membership);
        accountApplication = new LocalAccountApplication({ auth: humanAuth, management: accountManagement, setupToken });
      }
    }
    const providers = [...(humanAuth ? [humanAuth] : []), ...externalProviders];
    if (membership) instanceAccess = new InstanceAccess(membership, providers, actorStore, options.accessMemberProviders ?? [], identity?.admissionPolicy);
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
    const engines = options.engines ?? ["dsh"];
    if (engines.some(engine => !['dsh','pi'].includes(engine)) && !options.engineHostDescriptor)
      throw new Error('ACP and Claude execution require an independent Engine Host descriptor');
    let piEngine;
    let independentEngine;
    const conversationExecution = createRoutedConversationExecution(() => appHostServer, {machineId:machineIdentity.machineId,engines,
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
    actorCollaboration = new Collaboration(join(dataDirectory, 'actor-collaboration.sqlite'), actorStore,
      conversationExecution, Date.now, actorId => !instanceAccess || instanceAccess.admitsActor(actorId));
    actorCollaborationApi = new CollaborationHttpApi(actorCollaboration, actorAccess);
    actorCollaboration.start();
    threadOrchestration = new ThreadOrchestrationBroker(actorCollaboration, createThreadOrchestrationExecution(() => appHostServer, {
      enabled: ['codex', ...engines.filter(engine => engine !== 'dsh')], prepared: id => actorCollaboration.spawnPreparation(id),
    }));
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
    capabilityBindings = new CapabilityBindings(join(dataDirectory, "session-capabilities.sqlite"));
    capabilityMcp = new SessionCapabilityMcp(capabilities, capabilitySigningKey(join(dataDirectory, "session-capabilities.key")), capabilityBindings, {
      descriptorPath:join(dataDirectory,'session-capabilities.json'),
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
    const startAgent = options.startAgentHost ?? startLocalAgentHost;
    const startDsh = () => dshAgent ??= startAgent({
      sessionCapabilities: capabilities.scoped(`server:${machineIdentity.machineId}:dsh`),
      dshExecutable: options.dshExecutable ?? join(root, "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
      dshCapabilityPlugin: options.dshCapabilityPlugin ?? join(root, "runtime/dsh/opencraft-capability-plugin.mjs"),
      runtimeDirectory: options.runtimeDirectory ?? join(root, "runtime"),
      dataDirectory: join(dataDirectory, "agent"),
      modelStorageDirectory: join(dataDirectory, "models"),
      speechModelManagement: true,
      projectStorageDirectory: join(dataDirectory, "projects"),
      environmentDataDirectory: identity?.executionEnvironment ? dataDirectory : undefined,
      projectlessWorkspaceDirectory: join(dataDirectory, "workspaces"),
      skillsDirectory: join(dataDirectory, "skills"),
      taskSkillDirectories: [join(dataDirectory, "codex/runtime/skills")],
      taskServerId: "opencraft-server",
      taskConversationCatalog: (serverId, search, limit, cursor) => {
        if (serverId !== "local-codex" || !appHostServer) throw new Error("Task conversation server is unavailable");
        return readTaskCodexConversations(appHostServer, search, limit, cursor);
      },
      machineIdentity,
    }).catch(error => {dshAgent=undefined;throw error;});
    if (options.engineHostDescriptor) {
      independentEngine = await attachEngineHost(options.engineHostDescriptor, dataDirectory, machineIdentity.machineId,
        engines, options.defaultEngine ?? (engines.includes("dsh") ? "dsh" : "pi"));
      agent = independentEngine;
    } else if (engines.includes("pi")) {
      releasePiOwner = await lockfile.lock(join(dataDirectory, "pi-owner"), {realpath:false,retries:0});
      const piModels = await createPiModelConfiguration(join(dataDirectory, "models"), join(dataDirectory, "pi"));
      piEngine = new PiEngine({ ...piModels, executionEnvironment: identity?.executionEnvironment, sessionCapabilities: capabilities.scoped(`server:${machineIdentity.machineId}:pi`), dataDirectory, directory: join(dataDirectory, "pi"), attachmentDirectory: join(dataDirectory, "agent", "attachments"), cwd: options.runtimeDirectory ?? join(root, "runtime") });
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
        resources: { projectDirectory: join(dataDirectory, "projects"), attachmentDirectory: join(dataDirectory, "agent", "attachments") },
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
    usageQueries = new TokenUsageQueryService({
      entry: existsSync(fileURLToPath(new URL('./token-usage-query-worker.mjs', import.meta.url)))
        ? fileURLToPath(new URL('./token-usage-query-worker.mjs', import.meta.url))
        : fileURLToPath(new URL('../apps/opencraft-daemon/src/token-usage-query-worker.ts', import.meta.url)),
      databasePath: join(dataDirectory, 'codex', 'token-usage.sqlite'),
      serverId: `server:${machineIdentity.machineId}:codex`,
      ...(process.env.OPENCRAFT_TOKEN_USAGE_SOURCE === 'ledger' ? {} : {rollout:{nativeHome:join(dataDirectory,'codex','runtime'),
        ...(options.codexCoreEndpoint ? {coreEndpoint:options.codexCoreEndpoint,coreAuthToken:options.codexCoreAuthToken} : {})}}),
    });
    appHostServer = new AppHostServer({
      logicalClientRouting: true,
      physicalHostLifetime: "server",
      createTransport(hostId) {
        const transport = (() => {
        if (hostId === 'opencraft-server') return new TokenUsageQueryTransport(new MachineIdentityTransport(machineIdentity,'OpenCraft',async () =>
          new AgentDriverTransport(new ExecutionOwnershipTransport(new WebSocketTransport({url:agent.resolveWebsocketUrl?await agent.resolveWebsocketUrl():agent.websocketUrl,createSocket:url=>new WebSocket(url)}), executionStore, resolveExecutionNative), actorCollaboration,
            threadId => conversationExecution.serverForHost('opencraft-server', threadId))), usageQueries, actorId => actorStore.get(actorId));
        const remote = remoteServers.get(hostId);
        if (remote) return new MachineIdentityTransport(null, "Codex", () => createSshCodexEngineAdapter(remote, dataDirectory, createThreadMetadata, storageOpened(hostId)));
        if (hostId.startsWith("ssh:")) {
          const binding = sshManagement.store.binding(hostId);
          return new MachineIdentityTransport(null, "Codex", () => createSshCodexEngineAdapter(binding, dataDirectory, createThreadMetadata, storageOpened(hostId)));
        }
        if (hostId !== "local-codex") throw new Error(`Unknown server Host ${hostId}`);
        return new McpAppsTransport(new MachineIdentityTransport(machineIdentity, "Codex", () => options.createCodexTransport?.() ?? new CodexEngineAdapter({
          createSessionMcp: async () => {
            await capabilitiesReady;
            const reservation = capabilityMcp.prepareExecution();
            return { configuration: reservation.configuration,
              bind: (threadId, inputId, executionId) => reservation.bind({ serverId: actorCollaboration.execution.serverId,
                threadId, execution: { inputId, executionId } }),
              cancel: () => reservation.cancel() };
          },
          sessionMcp: async (threadId, inputId, executionId) => {
            await capabilitiesReady;
            const session = {serverId:actorCollaboration.execution.serverId, threadId, ...(inputId ? {execution:{inputId, ...(executionId ? {executionId} : {})}} : {})};
            await capabilities.refresh(session);
            return capabilityMcp.config(session);
          },
          createThreadMetadata,
          executionEnvironment: identity?.executionEnvironment,
          tokenUsage: {
            queryWorkerEntry: existsSync(fileURLToPath(new URL('./token-usage-query-worker.mjs',import.meta.url)))
              ? fileURLToPath(new URL('./token-usage-query-worker.mjs',import.meta.url))
              : fileURLToPath(new URL('../apps/opencraft-daemon/src/token-usage-query-worker.ts',import.meta.url)),
            serverId: `server:${machineIdentity.machineId}:codex`,
            ...(process.env.OPENCRAFT_TOKEN_USAGE_SOURCE === 'ledger' ? {} : {derivedQueries:usageQueries}),
            actor: context => actorStore.isCurrent(context) ? actorStore.get(context.actorId) : null,
            person: actorId => actorStore.get(actorId),
            submission: (threadId,inputId) => actorCollaboration.usageSubmission(threadId,inputId),
          },
          collaboration: {
    topology: threadId => actorCollaboration.threadTopology(threadId),
            queuedContext: (thread,inputId,input) => actorCollaboration.queuedReferenceContext(thread,inputId,input),
            continued: (thread,previous,turn) => actorCollaboration.executionContinued(thread,previous,turn),
            continuing: (thread,previous,inputId) => actorCollaboration.executionContinuing(thread,previous,inputId),
            inputDelegation: (thread,inputId,expected) => actorCollaboration.inputDelegation(thread,inputId,expected),
            prepare: (context,input) => actorCollaboration.referenceContext(context,input),
            command: (context, body) => actorCollaboration.command(context, body),
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
          onStorageOpened: storageOpened(hostId),
          executable: options.codexExecutable ?? join(root, "runtime/codex/bin/codex"),
          runtimeDirectory: options.runtimeDirectory ?? join(root, "runtime"),
          dataDirectory: join(dataDirectory, "codex"),
          coreEndpoint: options.codexCoreEndpoint,
          coreAuthToken: options.codexCoreAuthToken,
          coreHostOverlays: options.codexCoreEndpoint !== undefined,
          observationComponent: 'gateway',
          decorateNativeTransport: composition.decorateCodexNativeTransport,
          nativeCodexHomeDirectory: join(dataDirectory, "native-codex"),
          desktop,
        })), mcpApps);
        })();
        const scopedTransport = identity?.executionEnvironment && ['local-codex', 'opencraft-server'].includes(hostId)
          ? new ExecutionEnvironmentTransport(transport, identity.executionEnvironment, hostId) : transport;
        return ['local-codex', 'opencraft-server'].includes(hostId) ? new PushObservationTransport(scopedTransport, value => {
          if (!turnPush || actorStore.get(value.actorId)?.kind !== 'human') return;
          turnPush.store.watch(value.actorId, conversationExecution.serverForHost(hostId, value.threadId), hostId, value.threadId, value.inputId);
        }) : scopedTransport;
      },
    });
    turnPush = new TurnPushService(new PushStore(join(dataDirectory, 'web-push.sqlite')), {
      hosts: ['local-codex', 'opencraft-server'],
      authenticate: request => {
        const context = actorAccess.authenticate(request);
        return context && actorStore.get(context.actorId)?.kind === 'human'
          ? { context, loginDigest: humanAuth?.notificationLoginDigest(request) } : null;
      },
      current: binding => actorStore.isCurrent(binding.context) && actorStore.get(binding.context.actorId)?.kind === 'human'
        && (!instanceAccess || instanceAccess.admitsActor(binding.context.actorId))
        && (!binding.loginDigest || !!humanAccounts?.byDigest(binding.loginDigest)),
      trustedOrigin: request => actorAccess.options.trustedOrigin?.(request) ?? null,
      read: (hostId, method, params) => callConversationHost(appHostServer, {hostId, threadId:params.threadId}, 'push-history', method, params, undefined, 10_000),
    });
    // Local anonymous features remain usable. Public remote access is enabled
    // only with explicit operator opt-in; all remote sockets require a session.
    if (host === "127.0.0.1" || options.sshPublicOrigin || options.sshPublicAccess) sshManagement = new SshManagement({
      directory: join(dataDirectory, "ssh"), publicOrigin: options.sshPublicOrigin, publicAccess: options.sshPublicAccess, accessFile: options.sshAccessFile,
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
      if (hostId === "opencraft-server" || hostId === "local-codex") return "local";
      const binding = remoteServers.get(hostId) ?? (hostId.startsWith("ssh:") ? sshManagement?.store.binding(hostId) : null);
      if (!binding) throw new Error("Unknown file Host");
      return binding.connection;
    });
    const createWeb = options.createWebServer ?? createWorkbenchWebServer;
    web = await createWeb({
      root: webRoot,
      observability,
      getExecutionHealth: options.getExecutionHealth,
      getHostReadiness: () => codexReadiness ? { "local-codex": codexReadiness.snapshot() } : {},
      createAppServerQuerySession: emit => new TokenUsageQuerySession(usageQueries, emit, actorId => actorStore.get(actorId)),
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
      getPluginHealth: () => ({...(imPlugins ? {'opencraft.im':imPlugins.states()} : {}),...(turnPush ? {'opencraft.push':turnPush.health} : {})}),
      getStorageOutcomes: () => [
        ...(capabilityBindings ? [{name:'session-capabilities',status:capabilityBindings.outcome.status,appliedVersion:capabilityBindings.outcome.appliedVersion,movedAside:capabilityBindings.outcome.movedAsidePaths.length>0}] : []),
        ...(imPlugins ? [{name:'im-switchboard',status:imPlugins.outcome.status,appliedVersion:imPlugins.outcome.appliedVersion,movedAside:imPlugins.outcome.movedAsidePaths.length>0}] : []),
        ...(imPlugins ? [{name:'im-posts',status:imPlugins.postOutcome.status,appliedVersion:imPlugins.postOutcome.appliedVersion,movedAside:imPlugins.postOutcome.movedAsidePaths.length>0}] : []),
        ...(agent.storageOutcomes ?? []),
        ...(connectorService?.outcomes() ?? []),
        ...(turnPush ? [{name:'web-push',status:turnPush.store.outcome.status,appliedVersion:turnPush.store.outcome.appliedVersion,movedAside:turnPush.store.outcome.movedAsidePaths.length>0}] : []),
        {name:"mcp-apps",status:mcpApps.outcome.status,appliedVersion:mcpApps.outcome.appliedVersion,movedAside:mcpApps.outcome.movedAsidePaths.length>0},
        ...(agentIdentity ? [{ name: "thread-identity", hostId: "opencraft-server", status: agentIdentity.store.outcome.status,
          appliedVersion: agentIdentity.store.outcome.appliedVersion, backupPath: agentIdentity.store.outcome.backupPath,
          movedAside: agentIdentity.store.outcome.movedAsidePaths.length > 0 }] : []),
        ...(identity?.getStorageOutcomes?.() ?? []), ...[...codexStorageOutcomes.values()].flat(),
        { name: 'actor-collaboration', status: actorCollaboration.outcome.status, appliedVersion: actorCollaboration.outcome.appliedVersion,
          movedAside: actorCollaboration.outcome.movedAsidePaths.length > 0 },
        { name: 'actors', status: actorStore.outcome.status, appliedVersion: actorStore.outcome.appliedVersion,
          movedAside: actorStore.outcome.movedAsidePaths.length > 0 },
        ...(humanAccounts ? [{ name: 'human-logins', status: humanAccounts.outcome.status, appliedVersion: humanAccounts.outcome.appliedVersion,
          movedAside: humanAccounts.outcome.movedAsidePaths.length > 0 }] : []),
        ...(membership ? [{ name: 'memberships', status: membership.outcome.status, appliedVersion: membership.outcome.appliedVersion,
          movedAside: membership.outcome.movedAsidePaths.length > 0 }] : []),
        ...(sshManagement ? [{ name: "ssh-connections", status: sshManagement.store.outcome.status,
          appliedVersion: sshManagement.store.outcome.appliedVersion, backupPath: sshManagement.store.outcome.backupPath,
          movedAside: sshManagement.store.outcome.movedAsidePaths.length > 0 }] : []),
      ],
      desktopService: desktop ?? null,
      desktopAccess,
      identityService: identity?.service ?? null,
      accessService: instanceAccess ?? null,
      actorService: actorAccess,
      actorCollaborationService: actorCollaborationApi,
      turnPushService: turnPush,
      authService: humanAuth ?? null,
      accountService: accountApplication ?? null,
      hubService: hubController,
      remoteBrowserService: remoteBrowser = new RemoteBrowserService({ root, dataDirectory,
        allowNoSandbox: process.env.OPENCRAFT_BROWSER_ALLOW_NO_SANDBOX === '1' }),
      speechService: new SpeechTranscriptionService({ configuration: new SpeechModelConfiguration(
        new ModelConfigurationRepository(join(dataDirectory, "models")), new ModelCredentialRepository(join(dataDirectory, "models"))) }),
    });
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
    imPlugins = await startImPlugins(imConfiguration,{dataDirectory,capabilities,prepareCapabilities: tools => capabilityMcp.prepare(tools),actors:actorStore,collaboration:actorCollaboration,actorAccess,getAppHost:() => appHostServer,admittedActor:actorId => !instanceAccess || instanceAccess.admitsActor(actorId)});
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
      process.stdout.write('Optional instance-owned membership: --access-control (memberships.sqlite under --data-dir); administer with access-admin. --access-member-provider PROVIDER admits verified identities from that provider as ordinary members; explicit revocations and admin roles remain authoritative. --relay-connect-file ABSOLUTE_PRIVATE_JSON enables an outbound relay and requires instance membership.\n');
      process.stdout.write('Optional human login (bundled opencraft.account plugin for local accounts): --human-auth-config ABSOLUTE_PRIVATE_JSON (local accounts and OIDC); initialize new instances at /setup with a private setupTokenFile, or recover with human-account. setupTokenFile enables instance membership; otherwise add --access-control explicitly.\n');
      process.stdout.write('Optional same-machine managed Web workspace: --local-access-file ABSOLUTE_PRIVATE_FILE (also OPENCRAFT_LOCAL_ACCESS_FILE); the same private key file must be configured at the outer managed Web entry.\n');
      for (const line of help) process.stdout.write(line + '\n');
      process.stdout.write("Usage: opencraft-server [--host 127.0.0.1|0.0.0.0] [--port 10000] [--hub-target-port PORT] [--data-dir PATH] [--machine-name NAME] [--engines dsh,pi|pi|dsh] [--default-engine dsh|pi] [--ssh-servers PRIVATE_JSON] [--ssh-public-origin HTTPS_ORIGIN | --ssh-public-access] [--ssh-require-access-key] [--ssh-access-file PRIVATE_FILE] [--allow-unauthenticated-public] [--local-desktop | --trusted-internal-desktop] [--desktop-control]\nDefault: loopback only; SSH management uses shared installation access without an extra key. --ssh-require-access-key or --ssh-access-file enables key protection. Public SSH requires explicit opt-in; every permitted visitor can use saved connections in shared mode. HTTP provides no transport encryption. Desktop requires an installed verified observer. Trusted-internal desktop trusts everyone able to access this deployment; operator-owned network admission is required. Optional desktop control requires a separate installed private native executor.\n");
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
