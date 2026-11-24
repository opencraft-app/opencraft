import { MembershipStore, InstanceAccess } from "@opencraft/access-control";
import { ActorStore } from "@opencraft/access-control/actors";
import { ActorAccess } from "@opencraft/access-control/actor-access";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { HumanAccountManagement } from "@opencraft/access-control/account-management";
import { HumanAuth } from "@opencraft/access-control/human-auth";
import { IdentityWrites } from "@opencraft/access-control/identity-writes";
import { LocalAccountServerPlugin } from "@opencraft/plugin-local-account/server";
import { LocalAccountApplication } from "@opencraft/plugin-local-account/application";
import { ServerSpacesRuntime } from "@opencraft/access-control/server-spaces";
import { ThreadAccessStore } from "@opencraft/access-control/thread-access";
import { Collaboration, CollaborationHttpApi } from "@opencraft/access-control/collaboration";
import { OrchestrationRuntimeWorker } from "@opencraft/access-control/orchestration-runtime-store";
import { ThreadOrchestrationBroker } from "@opencraft/access-control/thread-orchestration-broker";
import { CapabilityBindingProjection } from "@opencraft/session-capabilities/binding-projection";
import { capabilitySigningKey } from "@opencraft/session-capabilities/credentials";
import { humanLoginPage } from "../human-login-page.ts";
import { validateHeadlessIdentity, environmentLaunchOwner } from "../headless-identity.mjs";
import { validateCodexWorkspaceHooks, workspaceLifecycleRouting } from "../codex-workspace-hooks.mjs";
import { createThreadOrchestrationExecution } from "../thread-orchestration-execution.mjs";
import { createProjectAutomations } from "../project-automations.mjs";
import { callConversationHost } from "../conversation-execution.mjs";
import { ServerInformationStore, serverInformationHttp } from "../server-information.mjs";
import { accountModelDefaultsHttp, humanActorAccess } from "../account-model-defaults-http.ts";
import { threadReadReceiptsHttp } from "../thread-read-receipts-http.ts";
import { ActorSshKeys, installationSshKeyAuthority } from "../actor-ssh-keys.ts";
import { actorSshKeysHttp } from "../actor-ssh-keys-http.ts";

/**
 * Installation assembly (gateway-split §4.1.1). Part 1, identity and
 * admission: the deployment's Actors, membership, the identity composition,
 * Human login with local accounts, login admission, instance access, Actor
 * access and the identity writes that commit through the Server core owner.
 * Part 2, collaboration and deployment-level services: orchestration runtime
 * storage, Server spaces and thread access, Collaboration with thread
 * orchestration and project automations, connectors, capability bindings and
 * the capability signing key, MCP apps, server information, personal model
 * defaults and SSH keys, and Turn push subscriptions.
 *
 * It receives the core SQL owner (`serverStorage`, already open) and the
 * authorizer side of that owner's identity commit fence (a
 * `@opencraft/access-control/commit-fence` port). Root inputs arrive as
 * values read through runtime-neutral ports (gateway-split §4.1.1): the
 * Hub node only as its `HubNodeIdentity` view, the machine identity and the
 * Human login and relay configurations already parsed. Every runtime-specific
 * construction (the owner itself, the Hub controller and its state port,
 * private files, the password hasher, the
 * login admission store, stores opened by path, key material, document
 * stores and the push delivery service) is supplied by the composition root
 * as a value or a factory called at its original moment. Creating it opens nothing. The root
 * calls each step at its original position in startup and each named
 * disposer at its original position in the shutdown order; a disposer for
 * something that was never opened resolves without effect.
 *
 * `ownerWake` (optional, `@opencraft/owner-wake`) drives the instance and Actor
 * access watches, the collaboration pump, the orchestration sweep and the
 * automation run check (schedule occurrences keep a wall-clock wake-up);
 * without it they keep the runtime's own timeouts. A single-alarm owner (the
 * InstallationCore Durable Object) passes its merged alarm.
 */
export function assembleInstallation({ serverStorage, identityFence, isHuman, ownerWake }) {
  let membership, actorStore, identity, instanceAccess, loginAdmission;
  let humanAccounts, localAccountPlugin, humanAuth, accountManagement, accountApplication;
  let providers, identityWrites, actorAccess;
  let orchestrationStorage, serverSpaces, threadAccess;
  let actorCollaboration, threadOrchestration, projectAutomations;
  let connectorService, capabilityBindings, mcpApps, serverInformation, personalSshKeys, turnPush;
  return {
    /**
     * Orchestration runtime storage on the core owner's connection (FIFO with
     * its domains); opened right after the owner, before any other step.
     */
    openOrchestrationStorage() {
      orchestrationStorage = new OrchestrationRuntimeWorker(serverStorage);
      return orchestrationStorage;
    },
    /** Instance membership, when the deployment configures any admission source. */
    openMembership({ hub, accessControl, accessMemberProviders, humanConfiguration, relayConfiguration }) {
      if (
        accessControl ||
        humanConfiguration?.setupTokenFile ||
        accessMemberProviders?.length ||
        relayConfiguration ||
        hub?.origin
      )
        membership = new MembershipStore(serverStorage);
      return membership;
    },
    /**
     * Actors, then the identity composition. ENV delivery options are refused
     * here, after Actors and before the composition, because the composition
     * receives the issuer only with delivery.
     */
    async openIdentity({
      createIdentity,
      hub,
      machineIdentity,
      relayConfiguration,
      workspaceExecution,
      sshIngressEnabled,
      environmentDelivery,
      environmentIssuer,
      engineHostDescriptor,
      capabilities,
    }) {
      // Identity adapters can bind their own credentials to this stable Human authority.
      actorStore = new ActorStore(serverStorage);
      // ENV delivery is a deployment setting independent of the vault owner:
      // whichever owner serves it publishes its issuer for the supervisor of
      // independent engine hosts, so this is refused before any owner starts.
      const environmentDelivered = environmentLaunchOwner(environmentDelivery, undefined) !== null;
      if (environmentIssuer !== undefined && !environmentDelivered)
        throw new Error("The ENV issuer requires environment delivery");
      if (environmentDelivered && engineHostDescriptor && !environmentIssuer?.publish)
        throw new Error("Environment delivery to an independent engine host requires a published issuer");
      if (createIdentity) {
        // With delivery, an identity composition that owns its vault receives the
        // same publication path and rotation generation core's Worker would.
        identity = await createIdentity({
          membership,
          relayConfiguration,
          workspaceExecution,
          hubAuthority: hub?.authority ?? null,
          resolveIdentity: (request) => instanceAccess?.authenticate(request) ?? null,
          getInstanceAccess: () => instanceAccess,
          machineIdentity,
          actors: actorStore,
          sshIngressEnabled,
          ...(environmentDelivered ? { environmentIssuer: Object.freeze({ ...environmentIssuer }) } : {}),
        });
        validateHeadlessIdentity(identity);
        if (identity?.codexWorkspaceRouting !== undefined) {
          validateCodexWorkspaceHooks(identity.codexWorkspaceRouting);
          workspaceLifecycleRouting(undefined, identity.codexWorkspaceRouting);
        }
        for (const provider of identity?.capabilityProviders ?? []) capabilities.register(provider);
      }
      return { actorStore, identity, environmentDelivered };
    },
    /**
     * External identity providers, Human login with local accounts, the core
     * login admission policy and instance access.
     */
    async openAdmission({
      hub,
      relayConfiguration,
      humanConfiguration,
      accessMemberProviders,
      createPasswordHasher,
      readSetupToken,
      openLoginAdmission,
      loginAttempts,
    }) {
      if (
        accessMemberProviders?.length &&
        !identity?.providers.length &&
        !relayConfiguration &&
        !humanConfiguration &&
        !hub?.authority
      )
        throw new Error("Authenticated membership requires an identity provider");
      // This identity authority is persistent even without an external human identity provider.
      // Creating it does not enable instance admission or change legacy resource ownership.
      const externalProviders = [
        ...(identity?.providers ?? []),
        ...(relayConfiguration ? [relayConfiguration.provider] : []),
        ...(hub ? [hub] : []),
      ];
      const externalHuman = (request) => {
        const identities = externalProviders.map((provider) => provider.authenticate(request)).filter(Boolean);
        const principal = identities.length === 1 ? identities[0] : null;
        return principal && (isHuman(principal) ?? true) ? principal : null;
      };
      if (humanConfiguration) {
        humanAccounts = new HumanAccounts(serverStorage, actorStore);
        if (humanConfiguration.local) {
          const localAccounts = new LocalAccountServerPlugin(
            humanAccounts.localAccountRepository,
            createPasswordHasher(),
          );
          humanAccounts.registerLocalAccounts(localAccounts);
          localAccountPlugin = localAccounts;
        } else humanAccounts.disableLocalAccounts();
        humanAuth = new HumanAuth(humanAccounts, actorStore, humanConfiguration, humanLoginPage, externalHuman);
        // Where login, setup and invitation attempts are counted; without it, this process's memory (Node).
        if (loginAttempts) humanAuth.useAttemptLimiter(loginAttempts);
        if (humanConfiguration.local && membership) {
          let setupToken;
          if (readSetupToken) {
            const input = await readSetupToken();
            if (
              !input ||
              typeof input !== "object" ||
              Array.isArray(input) ||
              Object.keys(input).length !== 1 ||
              typeof input.token !== "string" ||
              !/^[A-Za-z0-9_-]{43}$/u.test(input.token)
            )
              throw new Error("Invalid private setup token file");
            setupToken = input.token;
          }
          accountManagement = new HumanAccountManagement(serverStorage, humanAccounts, actorStore, membership);
          accountApplication = new LocalAccountApplication({
            auth: humanAuth,
            management: accountManagement,
            setupToken,
            ...(loginAttempts ? { attempts: loginAttempts } : {}),
          });
        }
      }
      providers = [...(humanAuth ? [humanAuth] : []), ...externalProviders];
      // The optional core login admission policy (composition `loginAdmission`); an
      // identity composition that supplies its own policy cannot also enable it.
      if (openLoginAdmission) {
        if (identity?.admissionPolicy) throw new Error("Login admission cannot have two owners");
        if (!membership) throw new Error("Login admission requires instance access");
        loginAdmission = await openLoginAdmission();
      }
      if (membership)
        instanceAccess = new InstanceAccess(
          membership,
          providers,
          actorStore,
          accessMemberProviders ?? [],
          identity?.admissionPolicy ?? loginAdmission,
        );
      if (ownerWake) instanceAccess?.useOwnerWake(ownerWake);
      return { humanAccounts, humanAuth, accountApplication, loginAdmission, instanceAccess };
    },
    /**
     * Actor access over the admitted Human authority, and the identity writes
     * every identity owner commits through.
     */
    openActorAccess() {
      const authenticateHuman = (request) => {
        if (instanceAccess) return instanceAccess.authenticate(request);
        const identities = providers.map((provider) => provider.authenticate(request)).filter(Boolean);
        if (identities.length === 1) return identities[0];
        const ids = identities.map((p) => actorStore.findHuman(p)?.id);
        return ids[0] && ids.every((id) => id === ids[0]) ? identities[0] : null;
      };
      actorAccess = new ActorAccess(actorStore, {
        authenticateHuman: (request) => {
          const principal = authenticateHuman(request);
          return principal && (["local", "oidc"].includes(principal.provider) || (isHuman(principal) ?? true))
            ? principal
            : null;
        },
        isHumanCurrent: (principal) =>
          ["local", "oidc"].includes(principal.provider) ? humanAuth?.isCurrent(principal) === true : true,
        rejectHumanRequest: (request) =>
          humanAuth?.invalidSession(request) ||
          (humanAuth?.hasSessionCookie(request) && request.headers.authorization !== undefined),
        admitted: (principal) => !instanceAccess || instanceAccess.role(principal) !== null,
        administrator: (principal) => instanceAccess?.role(principal) === "admin",
        trustedOrigin: (request) => instanceAccess?.trustedOrigin(request) ?? humanAuth?.trustedOrigin(request) ?? null,
      });
      // Login sessions, identity bindings and Actor administration commit in the
      // Server owner Worker; reads stay on this thread's permission projection.
      identityWrites = new IdentityWrites(serverStorage.call, actorStore, humanAccounts, identityFence, membership);
      if (ownerWake) actorAccess.useOwnerWake(ownerWake);
      actorAccess.useOwnerWrites(identityWrites);
      // Login-time password record upgrades commit in the owner Worker too.
      localAccountPlugin?.useOwnerWrites(identityWrites);
      humanAuth?.useOwnerWrites(identityWrites);
      instanceAccess?.useOwnerWrites(identityWrites);
      accountManagement?.useOwnerWrites(identityWrites);
      return actorAccess;
    },
    /** Server spaces, thread access over them, and shared thread notes. */
    async openSpaces() {
      serverSpaces = new ServerSpacesRuntime({ owner: serverStorage, bootstrapInstance: true });
      await serverSpaces.ready;
      // `permissionOwner` is the network thread's transitional connection (gateway-split §4.1.1, item 10).
      threadAccess = new ThreadAccessStore(serverStorage, actorStore, {
        permissionOwner: serverStorage.database,
        spaces: {
          allows: (actorId, serverId, threadId) =>
            !serverSpaces.initialized ||
            (actorId && actorStore.get(actorId)?.kind === "session") ||
            serverSpaces.allows(actorId, serverId, threadId),
          subscribe: (listener) => serverSpaces.subscribe(listener),
        },
      });
      // Shared notes run in the Server owner Worker (Yjs merge and SQL off this thread).
      const threadNotes = {
        exchange: (serverId, threadId, update, vector) =>
          serverStorage.call.exchangeThreadNote(serverId, threadId, update, vector),
      };
      return { serverSpaces, threadAccess, threadNotes };
    },
    /**
     * Collaboration over routed conversation execution, thread orchestration,
     * project automations and the collaboration HTTP API; all three start here.
     * The App Host is constructed later and is read through its late binding;
     * `codexBridge` is called at its original moment, once the broker is ready.
     */
    async openCollaboration({ conversationExecution, operator, anonymousHandoff, appHost, engines, codexBridge }) {
      actorCollaboration = new Collaboration(
        serverStorage,
        actorStore,
        conversationExecution,
        Date.now,
        (actorId) =>
          operator.owns(actorId) ? anonymousHandoff() : !instanceAccess || instanceAccess.admitsActor(actorId),
        orchestrationStorage,
        (context, ref) =>
          threadAccess.allows(ref.serverId, ref.threadId, operator.owns(context.actorId) ? undefined : context),
        serverStorage.call,
        serverStorage.call.readConversationOwner,
      );
      // Inbox team commands go to the Server space ledger, the only writer of team membership.
      actorCollaboration.attachSpaces({ command: (context, command) => serverSpaces.command(context, command) });

      threadOrchestration = new ThreadOrchestrationBroker(
        actorCollaboration,
        createThreadOrchestrationExecution(() => appHost.current(), {
          enabled: ["codex", ...engines.filter((engine) => engine !== "dsh")],
          prepared: (id) => actorCollaboration.spawnPreparation(id),
        }),
        Date.now,
        orchestrationStorage,
      );
      threadOrchestration.enableAssistantThreads(threadAccess);
      await threadOrchestration.initializeAssistantThreads();
      threadOrchestration.childScope = async (parent, child) => {
        if (serverSpaces.initialized) await serverSpaces.inherit(parent, child);
        threadAccess.acceptCreated(await orchestrationStorage.inheritChildCreator(parent, child));
      };
      threadOrchestration.legacySchedule = async (threadId) => {
        const serverId = conversationExecution.serverForThread(threadId),
          hostId = conversationExecution.hostForServer(serverId);
        return (
          await callConversationHost(
            appHost.current(),
            { hostId, threadId },
            "automation-schedule-inspect",
            "opencraft/schedules/read",
            { threadId },
          )
        ).schedule;
      };
      projectAutomations = createProjectAutomations(
        orchestrationStorage,
        threadOrchestration,
        actorCollaboration,
        codexBridge(),
      );
      const actorCollaborationApi = new CollaborationHttpApi(actorCollaboration, actorAccess, projectAutomations);
      await projectAutomations.start({ ownerWake });
      actorCollaboration.start(ownerWake);
      threadOrchestration.start(ownerWake);
      return { actorCollaboration, threadOrchestration, actorCollaborationApi };
    },
    /**
     * Connectors for the two local hosts' execution servers; the root's
     * factory opens the connector stores.
     */
    openConnectors({ createConnectors, machineId, defaultEngine, conversationExecution }) {
      connectorService = createConnectors({
        access: actorAccess,
        hosts: {
          "local-codex": `server:${machineId}:codex`,
          "opencraft-server": `server:${machineId}:${defaultEngine}`,
        },
        admitted: (actorId) => !instanceAccess || instanceAccess.admitsActor(actorId),
        resolveServer: (hostId, threadId) => {
          return conversationExecution.serverForHost(hostId, threadId);
        },
      });
      return connectorService;
    },
    /** Capability bindings are read from memory; the Server owner Worker commits each write in order. */
    async openCapabilityBindings() {
      capabilityBindings = new CapabilityBindingProjection(
        await serverStorage.call.capabilityBindings(),
        (write) => serverStorage.call.applyCapabilityBinding(write),
        (error) => console.error("[capability-bindings] unavailable", error.message),
      );
      return capabilityBindings;
    },
    /** The installation's capability signing key, ensured in the given key material. */
    openCapabilitySigningKey(keyMaterial) {
      return capabilitySigningKey(keyMaterial);
    },
    /** MCP apps; the root's factory opens their store. */
    openMcpApps(open) {
      mcpApps = open();
      return mcpApps;
    },
    /** Server information over the given document store: admitted Humans read it, administrators manage it. */
    openServerInformation(documents) {
      serverInformation = new ServerInformationStore(documents);
      const serverInformationService = serverInformationHttp(serverInformation, (request) => {
        const context = actorAccess.authenticate(request);
        if (
          !context ||
          context.credentialId !== null ||
          actorStore.get(context.actorId)?.kind !== "human" ||
          (instanceAccess && !instanceAccess.admitsActor(context.actorId))
        )
          return null;
        const principal = instanceAccess?.authenticate(request);
        return {
          actorId: context.actorId,
          administrator:
            !!principal &&
            actorStore.findHuman(principal)?.id === context.actorId &&
            instanceAccess.role(principal) === "admin",
          origin: actorAccess.options.trustedOrigin?.(request) ?? null,
        };
      });
      return { serverInformation, serverInformationService };
    },
    /** Personal model defaults, cross-device read receipts and personal SSH keys of the signed-in Human. */
    async openPersonalServices({ sshLogin }) {
      const signedInHuman = humanActorAccess({
        authenticate: (request) => actorAccess.authenticate(request),
        refused: (request) => actorAccess.legacyAdmissionStatus(request) === 403,
        isCurrentHuman: (context) => actorStore.isCurrent(context) && actorStore.get(context.actorId)?.kind === "human",
        admits: instanceAccess ? (actorId) => instanceAccess.admitsActor(actorId) : null,
        trustedOrigin: (request) => actorAccess.options.trustedOrigin?.(request) ?? null,
      });
      const accountModelDefaultsService = accountModelDefaultsHttp(serverStorage.call, signedInHuman);
      const threadReadReceiptsService = threadReadReceiptsHttp(serverStorage.call, signedInHuman);
      // Personal SSH keys: committed by the owner Worker, read from this thread's projection.
      const sshKeyAuthority = installationSshKeyAuthority({ actors: actorStore, access: instanceAccess });
      personalSshKeys = await ActorSshKeys.open(serverStorage.call, sshKeyAuthority);
      serverStorage.onUnavailable((error) => personalSshKeys?.fail(error));
      const actorSshKeysService = actorSshKeysHttp(personalSshKeys, {
        access: signedInHuman,
        administrator: (_request, actorId) => sshKeyAuthority.administrator(actorId),
        isHuman: (actorId) => actorStore.get(actorId)?.kind === "human",
        sshLogin,
      });
      return { accountModelDefaultsService, threadReadReceiptsService, personalSshKeys, actorSshKeysService };
    },
    /**
     * Turn push subscriptions for the two local hosts. The root's factories
     * open the subscription store and construct the delivering service; the
     * service is returned before `initialize`, which the root awaits.
     */
    async openTurnPush({ openStore, createService, appHost, imPlugins, conversationExecution }) {
      turnPush = createService(await openStore(), {
        hosts: ["local-codex", "opencraft-server"],
        publicBaseUrl: async () => (await serverInformation.read()).publicUrl,
        defaultTarget: identity?.notificationDefaultTarget,
        imTargets: async (binding) => imPlugins.current()?.notificationTargets(binding.context.actorId) ?? [],
        sendIm: async (binding, target, message) => {
          const im = imPlugins.current();
          if (!im) throw Error("notification_unavailable");
          const send = im.prepareDirectNotification(target.channelId, target.senderId, binding.context.actorId);
          await send([message.title, message.body, message.url].join("\n"), message.id);
        },
        authenticate: (request) => {
          const context = actorAccess.authenticate(request);
          return context && actorStore.get(context.actorId)?.kind === "human"
            ? { context, loginDigest: humanAuth?.notificationLoginDigest(request) }
            : null;
        },
        current: (binding) =>
          actorStore.isCurrent(binding.context) &&
          actorStore.get(binding.context.actorId)?.kind === "human" &&
          (!instanceAccess || instanceAccess.admitsActor(binding.context.actorId)) &&
          (!binding.loginDigest || !!humanAccounts?.byDigest(binding.loginDigest)),
        trustedOrigin: (request) => actorAccess.options.trustedOrigin?.(request) ?? null,
        canRead: (actorId, hostId, threadId) =>
          threadAccess.allowsActor(conversationExecution.serverForHost(hostId, threadId), threadId, actorId),
        read: (hostId, method, params) =>
          callConversationHost(
            appHost.get(),
            { hostId, threadId: params.threadId },
            "push-history",
            method,
            params,
            undefined,
            10_000,
          ),
      });
      return turnPush;
    },
    // Shutdown step 3, among the parallel entry disposers.
    closeTurnPush: () => turnPush?.close(),
    // Shutdown step 5, after the runtime plugins.
    closePersonalSshKeys: () => personalSshKeys?.close(),
    // Shutdown step 7, one at a time, before the personal assistant host and the App Host.
    closeProjectAutomations: () => projectAutomations?.close(),
    // Shutdown steps 7 and 9; the broker's close is idempotent.
    closeThreadOrchestration: () => threadOrchestration?.close(),
    // Shutdown step 9, in parallel with the broker's second close.
    closeConnectors: () => connectorService?.close(),
    closeCollaboration: () => actorCollaboration?.close(),
    closeThreadAccess: () => threadAccess?.close(),
    closeServerSpaces: () => serverSpaces?.close(),
    // Shutdown step 9 after that group, and first in the root's lock release.
    closeOrchestrationStorage: () => orchestrationStorage?.close(),
    // Shutdown step 11, among the serial writers: after the account, before SSH management.
    closeMcpApps: () => mcpApps?.close(),
    // Shutdown step 11, among the serial writers: after the SSH management
    // store and before the workspace routing and Assets owners.
    closeIdentityExecutionEnvironment: () => identity?.executionEnvironment?.close(),
    closeIdentity: () => identity?.close?.(),
    closeLoginAdmission: () => loginAdmission?.close(),
    // Shutdown step 11, after the composition's own disposer.
    closeAccountApplication: () => accountApplication?.close(),
    closeAccountManagement: () => accountManagement?.close(),
    closeHumanAuth: () => humanAuth?.close(),
    closeHumanAccounts: () => humanAccounts?.close(),
    closeIdentityWrites: () => identityWrites?.close(),
    closeCapabilityBindings: () => capabilityBindings?.close(),
    // Shutdown step 11, after the capability bindings: the last writers before the lock.
    closeActorStore: () => actorStore?.close(),
    closeMembership: () => membership?.close(),
  };
}
