import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection, JsonRpcRequest } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { TransparentRequestDispatchPort } from "../types/transparent-request-dispatch.ts";

type Dependencies =
  | "appServerProjection"
  | "modelGateway"
  | "transparentBackendRegistry"
  | "transparentBackendSession"
  | "transparentBackendRpc"
  | "transparentControlRouting"
  | "transparentModelList"
  | "transparentOuterQueue"
  | "transparentRequestRouter"
  | "transparentRuntimeAccess"
  | "transparentThreadActivation"
  | "transparentThreadAdmission"
  | "transparentThreadSettings"
  | "transparentThreadQueue"
  | "transparentTurnExecution"
  | "transparentWorkspaceControl";

/**
 * Owns the AppServer request decision tree at the transparent boundary.
 *
 * Runtime construction and filesystem effects remain explicit host ports;
 * protocol ordering is typed and independently testable here.
 */
export class TransparentRequestDispatchService extends Service
  implements TransparentRequestDispatchPort {
  static inject = [
    "appServerProjection",
    "modelGateway",
    "transparentBackendRegistry",
    "transparentBackendSession",
    "transparentBackendRpc",
    "transparentControlRouting",
    "transparentModelList",
    "transparentOuterQueue",
    "transparentRequestRouter",
    "transparentRuntimeAccess",
    "transparentThreadActivation",
    "transparentThreadAdmission",
    "transparentThreadSettings",
    "transparentThreadQueue",
    "transparentTurnExecution",
    "transparentWorkspaceControl",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentRequestDispatch");
  }

  handle(
    message: JsonRpcRequest | null,
    connection: AppServerConnection,
  ): boolean {
    const requestRoute = this.ctx.transparentRequestRouter.classify(message, connection);
    if (requestRoute.kind === "poll") {
      this.ctx.transparentBackendSession.poll(connection);
      return false;
    }
    if (requestRoute.kind === "pass") return false;
    if (requestRoute.kind === "backendServerResponse") {
      const states = this.ctx.transparentBackendRegistry.connections.get(connection) ?? new Set();
      for (const state of states) {
        const routed = this.ctx.transparentBackendRpc.takeServerResponse(
          state,
          connection,
          requestRoute.message,
        );
        if (!routed) continue;
        const forwarded: JsonRpcRequest = {
          ...this.ctx.transparentRuntimeAccess.toInner(requestRoute.message, state),
        };
        if (routed.innerId === undefined) delete forwarded.id;
        else forwarded.id = routed.innerId;
        this.ctx.transparentRuntimeAccess.filesystem(state).send(state.processId, forwarded);
        return true;
      }
      return false;
    }

    if (requestRoute.kind === "modelList") {
      this.ctx.transparentModelList.handle({ connection, message: requestRoute.message });
      return true;
    }

    if (requestRoute.kind === "userBackendControl") {
      this.ctx.transparentControlRouting.queueControl(connection, requestRoute.message);
      return true;
    }

    if (requestRoute.kind === "threadStartCandidate") {
      const admission = this.ctx.transparentThreadAdmission.handle(
        { connection, message: requestRoute.message },
      );
      if (admission === "handled") return true;
    }

    if (requestRoute.kind !== "thread") return false;
    const threadId = requestRoute.threadId;
    const activation = this.ctx.transparentThreadActivation.activate(
      { connection, message: requestRoute.message, threadId },
    );
    if (activation === "pass") return false;
    if (requestRoute.operation === "history") {
      return this.ctx.appServerProjection.handleHistory({
        connection,
        message: requestRoute.message,
        threadId,
      });
    }

    if (requestRoute.message.method === "thread/settings/update") {
      const model = requestRoute.message.params?.["model"];
      if (typeof model === "string") {
        const route = this.ctx.modelGateway.selectModelForConnection(connection, model);
        if (route?.provider || route?.kind === "codex") {
          this.ctx.transparentThreadSettings.update({
            connection,
            threadId,
            message: requestRoute.message,
            provider: route.provider ?? null,
          });
          return true;
        }
      }
    }

    const workspaceDecision = this.ctx.transparentWorkspaceControl.handle({
      connection,
      message: requestRoute.message,
      threadId,
      operation: requestRoute.operation,
    });
    if (workspaceDecision === "handled") return true;
    if (workspaceDecision === "pass") return false;

    if (requestRoute.operation === "queue") {
      const queueDecision = this.ctx.transparentThreadQueue.handle({
        connection,
        message: requestRoute.message,
        threadId,
      });
      if (queueDecision === "handled") return true;
    }

    const turnRequest = { connection, message: requestRoute.message, threadId };
    const turnDecision = this.ctx.transparentTurnExecution.handle(turnRequest);
    if (turnDecision === "handled") return true;
    this.ctx.transparentOuterQueue.enqueue({
      connection,
      outerThreadId: threadId,
      action: {
        connection,
        message: turnRequest.message,
        respondFromOpen: turnRequest.message.method === "thread/resume",
      },
    });
    return true;
  }
}
