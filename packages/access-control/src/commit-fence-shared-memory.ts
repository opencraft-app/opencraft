import { CommitFenceDenied, type CommitFence, type CommitFenceCheck } from "./commit-fence.js";

/**
 * Shared-memory adapter of the commit fence port: the owner Worker blocks on a
 * `SharedArrayBuffer` until the network thread answered (the Node
 * single-writer Worker). The Worker may block; the network thread never does.
 *
 * The network thread may defer an answer, e.g. until its projection applied
 * every write the owner committed before the request; the Worker keeps
 * blocking until its timeout, and a late answer is never taken for a later
 * request.
 *
 * Layout: [state, request token, approval, answered token].
 */
const IDLE = 0,
  REQUEST = 1,
  ANSWER = 2;
// Available in every supported Node; declared here until the lib target includes ES2024.
const waitAsync = (
  Atomics as unknown as {
    waitAsync(
      array: Int32Array,
      index: number,
      value: number,
    ): { async: false; value: string } | { async: true; value: Promise<string> };
  }
).waitAsync;
const STATE = 0,
  TOKEN = 1,
  APPROVED = 2,
  ANSWERED = 3;

/**
 * Network-thread side: answers each fence request with `check(token)`. A check
 * that returns a promise defers the answer until it settles; a rejection denies.
 */
export function serveCommitFence(buffer: SharedArrayBuffer, check: CommitFenceCheck): () => void {
  const state = new Int32Array(buffer);
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const value = Atomics.load(state, STATE);
      if (value === REQUEST) {
        const token = Atomics.load(state, TOKEN);
        let approved = false;
        try {
          const verdict = check(token);
          approved = (typeof verdict === "boolean" ? verdict : await verdict) === true;
        } catch {
          /* A failing check denies. */
        }
        if (stopped) break;
        // A deferred answer is for this request only: the Worker may have timed
        // out meanwhile and asked again with another token.
        if (Atomics.load(state, STATE) !== REQUEST || Atomics.load(state, TOKEN) !== token) continue;
        Atomics.store(state, APPROVED, approved ? 1 : 0);
        Atomics.store(state, ANSWERED, token);
        Atomics.compareExchange(state, STATE, REQUEST, ANSWER);
        Atomics.notify(state, STATE);
        continue;
      }
      const wait = waitAsync(state, STATE, value);
      if (wait.async) await wait.value;
    }
  })();
  return () => {
    stopped = true;
    Atomics.notify(state, STATE);
  };
}

/**
 * Worker side: blocks until the network thread answered `token`, and throws
 * unless it approved. A missing or late answer denies; the caller's write
 * then rolls back.
 */
export function commitFence(buffer: SharedArrayBuffer, timeoutMs = 2_000): (token: number) => void {
  const state = new Int32Array(buffer);
  return (token) => {
    Atomics.store(state, TOKEN, token);
    Atomics.store(state, STATE, REQUEST);
    Atomics.notify(state, STATE);
    Atomics.wait(state, STATE, REQUEST, timeoutMs);
    const approved =
      Atomics.load(state, STATE) === ANSWER &&
      Atomics.load(state, ANSWERED) === token &&
      Atomics.load(state, APPROVED) === 1;
    Atomics.store(state, STATE, IDLE);
    Atomics.notify(state, STATE);
    if (!approved) throw new CommitFenceDenied();
  };
}

export function createCommitFenceBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
}

/**
 * The commit fence over one shared buffer. Each thread builds its own view of
 * the same buffer: the network thread serves it, the owner Worker passes it
 * (the buffer itself is what crosses to the Worker).
 */
export function sharedMemoryCommitFence(buffer: SharedArrayBuffer, timeoutMs = 2_000): CommitFence {
  let pass: ((token: number) => void) | undefined;
  return {
    serve: (check) => serveCommitFence(buffer, check),
    pass: (token) => (pass ??= commitFence(buffer, timeoutMs))(token),
  };
}
