import { Service, type Context } from "@deepseek-ai/cordis";
import { errorMessage } from "../types/domain.ts";
import type { JsonRpcResponse } from "../types/appserver.ts";
import type {
  TransparentBackendBootstrapHost,
  TransparentBackendBootstrapPort,
  TransparentBackendState,
} from "../types/transparent-backend.ts";

/** Completes the Codex initialize handshake and releases queued work. */
export class TransparentBackendBootstrapService extends Service
  implements TransparentBackendBootstrapPort {
  static readonly inject = ["transparentBackendLifecycle"];

  constructor(ctx: Context) {
    super(ctx, "transparentBackendBootstrap");
  }

  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    host: TransparentBackendBootstrapHost,
  ): boolean {
    if (String(message.id) !== state.initId) return false;
    if (message.error) {
      host.fail(message.error.message || "local Codex initialize failed");
      return true;
    }
    const ready = this.ctx.transparentBackendLifecycle.completeInitialization(state);
    if (!ready) return true;
    console.info(
      `[transparent-codex] backend ready realm=${state.realm} view=${state.viewId} ` +
      `pending=${state.pendingByOuter.size}`,
    );
    for (const pending of ready.backendMessages) state.filesystem.send(state.processId, pending);
    for (const pending of ready.controls) {
      try {
        host.forwardControl(pending.connection, pending.message);
      } catch (error) {
        const reason = errorMessage(error);
        console.error(
          `[transparent-codex] control failed method=${String(pending.message.method)}: ${reason}`,
        );
        pending.connection.socket.send({
          id: pending.message.id,
          error: { code: -32050, message: reason },
        });
      }
    }
    for (const pending of ready.internalControls) host.forwardInternalControl(pending);
    for (const outerThreadId of ready.outerThreadIds) {
      try {
        host.openOuter(outerThreadId);
      } catch (error) {
        state.opening.delete(outerThreadId);
        host.failOuter(outerThreadId, errorMessage(error));
      }
    }
    return true;
  }
}
