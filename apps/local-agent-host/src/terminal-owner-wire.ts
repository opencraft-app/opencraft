import type { Socket } from 'node:net';
export const TERMINAL_OWNER_PROTOCOL = 1;
export const TERMINAL_OWNER_FRAME_BYTES = 4 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeTerminalOwnerFrame(value: unknown): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(value) + '\n');
  if (bytes.byteLength > TERMINAL_OWNER_FRAME_BYTES) throw new Error('Terminal owner frame exceeds its budget');
  return bytes;
}

/** Decode complete lines once, even when the endpoint delivers a split UTF-8 codepoint. */
export function terminalOwnerFrameReader(receive: (message: unknown) => void) {
  let pending = new Uint8Array(0);
  let length = 0;
  return (bytes: Uint8Array) => {
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      const part = bytes.subarray(offset, end === -1 ? bytes.length : end);
      const required = length + part.length;
      if (required > TERMINAL_OWNER_FRAME_BYTES) throw new Error('Terminal owner frame exceeds its budget');
      if (!length && end !== -1) {
        receive(JSON.parse(decoder.decode(part)));
        offset = end + 1;
        continue;
      }
      if (required > pending.length) {
        const capacity = Math.min(TERMINAL_OWNER_FRAME_BYTES, Math.max(required, pending.length * 2, 4096));
        const grown = new Uint8Array(capacity);
        grown.set(pending.subarray(0, length));
        pending = grown;
      }
      pending.set(part, length);
      length = required;
      if (end === -1) return;
      const line = pending.subarray(0, length);
      length = 0;
      if (pending.length > 64 * 1024) pending = new Uint8Array(0);
      receive(JSON.parse(decoder.decode(line)));
      offset = end + 1;
    }
  };
}

export function sendOwnerFrame(socket: Socket, value: unknown) {
  try {
    const frame = encodeTerminalOwnerFrame(value);
    if (socket.writableLength + frame.byteLength > TERMINAL_OWNER_FRAME_BYTES) { socket.destroy(); return; }
    socket.write(frame);
  } catch {
    socket.destroy();
  }
}
export function readOwnerFrames(socket: Socket, receive: (message: any) => void) {
  const read = terminalOwnerFrameReader(message => { if (!socket.destroyed) receive(message); });
  socket.on('data', (bytes: Uint8Array) => {
    try { read(bytes); } catch { socket.destroy(); }
  });
}
