import type { NativeControlLease } from "./native-control.js";

/** Pinned noVNC 1.5 / RFB 3.8 client messages. Observation bytes still go to
 * the immutable observer. Only key/pointer are projected to native input.
 * A fragmented message retains the grant present at its FIRST byte; later
 * acquire/release cannot promote buffered or stale input into a new grant. */
export class RfbInputDecoder {
  private buffer = Buffer.alloc(0);
  private grant: NativeControlLease | undefined;
  private stage = 0;
  constructor(private readonly current: () => NativeControlLease | undefined) {}
  push(chunk: Buffer): void {
    if (this.buffer.length + chunk.length > 1 << 20) throw new Error("Desktop input unavailable");
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.buffer.length) this.grant = this.current();
      // Buffer exactly one message, keeping the first-byte ownership even if
      // multiple complete messages and a trailing fragment share this chunk.
      const needed = this.length();
      const count = Math.min(chunk.length - offset, Math.max(1, needed - this.buffer.length));
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, offset + count)]); offset += count;
      const size = this.length();
      if (this.buffer.length < size) continue;
      if (this.stage < 3) {
        if (this.stage === 0 && this.buffer.toString() !== "RFB 003.008\n"
          || this.stage === 1 && this.buffer[0] !== 1) throw new Error("Desktop handshake unavailable");
        this.stage++;
      } else if (this.grant && this.grant === this.current() && this.grant.isValid()) {
        if (this.buffer[0] === 4) this.grant.key(this.buffer.readUInt32BE(4), this.buffer[1] === 1);
        else if (this.buffer[0] === 5) this.grant.pointer(this.buffer.readUInt16BE(2), this.buffer.readUInt16BE(4), this.buffer[1]!);
        else if (this.buffer[0] === 255) this.grant.key(this.buffer.readUInt32BE(4), this.buffer.readUInt16BE(2) === 1);
      }
      this.buffer = Buffer.alloc(0); this.grant = undefined;
    }
  }
  private length(): number {
    if (this.stage < 3) return this.stage === 0 ? 12 : 1;
    if (!this.buffer.length) return 1;
    switch (this.buffer[0]) {
      case 0: return 20;
      case 2: return this.buffer.length < 4 ? 4 : 4 + this.buffer.readUInt16BE(2) * 4;
      case 3: return 10;
      case 4:
        if (this.buffer.length >= 2 && this.buffer[1]! > 1) throw new Error("Invalid desktop key");
        return 8;
      case 5: return 6;
      case 6: {
        if (this.buffer.length < 8) return 8;
        const count = Math.abs(this.buffer.readInt32BE(4));
        if (count > 65536) throw new Error("Desktop clipboard unavailable");
        return 8 + count; // Parsed but NEVER sent to the native input executor.
      }
      case 150: return 10;
      case 248: return this.buffer.length < 9 ? 9 : 9 + this.buffer[8]!;
      case 251: return this.buffer.length < 8 ? 8 : 8 + this.buffer[6]! * 16;
      case 255:
        if (this.buffer.length >= 2 && this.buffer[1] !== 0) throw new Error("Unsupported desktop key");
        if (this.buffer.length >= 4 && this.buffer.readUInt16BE(2) > 1) throw new Error("Invalid desktop key");
        return 12;
      default: throw new Error("Unsupported desktop input");
    }
  }
}
