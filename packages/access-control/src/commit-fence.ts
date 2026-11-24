/**
 * Commit fence port (runtime-neutral; gateway-split §4.1.1 "根输入端口").
 *
 * A storage owner asks the authorizer (the side that holds the authority
 * projection) to recheck an authorization immediately before it commits, while
 * the owner holds its writer. The owner refuses the write unless that exact
 * request was approved in time.
 *
 * Two adapters implement it:
 *  - `sharedMemoryCommitFence` (`./commit-fence/shared-memory`): the owner runs
 *    on another thread and blocks on shared memory until the authorizer's
 *    event loop answered (the Node single-writer Worker).
 *  - `sameThreadCommitFence` (below): the owner and the authorizer run on one
 *    thread and one event loop (a single-writer object such as a Durable
 *    Object), so the recheck is a direct synchronous call.
 */

/** The authorizer's answer for one request; a promise defers it until it settles (a rejection denies). */
export type CommitFenceCheck = (token: number) => boolean | Promise<boolean>;

export interface CommitFence {
  /** Authorizer side: answers each request with `check(token)` until the returned function stops it. */
  serve(check: CommitFenceCheck): () => void;
  /**
   * Owner side, called inside the writer's transaction: returns when the
   * authorizer approved `token` in time and throws `CommitFenceDenied`
   * otherwise, so the write rolls back.
   */
  pass(token: number): void;
}

export class CommitFenceDenied extends Error {
  constructor() {
    super("Authorization changed before the write committed");
    this.name = "CommitFenceDenied";
  }
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null && typeof value === "object" && typeof (value as { then?: unknown }).then === "function";

/**
 * The fence for an owner that writes on the authorizer's own thread.
 *
 * Correctness. `pass` runs inside the owner's synchronous transaction on the
 * one thread that also runs every authority change, so nothing can change the
 * authority between the check and the commit: a synchronous `true` here is at
 * least as strong as the cross-thread fence's answer under the writer lock.
 * A deferred answer (the authorizer has not applied an earlier owner commit
 * yet) cannot be awaited without yielding inside the transaction, so it
 * denies — exactly what the cross-thread fence does when no answer arrives in
 * time. A missing or failing authorizer denies too.
 *
 * The recheck is not redundant on one thread: the authorizer's pre-check
 * happens when the write is issued, and the owner may run it only after
 * earlier queued writes (for example a revocation) committed, so the fence is
 * a real check, never a no-op.
 */
export function sameThreadCommitFence(): CommitFence {
  let current: CommitFenceCheck | null = null;
  return {
    serve(check) {
      if (current) throw new Error("A commit fence has one authorizer");
      current = check;
      return () => {
        if (current === check) current = null;
      };
    },
    pass(token) {
      let approved = false;
      try {
        const verdict = current?.(token);
        if (isThenable(verdict))
          // Not an answer in time; settle it quietly, the request is denied.
          verdict.then(undefined, () => undefined);
        else approved = verdict === true;
      } catch {
        /* A failing check denies. */
      }
      if (!approved) throw new CommitFenceDenied();
    },
  };
}
