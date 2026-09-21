import { Service, type Context } from "@deepseek-ai/cordis";
import type { AppServerConnection } from "../types/appserver.ts";
import type {
  TransparentBackendInput,
  TransparentForwardedRequest,
  TransparentInternalRequest,
  TransparentPendingOuterAction,
  TransparentBackendRegistryPort,
  TransparentServerRequestRoute,
  TransparentBackendState,
} from "../types/transparent-backend.ts";

/**
 * Owns the in-memory topology of live backend processes. Durable runtime
 * evidence remains in RuntimeRegistry; this service deliberately stores no
 * history or projections.
 */
export class TransparentBackendRegistryService extends Service
  implements TransparentBackendRegistryPort {
  readonly backends = new Map<string, TransparentBackendState>();
  readonly connections = new Map<AppServerConnection, Set<TransparentBackendState>>();

  constructor(ctx: Context) {
    super(ctx, "transparentBackendRegistry");
  }

  create(input: TransparentBackendInput): TransparentBackendState {
    if (this.backends.has(input.backendKey)) {
      throw new Error(`transparent backend already exists: ${input.backendKey}`);
    }
    const state: TransparentBackendState = {
      ownerUserId: input.ownerUserId,
      accountIdentity: input.accountIdentity,
      providerId: input.providerId,
      executionProfile: input.executionProfile,
      runtimeFingerprint: input.runtimeFingerprint,
      backendKey: input.backendKey,
      isolatedOuterThreadId: input.isolatedOuterThreadId,
      realm: input.realm,
      viewId: input.viewId,
      filesystem: input.filesystem,
      user: input.user,
      connections: new Set<AppServerConnection>(),
      processId: input.processId,
      phase: "initializing",
      initId: input.initId,
      internalRequests: new Map<string, TransparentInternalRequest>(),
      forwardedRequests: new Map<string, TransparentForwardedRequest>(),
      serverRequestIds: new Map<string, TransparentServerRequestRoute>(),
      pendingByOuter: new Map<string, TransparentPendingOuterAction[]>(),
      openResults: new Map<string, unknown>(),
      opened: new Set<string>(),
      opening: new Set<string>(),
      ephemeralOuterIds: new Map<AppServerConnection, Set<string>>(),
      turnEpochs: new Map<string, number>(),
      stderr: [],
      pendingControl: [],
      pendingInternalControl: [],
      pendingBackendMessages: [],
      internalControlRequests: new Map(),
      pendingThreadMessages: new Map(),
      commandProcesses: new Map(),
      commandProcessesByConnection: new Map(),
      hostProcesses: new Map(),
      hostProcessesByConnection: new Map(),
      abandonedRequestIds: new Set<string>(),
    };
    this.backends.set(state.backendKey, state);
    this.attach(state, input.connection);
    return state;
  }

  attach(state: TransparentBackendState, connection: AppServerConnection): void {
    state.connections.add(connection);
    const states = this.connections.get(connection) ?? new Set<TransparentBackendState>();
    states.add(state);
    this.connections.set(connection, states);
  }

  remove(state: TransparentBackendState): boolean {
    if (this.backends.get(state.backendKey) !== state) return false;
    this.backends.delete(state.backendKey);
    for (const connection of state.connections) {
      const states = this.connections.get(connection);
      states?.delete(state);
      if (states?.size === 0) this.connections.delete(connection);
    }
    state.connections.clear();
    return true;
  }

  detachConnection(state: TransparentBackendState, connection: AppServerConnection): void {
    state.connections.delete(connection);
    const states = this.connections.get(connection);
    states?.delete(state);
    if (states?.size === 0) this.connections.delete(connection);
  }
}
