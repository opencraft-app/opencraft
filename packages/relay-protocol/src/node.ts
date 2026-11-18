import type { Duplex } from 'node:stream';
import WebSocket, { createWebSocketStream } from 'ws';
/** Shared byte transport for ordinary relay and Hub links; owners enforce admission and lifetime. */
export function relayDuplex(socket: WebSocket) {
  const stream = createWebSocketStream(socket, { highWaterMark: 65_536 });
  // Relay is a byte stream. Bound each outer message so an inner WebSocket
  // fragment/control frame is forwarded without waiting for a giant outer FIN.
  stream._write = (chunk: Buffer, _encoding, callback) => {
    let offset = 0;
    const next = (error?: Error) => {
      if (error) { callback(error); return; }
      if (stream.destroyed) { callback(new Error('Relay stream closed')); return; }
      if (offset === chunk.length) { callback(); return; }
      const end = Math.min(offset + 16_384, chunk.length);
      const part = chunk.subarray(offset, end); offset = end;
      socket.send(part, { binary: true }, error => {
        if (error) callback(error); else setImmediate(next);
      });
    };
    if (socket.readyState === WebSocket.CONNECTING) socket.once('open', () => next());
    else next();
  };
  return stream;
}

/**
 * Tears down `to` when `from` closes. After a clean end, `from` has already
 * ended `to` through pipe(), so `to` keeps flushing its queued bytes and closes
 * on its own; destroying it here would truncate the tail of a response. Only an
 * abnormal close, or a flush that never completes, destroys `to`.
 */
export function closeWhenDone(from: Duplex, to: Duplex, flushMs = 30_000) {
  from.once('close', () => {
    if (to.destroyed) return;
    if (!from.readableEnded || to.writableFinished) { to.destroy(); return; }
    const timer = setTimeout(() => to.destroy(), flushMs); timer.unref();
    to.once('close', () => clearTimeout(timer));
  });
}
