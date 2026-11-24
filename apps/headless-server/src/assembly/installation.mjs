import { MembershipStore, InstanceAccess } from "@opencraft/access-control";
import { ActorStore } from "@opencraft/access-control/actors";
import { ActorAccess } from "@opencraft/access-control/actor-access";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { HumanAccountManagement } from "@opencraft/access-control/account-management";
import { HumanAuth } from "@opencraft/access-control/human-auth";
import { IdentityWrites } from "@opencraft/access-control/identity-writes";
import { LocalAccountServerPlugin } from "@opencraft/plugin-local-account/server";
import { LocalAccountApplication } from "@opencraft/plugin-local-account/application";
import { humanLoginPage } from "../human-login-page.ts";
import { validateHeadlessIdentity, environmentLaunchOwner } from "../headless-identity.mjs";
import { validateCodexWorkspaceHooks, workspaceLifecycleRouting } from "../codex-workspace-hooks.mjs";

/**
 * Installation assembly, part 1: identity and admission (gateway-split §4.1.1).
 * It composes the deployment's Actors, membership, the identity composition,
 * Human login with local accounts, login admission, instance access, Actor
 * access and the identity writes that commit through the Server core owner.
 *
 * It receives the core SQL owner (`serverStorage`, already open) and that
 * owner's identity commit fence; every runtime-specific construction (the
 * owner itself, the Hub controller, private files, the password hasher, the
 * login admission store) is supplied by the composition root as a value or a
 * factory called at its original moment. Creating it opens nothing. The root
 * calls each step at its original position in startup and each named
 * disposer at its original position in the shutdown order; a disposer for
 * something that was never opened resolves without effect.
 */
export function assembleInstallation({ serverStorage, identityFence, isHuman }) {
  let membership, actorStore, identity, instanceAccess, loginAdmission;
  let humanAccounts, localAccountPlugin, humanAuth, accountManagement, accountApplication;
  let providers, identityWrites;
  return {
    /** Instance membership, when the deployment configures any admission source. */
    openMembership({ hub, accessControl, accessMemberProviders, humanConfiguration, relayConfiguration }) {
      if (
        accessControl ||
        humanConfiguration?.setupTokenFile ||
        accessMemberProviders?.length ||
        relayConfiguration ||
        hub.node?.store.state.origin
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
          hubAuthority: hub.node?.store.state.authority ?? null,
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
    }) {
      if (
        accessMemberProviders?.length &&
        !identity?.providers.length &&
        !relayConfiguration &&
        !humanConfiguration &&
        !hub.node?.store.state.authority
      )
        throw new Error("Authenticated membership requires an identity provider");
      // This identity authority is persistent even without an external human identity provider.
      // Creating it does not enable instance admission or change legacy resource ownership.
      const externalProviders = [
        ...(identity?.providers ?? []),
        ...(relayConfiguration ? [relayConfiguration.provider] : []),
        ...(hub.node ? [hub.node] : []),
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
      const actorAccess = new ActorAccess(actorStore, {
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
      actorAccess.useOwnerWrites(identityWrites);
      // Login-time password record upgrades commit in the owner Worker too.
      localAccountPlugin?.useOwnerWrites(identityWrites);
      humanAuth?.useOwnerWrites(identityWrites);
      instanceAccess?.useOwnerWrites(identityWrites);
      accountManagement?.useOwnerWrites(identityWrites);
      return actorAccess;
    },
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
    // Shutdown step 11, after the capability bindings: the last writers before the lock.
    closeActorStore: () => actorStore?.close(),
    closeMembership: () => membership?.close(),
  };
}
