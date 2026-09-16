import { Service, type Context } from "@deepseek-ai/cordis";
import type { JsonRpcResponse } from "../types/appserver.ts";
import type {
  TransparentBackendState,
  TransparentInternalRequest,
} from "../types/transparent-backend.ts";
import type {
  TransparentBackendOpenHost,
  TransparentBackendOpenPort,
  TransparentOpenRuntimeHint,
} from "../types/transparent-open.ts";
import type { EngineKind } from "../types/domain.ts";

/** Converges ordinary thread/start and thread/resume responses. */
export class TransparentBackendOpenService extends Service
  implements TransparentBackendOpenPort {
  constructor(ctx: Context) {
    super(ctx, "transparentBackendOpen");
  }

  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    internal: TransparentInternalRequest,
    host: TransparentBackendOpenHost,
  ): boolean {
    if (internal.handoff) return false;
    state.opening.delete(internal.outerThreadId);
    const outerThreadId = internal.outerThreadId;

    if (message.error && internal.method === "thread/resume") {
      const reason = message.error.message || "local Codex thread resume failed";
      console.warn(
        `[transparent-codex] open resume failed outer=${outerThreadId} ` +
        `provider=${state.providerId ?? "openai"} error=${reason}`,
      );
      if (!reason.includes("no rollout found") || host.currentArtifactPath(outerThreadId)) {
        this.failOpen(host, outerThreadId, reason);
        return true;
      }
      host.clearBinding(outerThreadId);
      host.openOuter(outerThreadId, true);
      return true;
    }
    if (message.error) {
      this.failOpen(
        host,
        outerThreadId,
        message.error.message || "local Codex thread creation failed",
      );
      return true;
    }

    const result = record(message.result);
    const thread = record(result?.["thread"]);
    const innerThreadId = text(thread?.["id"]);
    if (!innerThreadId) {
      this.failOpen(host, outerThreadId, "local Codex did not return a thread id");
      return true;
    }
    const rolloutPath = text(thread?.["path"]);
    const runtime = runtimeHint(state);
    if (internal.method === "thread/start") {
      host.setBinding(outerThreadId, innerThreadId, false, state.realm, state.viewId, {
        ...runtime,
        rolloutPath,
      });
    } else {
      const binding = host.binding(outerThreadId);
      if (binding) {
        binding.rolloutPath = host.currentArtifactPath(outerThreadId) ?? rolloutPath;
        host.setRuntimeHint(outerThreadId, runtime);
        host.persistBindings();
      }
    }

    host.projectThread(outerThreadId, thread);
    state.opened.add(outerThreadId);
    state.openResults.set(outerThreadId, message.result);
    host.flushThreadMessages(innerThreadId);
    host.flushOpenQueue(outerThreadId);
    host.discardUnmatchedThreadMessages();
    return true;
  }

  private failOpen(
    host: TransparentBackendOpenHost,
    outerThreadId: string,
    reason: string,
  ): void {
    host.failOuter(outerThreadId, reason);
    host.discardUnmatchedThreadMessages();
  }
}

function runtimeHint(state: TransparentBackendState): TransparentOpenRuntimeHint {
  return {
    ownerUserId: state.ownerUserId,
    accountIdentity: state.accountIdentity,
    providerId: state.providerId,
    engineKind: supportedEngineKind(state.executionProfile?.engineKind),
    model: state.executionProfile?.model ?? null,
    backendKey: state.backendKey,
    nextProviderId: undefined,
    nextModel: undefined,
    nextThreadSettings: undefined,
  };
}

function supportedEngineKind(value: string | undefined): EngineKind {
  return value === "dsh" ? "dsh" : "codex";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
