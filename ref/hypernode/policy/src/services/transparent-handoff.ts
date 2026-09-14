import { Service, type Context } from "@deepseek-ai/cordis";
import type { JsonRpcResponse } from "../types/appserver.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import type {
  TransparentEngineSwitch,
  TransparentHandoffArtifact,
  TransparentHandoffHost,
  TransparentHandoffPort,
} from "../types/transparent-handoff.ts";
import type { EngineKind } from "../types/domain.ts";

/** Converges one execution-engine migration after the target resume response. */
export class TransparentHandoffService extends Service implements TransparentHandoffPort {
  constructor(ctx: Context) {
    super(ctx, "transparentHandoff");
  }

  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    handoff: TransparentEngineSwitch | undefined,
    host: TransparentHandoffHost,
  ): boolean {
    if (!handoff) return false;
    state.opening.delete(handoff.outerThreadId);
    const artifact = handoff.artifact;
    if (!artifact) {
      handoff.reject("The execution-engine switch lost its prepared rollout artifact.", -32072);
      return true;
    }

    if (message.error) {
      const reason = message.error.message || "unknown error";
      console.warn(
        `[transparent-codex] handoff resume failed outer=${handoff.outerThreadId} ` +
        `backend=${state.backendKey} error=${reason}`,
      );
      if (artifact.persistent) host.discardArtifact(artifact);
      host.retireIsolatedBackend(state, handoff.outerThreadId);
      if (artifact.persistent && /already has an active writer/i.test(reason) &&
          artifact.reidentified !== true) {
        console.info(
          `[transparent-codex] unmanaged writer fallback outer=${handoff.outerThreadId} ` +
          `inner=${handoff.binding.innerThreadId}`,
        );
        handoff.phase = "quiescing";
        handoff.reidentify = true;
        host.retry(handoff);
        return true;
      }
      handoff.reject(
        `Could not resume the rollout under the selected execution engine: ${reason}`,
        -32072,
      );
      return true;
    }

    const result = record(message.result);
    const thread = record(result?.["thread"]);
    const innerThreadId = text(thread?.["id"]);
    if (!innerThreadId) {
      this.rejectPrepared(
        state,
        handoff,
        artifact,
        host,
        "The selected execution engine did not return a thread id while resuming the rollout.",
      );
      return true;
    }
    if (artifact.resumeMode !== "history" && innerThreadId !== artifact.innerThreadId) {
      this.rejectPrepared(
        state,
        handoff,
        artifact,
        host,
        `The selected execution engine resumed unexpected thread ${innerThreadId}; ` +
          `expected ${artifact.innerThreadId}.`,
      );
      return true;
    }
    const resultRolloutPath = text(thread?.["path"]);
    if (artifact.resumeMode === "history" && !resultRolloutPath) {
      this.rejectPrepared(
        state,
        handoff,
        artifact,
        host,
        "The selected execution engine did not materialize a rollout while importing history.",
      );
      return true;
    }

    const committedArtifact: TransparentHandoffArtifact = artifact.resumeMode === "history"
      ? { ...artifact, innerThreadId, path: resultRolloutPath ?? artifact.path }
      : artifact;
    host.setBinding(
      handoff.outerThreadId,
      innerThreadId,
      state.realm,
      state.viewId,
      {
        ownerUserId: handoff.actorCredential.userId,
        accountIdentity: handoff.actorCredential.accountIdentity,
        providerId: handoff.actorCredential.providerId ?? null,
        engineKind: supportedEngineKind(handoff.executionProfile?.engineKind),
        model: text(handoff.resumeRoute?.["model"]),
        rolloutPath: committedArtifact.path,
        backendKey: state.backendKey,
        epoch: handoff.authority.epoch,
        nextProviderId: undefined,
        nextModel: undefined,
        nextThreadSettings: undefined,
      },
    );
    if (artifact.persistent) {
      host.commitArtifact(
        committedArtifact,
        handoff.actorCredential.accountIdentity,
        handoff.authority.epoch,
        handoff.actorCredential.userId,
      );
    }
    if (artifact.persistent && artifact.resumeMode === "history") {
      host.discardArtifact(artifact);
    }
    if (handoff.oldState &&
        !host.retireIsolatedBackend(handoff.oldState, handoff.outerThreadId) &&
        handoff.oldState !== state) {
      handoff.oldState.opened.delete(handoff.outerThreadId);
      handoff.oldState.openResults.delete(handoff.outerThreadId);
      host.unsubscribe(handoff.oldState, handoff.binding.innerThreadId);
    }

    host.projectThread(handoff.outerThreadId, thread);
    state.opened.add(handoff.outerThreadId);
    state.openResults.set(handoff.outerThreadId, message.result);
    host.flushThreadMessages(innerThreadId);
    host.discardUnmatchedThreadMessages();
    console.info(
      `[transparent-codex] handoff ready outer=${handoff.outerThreadId} ` +
      `epoch=${handoff.authority.epoch} generation=${artifact.generation}`,
    );
    host.forwardTurn(state, handoff.connection, handoff.outerThreadId, handoff.message);
    return true;
  }

  private rejectPrepared(
    state: TransparentBackendState,
    handoff: TransparentEngineSwitch,
    artifact: TransparentHandoffArtifact,
    host: TransparentHandoffHost,
    reason: string,
  ): void {
    if (artifact.persistent) host.discardArtifact(artifact);
    host.retireIsolatedBackend(state, handoff.outerThreadId);
    handoff.reject(reason, -32072);
  }
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
