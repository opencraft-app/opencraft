import WebSocket, { createWebSocketStream } from 'ws';
import type { Duplex } from 'node:stream';
/** Idle bound for a relayed stream. Live chat routes carry server heartbeats
 * every few seconds, so only abandoned streams reach it; there is no absolute
 * lifetime that would cut an active conversation on a fixed schedule. */
export const RELAY_STREAM_IDLE_MS = 15 * 60_000;

/** Calls expire() once the socket has carried no frame in either direction
 * for idleMs. Returns a canceller; the timer never holds the process open. */
export function relayIdleDeadline(socket: WebSocket, expire: () => void, idleMs = RELAY_STREAM_IDLE_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; expire(); }, idleMs); timer.unref?.();
  };
  const send = socket.send.bind(socket);
  socket.send = ((...args: Parameters<WebSocket['send']>) => { arm(); return send(...args); }) as WebSocket['send'];
  socket.on('message', arm);
  arm();
  return () => { if (timer !== null) clearTimeout(timer); timer = null; socket.off('message', arm); };
}

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

/** EOF drains queued writes; errors, truncated streams and owner cancellation abort immediately. */
export function bridgeRelayDuplex(left: Duplex, right: Duplex): () => void {
  const deadlines = new Set<ReturnType<typeof setTimeout>>();
  const abort = () => {
    for (const timer of deadlines) clearTimeout(timer);
    deadlines.clear(); left.destroy(); right.destroy();
  };
  const closed = (source: Duplex, destination: Duplex) => {
    if (source.errored || !source.readableEnded) { abort(); return; }
    destination.unpipe(source);
    if (destination.destroyed) return;
    const timer = setTimeout(abort, 30_000); timer.unref(); deadlines.add(timer);
    destination.once('close', () => { clearTimeout(timer); deadlines.delete(timer); });
    // pipe() normally ends this writer already. end() preserves its pending
    // writes; destroy()/WebSocket.terminate() would discard the response tail.
    if (!destination.writableEnded) destination.end();
  };
  left.on('error', abort); right.on('error', abort);
  left.once('close', () => closed(left, right)); right.once('close', () => closed(right, left));
  left.pipe(right); right.pipe(left);
  return abort;
}
