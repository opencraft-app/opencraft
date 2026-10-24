'use strict';
const { CreditWindow, parseMediaFeedback, packetId } = require('./protocol.cjs');

/** One negotiated receiver. Network writes and authority remain in the adapter. */
class MediaFlow {
  constructor({ stage, epoch, configure, keyframe, close, pace = () => {}, now = () => performance.now() }) {
    this.stage = stage; this.epochFactory = epoch; this.configure = configure;
    this.keyframe = keyframe; this.close = close; this.pace = pace; this.now = now;
    this.credits = new CreditWindow({ maxItems: 6, maxBytes: 2 * 1024 * 1024, maxItemBytes: 4 * 1024 * 1024 });
    this.ready = false; this.gap = true; this.lastKey = -Infinity; this.lastReset = -Infinity;
    this.disposed = false; this.recoveryAttempts = 0; this.reset();
  }
  reset() {
    if (this.disposed || this.now() - this.lastReset < 1000) return;
    // A peer confirming reset without making progress cannot keep the attachment alive forever.
    if (this.epoch && ++this.recoveryAttempts > 3) { this.disposed = true; this.close(); return; }
    this.epoch = this.epochFactory(); this.ready = false; this.lastReset = this.now(); this.gap = true;
    // Keep old credits until the receiver confirms it discarded old decoder work.
    this.configure({ type: 'media-config', version: 1, epoch: this.epoch, stage: this.stage,
      profile: 'h264-timestamp-v1', maxFrameBytes: this.credits.maxItemBytes });
  }
  feedback(value) {
    const feedback = parseMediaFeedback(value);
    if (this.disposed || !feedback || feedback.epoch !== this.epoch) return false;
    if (feedback.ready) {
      if (!this.ready) { this.credits.retire(); this.ready = true; this.gap = true; if (feedback.fps !== undefined) this.pace(feedback.fps); this.requestKey(); }
      return true;
    }
    if (!this.ready) return false;
    if (feedback.requestReset) { this.reset(); return true; }
    const received = this.credits.index(feedback.received);
    const rendered = this.credits.index(feedback.rendered);
    if (this.stage === 'received') {
      if (received >= 0) { this.credits.acknowledgeThrough(feedback.received); this.recoveryAttempts = 0; }
    } else if (received >= 0 && rendered >= 0 && rendered <= received) {
      this.credits.acknowledgeThrough(feedback.rendered);
      this.recoveryAttempts = 0;
    }
    if (feedback.fps !== undefined) this.pace(feedback.fps);
    if (this.gap) this.requestKey();
    return true;
  }
  requestKey() {
    if (!this.ready || this.now() - this.lastKey < 1000) return;
    this.lastKey = this.now(); this.keyframe();
  }
  admit(packet) {
    if (!this.ready || this.disposed) return false;
    const id = packetId(packet); if (id === null) return false;
    if (packet.byteLength > this.credits.maxItemBytes) { this.disposed = true; this.close(); return false; }
    if (this.gap && packet[0] !== 1) { this.requestKey(); return false; }
    if (!this.credits.reserve(id, packet.byteLength, packet[0] === 1, this.now())) {
      this.gap = true; this.requestKey(); return false;
    }
    if (packet[0] === 1) this.gap = false;
    return true;
  }
  tick() {
    if (this.disposed) return;
    if (!this.ready) { if (this.now() - this.lastReset >= 10000) { this.disposed = true; this.close(); } return; }
    // Quiet screens have no outstanding work. Only debt can trigger a reset.
    if (this.credits.oldestAge(this.now()) >= 1500) this.reset();
    else if (this.gap) this.requestKey();
  }
  dispose() { this.disposed = true; this.credits.retire(); }
}
module.exports = { MediaFlow };
