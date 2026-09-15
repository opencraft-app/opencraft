import { Service, type Inject } from "@deepseek-ai/cordis";
import type { JsonRpcError, JsonRpcResponse } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  TransparentModelListPort,
  TransparentModelListRequest,
} from "../types/transparent-model-list.ts";
import { requestParams } from "../types/transparent-request.ts";

type Dependencies =
  | "appServer"
  | "credential"
  | "modelCatalog"
  | "transparentControlRouting";

function responseFor(
  request: TransparentModelListRequest,
  result?: unknown,
  error?: JsonRpcError | null,
): JsonRpcResponse {
  return {
    ...(request.message.id !== undefined ? { id: request.message.id } : {}),
    ...(error ? { error } : { result }),
  };
}

/**
 * Projects one coherent model catalog across private/public providers and an
 * optional Codex subscription backend.
 */
export class TransparentModelListService extends Service
  implements TransparentModelListPort {
  static inject = [
    "appServer",
    "credential",
    "modelCatalog",
    "transparentControlRouting",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentModelList");
  }

  handle(request: TransparentModelListRequest): void {
    const params = requestParams(request.message);
    const customPage = this.ctx.modelCatalog.customPage(params, request.connection);
    if (customPage !== null) {
      this.respond(request, responseFor(request, customPage));
      return;
    }

    const userId = request.connection.identity?.id;
    const method = request.message.method ?? "model/list";
    if (this.ctx.credential.resolveCodexUser(userId)) {
      this.ctx.transparentControlRouting.requestUserBackend(
        request.connection,
        method,
        params,
        (error, result) => {
          if (error) {
            this.respond(request, responseFor(request, undefined, error));
            return;
          }
          const merged = this.ctx.modelCatalog.mergeSubscriptionPage(
            result,
            params,
            request.connection,
          );
          this.respond(request, responseFor(request, merged));
        },
      );
      return;
    }

    const localPage = this.ctx.modelCatalog.list(params, request.connection);
    this.respond(request, responseFor(request, localPage));
  }

  private respond(
    request: TransparentModelListRequest,
    response: JsonRpcResponse,
  ): void {
    this.ctx.appServer.send(request.connection, response);
    if (response.error) return;
    this.ctx.appServer.audit(request.connection, "rpc.response", {
      id: request.message.id,
      method: request.message.method,
      ...this.ctx.appServer.summarizeResult(response.result),
    });
  }
}
