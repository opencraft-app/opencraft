/**
 * A commit fence lets a storage owner Worker ask the network thread to recheck
 * an authorization immediately before it commits, while the owner holds the
 * database writer lock. The Worker blocks on the answer (it may block; the
 * network thread never does) and refuses the write unless the network thread
 * approved that exact request in time.
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

export class CommitFenceDenied extends Error {
  constructor() {
    super("Authorization changed before the write committed");
    this.name = "CommitFenceDenied";
  }
}

/** Network-thread side: answers each fence request with `check(token)`. */
export function serveCommitFence(buffer: SharedArrayBuffer, check: (token: number) => boolean): () => void {
  const state = new Int32Array(buffer);
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const value = Atomics.load(state, STATE);
      if (value === REQUEST) {
        const token = Atomics.load(state, TOKEN);
        let approved = false;
        try {
          approved = check(token) === true;
        } catch {
          /* A failing check denies. */
        }
        Atomics.store(state, APPROVED, approved ? 1 : 0);
        Atomics.store(state, ANSWERED, token);
        Atomics.store(state, STATE, ANSWER);
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
