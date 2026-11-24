import { WorkspaceNativeAdmission } from "../workspaces/native-admission.js";
import { createWorkspaceBotProvider } from "../workspaces/bot-client.js";
import { createEnvironmentAdmissionHandoff } from "../environment-admission-handoff.ts";
import { coreCodexEnvironmentLaunch } from "../codex-environment-launch.ts";
import { createGitStatusCapability } from "../git-status-capability.ts";
import { RemoteBrowserCapabilities } from "../remote-browser/capabilities.ts";
import { createCapabilityContextResolver } from "../capability-execution-context.ts";
import { createBrowserGrantResolver } from "../remote-browser/execution-grant.ts";
import { createHostEnvironmentLaunch } from "../host-environment-launch.ts";
import { NativeExecutionAuthority } from "../native-execution-authority.ts";
import {
  callConversationHost,
  createRoutedConversationExecution,
  readConversationCurrentTurn,
} from "../conversation-execution.mjs";
import { workspaceLifecycleRouting } from "../codex-workspace-hooks.mjs";
import { ConversationResourceLifecycle } from "../conversation-resource-lifecycle.mjs";
import { terminalResourceOwnerId } from "../host-resource-identity.ts";
import { periodicOwnerWork } from "@opencraft/owner-wake";
import { THREAD_ORCHESTRATION_TOOLS } from "@opencraft/appserver-protocol/collaboration";
import { createLateBinding } from "./lifecycle.mjs";
import { maintainHeadlessCodexHost } from "../headless-host-readiness.mjs";
import { CollaborationError } from "@opencraft/access-control/collaboration";
import { waitForExecutionCliBinding } from "@opencraft/session-capabilities/execution-cli";
import { createBridgeSessionMcp } from "@opencraft/opencraft-daemon/bridge-execution-admission";

/**
 * Workspace-host assembly (gateway-split §4.1.1), first part: the execution
 * delivery a workspace's runs consume and the capability surface they call.
 * The Assets vault, Bot and workspace execution owners and the Actor/lease
 * handoff with personal Git and ENV delivery; the remote browser with its
 * routing, capabilities and the capability context resolver, including the
 * native execution authorities of remote Codex Hosts; the session capability
 * listener, the execution CLI, the server's own Codex Engine Host and the
 * bridge session MCP; token usage queries; file downloads; and Codex Host
 * readiness. Second part: the routed conversation execution, the execution
 * engines (DSH, in-process Pi behind its owner lock, an independent Engine
 * Host), execution observation with the lease store and its bounded startup
 * reconciliation, the Hands terminal services and file owner, the
 * conversation resource lifecycle with its periodic reconciliation, and the
 * workspace-host layers of the local Hosts' App Host transports.
 *
 * It receives the composition root's shutdown state, the shared capability
 * registry and the late-bound ports for values constructed after the
 * closures that read them. Every runtime-specific construction (stores and
 * Workers opened by path, the personal Git worker process, the browser owner,
 * the capability listener and the CLI files, the Engine Host process, the
 * token usage query Worker and the file download transport) is supplied by
 * the composition root as a factory called at its original moment. Creating
 * it opens nothing. The root calls each step at its original position in
 * startup and each named disposer at its original position in the shutdown
 * order; a disposer for something that was never opened resolves without
 * effect.
 */
export function assembleWorkspaceHost({ lifecycle, capabilities, appHost, codexBridge, fileSystem }) {
  // Values constructed after the closures that read them, all within this module now.
  const conversationResources = createLateBinding("Conversation resource lifecycle");
  // The execution lease store and the native process observer, bound together.
  const executionObservation = createLateBinding("Execution observation");
  // The execution turn inspector, read by the ENV/Git handoff before it exists.
  const executionRecovery = createLateBinding("Execution recovery");
  const dshStart = createLateBinding("DSH engine start");
  let conversationExecution;
  let agent, dshAgent, piEngine, independentEngine, releasePiOwner;
  let agentIdentity, executionDatabase;
  let createTerminalService, terminalService, workspaceLifecycle, resourceReconciliationTimer;
  const terminalServices = new Map();
  let assetsStorage, botAdmission, installedBotProvider, ownedWorkspaceRouting, workspaceRouting;
  let assetsService, gitExecutionOwner, humanGitExecution, withdrawGitStatus, environmentLaunch, environmentHandoff;
  let executionIdentity, environmentMetadata, resourceAuthority, terminalScope;
  let remoteBrowser, browserCapabilities, authorizeBrowserExecution;
  let capabilityMcp, connectedExecutionCli, codexEngineHost;
  let usageQueries, fileDownloads, codexReadiness;
  // Native execution authorities of remote Codex Hosts, by their server ID;
  // written as their transports connect, read by browser and capability grants.
  const remoteExecutionAuthorities = new Map();
  return {
    /**
     * The Assets vault, Bot and workspace execution owners, the Actor/lease
     * handoff, personal Assets and Git, and ENV delivery. Runs right after
     * admission; every startup refusal keeps its original order.
     */
    async openExecutionDelivery({
      identity,
      workspaceExecution,
      workspaceRouting: identityRouting,
      coreEnvironmentLaunch,
      environmentIssuer,
      terminalOwner,
      machineIdentity,
      actorStore,
      instanceAccess,
      humanAuth,
      serverStorage,
      codexCoreEndpoint,
      readAssistantSandboxConfig,
      openAssetsStorage,
      openWorkspaceExecution,
      openHumanAssets,
      createHumanGitExecution,
    }) {
      workspaceRouting = identityRouting;
      executionIdentity = identity;
      // An identity product that owns configurations keeps its route and legacy partitions.
      // Never start a second resource writer alongside that composition.
      if (!identity?.assistantEnvironmentConfigurationManaged) {
        if (workspaceExecution && !workspaceRouting && !instanceAccess)
          throw Error("Workspace execution requires Human instance authority");
        assetsStorage = await openAssetsStorage({
          ...(workspaceExecution && !workspaceRouting
            ? {
                workspaceMachineId: machineIdentity.machineId,
                ...(terminalOwner ? { terminalOwner } : {}),
              }
            : {}),
          ...(coreEnvironmentLaunch
            ? { environmentLaunch: true, ...(environmentIssuer ? { environmentIssuer } : {}) }
            : {}),
        });
        if (!assetsStorage.botExecution) throw Error("Assets Bot execution owner unavailable");
        // Read when the vault is open, as before: the deployment's sandbox configuration, if any.
        const assistantSandboxConfig = readAssistantSandboxConfig();
        if (assistantSandboxConfig) {
          try {
            await assetsStorage.store.adoptWorkspaceInstallation(assistantSandboxConfig);
          } catch {
            console.warn("assistant_environment_configuration_unavailable");
          }
        }
        // With Human instance authority, a Bot owner's personal, platform and
        // installed environments are resolved per Actor in the vault Worker.
        if (instanceAccess) botAdmission = new WorkspaceNativeAdmission({ actors: actorStore, access: instanceAccess });
        installedBotProvider = createWorkspaceBotProvider({
          port: assetsStorage.store,
          onCleanupUnconfirmed: () => console.warn("assistant_environment_reconciliation_required"),
          ...(botAdmission ? { admission: (context) => botAdmission.admitResource(context.actorId) } : {}),
        });
        if (workspaceExecution && !workspaceRouting) {
          if (!assetsStorage.workspaceExecution) throw Error("Assets Native execution owner unavailable");
          ownedWorkspaceRouting = await openWorkspaceExecution({
            port: assetsStorage.store,
            actors: actorStore,
            access: instanceAccess,
            ...workspaceExecution,
            assertThreadActive: (threadId) => {
              const resources = conversationResources.current();
              if (!resources) throw Error("Workspace lifecycle is starting");
              resources.assertActive("local-codex", threadId);
            },
            onCleanupUnconfirmed: () => console.warn("workspace_cleanup_unconfirmed"),
          });
          workspaceRouting = ownedWorkspaceRouting;
        }
      }
      // Live checks shared by every Actor/lease handoff: the Actor is current and
      // admitted, and the lease is active for the live native process incarnation.
      const authorizeExecutionHandoff = (scope) => {
        const actorId = scope.account.slice("actor:".length),
          actor = actorStore.get(actorId);
        return (
          !lifecycle.closing() &&
          actor?.enabled === true &&
          actor.kind === "human" &&
          actor.generation === scope.actorGeneration &&
          instanceAccess.admitsActor(actorId)
        );
      };
      const inspectExecutionHandoff = async (handoff) => {
        const native = await executionObservation.current()?.resolveNative(handoff.scope.threadId);
        const recovery = executionRecovery.current();
        if (lifecycle.closing() || !recovery || !native || native.incarnation !== handoff.native.incarnation)
          return false;
        const state = await recovery.inspect({
          threadId: handoff.scope.threadId,
          inputId: handoff.scope.inputId,
          executionId: handoff.scope.executionId,
          generation: handoff.scope.leaseGeneration,
          turnId: handoff.native.turnId,
          engineIncarnation: handoff.native.incarnation,
          principal: null,
          ownership: "unknown",
          admittedAtMs: 0,
          endedAtMs: null,
        });
        return (
          state === "active" &&
          !lifecycle.closing() &&
          (await executionObservation.get().resolveNative(handoff.scope.threadId))?.incarnation === native.incarnation
        );
      };
      if (humanAuth && instanceAccess && !identity?.assistantEnvironmentConfigurationManaged) {
        assetsService = await openHumanAssets({
          auth: humanAuth,
          actors: actorStore,
          access: instanceAccess,
          openStorage: async () => ({ ...assetsStorage, close: async () => {} }),
        });
        if (!assetsService.gitAuthority) throw Error("Assets execution authority unavailable");
      }
      const identityLaunch = identity?.environmentLaunch;
      // One personal Git execution owner: core's assets vault Worker, or the
      // identity composition that owns the vault. Both hand off sealed grants only.
      if (identityLaunch?.git && assetsService) throw new Error("Personal Git execution cannot have two owners");
      if (identityLaunch?.git && !instanceAccess)
        throw new Error("Personal Git execution requires Human instance authority");
      gitExecutionOwner = assetsService
        ? Object.freeze({
            hosts: assetsService.gitHosts,
            authority: assetsService.gitAuthority,
            grant: (locator) => assetsService.executionGitGrant(locator),
            reservation: (locator) => assetsService.executionGitReservation(locator),
          })
        : identityLaunch?.git &&
          Object.freeze({
            hosts: Object.freeze([...identityLaunch.git.hosts]),
            authority: identityLaunch.git.authority,
            grant: (locator) => identityLaunch.git.grant(locator),
            reservation: (locator) => identityLaunch.git.reservation(locator),
          });
      if (gitExecutionOwner) {
        humanGitExecution = createHumanGitExecution({
          hosts: gitExecutionOwner.hosts,
          authority: gitExecutionOwner.authority,
          grant: gitExecutionOwner.grant,
          authorize: authorizeExecutionHandoff,
          inspect: inspectExecutionHandoff,
        });
        // The personal Git status tool exists only where the human Git owner does.
        withdrawGitStatus = capabilities.register(createGitStatusCapability(humanGitExecution));
      }
      environmentLaunch = identityLaunch ?? assetsStorage?.environmentLaunch;
      if (coreEnvironmentLaunch && !assetsStorage?.environmentLaunch)
        throw new Error("Environment delivery requires the sole vault owner");
      // A vault-owner port from the identity composition may bring its own
      // metadata port; core relays it exactly as for its own vault Worker.
      environmentMetadata = coreEnvironmentLaunch ? assetsStorage.environmentMetadata : identityLaunch?.metadata;
      if (coreEnvironmentLaunch && !environmentMetadata)
        throw new Error("Environment delivery requires the sole vault owner");
      // The same owner signs personal Git grants; Main never holds the vault key.
      if (coreEnvironmentLaunch && !assetsStorage.personalGitSeal)
        throw new Error("Environment delivery requires the sole vault owner");
      if (identityLaunch?.admission) {
        // Core's own vault Worker already owns the Actor/lease handoff.
        if (assetsService) throw new Error("Execution admission cannot have two owners");
        // The composition owns the durable read; core keeps the live checks.
        if (!instanceAccess) throw new Error("Environment delivery requires Human instance authority");
        environmentHandoff = createEnvironmentAdmissionHandoff({
          admission: (locator) => identityLaunch.admission(locator),
          authorize: authorizeExecutionHandoff,
          inspect: inspectExecutionHandoff,
          closed: lifecycle.closing,
        });
      } else if (environmentLaunch && humanGitExecution)
        environmentHandoff = (locator) => humanGitExecution.handoff(locator);
      // Codex: the split Codex Core receives creation and Turn ENV sealed for
      // core's durable records, and the adapter's Git owner hands off grants.
      const codexEnvironmentLaunch = coreCodexEnvironmentLaunch(
        environmentLaunch,
        serverStorage,
        codexCoreEndpoint,
        `server:${machineIdentity.machineId}:codex`,
        (actor) =>
          authorizeExecutionHandoff({ account: `actor:${actor.actorId}`, actorGeneration: actor.actorGeneration }),
      );
      // Missing delivery fails closed: a configured vault owner never lets Codex
      // run human Turns without its personal ENV or Git.
      if (environmentLaunch && codexCoreEndpoint && (!codexEnvironmentLaunch || !gitExecutionOwner))
        throw new Error("Codex environment delivery requires launch, creation admission and a personal Git owner");
      return {
        assetsStorage,
        botAdmission,
        installedBotProvider,
        ownedWorkspaceRouting,
        workspaceRouting,
        assetsService,
        gitExecutionOwner,
        humanGitExecution,
        environmentLaunch,
        environmentMetadata,
        codexEnvironmentLaunch,
      };
    },
    /**
     * The routed conversation execution: Thread to Host and server routing, and
     * explicit Host input submission recorded in the execution lease store.
     * Refuses engines this process cannot run before any engine starts.
     */
    openConversationExecution({ engines, engineHostDescriptor, machineIdentity }) {
      if (engines.some((engine) => !["dsh", "pi"].includes(engine)) && !engineHostDescriptor)
        throw new Error("ACP and Claude execution require an independent Engine Host descriptor");
      // Pi inside Main cannot host a receiver: delivered ENV must not reach this
      // process; with delivery, Pi runs only in the independent Engine Host.
      if (environmentLaunch && engines.includes("pi") && !engineHostDescriptor)
        throw new Error("Environment delivery requires the independent Pi engine host");
      conversationExecution = createRoutedConversationExecution(() => appHost.current(), {
        machineId: machineIdentity.machineId,
        engines,
        modelCatalog: true,
        connectedAgentsOwner: engines.includes("dsh") ? "dsh" : undefined,
        getInputs: async (engine) => {
          const inputs =
            engine !== "dsh"
              ? (independentEngine?.inputs ?? (engine === "pi" ? piEngine?.inputs : undefined))
              : (await dshStart.get()()).inputs;
          if (!inputs) return undefined;
          return {
            receipt: (...args) => inputs.receipt(...args),
            submit: async (threadId, inputId, text, canAdmit) => {
              const observation = executionObservation.current();
              if (!observation) throw new Error("Execution ownership unavailable");
              const { store: executionStore } = observation;
              const native = await observation.resolveNative(threadId);
              return inputs
                .submit(threadId, inputId, text, async () => {
                  if (!(await canAdmit())) return false;
                  // This explicit Host input is an agent, schedule or goal, not the
                  // person currently viewing the Thread.
                  executionStore.capture(
                    threadId,
                    inputId,
                    { principal: null, ownership: "unowned" },
                    "accepted",
                    "system",
                  );
                  executionStore.begin(threadId, inputId, native?.incarnation);
                  return true;
                })
                .then((receipt) => {
                  if (receipt?.state === "delivered" && receipt.turnId)
                    executionStore.started(threadId, receipt.turnId, inputId, native?.incarnation);
                  return receipt;
                });
            },
          };
        },
      });
      return conversationExecution;
    },
    /**
     * Opaque ENV delivery needs the same live Actor/lease handoff as Git; a
     * configured vault owner without it fails here, not at every command.
     */
    assertEnvironmentAdmission() {
      if (environmentLaunch && !environmentHandoff)
        throw new Error("Environment delivery requires execution admission");
    },
    /**
     * The remote browser owner, its routing into identity- or core-owned
     * workspaces, the browser capabilities and the capability context
     * resolver every provider reads the run's Host, Actor and lease from.
     */
    openBrowser({
      createRemoteBrowser,
      ownerConnector,
      conversationExecution,
      actorStore,
      instanceAccess,
      threadAccess,
      actorCollaboration,
      anonymousDeployment,
      operator,
    }) {
      remoteBrowser = createRemoteBrowser(
        ownerConnector
          ? { ownerConnector }
          : ownedWorkspaceRouting
            ? {
                ownerConnector: async () => {
                  throw Error("Local Hands browser owner unavailable");
                },
              }
            : {},
      );
      workspaceRouting?.connectBrowserRouting?.({
        service: remoteBrowser,
        assertThreadAccess: ({ ownerId, hostId, threadId }) => {
          const serverId = threadId === null ? null : conversationExecution.serverForHost(hostId, threadId);
          if (
            lifecycle.closing() ||
            !actorStore.get(ownerId)?.enabled ||
            !instanceAccess?.admitsActor(ownerId) ||
            (threadId !== null && !threadAccess.allowsActor(serverId, threadId, ownerId))
          )
            throw Error("Browser conversation authority revoked");
        },
      });
      authorizeBrowserExecution = (context, serverId, threadId) => {
        if (
          lifecycle.closing() ||
          !actorStore.isCurrent(context) ||
          actorStore.get(context.actorId)?.kind !== "human" ||
          (instanceAccess && !instanceAccess.admitsActor(context.actorId)) ||
          !threadAccess.allows(serverId, threadId, context)
        )
          throw new Error("Browser execution authority revoked");
      };
      browserCapabilities = new RemoteBrowserCapabilities(
        capabilities,
        remoteBrowser,
        createBrowserGrantResolver({
          serverForThread: (threadId, requested) =>
            remoteExecutionAuthorities.has(requested) ? requested : conversationExecution.serverForThread(threadId),
          hostForServer: (serverId) =>
            remoteExecutionAuthorities.get(serverId)?.hostId ?? conversationExecution.hostForServer(serverId),
          source: async (threadId, execution, serverId) =>
            remoteExecutionAuthorities.has(serverId)
              ? remoteExecutionAuthorities.get(serverId).authority.source(threadId, execution)
              : actorCollaboration.executionContext(threadId, execution),
          authorize: authorizeBrowserExecution,
          owner: (context) =>
            anonymousDeployment && operator.owns(context.actorId) ? "local-anonymous" : context.actorId,
          currentTurn: async (hostId, threadId, context) => {
            return readConversationCurrentTurn(
              appHost.current(),
              { hostId, threadId },
              { sender: null, actorContext: context },
            );
          },
        }),
      );
      // Providers read the run's Host, verified human Actor and active lease from
      // these owners instead of parsing serverId or opening execution stores.
      capabilities.resolveContext(
        createCapabilityContextResolver({
          route: (serverId, threadId) => {
            const remote = remoteExecutionAuthorities.get(serverId);
            if (remote) return { hostId: remote.hostId, engine: "codex" };
            const server = conversationExecution.servers.find((row) => row.serverId === serverId);
            try {
              if (!server || conversationExecution.serverForHost(server.hostId, threadId) !== serverId)
                return undefined;
            } catch {
              return undefined;
            }
            return { hostId: server.hostId, engine: server.engine ?? "codex" };
          },
          source: async (serverId, threadId, execution) =>
            remoteExecutionAuthorities.has(serverId)
              ? remoteExecutionAuthorities.get(serverId).authority.source(threadId, execution)
              : actorCollaboration.executionContext(threadId, execution),
          current: (context, serverId, threadId) => {
            try {
              authorizeBrowserExecution(context, serverId, threadId);
              return true;
            } catch {
              return false;
            }
          },
          bindings: (actorId) => actorStore.bindings(actorId),
          lease: async (locator) => (humanGitExecution ? humanGitExecution.handoff(locator) : null),
        }),
      );
      return { remoteBrowser, browserCapabilities };
    },
    /**
     * A remote Codex Host's native execution authority, replacing (and
     * invalidating) the previous one for its server; its native tools reach the
     * browser only while it is still the current authority.
     */
    remoteExecution(serverId, hostId) {
      remoteExecutionAuthorities.get(serverId)?.authority.invalidate();
      const authority = new NativeExecutionAuthority((context, threadId) =>
        authorizeBrowserExecution(context, serverId, threadId),
      );
      remoteExecutionAuthorities.set(serverId, { hostId, authority });
      return {
        authority,
        nativeTool: (context, tool, args, signal) =>
          remoteExecutionAuthorities.get(serverId)?.authority !== authority
            ? Promise.reject(new Error("Native execution authority replaced"))
            : browserCapabilities.invokeNative(
                {
                  serverId,
                  threadId: context.threadId,
                  execution: { turnId: context.turnId, callId: context.callId },
                },
                tool,
                args,
                signal,
              ),
      };
    },
    /**
     * The session capability listener and the execution CLI beside it; then,
     * when configured, the server's own Codex Engine Host (after the listener:
     * it forwards its execution CLI to this listener) and the bridge session MCP.
     */
    async openCapabilityMcp({
      capabilityKey,
      capabilityBindings,
      conversationExecution,
      anonymousDeployment,
      actorCollaboration,
      threadOrchestration,
      createCapabilityMcp,
      openExecutionCli,
      startCodexEngineHost,
    }) {
      capabilityMcp = createCapabilityMcp(capabilities, capabilityKey, capabilityBindings, {
        hostGit: async (session) => {
          if (
            session.serverId !== conversationExecution.serverForHost("opencraft-server", session.threadId) ||
            conversationExecution.hostForServer(session.serverId) !== "opencraft-server" ||
            (!session.execution?.inputId && !session.execution?.turnId)
          )
            throw Error("git_execution_unavailable");
          // Only explicit installation-level anonymous mode can run without a
          // personal authority. Missing login/observer/issuer is never fallback.
          if (!humanGitExecution) {
            if (anonymousDeployment) return { mode: "anonymous" };
            throw Error("git_execution_unavailable");
          }
          const grant = await humanGitExecution.handoff({
            hostId: "opencraft-server",
            threadId: session.threadId,
            ...(session.execution.inputId
              ? { inputId: session.execution.inputId }
              : { turnId: session.execution.turnId }),
          });
          return { authority: gitExecutionOwner.authority, hosts: gitExecutionOwner.hosts, grant };
        },
        ...(environmentLaunch
          ? {
              hostEnvironment: createHostEnvironmentLaunch({
                port: environmentLaunch,
                handoff: environmentHandoff,
                routes: (session) =>
                  !lifecycle.closing() &&
                  session.serverId === conversationExecution.serverForHost("opencraft-server", session.threadId) &&
                  conversationExecution.hostForServer(session.serverId) === "opencraft-server",
              }),
            }
          : {}),
        authorizeExecution: async (session) => {
          if (session.serverId !== conversationExecution.serverForThread(session.threadId))
            throw new CollaborationError(403, "execution_delegation_required");
          await actorCollaboration.admittedExecution(session.threadId, session.execution.inputId);
        },
        threadCli: async (session, request) => {
          await waitForExecutionCliBinding(() =>
            actorCollaboration.admittedExecution(session.threadId, session.execution.inputId),
          );
          return threadOrchestration.cli(session, request);
        },
        authorizeInput: (session, inputId) =>
          actorCollaboration.authorizeInput(session.threadId, inputId, "queue", undefined, session.serverId),
        orchestration: async (session, request) => {
          const fields = ["turnId", "callId", "name", "arguments", "inputId", "incarnation", "toolCallKey"];
          if (
            Object.keys(request).some((key) => !fields.includes(key)) ||
            !["turnId", "callId", "name", "incarnation"].every(
              (key) => typeof request[key] === "string" && request[key].length > 0 && request[key].length <= 512,
            ) ||
            !request.arguments ||
            typeof request.arguments !== "object" ||
            Array.isArray(request.arguments) ||
            (request.inputId !== undefined && (typeof request.inputId !== "string" || request.inputId.length > 512)) ||
            session.serverId !== conversationExecution.serverForThread(session.threadId)
          )
            throw new CollaborationError(400, "invalid_orchestration_source");
          if (request.inputId) actorCollaboration.executionStarted(session.threadId, request.inputId, request.turnId);
          const key = JSON.stringify([
            session.serverId,
            request.incarnation,
            session.threadId,
            request.turnId,
            request.callId,
          ]);
          const result = await threadOrchestration.invoke(
            session.threadId,
            request.turnId,
            key,
            request.name,
            request.arguments,
            undefined,
            request.incarnation,
          );
          return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
        },
      });
      await capabilityMcp.listen();
      connectedExecutionCli = await openExecutionCli({ endpoint: capabilityMcp.cliEndpoint, key: capabilityKey });
      if (startCodexEngineHost) {
        // After the capability listener: the Engine Host forwards its execution CLI (thread
        // spawn/tell/wait from a turn's shell) to this Server's /thread-cli, signed by its key.
        codexEngineHost = await startCodexEngineHost({ cliEndpoint: capabilityMcp.cliEndpoint });
        codexBridge.bind(codexEngineHost.bridge);
      }
      const bridgeSessionMcp = createBridgeSessionMcp(
        capabilityMcp,
        (threadId) => ({ serverId: conversationExecution.serverForThread(threadId), threadId }),
        (session) => capabilities.refresh(session),
      );
      return { capabilityMcp, connectedExecutionCli, codexEngineHost, bridgeSessionMcp };
    },
    /**
     * The execution engines: an independent Engine Host, or in-process Pi
     * behind its owner lock with DSH as its legacy engine, or DSH alone. DSH
     * starts once, on first use (eagerly when it is the only engine); a failed
     * start is retried on the next use.
     */
    async openEngines({
      engines,
      machineIdentity,
      actorCollaboration,
      threadOrchestration,
      readTaskConversations,
      startDsh: startDshAgent,
      attachIndependentEngine,
      acquirePiOwner,
      createPiEngine,
      startPiEngineHost,
    }) {
      const startDsh = dshStart.bind(
        () =>
          (dshAgent ??= startDshAgent({
            executionCli: connectedExecutionCli,
            sessionCapabilities: () => capabilities.scoped(`server:${machineIdentity.machineId}:dsh`),
            prepareArtifact: fileSystem
              ? (artifact, owner, signal) => fileSystem.prepareArtifact(artifact, owner, signal)
              : undefined,
            taskConversationCatalog: (serverId, search, limit, cursor) => {
              const appHostServer = appHost.current();
              if (serverId !== "local-codex" || !appHostServer)
                throw new Error("Task conversation server is unavailable");
              return readTaskConversations(appHostServer, search, limit, cursor);
            },
          }).catch((error) => {
            dshAgent = undefined;
            throw error;
          })),
      );
      if (attachIndependentEngine) {
        independentEngine = await attachIndependentEngine();
        agent = independentEngine;
      } else if (engines.includes("pi")) {
        releasePiOwner = await acquirePiOwner();
        piEngine = await createPiEngine({
          executionCli: connectedExecutionCli,
          executionGit: humanGitExecution,
          sessionCapabilities: () => capabilities.scoped(`server:${machineIdentity.machineId}:pi`),
        });
        // The in-process standalone mode has the same trusted port. Shared-server
        // deployments attach the independent owner through its descriptor instead.
        piEngine.setOrchestration({
          tools: THREAD_ORCHESTRATION_TOOLS,
          call: async (threadId, turnId, callId, name, args, _signal, inputId) => {
            if (inputId) actorCollaboration.executionStarted(threadId, inputId, turnId);
            const result = await threadOrchestration.invoke(
              threadId,
              turnId,
              JSON.stringify(["pi", piEngine.orchestrationIncarnation, threadId, turnId, callId]),
              name,
              args,
              undefined,
              piEngine.orchestrationIncarnation,
            );
            return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
          },
        });
        agent = await startPiEngineHost({ piEngine, startDsh });
      } else agent = await startDsh();
      return agent;
    },
    /**
     * Execution observation: the lease store (inside the Thread metadata
     * overlay when an identity owns Thread metadata, else the server's own
     * Thread identity database), the native process resolver and the turn
     * inspector; then a finite read-only reconciliation of unsettled leases.
     */
    async openExecutionObservation({
      createThreadMetadata,
      createIdentityOverlay,
      openExecutionLeases,
      reportedExecutionProcess,
      observeOwnProcess,
      createExecutionRecovery,
    }) {
      if (createThreadMetadata)
        agentIdentity = createIdentityOverlay({
          resolveTarget: async () =>
            agent.resolveWebsocketUrl ? await agent.resolveWebsocketUrl() : agent.websocketUrl,
          createMetadata: createThreadMetadata,
          resolveExecutionNative: async (threadId) => executionObservation.current()?.resolveNative(threadId) ?? null,
        });
      let executionStore;
      if (agentIdentity) executionStore = agentIdentity.executions;
      else ({ database: executionDatabase, store: executionStore } = openExecutionLeases());
      executionStore.suspend();
      // The owner reports the execution's process identity over its endpoint (workspace-host-split
      // §3.4); only the in-process Pi engine is observed here, inside the Gateway itself.
      const resolveExecutionNative = async (threadId) => {
        try {
          if (agent.getExecutionIdentity) {
            const { pid, incarnation } = await agent.getExecutionIdentity(threadId);
            return pid === null ? null : reportedExecutionProcess({ pid, incarnation });
          }
          if (threadId.startsWith("pi_") && piEngine) return await observeOwnProcess();
          return await (await dshStart.get()()).engineExecutionIdentity();
        } catch {
          return null;
        }
      };
      executionObservation.bind({ store: executionStore, resolveNative: resolveExecutionNative });
      const recovery = executionRecovery.bind(
        await createExecutionRecovery(async () =>
          agent.resolveWebsocketUrl ? agent.resolveWebsocketUrl() : agent.websocketUrl,
        ),
      );
      // A finite read-only reconciliation restores the original pre-send lease,
      // including tools born before Gateway loss; failure stays unknown.
      for (const threadId of executionStore.unsettledThreads().slice(0, 256)) {
        try {
          const native = await resolveExecutionNative(threadId);
          const observation = agent.getExecutionIdentity ? await agent.getExecutionIdentity(threadId) : null;
          if (native && observation?.turn && observation.pid === native.pid) {
            const turn = observation.turn;
            executionStore.reconcile(
              threadId,
              [
                {
                  id: turn.id,
                  status: turn.status,
                  items: turn.inputId ? [{ type: "userMessage", clientId: turn.inputId }] : [],
                },
              ],
              native.incarnation,
            );
          } else {
            const result = await recovery.readThread(threadId);
            if (native && Array.isArray(result?.thread?.turns))
              executionStore.reconcile(threadId, result.thread.turns, native.incarnation);
          }
        } catch {
          /* Authority cannot be inferred from a failed recovery read. */
        }
      }
      return { agentIdentity, executionStore, resolveExecutionNative };
    },
    /** Token usage queries over the deployment's existing Codex ledger. */
    openUsageQueries(createUsageQueries) {
      usageQueries = createUsageQueries();
      return usageQueries;
    },
    /**
     * The Hands terminal service per Host (created on first use), the one
     * workspace lifecycle owner, the conversation resource lifecycle that
     * releases terminals, browsers and workspaces, and the live authority
     * checks Host resources and terminal scopes run.
     */
    async openConversationResources({
      createTerminalService: terminalServiceFactory,
      identity,
      actorStore,
      instanceAccess,
      serverStorage,
      ownerWake,
    }) {
      createTerminalService = terminalServiceFactory;
      const unavailableTerminal = {
        probe: async () => {
          throw Error("Local Hands terminal unavailable");
        },
        subscribe: () => () => {},
        dispatch: async () => {
          throw Error("Local Hands terminal unavailable");
        },
        close() {},
      };
      terminalService = (hostId) => {
        if (!createTerminalService) return unavailableTerminal;
        let service = terminalServices.get(hostId);
        if (!service) {
          // A vault owner that admits terminal launches delivers ENV to the Hands
          // terminal owner as capsules; otherwise the synchronous path is unchanged.
          service = createTerminalService({
            environment: identity?.executionEnvironment,
            ...(typeof environmentLaunch?.terminalActor === "function" ? { environmentLaunch } : {}),
          });
          terminalServices.set(hostId, service);
        }
        return service;
      };
      // One workspace lifecycle owner: core's own routing, or identity routing
      // that carries the lifecycle members. Without them, no workspace owner.
      workspaceLifecycle = workspaceLifecycleRouting(ownedWorkspaceRouting, identity?.codexWorkspaceRouting);
      const resources = conversationResources.bind(
        await ConversationResourceLifecycle.open(
          serverStorage,
          {
            terminal: async (row) => {
              if (createTerminalService) {
                if (!remoteBrowser) throw Error("Resource bindings are starting");
                const aliases = (await remoteBrowser.threadAliases(row.hostId, row.threadId)).map((value) => ({
                  owner: terminalResourceOwnerId(value.actorId, row.hostId),
                  resourceOwnerId: value.resourceOwnerId,
                }));
                await terminalService(row.hostId).releaseThread(
                  row.hostId,
                  row.threadId,
                  row.state === "active",
                  aliases,
                );
              }
            },
            browser: async (row) => {
              if (!remoteBrowser) throw Error("Browser owner is starting");
              await remoteBrowser.releaseThread(row.hostId, row.threadId);
            },
            ...(workspaceLifecycle ? { workspace: (row) => workspaceLifecycle.releaseConversation(row) } : {}),
          },
          {
            diagnose: (value) => console.warn("[conversation-resources]", JSON.stringify(value)),
            wake: ownerWake,
            ...(workspaceLifecycle
              ? { dependencies: { workspace: ["browser"] }, replayOwners: ["browser", "workspace"] }
              : {}),
          },
        ),
      );
      if (remoteBrowser) remoteBrowser.conversationLifecycle = resources;
      resourceAuthority = (context) => {
        context.resourceOwner?.assertCurrent();
        const actor = context.actorContext;
        if (
          !actor ||
          !actorStore.isCurrent(actor) ||
          actorStore.get(actor.actorId)?.kind !== "human" ||
          (instanceAccess && !instanceAccess.admitsActor(actor.actorId)) ||
          (context.executionPrincipal && (!Number.isFinite(context.validUntil) || context.validUntil <= Date.now()))
        )
          throw new Error("Host resource authority expired");
      };
      terminalScope = (hostId) => (context, params) => {
        resourceAuthority(context);
        const actor = context.actorContext;
        resources.assertActive(hostId, params.threadId);
        const scope = identity?.executionEnvironment?.scope(context, hostId, params);
        for (const name of ["threadId", "projectId"])
          if (params[name] != null && (typeof params[name] !== "string" || !params[name] || params[name].length > 512))
            throw new Error("Invalid terminal scope");
        return {
          account: scope?.account ?? `actor:${actor.actorId}`,
          actorId: actor.actorId,
          hostId,
          threadId: params.threadId ?? null,
          projectId: scope?.projectId ?? params.projectId ?? null,
        };
      };
      return { conversationResources: resources, terminalService, resourceAuthority, terminalScope };
    },
    /**
     * The workspace-host layers of the local Hosts' App Host transports
     * (`local-codex`, `opencraft-server`): execution environment or ENV
     * metadata scoping and the workspace catalog, then (after the root's model
     * gateway settings layer) the Hands terminal and file transports behind the
     * resource authority and the conversation resource transport. The root
     * supplies the transport classes, which are Node transports today.
     */
    openHostTransports({ transports, selectHostTerminalService, selectHostFiles }) {
      const local = (hostId) => ["local-codex", "opencraft-server"].includes(hostId);
      const unavailableFiles = {
        request: async () => {
          throw Error("Local Hands files unavailable");
        },
      };
      return {
        scopeExecution(hostId, transport) {
          let scopedTransport = !local(hostId)
            ? transport
            : executionIdentity?.executionEnvironment
              ? transports.executionEnvironment(transport, executionIdentity.executionEnvironment, hostId)
              : environmentMetadata
                ? transports.environmentMetadata(transport, environmentMetadata, hostId)
                : transport;
          if (hostId === "local-codex" && workspaceRouting)
            scopedTransport = transports.workspaceCatalog(
              scopedTransport,
              (context) => workspaceRouting.readCatalog(hostId, context),
              typeof workspaceRouting.readFileScope === "function"
                ? (context, threadId) => workspaceRouting.readFileScope(hostId, context, threadId)
                : undefined,
            );
          return scopedTransport;
        },
        scopeResources(hostId, transport) {
          let scopedTransport = transport;
          if (local(hostId)) {
            const ordinary = hostId === "local-codex" ? ownedWorkspaceRouting : undefined;
            if (createTerminalService || ordinary)
              scopedTransport = transports.terminals(
                scopedTransport,
                terminalService(hostId),
                terminalScope(hostId),
                hostId,
                ordinary
                  ? (scope, context, localService) =>
                      ordinary.selectHostTerminalService(
                        hostId,
                        scope,
                        context,
                        selectHostTerminalService
                          ? (s, c) => selectHostTerminalService(hostId, s, c, localService)
                          : localService,
                      )
                  : selectHostTerminalService
                    ? (scope, context, localService) => selectHostTerminalService(hostId, scope, context, localService)
                    : undefined,
              );
            if (fileSystem || ordinary) {
              const localFiles = fileSystem ?? unavailableFiles;
              scopedTransport = transports.files(
                scopedTransport,
                localFiles,
                resourceAuthority,
                ordinary
                  ? (context, params, localBinding) =>
                      ordinary.selectHostFiles(
                        hostId,
                        context,
                        params,
                        selectHostFiles ? (c, p) => selectHostFiles(hostId, c, p, localBinding) : localBinding,
                      )
                  : selectHostFiles
                    ? (context, params, localBinding) => selectHostFiles(hostId, context, params, localBinding)
                    : undefined,
              );
            }
          }
          if (local(hostId))
            scopedTransport = transports.conversationResources(scopedTransport, hostId, conversationResources.get());
          return scopedTransport;
        },
      };
    },
    /**
     * File downloads for each Host: the local file owner, the server's own
     * files, or a configured or saved SSH connection.
     */
    openFileDownloads({ createFileDownloads, remoteServers, sshManagement }) {
      fileDownloads = createFileDownloads((hostId) => {
        if (hostId === "local-codex" && ownedWorkspaceRouting && !fileSystem)
          throw Error("Local Hands file downloads unavailable");
        if (hostId === "opencraft-server" || hostId === "local-codex") return fileSystem ?? "local";
        const binding =
          remoteServers.get(hostId) ?? (hostId.startsWith("ssh:") ? sshManagement?.store.binding(hostId) : null);
        if (!binding) throw new Error("Unknown file Host");
        return binding.connection;
      });
      return fileDownloads;
    },
    /**
     * Retries pending resource releases, then reconciles archived Threads'
     * resources now and on each period of the owner wake-up; a pass is skipped
     * while shutting down or while the previous one is still running.
     */
    startResourceReconciliation({ appHostServer, ownerWake }) {
      const resources = conversationResources.get();
      resources.retry();
      const reconciledResourceHosts = new Map();
      let resourceInventoryRunning = false;
      const reconcileResources = async () => {
        if (lifecycle.closing() || resourceInventoryRunning) return;
        resourceInventoryRunning = true;
        try {
          const scopes = [
            ...(await remoteBrowser.threadScopes()),
            ...(workspaceLifecycle?.conversationScopes() ?? []),
            ...(createTerminalService ? await terminalService("local-codex").threadScopes() : []),
          ];
          const hosts = new Set(
            scopes.map((scope) => scope.hostId).filter((id) => ["local-codex", "opencraft-server"].includes(id)),
          );
          // No resources means no reason to cold-start an execution engine merely
          // to inspect its archive catalog. Read metadata only for actual owners.
          for (const hostId of hosts)
            if (reconciledResourceHosts.get(hostId) !== resources.hostRevision(hostId)) {
              const revision = resources.hostRevision(hostId);
              const ok = await resources.reconcileArchived(hostId, (cursor) =>
                callConversationHost(
                  appHostServer,
                  { hostId, threadId: "" },
                  "resource-archive-reconciliation",
                  "thread/list",
                  { archived: true, cursor, limit: 200 },
                  undefined,
                  10_000,
                ),
              );
              if (ok) reconciledResourceHosts.set(hostId, revision);
            }
        } catch {
          if (!lifecycle.closing()) console.warn("[conversation-resources] inventory unavailable; will retry");
        } finally {
          resourceInventoryRunning = false;
        }
      };
      void reconcileResources();
      resourceReconciliationTimer = periodicOwnerWork(ownerWake, 60_000, () => {
        void reconcileResources();
      });
    },
    /** Keeps the local Codex Host initialized once the listener is up. */
    maintainReadiness(appHostServer) {
      codexReadiness = maintainHeadlessCodexHost(appHostServer);
    },
    /** Readiness by Host for the Web health report; empty without a readiness owner. */
    hostReadiness: () => (codexReadiness ? { "local-codex": codexReadiness.snapshot() } : {}),
    // Shutdown step 1, before the entry phase: the reconciliation wake-up (synchronous), then the lifecycle.
    closeResourceReconciliation: () => resourceReconciliationTimer?.close(),
    closeConversationResources: () => conversationResources.current()?.close(),
    // Shutdown step 3 (entry phase, in parallel with the other entry owners);
    // the Git status withdrawal, browser capabilities and browser close in series.
    closeReadiness: () => codexReadiness?.close(),
    closeUsageQueries: () => usageQueries?.close(),
    withdrawGitStatus: () => withdrawGitStatus?.(),
    closeBrowserCapabilities: () => browserCapabilities?.close(),
    closeRemoteBrowser: () => remoteBrowser?.close(),
    closeFileDownloads: () => fileDownloads?.close(),
    // Shutdown step 7, after the App Host.
    closeCodexEngineHost: () => codexEngineHost?.close(),
    // Shutdown step 8, synchronous: every Hands terminal service, then the file owner.
    closeTerminals: () => {
      for (const service of terminalServices.values()) service.close();
      terminalServices.clear();
    },
    closeFileSystem: () => fileSystem?.close(),
    // Shutdown step 10: the engines, the execution CLI and the capability listener in
    // parallel; then the Pi owner lock; then the turn inspector and the metadata overlay.
    closeEngine: () => agent?.close(),
    closeDsh: async () => (await dshAgent?.catch(() => undefined))?.close(),
    closeExecutionCli: () => connectedExecutionCli?.close(),
    closeCapabilityMcp: () => capabilityMcp?.close(),
    /** Whether an in-process Pi owner lock is held; the root releases it only then. */
    holdsPiOwner: () => !!releasePiOwner,
    releasePiOwner: () => releasePiOwner(),
    closeExecutionRecovery: () => executionRecovery.current()?.close(),
    closeIdentityOverlay: () => agentIdentity?.close(),
    // Shutdown step 11, the first serial writer.
    closeExecutionDatabase: () => executionDatabase?.close(),
    // Shutdown step 11, among the serial writers, after the identity's login admission.
    closeWorkspaceRouting: () => ownedWorkspaceRouting?.close(),
    closeBotProvider: () => installedBotProvider?.close(),
    closeBotAdmission: () => botAdmission?.close(),
    closeHumanGitExecution: () => humanGitExecution?.close(),
    closeHumanAssets: () => assetsService?.close(),
    closeAssetsStorage: () => assetsStorage?.close(),
  };
}
