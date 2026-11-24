import type { InstanceAccess, InstanceAdmissionPolicy, MembershipStore } from "@opencraft/access-control";
import type { ActorStore } from "@opencraft/access-control/actors";
import type { ActorAccess } from "@opencraft/access-control/actor-access";
import type { HumanAccounts } from "@opencraft/access-control/human-accounts";
import type { HumanAuth, HumanAuthConfiguration } from "@opencraft/access-control/human-auth";
import type { IdentityWrites } from "@opencraft/access-control/identity-writes";
import type { CommitFence } from "@opencraft/access-control/commit-fence";
import type { HubNodeIdentity } from "@opencraft/hub-network";
import type { Principal } from "@opencraft/identity-core";
import type { IdentityProvider, IdentityRequest } from "@opencraft/identity-core/node";
import type { PasswordHasher } from "@opencraft/plugin-local-account/password-hash";
import type { LocalAccountApplication } from "@opencraft/plugin-local-account/application";
import type { ServerSpacesRuntime } from "@opencraft/access-control/server-spaces";
import type { ThreadAccessStore } from "@opencraft/access-control/thread-access";
import type { Collaboration, CollaborationHttpApi } from "@opencraft/access-control/collaboration";
import type { OrchestrationRuntimeWorker } from "@opencraft/access-control/orchestration-runtime-store";
import type { ThreadOrchestrationBroker } from "@opencraft/access-control/thread-orchestration-broker";
import type { CapabilityBindingProjection } from "@opencraft/session-capabilities/binding-projection";
import type { KeyMaterial } from "@opencraft/secret-storage";
import type { StateDocumentStore } from "@opencraft/document-storage/state";
import type { TurnPushOptions, TurnPushService } from "@opencraft/web-push-node";
import type { LoginAttemptLimiter } from "@opencraft/identity-core/login-attempts";
import type { OwnerWake } from "@opencraft/owner-wake";
import type { ActorSshKeys } from "../actor-ssh-keys.ts";
import type { LateBinding } from "./lifecycle.mjs";

/**
 * The Server core SQL owner: the source the identity stores open their
 * projection on, and the owner calls identity writes commit through.
 */
export type InstallationSqlOwner = ConstructorParameters<typeof ActorStore>[0] & {
  readonly call: ConstructorParameters<typeof IdentityWrites>[0];
};

/**
 * The installation's own Hub node as identity and admission read it (null
 * without one: a remote controller or no Hub). The root opens the node over
 * the Hub state port; the installation reads only this view.
 */
export type InstallationHub = HubNodeIdentity | null;

/** A configured outbound relay; its provider verifies relayed people. */
export interface InstallationRelay {
  readonly provider: IdentityProvider;
}

/**
 * The identity composition's result as the installation reads it; the
 * composition root and the other modules read further members.
 */
export interface InstallationIdentity {
  readonly providers: readonly IdentityProvider[];
  readonly admissionPolicy?: InstanceAdmissionPolicy;
  readonly capabilityProviders?: readonly unknown[];
  readonly codexWorkspaceRouting?: unknown;
  readonly executionEnvironment?: { close(): unknown } | null;
  close?(): unknown;
  readonly [member: string]: unknown;
}

/** What the identity composition receives; the root adds its runtime-specific inputs. */
export interface InstallationIdentityInputs {
  membership: MembershipStore | undefined;
  relayConfiguration: InstallationRelay | null;
  workspaceExecution: unknown;
  hubAuthority: unknown;
  resolveIdentity(request: IdentityRequest): Principal | null;
  getInstanceAccess(): InstanceAccess | undefined;
  machineIdentity: { machineId: string };
  actors: ActorStore;
  sshIngressEnabled: boolean;
  environmentIssuer?: Readonly<Record<string, unknown>>;
}

export interface InstallationAdmission {
  humanAccounts: HumanAccounts | undefined;
  humanAuth: HumanAuth | undefined;
  /** Local account setup and administration; present with local accounts and membership. */
  accountApplication: LocalAccountApplication | undefined;
  /** The core login admission policy; present only when the composition enables it. */
  loginAdmission: (InstanceAdmissionPolicy & { close(): unknown; outcome: unknown }) | undefined;
  /** Instance admission; present with membership. */
  instanceAccess: InstanceAccess | undefined;
}

/** The routed conversation execution the collaboration services read (workspace-host owns it). */
export interface InstallationConversationExecution {
  serverForHost(hostId: string, threadId: string): string;
  serverForThread(threadId: string): string;
  hostForServer(serverId: string): string;
  readonly [member: string]: unknown;
}

/** The deployment operator the root selects (anonymous deployments act through it). */
export interface InstallationOperator {
  owns(actorId: string): boolean;
  readonly [member: string]: unknown;
}

/** The push subscription store the delivering service runs on. */
export type InstallationPushStore = ConstructorParameters<typeof TurnPushService>[0];

/** The installation's server information, as Turn push links read it. */
export interface InstallationServerInformation {
  read(): Promise<{ revision: number; publicUrl: string }>;
}

/** An HTTP handler that answers its own routes and declines the rest. */
export type InstallationHttpService = (request: unknown, response: unknown) => Promise<boolean>;

/** A store with a close the shutdown order calls. */
export interface InstallationClosable {
  close(): unknown;
  readonly [member: string]: unknown;
}

export interface InstallationAssembly {
  /** Orchestration runtime storage on the core owner's connection; opened right after the owner. */
  openOrchestrationStorage(): OrchestrationRuntimeWorker;
  /** Opens instance membership when any admission source is configured; otherwise `undefined`. */
  openMembership(options: {
    hub: InstallationHub;
    accessControl: boolean | undefined;
    accessMemberProviders: readonly string[] | undefined;
    humanConfiguration: HumanAuthConfiguration | null;
    relayConfiguration: InstallationRelay | null;
  }): MembershipStore | undefined;
  /**
   * Opens Actors, refuses invalid ENV delivery options, then creates and
   * validates the identity composition and registers its capability providers.
   */
  openIdentity(options: {
    createIdentity:
      ((input: InstallationIdentityInputs) => Promise<InstallationIdentity | null | undefined>) | undefined;
    hub: InstallationHub;
    machineIdentity: { machineId: string };
    relayConfiguration: InstallationRelay | null;
    workspaceExecution: unknown;
    sshIngressEnabled: boolean;
    environmentDelivery: string | undefined;
    environmentIssuer: Readonly<Record<string, unknown>> | undefined;
    engineHostDescriptor: string | undefined;
    capabilities: { register(provider: unknown): unknown };
  }): Promise<{ actorStore: ActorStore; identity: InstallationIdentity | undefined; environmentDelivered: boolean }>;
  /**
   * Opens Human login (with local accounts when configured), the core login
   * admission policy and instance access. Runtime-specific parts arrive as
   * factories called at their original moment.
   */
  openAdmission(options: {
    hub: InstallationHub;
    relayConfiguration: InstallationRelay | null;
    humanConfiguration: HumanAuthConfiguration | null;
    accessMemberProviders: readonly string[] | undefined;
    createPasswordHasher(): PasswordHasher;
    /** Reads the private setup token document; absent when none is configured. */
    readSetupToken: (() => Promise<unknown>) | undefined;
    /** Opens the core login admission policy; absent unless the composition enables it. */
    openLoginAdmission: (() => Promise<NonNullable<InstallationAdmission["loginAdmission"]>>) | undefined;
    /**
     * Where login, setup and invitation attempts are counted; absent keeps this
     * process's memory (the Node root). A single-writer owner passes its durable ledger.
     */
    loginAttempts?: LoginAttemptLimiter;
  }): Promise<InstallationAdmission>;
  /** Actor access over the admitted Human authority; identity owners commit through the identity writes. */
  openActorAccess(): ActorAccess;
  /** Server spaces, thread access over them, and shared thread notes in the core owner. */
  openSpaces(): Promise<{
    serverSpaces: ServerSpacesRuntime;
    threadAccess: ThreadAccessStore;
    threadNotes: {
      exchange(serverId: string, threadId: string, update: unknown, vector: unknown): Promise<unknown>;
    };
  }>;
  /**
   * Collaboration, thread orchestration and project automations, started;
   * the App Host is read through its late binding, `codexBridge` is called
   * once the broker is ready.
   */
  openCollaboration(options: {
    conversationExecution: InstallationConversationExecution;
    operator: InstallationOperator;
    anonymousHandoff(): boolean;
    appHost: LateBinding<unknown>;
    engines: readonly string[];
    codexBridge(): { readonly url: string; readonly token: string } | undefined;
  }): Promise<{
    actorCollaboration: Collaboration;
    threadOrchestration: ThreadOrchestrationBroker;
    actorCollaborationApi: CollaborationHttpApi;
  }>;
  /** Connectors for the two local hosts' execution servers; the root's factory opens their stores. */
  openConnectors<Connectors extends InstallationClosable>(options: {
    createConnectors(input: {
      access: ActorAccess;
      hosts: Readonly<Record<"local-codex" | "opencraft-server", string>>;
      admitted(actorId: string): boolean;
      resolveServer(hostId: string, threadId: string): string;
    }): Connectors;
    machineId: string;
    defaultEngine: string;
    conversationExecution: InstallationConversationExecution;
  }): Connectors;
  /** Capability bindings read from memory and committed by the core owner. */
  openCapabilityBindings(): Promise<CapabilityBindingProjection>;
  /** The capability signing key, ensured in the given key material. */
  openCapabilitySigningKey(keyMaterial: KeyMaterial): Promise<Buffer>;
  /** MCP apps; the root's factory opens their store. */
  openMcpApps<Apps extends InstallationClosable>(open: () => Apps): Apps;
  /** Server information over the given document store. */
  openServerInformation(documents: StateDocumentStore): {
    serverInformation: InstallationServerInformation;
    serverInformationService: InstallationHttpService;
  };
  /** Personal model defaults and personal SSH keys of the signed-in Human. */
  openPersonalServices(options: { sshLogin: boolean }): Promise<{
    accountModelDefaultsService: InstallationHttpService;
    personalSshKeys: ActorSshKeys;
    actorSshKeysService: InstallationHttpService;
  }>;
  /**
   * Turn push subscriptions; the root's factories open the store and
   * construct the service, returned before `initialize`.
   */
  openTurnPush(options: {
    openStore(): Promise<InstallationPushStore>;
    createService(store: InstallationPushStore, options: TurnPushOptions): TurnPushService;
    appHost: LateBinding<unknown>;
    imPlugins: LateBinding<unknown>;
    conversationExecution: InstallationConversationExecution;
  }): Promise<TurnPushService>;
  /** Shutdown step 3, among the parallel entry disposers. */
  closeTurnPush(): unknown;
  /** Shutdown step 5, after the runtime plugins. */
  closePersonalSshKeys(): unknown;
  /** Shutdown step 7, one at a time, before the personal assistant host and the App Host. */
  closeProjectAutomations(): unknown;
  /** Shutdown steps 7 and 9; idempotent. */
  closeThreadOrchestration(): unknown;
  /** Shutdown step 9, in parallel. */
  closeConnectors(): unknown;
  closeCollaboration(): unknown;
  closeThreadAccess(): unknown;
  closeServerSpaces(): unknown;
  /** Shutdown step 9 after that group, and first in the root's lock release. */
  closeOrchestrationStorage(): unknown;
  /** Shutdown step 11, serial, after the account and before SSH management. */
  closeMcpApps(): unknown;
  /** Shutdown step 11, serial, after the SSH management store and before the workspace routing and Assets owners. */
  closeIdentityExecutionEnvironment(): unknown;
  closeIdentity(): unknown;
  closeLoginAdmission(): unknown;
  /** Shutdown step 11, serial, after the composition's own disposer. */
  closeAccountApplication(): unknown;
  closeAccountManagement(): unknown;
  closeHumanAuth(): unknown;
  closeHumanAccounts(): unknown;
  closeIdentityWrites(): unknown;
  closeCapabilityBindings(): unknown;
  /** Shutdown step 11, serial, after the capability bindings: the last writers before the root lock. */
  closeActorStore(): unknown;
  closeMembership(): unknown;
}

export function assembleInstallation(options: {
  serverStorage: InstallationSqlOwner;
  /**
   * The authorizer side of the commit fence the core SQL owner's identity
   * writes pass (shared-memory for the Node owner Worker, same-thread for an
   * owner on this thread).
   */
  identityFence: CommitFence;
  /** The composition's qualification of a verified external principal; `undefined` means a person. */
  isHuman(principal: Principal): boolean | undefined;
  /**
   * Drives the instance and Actor access watches; absent keeps the runtime's
   * own timeouts (the Node root). A single-alarm owner passes its merged alarm.
   */
  ownerWake?: OwnerWake;
}): InstallationAssembly;
