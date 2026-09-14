import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  JsonRpcError,
  JsonRpcRequest,
} from "../types/appserver.ts";
import type {
  TransparentTurnExecutionDecision,
  TransparentTurnExecutionPort,
  TransparentTurnExecutionRequest,
  TransparentTurnRoute,
} from "../types/transparent-turn-execution.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import { asJsonValue, errorMessage, type JsonValue } from "../types/domain.ts";
import type { EngineKind } from "../types/domain.ts";
import type { TransparentTurnCredential } from "../types/transparent-turn-execution.ts";
import type { TransparentHandoffCredential } from "../types/transparent-handoff.ts";
import {
  desiredRuntimeHint,
  type ExecutionProfile,
  type RuntimeExecutionHint,
} from "./execution-profile.ts";
import {
  codexAccountHandoffRequiredError,
  codexAccountNotBoundError,
  executionProfileForRoute,
  modelProviderCredentialMissingError,
  runtimeNeedsExecutionHandoff,
} from "./transparent-thread-routing.ts";

type Dependencies =
  | "appServer"
  | "credential"
  | "deviceIdentity"
  | "dshNativeSessionStore"
  | "executionEngine"
  | "modelGateway"
  | "runtimeWorkspace"
  | "threadArtifactStore"
  | "threadEngineBinding"
  | "threadExecution"
  | "threadManager"
  | "transparentBackendChannel"
  | "transparentEngineSwitch"
  | "transparentRuntimeAccess"
  | "transparentRuntimeRetirement"
  | "transparentThreadBinding"
  | "userDirectory";

/**
 * Owns the immutable execution decision for one outer Turn.
 *
 * The service deliberately does not own a Codex process or a DSH worker. It
 * selects and claims the Turn authority, then dispatches through engine ports.
 * A Runtime remains replaceable; the outer Thread and canonical timeline do
 * not change identity when the chosen adapter changes.
 */
export class TransparentTurnExecutionService extends Service
  implements TransparentTurnExecutionPort {
  static inject = [
    "appServer",
    "credential",
    "deviceIdentity",
    "dshNativeSessionStore",
    "executionEngine",
    "modelGateway",
    "runtimeWorkspace",
    "threadArtifactStore",
    "threadEngineBinding",
    "threadExecution",
    "threadManager",
    "transparentBackendChannel",
    "transparentEngineSwitch",
    "transparentRuntimeAccess",
    "transparentRuntimeRetirement",
    "transparentThreadBinding",
    "userDirectory",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentTurnExecution");
  }

  handle(request: TransparentTurnExecutionRequest): TransparentTurnExecutionDecision {
    switch (request.message.method) {
      case "turn/start":
        return this.start(request);
      case "turn/steer":
        return this.steer(request);
      case "turn/interrupt":
        return this.interrupt(request);
      default:
        return "queueCodex";
    }
  }

  private start(request: TransparentTurnExecutionRequest): TransparentTurnExecutionDecision {
    const { connection, threadId } = request;
    const actorUserId = connection.identity?.id;
    const runtimeHint = this.ctx.transparentThreadBinding.runtimeHintFor(threadId);
    const desiredHint = desiredRuntimeHint(runtimeHint);
    let route: TransparentTurnRoute | null;
    try {
      route = this.ctx.modelGateway.selectModelForTurn(
        connection,
        requestedModel(request.message, desiredHint),
        request.message.params?.["input"],
      );
    } catch (error) {
      if (request.suppressResponse !== true) {
        this.ctx.transparentBackendChannel.send(connection, withError(request.message, {
          code: -32052,
          message: errorMessage(error),
        }));
      }
      this.ctx.threadExecution.abortRequest(threadId, connection, request.message.id);
      return "handled";
    }

    const credential = route?.provider
      ? this.ctx.credential.resolveProvider(actorUserId, route.provider)
      : (route?.kind === "codex"
        ? this.ctx.credential.resolveCodexUser(actorUserId)
        : this.ctx.credential.resolve(connection));
    const message = normalizeModel(
      request.message,
      desiredHint,
      route?.provider?.model ?? null,
    );
    if (!credential) {
      const provider = this.ctx.modelGateway.activeForUser(actorUserId);
      const device = this.ctx.deviceIdentity.read(actorUserId);
      if (request.suppressResponse !== true) {
        this.ctx.transparentBackendChannel.send(connection, withError(message, provider
          ? asRpcError(modelProviderCredentialMissingError(device, provider))
          : asRpcError(codexAccountNotBoundError(device))));
      }
      this.ctx.threadExecution.abortRequest(threadId, connection, message.id);
      return "handled";
    }

    const executionProfile = executionProfileForRoute(
      route,
      credential,
      requestedModel(message, desiredHint),
      message.params ?? {},
    );
    try {
      const inferredEngineKind = this.inferredEngineKind(threadId, runtimeHint);
      this.ctx.threadEngineBinding.claim(
        threadId,
        executionProfile.engineKind,
        {
          ...(inferredEngineKind ? { inferredEngineKind } : {}),
          inferredProvenance: "legacy-runtime-evidence",
        },
      );
    } catch (error) {
      if (request.suppressResponse !== true) {
        this.ctx.transparentBackendChannel.send(
          connection,
          withError(message, rpcError(error, -32084)),
        );
      }
      return "handled";
    }
    if (!this.ctx.threadExecution.claimRequest(
      threadId,
      credential,
      connection,
      message.id,
      executionProfile,
    )) return "handled";

    if (this.ctx.executionEngine.supports(executionProfile)) {
      this.ctx.transparentThreadBinding.setRuntimeHint(threadId, {
        ownerUserId: actorUserId ?? null,
        accountIdentity: credential.accountIdentity ?? null,
        engineKind: "dsh",
        providerId: executionProfile.providerId,
        model: executionProfile.model,
        threadSettings: jsonObject(desiredHint?.threadSettings),
        nextProviderId: undefined,
        nextModel: undefined,
        nextThreadSettings: undefined,
      });
      try {
        const thread = this.ctx.threadManager.get(threadId);
        const filesystem = this.ctx.transparentRuntimeAccess.filesystemForCwd(thread.cwd) ??
          this.ctx.transparentRuntimeAccess.defaultFilesystem();
        this.ctx.executionEngine.startTurn({
          connection,
          threadId,
          message,
          profile: executionProfile,
          credential,
          filesystem,
          viewId: this.ctx.runtimeWorkspace.viewIdForThread(threadId),
          cwd: thread.cwd,
          suppressResponse: request.suppressResponse === true,
        });
      } catch (error) {
        this.ctx.threadExecution.abortRequest(threadId, connection, message.id);
        if (request.suppressResponse !== true) {
          this.ctx.transparentBackendChannel.send(
            connection,
            withError(message, rpcError(error, -32082)),
          );
        }
      }
      return "handled";
    }

    const state = this.ctx.transparentRuntimeAccess.stateForOuter(threadId);
    if (runtimeNeedsExecutionHandoff(state, runtimeHint, executionProfile)) {
      const binding = this.ctx.transparentThreadBinding.bindings.get(threadId) ?? null;
      const backendUserId = runtimeHint?.ownerUserId ??
        this.ctx.threadManager.ownerOf(threadId) ?? actorUserId;
      if (binding?.durable) {
        this.beginEngineSwitch(
          connection,
          threadId,
          message,
          credential,
          backendUserId,
          executionProfile,
        );
        return "handled";
      }
      if (state?.isolatedOuterThreadId === threadId) {
        this.ctx.transparentRuntimeRetirement.retireIsolatedBackend(state, threadId, true);
      }
    }
    const input = message.params?.["input"];
    this.ctx.threadManager.touch(threadId, Array.isArray(input) ? input : []);
    request.message = message;
    return "queueCodex";
  }

  private steer(request: TransparentTurnExecutionRequest): TransparentTurnExecutionDecision {
    const { connection, message, threadId } = request;
    const execution = this.ctx.threadExecution.table.get(threadId);
    const requestedTurnId = message.params?.["turnId"];
    if (!execution || (typeof requestedTurnId === "string" && execution.turnId &&
        requestedTurnId !== execution.turnId)) {
      this.ctx.transparentBackendChannel.send(connection, withError(message, {
        code: -32068,
        message: "No matching active Turn is available for steering.",
      }));
      return "handled";
    }
    this.ctx.transparentBackendChannel.subscribe(connection, threadId);
    if (execution.executionProfile?.engineKind !== "dsh") return "queueCodex";
    try {
      this.ctx.executionEngine.steer({ connection, threadId, message });
    } catch (error) {
      this.ctx.transparentBackendChannel.send(
        connection,
        withError(message, rpcError(error, -32082)),
      );
    }
    return "handled";
  }

  private interrupt(request: TransparentTurnExecutionRequest): TransparentTurnExecutionDecision {
    const { connection, message, threadId } = request;
    const execution = this.ctx.threadExecution.table.get(threadId);
    if (execution?.executionProfile?.engineKind === "dsh" ||
        this.ctx.executionEngine.hasThread(threadId)) {
      try {
        this.ctx.executionEngine.interrupt({ connection, threadId, message });
      } catch (error) {
        this.ctx.transparentBackendChannel.send(
          connection,
          withError(message, rpcError(error, -32082)),
        );
      }
      return "handled";
    }
    if (!execution || !this.hasProjectedInProgressTurn(threadId) ||
        !this.hasLiveCodexRuntime(threadId)) {
      this.completeOrphanInterrupt(connection, threadId, message.id);
      return "handled";
    }
    return "queueCodex";
  }

  private hasLiveCodexRuntime(threadId: string): boolean {
    const state = this.ctx.transparentRuntimeAccess.stateForOuter(threadId);
    return Boolean(state && ["initializing", "ready"].includes(state.phase));
  }

  private inferredEngineKind(
    threadId: string,
    runtimeHint: RuntimeExecutionHint | null,
  ): EngineKind | null {
    if (this.ctx.dshNativeSessionStore.has(threadId)) return "dsh";
    if (this.ctx.transparentThreadBinding.bindings.has(threadId) ||
        this.ctx.threadArtifactStore.current(threadId)) return "codex";
    return runtimeHint?.engineKind === "codex" || runtimeHint?.engineKind === "dsh"
      ? runtimeHint.engineKind
      : null;
  }

  private beginEngineSwitch(
    connection: TransparentTurnExecutionRequest["connection"],
    threadId: string,
    message: JsonRpcRequest,
    credential: TransparentTurnCredential,
    backendUserId: string | undefined,
    executionProfile: ExecutionProfile,
  ): void {
    const owner = backendUserId
      ? (this.ctx.userDirectory.find(backendUserId) ?? { username: backendUserId })
      : { username: null };
    const reject = (reason: string, code = -32069) => {
      connection.socket.send({
        id: message.id,
        error: {
          ...codexAccountHandoffRequiredError(credential, owner),
          code,
          message: reason,
        },
      });
      this.ctx.threadExecution.abortRequest(threadId, connection, message.id);
    };
    if (!backendUserId || !credential.userId) {
      reject("Transparent thread execution-engine switching requires a stable user identity.");
      return;
    }
    const actorCredential: TransparentHandoffCredential = {
      userId: credential.userId,
      accountIdentity: credential.accountIdentity ?? null,
      providerId: credential.providerId ?? null,
    };
    this.ctx.transparentEngineSwitch.begin({
      connection,
      outerThreadId: threadId,
      message,
      actorCredential,
      backendUserId,
      executionProfile,
      reject,
    });
  }

  private hasProjectedInProgressTurn(threadId: string): boolean {
    return this.ctx.threadManager.find(threadId)?.turns?.some(
      (turn) => turn?.status === "inProgress",
    ) === true;
  }

  private completeOrphanInterrupt(
    connection: TransparentTurnExecutionRequest["connection"],
    threadId: string,
    requestId: JsonRpcRequest["id"],
  ): void {
    const interrupted = this.ctx.threadManager.reconcileInterruptedRuntime(threadId);
    this.ctx.threadExecution.complete(threadId, { reason: "interruptConverged" });
    connection.socket.send({ ...(requestId === undefined ? {} : { id: requestId }), result: {} });
    if (Array.isArray(interrupted)) {
      for (const turn of interrupted) {
        if (typeof turn !== "object" || turn == null) continue;
        this.ctx.appServer.broadcastNotification("turn/completed", {
          threadId,
          turn: { ...turn, itemsView: "summary" },
        });
      }
    }
    this.ctx.appServer.broadcastNotification("thread/status/changed", {
      threadId,
      status: { type: "idle" },
    });
  }
}

function jsonObject(value: unknown): Record<string, JsonValue> | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const json = asJsonValue(value);
  return typeof json === "object" && json != null && !Array.isArray(json) ? json : null;
}

function rpcError(error: unknown, fallbackCode: number): JsonRpcError {
  if (typeof error !== "object" || error == null) {
    return { code: fallbackCode, message: errorMessage(error) };
  }
  const code = Reflect.get(error, "code");
  const data = Reflect.get(error, "data");
  return {
    code: typeof code === "number" && Number.isInteger(code) ? code : fallbackCode,
    message: errorMessage(error),
    ...(data === undefined ? {} : { data }),
  };
}

function asRpcError(value: Record<string, unknown>): JsonRpcError {
  const code = value["code"];
  const message = value["message"];
  return {
    code: typeof code === "number" ? code : -32000,
    message: typeof message === "string" ? message : "Execution credential is unavailable.",
    ...(value["data"] === undefined ? {} : { data: value["data"] }),
  };
}

function withError(message: JsonRpcRequest, error: JsonRpcError) {
  return message.id === undefined ? { error } : { id: message.id, error };
}

function requestedModel(
  message: JsonRpcRequest,
  runtimeHint: Readonly<Record<string, unknown>> | null,
): string | null {
  const explicit = message.params?.["model"];
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const collaborationMode = message.params?.["collaborationMode"];
  if (typeof collaborationMode === "object" && collaborationMode != null) {
    const settings = Reflect.get(collaborationMode, "settings");
    if (typeof settings === "object" && settings != null) {
      const model = Reflect.get(settings, "model");
      if (typeof model === "string" && model.trim()) return model.trim();
    }
  }
  const hintedModel = runtimeHint?.["model"];
  if (typeof hintedModel === "string" && hintedModel.trim()) return hintedModel.trim();
  const providerId = runtimeHint?.["providerId"];
  return typeof providerId === "string" && providerId.trim() ? providerId.trim() : null;
}

function normalizeModel(
  message: JsonRpcRequest,
  runtimeHint: Readonly<Record<string, unknown>> | null,
  routeModel: string | null,
): JsonRpcRequest {
  if (message.method !== "turn/start") return message;
  const model = routeModel ?? requestedModel(message, runtimeHint);
  if (!model || message.params?.["model"] === model) return message;
  return { ...message, params: { ...(message.params ?? {}), model } };
}
