import type { AppHostServer } from "@opencraft/app-host-server";
import type { LateBinding } from "./lifecycle.mjs";

/** Something the shutdown order closes; it resolves without effect before the server exists. */
export type ClientSessionDisposer = () => unknown;

/** A per-connection session as the App Host server and Web drive it. */
export interface ClientAccessSession {
  receive(frame: unknown): unknown;
  close(): unknown;
  readonly [member: string]: unknown;
}

/** The per-request context a client session is created with. */
export interface ClientSessionContext {
  readonly actorContext?: { readonly actorId: string; readonly [member: string]: unknown } | null;
  readonly resourceOwner?: { assertCurrent(): void } | null;
  readonly [member: string]: unknown;
}

export type CreateThreadAccessSession = (
  hostId: string,
  context: ClientSessionContext,
  emit: (frame: string) => void,
) => ClientAccessSession;

/** A Hands session Web drives on its terminal socket (the Node terminal or file session). */
export interface ClientHandsSession {
  subscribeMessage(listener: (frame: string) => void): unknown;
  connect(): Promise<unknown>;
  close(): void;
  project(frame: string): string | null;
  receive(frame: string, context: unknown): Promise<boolean> | boolean;
}

export interface ClientSessionAssembly {
  /** The App Host server, bound once by `openAppHost`; installation and workspace-host read it after that. */
  readonly appHost: LateBinding<AppHostServer>;
  openAccessSessions(options: {
    machineIdentity: { readonly machineId: string };
    conversationExecution: {
      serverForHost(hostId: string, threadId: string): string;
      readonly [member: string]: unknown;
    };
    threadAccess: unknown;
    threadNotes: unknown;
    serverSpaces: {
      readonly initialized: boolean;
      bootstrap(actorId: string): Promise<unknown>;
      readonly [member: string]: unknown;
    };
    /** Absent without collaboration membership; read only for an admitted Actor. */
    membership: { actorMembership(actorId: string): { readonly role?: string } | null | undefined } | null | undefined;
    actorStore: { isCurrent(context: unknown): boolean; readonly [member: string]: unknown };
    instanceAccess: { admitsActor(actorId: string): boolean; readonly [member: string]: unknown } | null | undefined;
    identity:
      { isThreadCreator?: (...args: never[]) => unknown; readonly [member: string]: unknown } | null | undefined;
    /** Whether an anonymous deployment hands its local Hosts' Threads to the deployment operator now. */
    anonymousHandoff(): boolean;
  }): {
    accessServerForHost(hostId: string, threadId: string): string;
    createThreadAccessSession: CreateThreadAccessSession;
  };
  openAppHost(options: {
    /** Each Host's inner transport; Node constructions of the composition root. */
    transports: {
      channels(): unknown;
      server(): unknown;
      remoteCodex(binding: unknown, hostId: string): unknown;
      localCodex(hostId: string): unknown;
    };
    /** The account and push layers around a Host's transport; Node constructions of the composition root. */
    layers: {
      modelPolicy(transport: unknown, engine: "dsh" | "codex"): unknown;
      /** Called for every Host: the gateway settings layer when configured, else undefined. */
      modelGatewaySettings(): ((transport: unknown) => unknown) | undefined;
      pushObservation(transport: unknown, hostId: string): unknown;
    };
    /** The workspace-host layers (`openHostTransports`). */
    hostTransports: {
      scopeExecution(hostId: string, transport: unknown): unknown;
      scopeResources(hostId: string, transport: unknown): unknown;
    };
    /** Configured SSH Codex Hosts by server id. */
    remoteServers: ReadonlyMap<string, unknown>;
    /** Saved SSH connections, bound once they opened (after the App Host). */
    sshManagement: LateBinding<{ readonly store: { binding(hostId: string): unknown } } | undefined>;
  }): AppHostServer;
  openWebSessions(options: {
    actorCollaboration: unknown;
    conversationExecution: { serverForHost(hostId: string, threadId: string): string };
    signExecutionCli: (session: unknown) => unknown;
    operator: { readonly context: unknown };
    usageQueries: unknown;
    actorStore: { get(actorId: string): unknown };
    /** Only with a configured Hands terminal owner. */
    terminalService: ((hostId: string) => unknown) | undefined;
    terminalScope: (hostId: string) => unknown;
    /** The Hands file owner, or null. */
    fileSystem: unknown;
    resourceAuthority: unknown;
    selectHostTerminalService: ((...args: never[]) => unknown) | undefined;
    selectHostFiles: ((...args: never[]) => unknown) | undefined;
    /** The Hands sessions; Node constructions of the composition root. */
    sessions: {
      terminal(
        service: unknown,
        scope: unknown,
        hostId: string,
        select: ((scope: unknown, context: unknown, local: unknown) => unknown) | undefined,
      ): ClientHandsSession;
      files(
        files: unknown,
        authority: unknown,
        select: ((context: unknown, params: unknown, local: unknown) => unknown) | undefined,
      ): ClientHandsSession;
    };
  }): {
    createAppServerAccessSession(context: ClientSessionContext, emit: (frame: string) => void): ClientAccessSession;
    createAppServerDriverSession(emit: (frame: string) => void): unknown;
    createAppServerQuerySession(emit: (frame: string) => void): unknown;
    createTerminalSession: ((emit: (frame: string) => void) => unknown) | null;
  };
  /** Shutdown step 7: after the personal assistant, before the server's Codex Engine Host. */
  closeAppHost: ClientSessionDisposer;
}

export function assembleClientSession(): ClientSessionAssembly;
