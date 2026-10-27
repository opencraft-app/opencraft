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

/** ThreadView snapshots are immutable. A binding may retain the weak cache across live sources;
 * standalone callers still receive an independent JSON projection. */
function toJsonValue(
  value: unknown,
  cache: WeakMap<object, ReplicaJsonValue>,
  seen = new Set<object>(),
): ReplicaJsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) throw new TypeError("Thread View contains a cyclic value");
  const previous = cache.get(value);
  if (previous !== undefined) return previous;
  seen.add(value);
  let result: ReplicaJsonValue;
  if (value instanceof Error) {
    result = Object.freeze({ name: value.name, message: value.message });
  } else if (Array.isArray(value)) {
    result = Object.freeze(value.map(entry => toJsonValue(entry, cache, seen) ?? null));
  } else {
    const record: Record<string, ReplicaJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const converted = toJsonValue(entry, cache, seen);
      if (converted !== undefined) record[key] = converted;
    }
    result = Object.freeze(record);
  }
  seen.delete(value);
  cache.set(value, result);
  return result;
}

export function projectThreadViewForReplica(
  view: ThreadView,
  cache = new WeakMap<object, ReplicaJsonValue>(),
): ReplicaJsonValue {
  const projected = toJsonValue(view, cache);
  if (projected === undefined) throw new TypeError("Thread View cannot be represented as Replica JSON");
  return projected;
}

export function threadViewReplicaScope(hostId: string, threadId: string): string {
  return `appserver-thread:${hostId}:${threadId}`;
}

function threadViewEpoch(view: ThreadView): string {
  return `appserver-v3:${view.hostId}:${view.connectionGeneration}`;
}

function measuredProjection(view: ThreadView, cache: WeakMap<object, ReplicaJsonValue>, onProjection?: (durationMs: number) => void) {
  const start = performance.now();
  const value = projectThreadViewForReplica(view, cache);
  onProjection?.(performance.now() - start);
  return value;
}

function snapshotFor(
  scope: string,
  threadId: string,
  view: ThreadView | null,
  reason: ReplicaSnapshotResponse["reason"],
  cache: WeakMap<object, ReplicaJsonValue>,
  onProjection?: (durationMs: number) => void,
): ReplicaSnapshotResponse {
  const epoch = view === null ? `${scope}:unmounted` : threadViewEpoch(view);
  const nextSeq = view === null ? 1 : view.revision + 1;
  return {
    kind: "snapshot",
    scope,
    epoch,
    bounds: { journalStartSeq: nextSeq, nextSeq },
    entities: view === null ? [] : [{
      entityId: threadId,
      value: measuredProjection(view, cache, onProjection),
    }],
    reason,
  };
}

/**
 * Compatibility source for AppServer V3 Thread Views. It exposes View revisions to
 * the V4 client shape without claiming a server-retained journal. A missed
 * revision or connection generation change is therefore a snapshot boundary.
 */
export function createThreadViewReplicaSource(
  store: ThreadViewReplicaStore,
  hostId: string,
  threadId: string,
  cache = new WeakMap<object, ReplicaJsonValue>(),
  onProjection?: (durationMs: number) => void,
): ReplicaSource {
  const scope = threadViewReplicaScope(hostId, threadId);
  return {
    scope,
    async sync(cursor) {
      const view = store.get(threadId);
      const snapshot = snapshotFor(scope, threadId, view, "initial", cache, onProjection);
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
          listener({ kind: "snapshot", snapshot: snapshotFor(scope, threadId, null, "forced", cache, onProjection) });
          return;
        }
        if (
          previous === null
          || threadViewEpoch(previous) !== threadViewEpoch(current)
          || current.revision !== previous.revision + 1
        ) {
          previous = current;
          listener({ kind: "snapshot", snapshot: snapshotFor(scope, threadId, current, "forced", cache, onProjection) });
          return;
        }
        previous = current;
        const event: ReplicaLiveEvent = {
          kind: "entry",
          entry: {
            scope,
            epoch: threadViewEpoch(current),
            seq: current.revision,
            mutation: {
              kind: "upsert",
              entityId: threadId,
              value: measuredProjection(current, cache, onProjection),
            },
          },
        };
        listener(event);
      });
    },
  };
}
