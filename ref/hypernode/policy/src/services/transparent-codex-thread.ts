import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerConnection,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types/appserver.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import type { TransparentRuntimeHint } from "../types/transparent-binding.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { TransparentInternalControlRequest } from "../types/transparent-process.ts";

type Dependencies =
  | "appServer"
  | "modelGateway"
  | "principal"
  | "threadManager"
  | "transparentBackendChannel"
  | "transparentBackendRegistry"
  | "transparentBackendSession"
  | "transparentConnectionCleanup"
  | "transparentControlRouting"
  | "transparentOuterDispatch"
  | "transparentRequestDispatch"
  | "transparentRuntimeAccess"
  | "transparentRuntimeRetirement"
  | "transparentThreadBinding"
  | "virtualFilesystem";

/**
 * Compatibility entry point for native Codex AppServer traffic.
 *
 * Runtime ownership lives in the injected Cordis services. This facade only
 * installs the protocol interceptors and retains a narrow compatibility
 * surface for protocol tests while those fixtures migrate to the ports.
 */
export class TransparentCodexThreadService extends Service {
  static inject = [
    "appServer",
    "modelGateway",
    "principal",
    "threadManager",
    "transparentBackendChannel",
    "transparentBackendRegistry",
    "transparentBackendSession",
    "transparentConnectionCleanup",
    "transparentControlRouting",
    "transparentOuterDispatch",
    "transparentRequestDispatch",
    "transparentRuntimeAccess",
    "transparentRuntimeRetirement",
    "transparentThreadBinding",
    "virtualFilesystem",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentCodexThread");
    ctx.transparentRuntimeAccess.initialize(ctx.virtualFilesystem);
    this.removeLegacyRoot();

    ctx.effect(() => ctx.modelGateway.attachRuntimeRetirer(
      (userId) => ctx.transparentRuntimeRetirement.retireIdleUserBackends(userId),
    ));
    ctx.effect(() => ctx.appServer.register("hypernode/transparentCodexThread/read", () => ({
      bindings: ctx.transparentThreadBinding.describe(),
      localhostRoot: ctx.virtualFilesystem.physicalRoot,
    })));
    ctx.effect(() => ctx.appServer.intercept(
      (message, connection) => this.intercept(message, connection),
    ));
    ctx.effect(() => ctx.appServer.onClose(
      (connection) => this.close(connection),
    ));
  }

  private removeLegacyRoot(): void {
    const principalId = this.ctx.principal.current().id;
    const rootId = policyStore.get("transparentCodexThread", principalId);
    if (
      rootId !== null &&
      this.ctx.threadManager.metadataFor(rootId)?.kind === "transparentCodexRoot"
    ) {
      this.ctx.transparentThreadBinding.clearBinding(rootId);
      this.ctx.threadManager.forget(rootId);
    }
    policyStore.delete("transparentCodexThread", principalId);
    policyStore.delete("transparentCodexThread", `${principalId}:innerThreadId`);
  }

  runtimeHintFor(outerThreadId: string): TransparentRuntimeHint | null {
    return this.ctx.transparentThreadBinding.runtimeHintFor(outerThreadId);
  }

  forwardInternalControlNow(
    state: TransparentBackendState,
    request: TransparentInternalControlRequest,
  ): void {
    this.ctx.transparentControlRouting.forwardInternalControlNow(state, request);
  }

  intercept(message: JsonRpcRequest | null, connection: AppServerConnection): boolean {
    return this.ctx.transparentRequestDispatch.handle(message, connection);
  }

  attachConnection(state: TransparentBackendState, connection: AppServerConnection): void {
    this.ctx.transparentBackendRegistry.attach(state, connection);
  }

  sendWhenReady(state: TransparentBackendState, message: JsonRpcRequest): void {
    if (state.phase === "ready") {
      this.ctx.transparentRuntimeAccess.filesystem(state).send(state.processId, message);
    }
    else state.pendingBackendMessages.push(message);
  }

  forwardControlNow(
    state: TransparentBackendState,
    connection: AppServerConnection,
    message: JsonRpcRequest,
  ): void {
    this.ctx.transparentControlRouting.forwardControlNow(state, connection, message);
  }

  openOuter(
    state: TransparentBackendState,
    outerThreadId: string,
    forceStart = false,
  ): void {
    this.ctx.transparentOuterDispatch.open(state, outerThreadId, forceStart);
  }

  forwardNow(
    state: TransparentBackendState,
    connection: AppServerConnection,
    outerThreadId: string,
    message: JsonRpcRequest,
  ): void {
    this.ctx.transparentOuterDispatch.forward(state, connection, outerThreadId, message);
  }

  onBackendMessage(state: TransparentBackendState, message: JsonRpcResponse): void {
    this.ctx.transparentBackendSession.handleMessage(state, message);
  }

  broadcast(state: TransparentBackendState, message: JsonRpcResponse): void {
    this.ctx.transparentBackendChannel.broadcast(state, message);
  }

  send(
    connection: AppServerConnection,
    message: JsonRpcResponse,
    sensitive = false,
  ): void {
    this.ctx.transparentBackendChannel.send(connection, message, sensitive);
  }

  subscribeThread(connection: AppServerConnection, outerThreadId: string): void {
    this.ctx.transparentBackendChannel.subscribe(connection, outerThreadId);
  }

  unsubscribeThread(connection: AppServerConnection, outerThreadId: string): boolean {
    return this.ctx.transparentBackendChannel.unsubscribe(connection, outerThreadId);
  }

  broadcastCatalog(
    method: string,
    threadId: string,
    message: JsonRpcResponse | null = null,
    now = Date.now(),
  ): boolean {
    return this.ctx.transparentBackendChannel.broadcastCatalog(method, threadId, message, now);
  }

  fail(state: TransparentBackendState, reason: string): void {
    this.ctx.transparentBackendSession.fail(state, reason);
  }

  retireIsolatedBackend(
    state: TransparentBackendState | null | undefined,
    outerThreadId: string,
    strict = false,
  ): boolean {
    return this.ctx.transparentRuntimeRetirement.retireIsolatedBackend(
      state,
      outerThreadId,
      strict,
    );
  }

  close(connection: AppServerConnection): void {
    this.ctx.transparentConnectionCleanup.close(connection);
  }
}
