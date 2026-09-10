import type {
  ReplicaCursor,
  ReplicaEntryNotification,
  ReplicaJsonValue,
  ReplicaMutateParams,
  ReplicaMutation,
  ReplicaSnapshotNotification,
} from "@opencraft/appserver-protocol";

import type { ReplicaAuthority } from "./authority";
import { ReplicaError } from "./errors";

export interface ReplicaWireNotification {
  method: "replica/entry" | "replica/snapshot";
  params: ReplicaEntryNotification | ReplicaSnapshotNotification;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is ReplicaJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function parseCursor(value: unknown): ReplicaCursor | null {
  if (value === null) return null;
  if (
    !isRecord(value)
    || typeof value.epoch !== "string"
    || !Number.isSafeInteger(value.nextSeq)
  ) {
    throw new ReplicaError("PROTOCOL_ERROR", "replica cursor is malformed");
  }
  return { epoch: value.epoch, nextSeq: Number(value.nextSeq) };
}

function parseMutations(value: unknown): readonly ReplicaMutation[] {
  if (!Array.isArray(value)) throw new ReplicaError("PROTOCOL_ERROR", "replica mutations must be an array");
  return value.map((entry): ReplicaMutation => {
    if (!isRecord(entry) || typeof entry.entityId !== "string") {
      throw new ReplicaError("PROTOCOL_ERROR", "replica mutation is malformed");
    }
    if (entry.kind === "delete") return { kind: "delete", entityId: entry.entityId };
    if (entry.kind === "upsert" && isJsonValue(entry.value)) {
      return { kind: "upsert", entityId: entry.entityId, value: entry.value };
    }
    throw new ReplicaError("PROTOCOL_ERROR", "replica mutation has an invalid kind or value");
  });
}

/** Bridges a Replica authority into any JSON-RPC/WebSocket server implementation. */
export class ReplicaAuthorityRouter {
  private readonly notificationListeners = new Set<(notification: ReplicaWireNotification) => void>();
  private readonly removeAuthorityListener: () => void;

  constructor(private readonly authority: ReplicaAuthority) {
    this.removeAuthorityListener = authority.subscribe((event) => {
      const notification: ReplicaWireNotification = event.kind === "entry"
        ? { method: "replica/entry", params: { entry: event.entry } }
        : { method: "replica/snapshot", params: { snapshot: event.snapshot } };
      for (const listener of this.notificationListeners) listener(notification);
    });
  }

  subscribe(listener: (notification: ReplicaWireNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    if (!isRecord(params)) throw new ReplicaError("PROTOCOL_ERROR", `${method} params must be an object`);
    if (params.scope !== this.authority.scope) {
      throw new ReplicaError("PROTOCOL_ERROR", `${method} requested an unknown Replica scope`);
    }
    if (method === "replica/sync") {
      if (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1) {
        throw new ReplicaError("PROTOCOL_ERROR", "replica/sync limit must be positive");
      }
      return this.authority.sync(parseCursor(params.cursor), Number(params.limit));
    }
    if (method === "replica/mutate") {
      if (typeof params.commandId !== "string" || params.commandId.length === 0) {
        throw new ReplicaError("PROTOCOL_ERROR", "replica/mutate commandId must not be empty");
      }
      const request: ReplicaMutateParams = {
        scope: this.authority.scope,
        commandId: params.commandId,
        expectedCursor: params.expectedCursor === undefined ? null : parseCursor(params.expectedCursor),
        mutations: parseMutations(params.mutations),
      };
      return this.authority.mutate(request);
    }
    throw new ReplicaError("PROTOCOL_ERROR", `Unsupported Replica method ${method}`);
  }

  dispose(): void {
    this.removeAuthorityListener();
    this.notificationListeners.clear();
  }
}
