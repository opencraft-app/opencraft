import { Service, type Inject } from "@deepseek-ai/cordis";
import type { EngineRuntimeNotification } from "../types/engine.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { JsonRpcResponse } from "../types/appserver.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import type {
  TransparentBackendMessageCoordinatorHost,
  TransparentBackendMessageCoordinatorPort,
} from "../types/transparent-backend-message-coordinator.ts";

type Dependencies =
  | "codexRuntimeAdapter"
  | "transparentAccountEvent"
  | "transparentBackendBootstrap"
  | "transparentBackendChannel"
  | "transparentBackendMessage"
  | "transparentBackendOutbound"
  | "transparentBackendProjection"
  | "transparentBackendRpc"
  | "transparentForwardedResponse"
  | "transparentProcessBridge"
  | "transparentProtocolMapper"
  | "transparentThreadBinding";

/**
 * Wires native Runtime ingress to typed HyperNode protocol services.
 *
 * The inner message router remains a pure ordering primitive. This service is
 * the Cordis-owned integration boundary: it resolves correlation tables,
 * account/runtime observers and public AppServer egress without leaking those
 * dependencies back into the JavaScript compatibility facade.
 */
export class TransparentBackendMessageCoordinatorService extends Service
  implements TransparentBackendMessageCoordinatorPort {
  static inject = [
    "codexRuntimeAdapter",
    "transparentAccountEvent",
    "transparentBackendBootstrap",
    "transparentBackendChannel",
    "transparentBackendMessage",
    "transparentBackendOutbound",
    "transparentBackendProjection",
    "transparentBackendRpc",
    "transparentForwardedResponse",
    "transparentProcessBridge",
    "transparentProtocolMapper",
    "transparentThreadBinding",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentBackendMessageCoordinator");
  }

  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    host: TransparentBackendMessageCoordinatorHost,
  ): void {
    this.ctx.transparentBackendMessage.handle(state, message, {
      observe: (candidate) => this.observe(state, candidate),
      handleBootstrap: (candidate) =>
        this.ctx.transparentBackendBootstrap.handle(state, candidate, host.bootstrap),
      handleAccount: (candidate) => this.ctx.transparentAccountEvent.handle(
        state.ownerUserId,
        candidate,
        (accountEvent) => this.ctx.transparentAccountEvent.emit(
          state.ownerUserId,
          accountEvent,
          state,
        ),
      ),
      observeRuntime: (candidate) => this.ctx.codexRuntimeAdapter.observe(
        state.backendKey,
        candidate as EngineRuntimeNotification,
      ),
      deferUntilBinding: (candidate) => this.deferUntilBinding(state, candidate, host),
      handleProcess: (candidate) => this.handleProcess(state, candidate),
      completeInternalControl: (candidate) =>
        this.ctx.transparentBackendRpc.completeInternalControl(state, candidate),
      consumeAbandoned: (candidate) =>
        this.ctx.transparentBackendRpc.consumeAbandoned(state, candidate),
      takeInternal: (candidate) => this.ctx.transparentBackendRpc.takeInternal(state, candidate),
      handleInternal: (candidate, request) => host.handleInternal(candidate, request),
      takeForwarded: (candidate) => this.ctx.transparentBackendRpc.takeForwarded(state, candidate),
      handleForwarded: (candidate, request) => this.ctx.transparentForwardedResponse.handle(
        state,
        candidate,
        request,
        host.forwardedResponseHost(),
      ),
      handleUnmatchedResponse: (candidate) => {
        const outward = this.toOuter(state, candidate);
        this.ctx.transparentBackendProjection.projectBackend(
          outward,
          state,
        );
        this.ctx.transparentBackendChannel.broadcast(state, outward);
      },
      handleServerRequest: (candidate) =>
        this.ctx.transparentBackendOutbound.handleServerRequest(
          state,
          candidate,
        ),
      handleNotification: (candidate) =>
        this.ctx.transparentBackendOutbound.handleNotification(
          state,
          candidate,
        ),
    });
  }

  flushDeferred(
    state: TransparentBackendState,
    innerThreadId: string,
    host: TransparentBackendMessageCoordinatorHost,
  ): void {
    this.ctx.transparentBackendChannel.flushThreadMessages(
      state,
      innerThreadId,
      this.channelHost(host),
    );
  }

  private deferUntilBinding(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    host: TransparentBackendMessageCoordinatorHost,
  ): boolean {
    return this.ctx.transparentBackendChannel.deferUntilThreadBinding(
      state,
      message,
      this.channelHost(host),
    );
  }

  private channelHost(host: TransparentBackendMessageCoordinatorHost) {
    return {
      hasBinding: (innerThreadId: string) =>
        this.ctx.transparentThreadBinding.reverseBindings.has(innerThreadId),
      outerThreadId: (innerThreadId: string) =>
        this.ctx.transparentThreadBinding.reverseBindings.get(innerThreadId) ?? null,
      replay: (candidateState: TransparentBackendState, candidate: JsonRpcResponse) =>
        this.handle(candidateState, candidate, host),
    };
  }

  private handleProcess(state: TransparentBackendState, message: JsonRpcResponse): boolean {
    const project = (candidate: JsonRpcResponse) => this.toOuter(state, candidate);
    const commandOutput = this.ctx.transparentProcessBridge.routeCommandOutput(
      state,
      message,
      project,
    );
    if (commandOutput.handled) {
      if (commandOutput.connection && commandOutput.message) {
        this.ctx.transparentBackendChannel.send(
          commandOutput.connection,
          commandOutput.message,
        );
      }
      return true;
    }

    const hostOutput = this.ctx.transparentProcessBridge.routeHostProcessNotification(
      state,
      message,
      project,
    );
    if (!hostOutput.handled) return false;
    if (hostOutput.connection && hostOutput.message) {
      this.ctx.transparentBackendChannel.send(hostOutput.connection, hostOutput.message);
    }
    return true;
  }

  private toOuter(
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): JsonRpcResponse {
    return this.ctx.transparentProtocolMapper.toOuter(
      message,
      state,
      state.filesystem,
    ) as JsonRpcResponse;
  }

  private observe(state: TransparentBackendState, message: JsonRpcResponse): void {
    const forwardedMethod = message.id === undefined
      ? undefined
      : state.forwardedRequests?.get(String(message.id))?.method;
    if (!["process/outputDelta", "process/exited"].includes(message.method ?? "") &&
        forwardedMethod !== "process/spawn") return;

    const params = record(message.params);
    console.info(
      `[transparent-codex] host process event method=${message.method ?? "response"} ` +
      `id=${message.id ?? "none"} handle=${stringValue(params?.["processHandle"]) ?? "none"} ` +
      `bytes=${stringValue(params?.["deltaBase64"])?.length ?? 0} ` +
      `error=${message.error?.message ?? "none"}`,
    );
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
