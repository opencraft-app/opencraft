import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerConnection,
  AppServerParams,
  JsonRpcRequest,
} from "../types/appserver.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { TransparentOuterDispatchPort } from "../types/transparent-outer-dispatch.ts";
import { internalModelProvider } from "./model-router.ts";
import { canonicalThreadTitle } from "./thread-manager.js";
import {
  resumeRouteOverride,
  threadResumeSettingsFromTurn,
  transparentThreadOpenParams,
} from "./transparent-thread-routing.ts";

const OPENING_METHODS = new Set(["thread/start", "thread/resume", "turn/start"]);

type Dependencies =
  | "threadArtifactStore"
  | "threadExecution"
  | "threadManager"
  | "transparentBackendChannel"
  | "transparentBackendRpc"
  | "transparentRuntimeAccess"
  | "transparentThreadBinding";

/** Owns the Codex-private open and request dispatch protocol for an outer Thread. */
export class TransparentOuterDispatchService extends Service
  implements TransparentOuterDispatchPort {
  static inject = [
    "threadArtifactStore",
    "threadExecution",
    "threadManager",
    "transparentBackendChannel",
    "transparentBackendRpc",
    "transparentRuntimeAccess",
    "transparentThreadBinding",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private sequence = 0;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentOuterDispatch");
  }

  open(
    state: TransparentBackendState,
    outerThreadId: string,
    forceStart = false,
  ): void {
    if (state.opened.has(outerThreadId) || state.opening.has(outerThreadId)) return;
    const thread = this.ctx.threadManager.get(outerThreadId);
    const binding = this.ctx.transparentThreadBinding.bindings.get(outerThreadId) ?? null;
    const method = binding?.durable === true && !forceStart ? "thread/resume" : "thread/start";
    const id = `hypernode:transparent:${method}:${++this.sequence}`;
    state.opening.add(outerThreadId);
    this.ctx.transparentBackendRpc.trackInternal(state, id, { outerThreadId, method });

    const actions = state.pendingByOuter.get(outerThreadId) ?? [];
    const openingAction = actions.find((action) =>
      action.message.method !== undefined && OPENING_METHODS.has(action.message.method));
    const requested = openingAction?.message.method === "turn/start"
      ? threadResumeSettingsFromTurn(openingAction.message.params ?? {})
      : openingAction?.message.params ?? {};
    const requestedCwd = stringValue(requested["cwd"]) ?? thread.cwd;
    const artifact = binding ? this.ctx.threadArtifactStore.current(outerThreadId) : null;
    const runtimeHint = this.ctx.transparentThreadBinding.runtimeHintFor(outerThreadId);
    const executionHint = state.executionProfile
      ? {
        ...runtimeHint,
        engineKind: state.executionProfile.engineKind,
        providerId: state.executionProfile.providerId === "openai"
          ? null
          : state.executionProfile.providerId,
        model: state.executionProfile.model,
      }
      : runtimeHint;

    if (method === "thread/resume" && artifact && executionHint) {
      const provider = executionHint.providerId ?? "openai";
      const repaired = this.ctx.threadArtifactStore.ensureModelProvider(artifact.path, provider);
      if (repaired.providerChanged) {
        console.info(
          `[transparent-codex] repaired rollout provider outer=${outerThreadId} ` +
          `provider=${provider} sessionMeta=${repaired.sessionMetaCount}`,
        );
      }
      if (repaired.responseItemIdsStripped > 0) {
        console.info(
          `[transparent-codex] sanitized rollout item ids outer=${outerThreadId} ` +
          `count=${repaired.responseItemIdsStripped}`,
        );
      }
    }

    this.ctx.transparentRuntimeAccess.filesystem(state).ensureWorkingDirectory(
      requestedCwd,
      state.user,
      state.viewId,
    );
    const resumeLocator = method === "thread/resume" && artifact
      ? {
        threadId: artifact.innerThreadId,
        path: this.ctx.threadArtifactStore.runtimePath(artifact.path, state.realm),
      }
      : { threadId: binding?.innerThreadId };
    let params: AppServerParams = transparentThreadOpenParams(method, requested, {
      cwd: requestedCwd,
      ...resumeLocator,
      ephemeral: thread["ephemeral"] === true,
      threadSource: thread["threadSource"],
    });
    params = { ...params, modelProvider: internalModelProvider(state.providerId) };
    if (method === "thread/resume" && executionHint) {
      params = {
        ...params,
        ...resumeRouteOverride(requested, executionHint, executionHint.providerId),
      };
    }
    const outbound = this.ctx.transparentRuntimeAccess.toInner({ id, method, params }, state);
    console.info(
      `[transparent-codex] open method=${method} outer=${outerThreadId} ` +
      `realm=${state.realm} view=${state.viewId} cwd=${stringValue(outbound.params?.["cwd"]) ?? ""}`,
    );
    this.ctx.transparentRuntimeAccess.filesystem(state).send(state.processId, outbound);
  }

  flush(
    state: TransparentBackendState,
    outerThreadId: string,
  ): void {
    const actions = state.pendingByOuter.get(outerThreadId) ?? [];
    state.pendingByOuter.delete(outerThreadId);
    for (const action of actions) {
      if (action.respondFromOpen === true) {
        this.ctx.transparentBackendChannel.send(
          action.connection,
          this.ctx.transparentRuntimeAccess.toOuter({
            ...(action.message.id === undefined ? {} : { id: action.message.id }),
            result: state.openResults.get(outerThreadId),
          }, state),
        );
      } else {
        this.forward(state, action.connection, outerThreadId, action.message);
      }
    }
  }

  forward(
    state: TransparentBackendState,
    connection: AppServerConnection,
    outerThreadId: string,
    message: JsonRpcRequest,
  ): void {
    const currentBinding = this.ctx.transparentThreadBinding.bindings.get(outerThreadId) ?? null;
    if (message.method === "thread/read" && currentBinding && !currentBinding.durable) {
      this.ctx.transparentBackendChannel.send(connection, {
        ...(message.id === undefined ? {} : { id: message.id }),
        result: { thread: this.ctx.threadManager.get(outerThreadId) },
      });
      return;
    }

    let forwardedMessage = message;
    if (message.method === "turn/start") {
      forwardedMessage = {
        ...message,
        params: {
          ...(message.params ?? {}),
          modelProvider: internalModelProvider(state.providerId),
        },
      };
    }
    let canonicalName = message.params?.["name"];
    if (message.method === "thread/name/set" && typeof canonicalName === "string") {
      canonicalName = canonicalThreadTitle(canonicalName);
      forwardedMessage = {
        ...message,
        params: { ...(message.params ?? {}), name: canonicalName },
      };
    }

    const authorityEpoch = message.method === "turn/start"
      ? this.ctx.threadExecution.table.get(outerThreadId)?.epoch
      : undefined;
    if (message.method === "turn/start") {
      const bound = this.ctx.threadExecution.bindRuntime(
        outerThreadId,
        connection,
        state.backendKey,
        currentBinding?.innerThreadId,
        authorityEpoch,
        state.runtimeFingerprint,
      );
      if (!bound) {
        this.ctx.threadExecution.abortRequest(outerThreadId, connection, message.id);
        this.ctx.transparentBackendChannel.send(connection, {
          ...(message.id === undefined ? {} : { id: message.id }),
          error: {
            code: -32068,
            message: "Turn execution authority changed before runtime dispatch.",
          },
        });
        return;
      }
    }

    const backendId = `hypernode:transparent:request:${++this.sequence}`;
    const forwardedAtMs = Date.now();
    const clientUserMessageId = typeof message.params?.["clientUserMessageId"] === "string"
      ? message.params["clientUserMessageId"]
      : null;
    const expectedTurnId = typeof message.params?.["expectedTurnId"] === "string"
      ? message.params["expectedTurnId"]
      : null;
    this.ctx.transparentBackendRpc.trackForwarded(state, backendId, {
      connection,
      clientId: message.id,
      outerThreadId,
      method: message.method,
      backendId,
      forwardedAtMs,
      clientUserMessageId,
      expectedTurnId,
      name: typeof canonicalName === "string" ? canonicalName : undefined,
      authorityEpoch,
    });
    if (message.method === "turn/steer") {
      console.info(`[turn-steer] ${JSON.stringify({
        stage: "forwarded",
        outerThreadId,
        connectionId: connection.connectionId ?? null,
        sessionId: connection.sessionId ?? null,
        frontendRequestId: message.id ?? null,
        clientUserMessageId,
        expectedTurnId,
        backendId,
        backendKey: state.backendKey,
      })}`);
    }
    const outbound = this.ctx.transparentRuntimeAccess.toInner(
      { ...forwardedMessage, id: backendId },
      state,
    );
    this.ctx.transparentRuntimeAccess.filesystem(state).send(state.processId, outbound);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
