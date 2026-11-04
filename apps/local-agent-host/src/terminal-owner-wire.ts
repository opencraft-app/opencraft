import type { Socket } from 'node:net';
export const TERMINAL_OWNER_PROTOCOL = 1;
export const TERMINAL_OWNER_FRAME_BYTES = 4 * 1024 * 1024;
export function sendOwnerFrame(socket: Socket, value: unknown) {
  const frame = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(frame) > TERMINAL_OWNER_FRAME_BYTES || socket.writableLength + Buffer.byteLength(frame) > TERMINAL_OWNER_FRAME_BYTES) {
    socket.destroy(); return;
  }
  socket.write(frame);
}
export function readOwnerFrames(socket: Socket, receive: (message: any) => void) {
  let buffered = Buffer.alloc(0);
  socket.on('data', (bytes: Buffer) => {
    buffered = Buffer.concat([buffered, bytes]);
    for (;;) {
      const end = buffered.indexOf(10);
      if (end < 0) break;
      if (end > TERMINAL_OWNER_FRAME_BYTES) { socket.destroy(); return; }
      const line = buffered.subarray(0, end); buffered = buffered.subarray(end + 1);
      try { receive(JSON.parse(line.toString('utf8'))); } catch { socket.destroy(); return; }
      if (socket.destroyed) return;
    }
    if (buffered.length > TERMINAL_OWNER_FRAME_BYTES) socket.destroy();
  });
}
