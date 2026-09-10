import type { ReplicaJsonValue } from "@opencraft/appserver-protocol";
import type { ReplicaClientSnapshot } from "@opencraft/appserver-replica";

export interface ThreadViewProjectionCommit {
  readonly hostId: string;
  readonly threadId: string;
  readonly connectionGeneration: number;
  readonly viewRevision: number;
}

export interface ThreadViewProjectionBarrier {
  waitUntilProjected(
    commit: ThreadViewProjectionCommit,
    options?: { readonly signal?: AbortSignal },
  ): Promise<number>;
}

/** Narrow Replica read port; keeps navigation/session code independent of client internals. */
export interface ThreadViewProjectionReplica {
  get(entityId: string): ReplicaJsonValue | null;
  getSnapshot(): ReplicaClientSnapshot<ReplicaJsonValue>;
  subscribe(listener: () => void): () => void;
}

function isRecord(value: ReplicaJsonValue): value is { readonly [key: string]: ReplicaJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): Error {
  const error = new Error("Navigation projection wait was aborted");
  error.name = "AbortError";
  return error;
}

function projectedViewSatisfies(
  replica: ThreadViewProjectionReplica,
  commit: ThreadViewProjectionCommit,
): boolean {
  const value = replica.get(commit.threadId);
  return value !== null
    && isRecord(value)
    && value.hostId === commit.hostId
    && value.threadId === commit.threadId
    && value.connectionGeneration === commit.connectionGeneration
    && typeof value.revision === "number"
    && value.revision >= commit.viewRevision;
}

/**
 * A commit barrier for the V3 View -> V4 Replica adapter. Resolution means the
 * exact ThreadView revision is visible from Replica authority, not merely that
 * some unrelated Replica revision was published.
 */
export function createThreadViewReplicaProjectionBarrier(
  replica: ThreadViewProjectionReplica,
): ThreadViewProjectionBarrier {
  return {
    waitUntilProjected(commit, options = {}) {
      if (options.signal?.aborted === true) return Promise.reject(abortError());
      if (projectedViewSatisfies(replica, commit)) return Promise.resolve(replica.getSnapshot().revision);
      const initial = replica.getSnapshot();
      if (initial.phase === "error") {
        return Promise.reject(initial.lastError ?? new Error("Replica projection failed"));
      }
      if (initial.phase === "offline") {
        return Promise.reject(new Error("Replica went offline before projection commit"));
      }
      return new Promise<number>((resolve, reject) => {
        let settled = false;
        let unsubscribe: () => void = () => undefined;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          unsubscribe();
          options.signal?.removeEventListener("abort", handleAbort);
          if (error === undefined) resolve(replica.getSnapshot().revision);
          else reject(error);
        };
        const inspect = () => {
          if (projectedViewSatisfies(replica, commit)) {
            finish();
            return;
          }
          const snapshot = replica.getSnapshot();
          if (snapshot.phase === "error") {
            finish(snapshot.lastError ?? new Error("Replica projection failed"));
          } else if (snapshot.phase === "offline") {
            finish(new Error("Replica went offline before projection commit"));
          }
        };
        const handleAbort = () => finish(abortError());
        const removeSubscription = replica.subscribe(inspect);
        unsubscribe = removeSubscription;
        if (settled) {
          removeSubscription();
        } else {
          options.signal?.addEventListener("abort", handleAbort, { once: true });
          inspect();
        }
      });
    },
  };
}
