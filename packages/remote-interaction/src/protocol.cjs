'use strict';

const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
const epoch = value => typeof value === 'string' && /^[a-zA-Z0-9-]{20,100}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
function packetId(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 10 || bytes[0] > 1) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(1).toString();
}
function parseMediaConfig(value) {
  if (!record(value) || value.type !== 'media-config' || value.version !== 1 || !epoch(value.epoch)
    || !['received', 'rendered'].includes(value.stage) || value.profile !== 'h264-timestamp-v1'
    || value.bucket !== undefined && !['fast', 'slow'].includes(value.bucket)
    || !positive(value.maxFrameBytes) || value.maxFrameBytes > 4 * 1024 * 1024) return null;
  return { type: 'media-config', version: 1, epoch: value.epoch, stage: value.stage,
    profile: 'h264-timestamp-v1', maxFrameBytes: value.maxFrameBytes, ...(value.bucket ? { bucket: value.bucket } : {}) };
}
function parseMediaFeedback(value) {
  if (!record(value) || value.version !== 1 || !epoch(value.epoch)
    || value.received !== null && !decimal(value.received)
    || value.rendered !== null && !decimal(value.rendered)
    || value.ready !== undefined && typeof value.ready !== 'boolean'
    || value.requestReset !== undefined && typeof value.requestReset !== 'boolean'
    || value.fps !== undefined && (!Number.isInteger(value.fps) || value.fps < 5 || value.fps > 30)) return null;
  if (value.ready && (value.received !== null || value.rendered !== null)) return null;
  return { version: 1, epoch: value.epoch, received: value.received, rendered: value.rendered,
    ready: value.ready === true, requestReset: value.requestReset === true, fps: value.fps };
}

/** A timeout settles a caller; it never releases capacity. No timer in this ledger. */
class CreditWindow {
  constructor({ maxItems, maxBytes, maxItemBytes = maxBytes }) {
    if (![maxItems, maxBytes, maxItemBytes].every(positive)) throw new TypeError('Invalid credit limits');
    this.maxItems = maxItems; this.maxBytes = maxBytes; this.maxItemBytes = maxItemBytes;
    this.items = new Map(); this.bytes = 0;
  }
  get size() { return this.items.size; }
  reserve(id, bytes, key = false, now = 0) {
    if (typeof id !== 'string' || !positive(bytes) || bytes > this.maxItemBytes || this.items.has(id)
      || this.size >= this.maxItems || this.bytes + bytes > this.maxBytes && !(key && this.size === 0)) return false;
    this.items.set(id, { bytes, at: now }); this.bytes += bytes; return true;
  }
  release(id) {
    const item = this.items.get(id); if (!item) return false;
    this.items.delete(id); this.bytes -= item.bytes; return true;
  }
  acknowledgeThrough(id) {
    if (!this.items.has(id)) return false;
    for (const key of this.items.keys()) { this.release(key); if (key === id) break; }
    return true;
  }
  contains(id) { return this.items.has(id); }
  index(id) { let n = 0; for (const key of this.items.keys()) { if (key === id) return n; n++; } return -1; }
  oldestAge(now) { const first = this.items.values().next().value; return first ? Math.max(0, now - first.at) : 0; }
  age(id, now) { const item = this.items.get(id); return item ? Math.max(0, now - item.at) : null; }
  /** Only after a confirmed receiver reset or retirement of this connection. */
  retire() { this.items.clear(); this.bytes = 0; }
}
module.exports = { CreditWindow, parseMediaConfig, parseMediaFeedback, packetId };
