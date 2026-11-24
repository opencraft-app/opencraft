import { utf8Length } from "@opencraft/app-host-resume";
import type { SessionFrame, SessionSocket, SessionSocketHandler } from "@opencraft/client-session";

/**
 * In-memory peer adapter of the session socket contract: no network, no
 * runtime socket. Events are delivered the way real runtimes do it: frames
 * from the peer synchronously into the handler, close notifications on a
 * later microtask and exactly once.
 */
export interface MemorySessionPeer {
  /** Frames the session sent, in order. */
  readonly received: readonly SessionFrame[];
  /** The close the session initiated, if any. */
  readonly closedBySession: { readonly code: number; readonly reason: string } | null;
  /** Resolves with the next frame the session sends that has not been read with `next` yet. */
  next(): Promise<SessionFrame>;
  /** Deliver a frame from the client to the session. */
  send(frame: SessionFrame): void;
  /** The client closes normally (closing handshake). */
  close(code?: number, reason?: string): void;
  /** The route dies without a closing handshake (abnormal loss, 1006 by default). */
  disconnect(code?: number): void;
}

export interface MemorySessionSocket {
  readonly socket: SessionSocket;
  readonly peer: MemorySessionPeer;
  /** Connect the handler the session produced for `socket`. */
  bind(handler: SessionSocketHandler): void;
}

export interface MemorySessionSocketOptions {
  /** Simulated unwritten bytes (backpressure reading); 0 by default. */
  readonly bufferedAmount?: () => number;
}

export function createMemorySessionSocket(options: MemorySessionSocketOptions = {}): MemorySessionSocket {
  let readyState = 1;
  let handler: SessionSocketHandler | null = null;
  let closeDelivered = false;
  let read = 0;
  let closedBySession: { code: number; reason: string } | null = null;
  const received: SessionFrame[] = [];
  const waiters: Array<(frame: SessionFrame) => void> = [];

  const finish = (code: number) => {
    readyState = 3;
    if (closeDelivered) return;
    closeDelivered = true;
    queueMicrotask(() => handler?.close(code));
  };

  const socket: SessionSocket = {
    get readyState() {
      return readyState;
    },
    get bufferedAmount() {
      return options.bufferedAmount?.() ?? 0;
    },
    send(frame, done) {
      if (readyState !== 1) {
        if (done) queueMicrotask(() => done(new Error("Session socket is not open")));
        return;
      }
      received.push(frame);
      const waiter = waiters.shift();
      if (waiter) {
        read++;
        waiter(frame);
      }
      if (done) queueMicrotask(() => done());
    },
    close(code, reason) {
      if (readyState >= 2) return;
      readyState = 2;
      closedBySession = { code, reason };
      // The peer echoes the close frame; the runtime then reports the code.
      queueMicrotask(() => finish(code));
    },
    terminate() {
      if (readyState === 3) return;
      finish(1006);
    },
  };

  const peer: MemorySessionPeer = {
    get received() {
      return received;
    },
    get closedBySession() {
      return closedBySession;
    },
    next() {
      if (read < received.length) return Promise.resolve(received[read++]!);
      return new Promise((resolve) => waiters.push(resolve));
    },
    send(frame) {
      if (readyState !== 1) throw new Error("Session socket is not open");
      if (!handler) throw new Error("Session socket has no handler");
      handler.message(frame, typeof frame === "string" ? utf8Length(frame) : frame.byteLength);
    },
    close(code = 1000) {
      if (readyState >= 2) return;
      readyState = 2;
      queueMicrotask(() => finish(code));
    },
    disconnect(code = 1006) {
      if (readyState === 3) return;
      finish(code);
    },
  };

  return {
    socket,
    peer,
    bind(next) {
      if (handler) throw new Error("Session socket is already bound");
      handler = next;
    },
  };
}
