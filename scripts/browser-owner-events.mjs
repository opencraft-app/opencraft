import { EventEmitter } from 'node:events';

/** Attachment may include events in the greeting's packet. Retain them until
 * the consumer has installed its listeners, including across async adoption. */
export class BrowserOwnerEvents extends EventEmitter {
  constructor() { super(); this.early = []; this.earlyBytes = 0; this.flushing = false; }
  on(name, listener) {
    super.on(name, listener);
    queueMicrotask(() => this.flush());
    return this;
  }
  publish(name, value) {
    if (!this.early.length && this.listenerCount(name)) return this.deliver(name, value);
    const bytes = Buffer.byteLength(JSON.stringify(value ?? null));
    if (this.early.length >= 256 || this.earlyBytes + bytes > 64 * 1024 * 1024) {
      this.early = []; this.earlyBytes = 0;
      this.kill();
      this.early.push({ name: 'error', value: new Error('Browser attachment event overflow'), bytes: 0 });
      this.flush();
      return;
    }
    this.early.push({ name, value, bytes }); this.earlyBytes += bytes;
    this.flush();
  }
  deliver(name, value) {
    try { return super.emit(name, value); }
    catch {
      // A malformed native event/consumer failure closes this fenced transport;
      // deferred adoption must not turn it into an uncaught microtask exception.
      this.early = []; this.earlyBytes = 0; this.kill(); return false;
    }
  }
  flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.early.length && this.listenerCount(this.early[0].name)) {
        const event = this.early.shift(); this.earlyBytes -= event.bytes;
        if (!this.deliver(event.name, event.value)) break;
      }
    } finally { this.flushing = false; }
  }
}
