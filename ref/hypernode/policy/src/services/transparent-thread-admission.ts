import { Service, type Inject } from "@deepseek-ai/cordis";
import type { JsonRpcError, JsonRpcRequest } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  TransparentThreadAdmissionDecision,
  TransparentThreadAdmissionPort,
  TransparentThreadAdmissionRequest,
} from "../types/transparent-thread-admission.ts";
import type { TransparentBackendFilesystemPort } from "../types/transparent-backend.ts";
import type { TransparentTurnCredential } from "../types/transparent-turn-execution.ts";
import type { ExecutionProfile } from "./execution-profile.ts";
import { asJsonValue, errorMessage, type JsonValue } from "../types/domain.ts";
import { threadStartedProjection, threadStartResponse } from "./thread-protocol.ts";
import {
  codexAccountNotBoundError,
  executionProfileForRoute,
  modelProviderCredentialMissingError,
} from "./transparent-thread-routing.ts";

/**
 * Creates one stable outer Thread and binds its initial execution adapter.
 *
 * Thread identity is committed before either DSH or Codex starts.  Concrete
 * runtime construction remains behind host ports so a process can be replaced
 * without replacing the Thread or its canonical timeline.
 */
export class TransparentThreadAdmissionService extends Service
  implements TransparentThreadAdmissionPort {
  static inject = [
    "appServer",
    "credential",
    "deviceIdentity",
    "executionEngine",
    "modelGateway",
    "principal",
    "runtimeWorkspace",
    "threadManager",
    "threadProjectBinding",
    "transparentBackendChannel",
    "transparentBackendLifecycle",
    "transparentOuterQueue",
    "transparentRuntimeAccess",
    "transparentThreadBinding",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentThreadAdmission");
  }

  handle(
    request: TransparentThreadAdmissionRequest,
  ): TransparentThreadAdmissionDecision {
    const { connection } = request;
    if (request.message.method !== "thread/start") return "pass";
    const cwd = request.message.params?.["cwd"];
    const requestedFilesystem = typeof cwd === "string"
      ? this.ctx.transparentRuntimeAccess.filesystemForCwd(cwd)
      : null;
    // Desktop can send its own host-side project cwd (for example `/vela`)
    // when creating a remote Thread.  Once Workspace v2 is enabled that path
    // is not an execution realm and must not fall through to the synthetic
    // conversation owner.  Start the task in the durable Workspace instead.
    const fallbackToWorkspace = this.ctx.runtimeWorkspace.enabled &&
      typeof cwd === "string" && requestedFilesystem === null;
    const filesystem = cwd == null && this.ctx.runtimeWorkspace.enabled
      ? this.ctx.transparentRuntimeAccess.defaultFilesystem()
      : (requestedFilesystem ?? (fallbackToWorkspace
        ? this.ctx.transparentRuntimeAccess.defaultFilesystem()
        : null));
    if (!filesystem) return "pass";

    let route;
    try {
      route = this.ctx.modelGateway.selectModelForConnection(
        connection,
        requestedModel(request.message),
      );
    } catch (error) {
      this.ctx.transparentBackendChannel.send(connection, withRequestId(request.message, {
        error: { code: -32052, message: errorMessage(error) },
      }));
      return "handled";
    }
    const actorUserId = connection.identity?.id;
    const credential = route?.provider
      ? this.ctx.credential.resolveProvider(actorUserId, route.provider)
      : (route?.kind === "codex"
        ? this.ctx.credential.resolveCodexUser(actorUserId)
        : this.ctx.credential.resolve(connection));
    if (!credential) {
      const provider = this.ctx.modelGateway.activeForUser(actorUserId);
      const device = this.ctx.deviceIdentity.read(actorUserId);
      const error = provider
        ? asRpcError(modelProviderCredentialMissingError(device, provider))
        : asRpcError(codexAccountNotBoundError(device));
      this.ctx.transparentBackendChannel.send(
        connection,
        withRequestId(request.message, { error }),
      );
      return "handled";
    }
    const executionProfile = executionProfileForRoute(
      route,
      credential,
      requestedModel(request.message),
      request.message.params ?? {},
    );
    const ownerUserId = actorUserId ?? this.ctx.principal.current().id;
    const startParams = fallbackToWorkspace
      ? {
        ...(request.message.params ?? {}),
        cwd: this.ctx.runtimeWorkspace.projectsRoot(),
      }
      : (request.message.params ?? {});
    const params = this.ctx.transparentRuntimeAccess.isWorkspaceFilesystem(filesystem)
      ? this.ctx.runtimeWorkspace.prepareStartParams(startParams)
      : startParams;
    if (fallbackToWorkspace) {
      console.info(
        `[transparent-codex] normalized unroutable thread/start cwd=${cwd} ` +
        `workspaceCwd=${String(params["cwd"] ?? "")}`,
      );
    }
    const message = { ...request.message, params };
    const thread = this.ctx.threadManager.create(params, {}, {
      ownerPrincipalId: ownerUserId,
      visibility: "nodeShared",
      kind: "transparentCodex",
    });
    if (this.ctx.transparentRuntimeAccess.isWorkspaceFilesystem(filesystem)) {
      this.ctx.runtimeWorkspace.bindMain(thread);
    }
    this.ctx.threadProjectBinding.capture(thread, params, connection, { inferWhenNull: true });
    connection.activeThreadId = thread.id;

    if (this.ctx.executionEngine.supports(executionProfile)) {
      const viewId = this.ctx.runtimeWorkspace.viewIdForThread(thread.id);
      this.ctx.transparentThreadBinding.setRuntimeHint(thread.id, {
        ownerUserId,
        accountIdentity: credential?.accountIdentity ?? null,
        engineKind: "dsh",
        providerId: executionProfile.providerId,
        model: executionProfile.model,
        threadSettings: jsonObject(params),
      }, false);
      this.ctx.transparentBackendChannel.subscribe(connection, thread.id);
      this.ctx.transparentBackendChannel.send(connection, withRequestId(message, {
        result: threadStartResponse(params, thread),
      }));
      this.ctx.transparentBackendChannel.send(connection, {
        method: "thread/started",
        params: { thread: threadStartedProjection(thread) },
      });
      this.scheduleDshPrewarm({
        connection,
        threadId: thread.id,
        profile: executionProfile,
        credential,
        filesystem,
        viewId,
        cwd: thread.cwd,
      });
      return "handled";
    }

    this.startCodex({
      connection,
      message,
      thread,
      filesystem,
      ownerUserId,
      credential,
      executionProfile,
    });
    return "handled";
  }

  private scheduleDshPrewarm(options: {
    connection: TransparentThreadAdmissionRequest["connection"];
    threadId: string;
    profile: ExecutionProfile;
    credential: TransparentTurnCredential | null;
    filesystem: TransparentBackendFilesystemPort;
    viewId: string;
    cwd: string;
  }): void {
    this.ctx.appServer.defer(options.connection, 0, () => {
      try {
        this.ctx.executionEngine.prepareThread({
          threadId: options.threadId,
          profile: options.profile,
          credential: options.credential,
          connection: options.connection,
          filesystem: options.filesystem,
          viewId: options.viewId,
          cwd: options.cwd,
          prewarm: true,
        });
      } catch (error) {
        console.warn(
          `[transparent-codex] DSH prewarm failed thread=${options.threadId}: ` +
          errorMessage(error),
        );
      }
    });
    globalThis.hostEvents?.wakeAfter?.(0);
  }

  private startCodex(options: {
    connection: TransparentThreadAdmissionRequest["connection"];
    message: JsonRpcRequest;
    thread: ReturnType<HypernodeServices["threadManager"]["create"]>;
    filesystem: TransparentBackendFilesystemPort;
    ownerUserId: string;
    credential: TransparentTurnCredential | null;
    executionProfile: ExecutionProfile;
  }): void {
    const viewId = this.ctx.runtimeWorkspace.viewIdForThread(options.thread.id);
    // Persist the exact identity selected at admission before the open request
    // enters the generic queue.  Without this hint the queue computes a
    // legacy, unbound Runtime key and starts a second app-server next to the
    // already-prewarmed authenticated Runtime.
    this.ctx.transparentThreadBinding.setRuntimeHint(options.thread.id, {
      ownerUserId: options.ownerUserId,
      accountIdentity: options.credential?.accountIdentity ?? null,
      engineKind: "codex",
      providerId: options.executionProfile.providerId === "openai"
        ? null
        : options.executionProfile.providerId,
      model: options.executionProfile.model,
      threadSettings: jsonObject(options.message.params ?? {}),
      backendKey: null,
      epoch: null,
    }, false);
    this.ctx.transparentBackendChannel.subscribe(options.connection, options.thread.id);
    const state = this.ctx.transparentBackendLifecycle.ensure({
      connection: options.connection,
      ownerUserId: options.ownerUserId,
      filesystem: options.filesystem,
      viewId,
      initialCwd: options.thread.cwd,
      defaultBackendKey: this.ctx.transparentRuntimeAccess.backendKey(
        options.ownerUserId,
        options.filesystem,
        viewId,
      ),
      workspaceRealm: this.ctx.transparentRuntimeAccess.isWorkspaceFilesystem(options.filesystem),
      options: {
        backendKey: this.ctx.transparentRuntimeAccess.threadBackendKey(
          options.ownerUserId,
          options.filesystem,
          viewId,
          options.thread.id,
          options.executionProfile,
        ),
        isolatedOuterThreadId: options.thread.id,
        accountIdentity: options.credential?.accountIdentity ?? null,
        providerId: options.credential?.providerId ?? null,
        executionProfile: options.executionProfile,
      },
    });
    console.info(
      `[transparent-codex] thread/start outer=${options.thread.id} ` +
      `realm=${state.realm} view=${state.viewId} phase=${state.phase}`,
    );
    if (options.thread.ephemeral) {
      const ephemeral = state.ephemeralOuterIds.get(options.connection) ?? new Set<string>();
      ephemeral.add(options.thread.id);
      state.ephemeralOuterIds.set(options.connection, ephemeral);
    }
    this.ctx.transparentOuterQueue.enqueue({
      connection: options.connection,
      outerThreadId: options.thread.id,
      action: {
        connection: options.connection,
        message: options.message,
        respondFromOpen: true,
      },
    });
  }
}

type Dependencies =
  | "appServer"
  | "credential"
  | "deviceIdentity"
  | "executionEngine"
  | "modelGateway"
  | "principal"
  | "runtimeWorkspace"
  | "threadManager"
  | "threadProjectBinding"
  | "transparentBackendChannel"
  | "transparentBackendLifecycle"
  | "transparentOuterQueue"
  | "transparentRuntimeAccess"
  | "transparentThreadBinding";

function requestedModel(message: JsonRpcRequest): string | null {
  const model = message.params?.["model"];
  if (typeof model === "string" && model.trim()) return model.trim();
  const collaborationMode = message.params?.["collaborationMode"];
  if (typeof collaborationMode !== "object" || collaborationMode == null) return null;
  const settings = Reflect.get(collaborationMode, "settings");
  if (typeof settings !== "object" || settings == null) return null;
  const nestedModel = Reflect.get(settings, "model");
  return typeof nestedModel === "string" && nestedModel.trim() ? nestedModel.trim() : null;
}

function withRequestId(
  message: JsonRpcRequest,
  payload: { result?: unknown; error?: JsonRpcError },
) {
  return message.id === undefined ? payload : { id: message.id, ...payload };
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

function jsonObject(value: Readonly<Record<string, unknown>>): Record<string, JsonValue> {
  const serialized = asJsonValue(value);
  if (serialized == null || Array.isArray(serialized) || typeof serialized !== "object") {
    throw new Error("thread/start params must be a JSON object");
  }
  return serialized;
}
