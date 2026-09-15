import { Service, type Inject } from "@deepseek-ai/cordis";
import type { JsonRpcResponse } from "../types/appserver.ts";
import type {
  TransparentBackendState,
  TransparentInternalRequest,
} from "../types/transparent-backend.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  TransparentInternalResponseHost,
  TransparentInternalResponsePort,
} from "../types/transparent-internal-response.ts";

/**
 * Converges responses to HyperNode-owned Runtime requests.
 *
 * Engine handoff has precedence over an ordinary open because both protocols
 * may use thread/start or thread/resume internally.  Keeping that ordering in
 * one typed service prevents the compatibility facade from accidentally
 * materializing a migration response as a normal thread open.
 */
export class TransparentInternalResponseService extends Service
  implements TransparentInternalResponsePort {
  static inject = ["transparentHandoff", "transparentBackendOpen"] satisfies Inject<Pick<
    HypernodeServices,
    "transparentHandoff" | "transparentBackendOpen"
  >>;

  declare protected ctx: HypernodeContext<"transparentHandoff" | "transparentBackendOpen">;

  constructor(ctx: HypernodeContext<"transparentHandoff" | "transparentBackendOpen">) {
    super(ctx, "transparentInternalResponse");
  }

  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    request: TransparentInternalRequest,
    host: TransparentInternalResponseHost,
  ): boolean {
    if (this.ctx.transparentHandoff.handle(
      state,
      message,
      request.handoff,
      host.handoff,
    )) return true;
    return this.ctx.transparentBackendOpen.handle(state, message, request, host.open);
  }
}
