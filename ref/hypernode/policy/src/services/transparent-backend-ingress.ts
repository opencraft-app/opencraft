import { Service, type Context } from "@deepseek-ai/cordis";
import type { JsonRpcResponse } from "../types/appserver.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import type {
  TransparentBackendIngressPort,
  TransparentIngressAuthorityPort,
} from "../types/transparent-ingress.ts";

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Owns native backend ingress fencing and pre-binding buffering.
 *
 * These are transport/control-plane rules, not AppServer presentation rules:
 * an old Runtime must never mutate a newer execution epoch, and a native
 * thread id must never escape before its durable outer binding exists.
 */
export class TransparentBackendIngressService extends Service
  implements TransparentBackendIngressPort {
  constructor(ctx: Context) {
    super(ctx, "transparentBackendIngress");
  }

  backendThreadId(message: JsonRpcResponse): string | null {
    if (!message.method) return null;
    const params = objectValue(message.params);
    return stringValue(objectValue(params["thread"])["id"]) ?? stringValue(params["threadId"]);
  }

  messageTurnId(message: JsonRpcResponse): string | null {
    const params = objectValue(message.params);
    return stringValue(objectValue(params["turn"])["id"]) ??
      stringValue(params["turnId"]) ??
      stringValue(objectValue(params["item"])["turnId"]);
  }

  isStaleAuthorityMessage(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    authority: TransparentIngressAuthorityPort,
  ): boolean {
    const innerThreadId = this.backendThreadId(message);
    if (!innerThreadId) return false;
    const outerThreadId = authority.outerThreadId(innerThreadId);
    if (!outerThreadId) return false;
    const turnId = this.messageTurnId(message);
    const activeExecution = authority.activeExecution(outerThreadId);
    const runtimeAuthority = authority.runtimeAuthority(outerThreadId);
    const expectedRuntimeId = activeExecution?.runtimeId ?? runtimeAuthority?.runtimeId;
    if (activeExecution && !activeExecution.runtimeId) {
      console.info(
        `[transparent-codex] fenced runtime message before dispatch outer=${outerThreadId} ` +
        `backend=${state.backendKey} epoch=${activeExecution.epoch}`,
      );
      return true;
    }
    if (expectedRuntimeId && expectedRuntimeId !== state.backendKey) {
      console.info(
        `[transparent-codex] fenced superseded runtime outer=${outerThreadId} ` +
        `backend=${state.backendKey} authority=${expectedRuntimeId}`,
      );
      return true;
    }
    if (!turnId) return false;
    const observedEpoch = state.turnEpochs.get(turnId);
    const latestEpoch = authority.latestEpoch(outerThreadId);
    if (observedEpoch === undefined || latestEpoch === null || observedEpoch === latestEpoch) return false;
    console.info(
      `[transparent-codex] fenced stale turn message outer=${outerThreadId} turn=${turnId} ` +
      `epoch=${observedEpoch} latestEpoch=${latestEpoch}`,
    );
    return true;
  }

  deferUntilThreadBinding(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    hasBinding: (innerThreadId: string) => boolean,
  ): boolean {
    const innerThreadId = this.backendThreadId(message);
    if (!innerThreadId || hasBinding(innerThreadId)) return false;
    const awaitingBinding = [...state.internalRequests.values()]
      .some((request) => request.method === "thread/start" || request.method === "thread/resume");
    if (!awaitingBinding) return false;
    const pending = state.pendingThreadMessages.get(innerThreadId) ?? [];
    pending.push(message);
    state.pendingThreadMessages.set(innerThreadId, pending);
    return true;
  }

  takeDeferredThreadMessages(
    state: TransparentBackendState,
    innerThreadId: string,
  ): JsonRpcResponse[] {
    const pending = state.pendingThreadMessages.get(innerThreadId) ?? [];
    state.pendingThreadMessages.delete(innerThreadId);
    return pending;
  }

  discardUnmatchedThreadMessages(state: TransparentBackendState): boolean {
    const awaitingBinding = [...state.internalRequests.values()]
      .some((request) => request.method === "thread/start" || request.method === "thread/resume");
    if (awaitingBinding) return false;
    state.pendingThreadMessages.clear();
    return true;
  }
}
