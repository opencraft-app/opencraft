import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { TransparentConnectionCleanupPort } from "../types/transparent-connection-cleanup.ts";

type Dependencies =
  | "transparentBackendRegistry"
  | "transparentBackendRpc"
  | "transparentProcessBridge"
  | "transparentRuntimeAccess"
  | "transparentRuntimeRetirement"
  | "transparentSubscription"
  | "transparentThreadBinding"
  | "threadManager";

/**
 * Converges frontend disconnect into one topology transaction. Runtime
 * retirement happens only after subscriptions, process routes and RPC
 * ownership have been removed.
 */
export class TransparentConnectionCleanupService extends Service
  implements TransparentConnectionCleanupPort {
  static inject = [
    "transparentBackendRegistry",
    "transparentBackendRpc",
    "transparentProcessBridge",
    "transparentRuntimeAccess",
    "transparentRuntimeRetirement",
    "transparentSubscription",
    "transparentThreadBinding",
    "threadManager",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentConnectionCleanup");
  }

  close(connection: AppServerConnection): void {
    const states = [...(this.ctx.transparentBackendRegistry.connections.get(connection) ?? [])];
    const affectedOuterThreadIds = this.ctx.transparentSubscription.removeConnection(connection);

    for (const state of states) {
      this.ctx.transparentProcessBridge.closeConnectionProcesses(
        state,
        connection,
        this.ctx.transparentRuntimeAccess.filesystem(state),
      );
      this.ctx.transparentBackendRpc.abandonConnection(state, connection);
      this.ctx.transparentBackendRegistry.detachConnection(state, connection);
      for (const outerThreadId of state.ephemeralOuterIds.get(connection) ?? []) {
        this.ctx.transparentThreadBinding.clearBinding(outerThreadId);
        this.ctx.threadManager.forget(outerThreadId);
      }
      state.ephemeralOuterIds.delete(connection);
    }
    this.ctx.transparentBackendRegistry.connections.delete(connection);

    for (const outerThreadId of affectedOuterThreadIds) {
      this.ctx.transparentRuntimeRetirement.retireThreadRuntimeIfIdle(outerThreadId);
    }
  }
}
