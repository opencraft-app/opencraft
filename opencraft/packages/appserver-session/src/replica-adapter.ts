import type {
  ReplicaDeltaResponse,
  ReplicaJsonValue,
  ReplicaSnapshotResponse,
} from "@opencraft/appserver-protocol";
import type { ReplicaLiveEvent, ReplicaSource } from "@opencraft/appserver-replica";

import type { ThreadView } from "./models";

export interface ThreadViewReplicaStore {
  get(threadId: string): ThreadView | null;
  subscribeThread(threadId: string, listener: () => void): () => void;
}

function toJsonValue(value: unknown, seen = new Set<object>()): ReplicaJsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry, seen) ?? null);
  }
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) throw new TypeError("Thread View contains a cyclic value");
  seen.add(value);
  const result: Record<string, ReplicaJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const converted = toJsonValue(entry, seen);
    if (converted !== undefined) result[key] = converted;
  }
  seen.delete(value);
  return result;
}

export function projectThreadViewForReplica(view: ThreadView): ReplicaJsonValue {
  const projected = toJsonValue(view);
  if (projected === undefined) throw new TypeError("Thread View cannot be represented as Replica JSON");
  return projected;
}

export function codexThreadReplicaScope(hostId: string, threadId: string): string {
  return `codex-thread:${hostId}:${threadId}`;
}

function codexViewEpoch(view: ThreadView): string {
  return `codex-v3:${view.hostId}:${view.connectionGeneration}`;
}

function snapshotFor(
  scope: string,
  threadId: string,
  view: ThreadView | null,
  reason: ReplicaSnapshotResponse["reason"],
): ReplicaSnapshotResponse {
  const epoch = view === null ? `${scope}:unmounted` : codexViewEpoch(view);
  const nextSeq = view === null ? 1 : view.revision + 1;
  return {
    kind: "snapshot",
    scope,
    epoch,
    bounds: { journalStartSeq: nextSeq, nextSeq },
    entities: view === null ? [] : [{
      entityId: threadId,
      value: projectThreadViewForReplica(view),
    }],
    reason,
  };
}

/**
 * Compatibility source for Codex AppServer V3. It exposes View revisions to
 * the V4 client shape without claiming a server-retained journal. A missed
 * revision or connection generation change is therefore a snapshot boundary.
 */
export function createCodexThreadReplicaSource(
  store: ThreadViewReplicaStore,
  hostId: string,
  threadId: string,
): ReplicaSource {
  const scope = codexThreadReplicaScope(hostId, threadId);
  return {
    scope,
    async sync(cursor) {
      const view = store.get(threadId);
      const snapshot = snapshotFor(scope, threadId, view, "initial");
      if (cursor === null) return snapshot;
      if (cursor.epoch !== snapshot.epoch) return { ...snapshot, reason: "epoch_changed" };
      if (cursor.nextSeq < snapshot.bounds.nextSeq) {
        return { ...snapshot, reason: "journal_compacted" };
      }
      if (cursor.nextSeq > snapshot.bounds.nextSeq) return { ...snapshot, reason: "rewind" };
      const delta: ReplicaDeltaResponse = {
        kind: "delta",
        scope,
        epoch: snapshot.epoch,
        bounds: snapshot.bounds,
        fromNextSeq: cursor.nextSeq,
        entries: [],
        hasMore: false,
      };
      return delta;
    },
    subscribe(listener) {
      let previous = store.get(threadId);
      return store.subscribeThread(threadId, () => {
        const current = store.get(threadId);
        if (current === null) {
          previous = null;
          listener({ kind: "snapshot", snapshot: snapshotFor(scope, threadId, null, "forced") });
          return;
        }
        if (
          previous === null
          || codexViewEpoch(previous) !== codexViewEpoch(current)
          || current.revision !== previous.revision + 1
        ) {
          previous = current;
          listener({ kind: "snapshot", snapshot: snapshotFor(scope, threadId, current, "forced") });
          return;
        }
        previous = current;
        const event: ReplicaLiveEvent = {
          kind: "entry",
          entry: {
            scope,
            epoch: codexViewEpoch(current),
            seq: current.revision,
            mutation: {
              kind: "upsert",
              entityId: threadId,
              value: projectThreadViewForReplica(current),
            },
          },
        };
        listener(event);
      });
    },
  };
}
