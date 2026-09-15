import { Service, type Context } from "@deepseek-ai/cordis";
import type { JsonRpcResponse } from "../types/appserver.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import type {
  TransparentBackendMessageHost,
  TransparentBackendMessagePort,
} from "../types/transparent-backend-message.ts";

/**
 * Orders every native Runtime ingress phase before it reaches a projection.
 *
 * The order is part of the protocol contract: bootstrap and identity events
 * are consumed before Thread binding, control/process responses before normal
 * RPC correlation, and only uncorrelated messages may become broadcasts.
 */
export class TransparentBackendMessageService extends Service
  implements TransparentBackendMessagePort {
  constructor(ctx: Context) {
    super(ctx, "transparentBackendMessage");
  }

  handle(
    _state: TransparentBackendState,
    message: JsonRpcResponse,
    host: TransparentBackendMessageHost,
  ): void {
    host.observe(message);
    if (host.handleBootstrap(message)) return;
    if (host.handleAccount(message)) return;
    if (host.observeRuntime(message)) return;
    if (host.deferUntilBinding(message)) return;
    if (host.handleProcess(message)) return;
    if (host.completeInternalControl(message)) return;
    if (host.consumeAbandoned(message)) return;

    const internal = host.takeInternal(message);
    if (internal && host.handleInternal(message, internal)) return;

    if (message.id !== undefined && message.method === undefined) {
      const forwarded = host.takeForwarded(message);
      if (forwarded) host.handleForwarded(message, forwarded);
      else host.handleUnmatchedResponse(message);
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      host.handleServerRequest(message);
      return;
    }
    host.handleNotification(message);
  }
}
