import {
  asHostId,
  createConversationKey,
  encodeConversationKey,
  equalConversationKey,
  type ConversationKey,
  type HostId,
  type OpaqueId,
} from "@opencraft/chat-core";

/** Identity of one retained presentation of a Conversation Scope. */
export type RouteScopeId = OpaqueId<"RouteScopeId">;

export function asRouteScopeId(value: string): RouteScopeId {
  const normalized = value.trim();
  if (normalized.length === 0) throw new RangeError("Route Scope ID must not be empty");
  return normalized as RouteScopeId;
}

export interface WorkbenchDraftLocation {
  readonly kind: "draft";
  readonly hostId: HostId;
  readonly draftId: string;
}

export interface WorkbenchThreadLocation {
  readonly kind: "thread";
  readonly key: ConversationKey;
}

/**
 * Serializable semantic location for the workbench. It deliberately excludes
 * React state, panel geometry and Replica data. Platform routers own how this
 * value enters their history; domain runtimes own how it is activated.
 */
export type WorkbenchLocation = WorkbenchDraftLocation | WorkbenchThreadLocation;

function requireDraftId(value: string): string {
  const draftId = value.trim();
  if (draftId.length === 0) throw new RangeError("Draft ID must not be empty");
  return draftId;
}

export function createWorkbenchDraftLocation(
  hostId: string,
  draftId: string,
): WorkbenchDraftLocation {
  return Object.freeze({
    kind: "draft",
    hostId: asHostId(hostId),
    draftId: requireDraftId(draftId),
  });
}

export function createWorkbenchThreadLocation(
  hostId: string,
  threadId: string,
): WorkbenchThreadLocation {
  return Object.freeze({
    kind: "thread",
    key: createConversationKey(hostId, threadId),
  });
}

export function workbenchLocationHostId(location: WorkbenchLocation): HostId {
  return location.kind === "thread" ? location.key.hostId : location.hostId;
}

export function equalWorkbenchLocation(
  left: WorkbenchLocation,
  right: WorkbenchLocation,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "thread" && right.kind === "thread") {
    return equalConversationKey(left.key, right.key);
  }
  return left.kind === "draft"
    && right.kind === "draft"
    && left.hostId === right.hostId
    && left.draftId === right.draftId;
}

/** Collision-free cache key shared by Web and Native view checkpoints. */
export function encodeWorkbenchLocation(location: WorkbenchLocation): string {
  return location.kind === "thread"
    ? JSON.stringify(["thread", encodeConversationKey(location.key)])
    : JSON.stringify(["draft", location.hostId, location.draftId]);
}

export function parseWorkbenchLocation(value: unknown): WorkbenchLocation | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as {
    kind?: unknown;
    hostId?: unknown;
    threadId?: unknown;
    draftId?: unknown;
  };
  if (
    candidate.kind === "thread"
    && typeof candidate.hostId === "string"
    && typeof candidate.threadId === "string"
  ) {
    try {
      return createWorkbenchThreadLocation(candidate.hostId, candidate.threadId);
    } catch {
      return null;
    }
  }
  if (
    candidate.kind === "draft"
    && typeof candidate.hostId === "string"
    && typeof candidate.draftId === "string"
  ) {
    try {
      return createWorkbenchDraftLocation(candidate.hostId, candidate.draftId);
    } catch {
      return null;
    }
  }
  return null;
}

export function serializeWorkbenchLocation(location: WorkbenchLocation) {
  return location.kind === "thread"
    ? {
        kind: "thread" as const,
        hostId: location.key.hostId,
        threadId: location.key.threadId,
      }
    : {
        kind: "draft" as const,
        hostId: location.hostId,
        draftId: location.draftId,
      };
}
