/**
 * Runtime-neutral server side of one client WebSocket.
 *
 * Session code (logical routing, access sessions, resume, heartbeat policy)
 * depends only on this contract. Node `ws`, the in-memory test transport and a
 * hibernating single-writer socket are peer adapters. The floor is the weakest
 * runtime: request-scoped, no filesystem or child processes, and process memory
 * that may be dropped between two messages. Therefore the contract has
 *
 * - no listener registration: the runtime delivers events by calling the
 *   handler the session returned (a hibernated runtime dispatches into a fresh
 *   instance the same way);
 * - only `string` (text frame) and `Uint8Array` (binary frame) payloads, never
 *   runtime buffers, sockets or upgrade requests;
 * - a backpressure reading that may honestly be 0 where the runtime cannot
 *   observe its queue.
 *
 * Durable continuity across lost memory is not a socket concern: resume
 * sessions are reached through the store the session layer is given (see
 * `AppHostResumeStore` in `./app-host`).
 */

/** WHATWG `WebSocket.readyState` values. */
export const SESSION_SOCKET_CONNECTING = 0;
export const SESSION_SOCKET_OPEN = 1;
export const SESSION_SOCKET_CLOSING = 2;
export const SESSION_SOCKET_CLOSED = 3;

/** A text frame is a `string`; a binary frame is a `Uint8Array`. */
export type SessionFrame = string | Uint8Array;

export interface SessionSocket {
  /** WHATWG readyState; only `SESSION_SOCKET_OPEN` accepts frames. */
  readonly readyState: number;
  /**
   * Bytes accepted by `send` that the runtime has not yet written. The session
   * uses it to avoid growing a congested queue; 0 where it cannot be observed.
   */
  readonly bufferedAmount: number;
  /**
   * Queue one frame. `done` runs once the runtime finished (or failed) the
   * local write; it is not peer receipt. Synchronous runtimes may run it on the
   * next microtask.
   */
  send(frame: SessionFrame, done?: (error?: Error) => void): void;
  /** Start the closing handshake with an application close code. */
  close(code: number, reason: string): void;
  /** Drop the connection without waiting for the peer; runtimes without the distinction close. */
  terminate(): void;
}

/** Events the runtime delivers to a session, each at most once per socket for `close`. */
export interface SessionSocketHandler {
  /** `byteLength` is the frame's size on the wire (UTF-8 bytes for text). */
  message(frame: SessionFrame, byteLength: number): void;
  /** The socket is gone; `code` is the close code the runtime observed (1006 for abnormal loss). */
  close(code: number): void;
  /** A transport error; `close` follows. */
  error(): void;
}
