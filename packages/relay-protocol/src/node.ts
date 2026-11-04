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
