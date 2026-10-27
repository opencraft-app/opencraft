'use strict';
const { CreditWindow, parseMediaFeedback, packetId } = require('./protocol.cjs');
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
/** Send timestamps measure local feedback turnaround, including receiver work. */
class MediaFlow {
  constructor({ stage, epoch, configure, keyframe, close, pace = () => {}, now = () => performance.now() }) {
    Object.assign(this, { stage, epochFactory: epoch, configure, keyframe, close, pace, now });
    this.credits = new CreditWindow({ maxItems: 12, maxBytes: 2 * 1024 * 1024, maxItemBytes: 4 * 1024 * 1024 });
    this.window = 12; this.requestedFps = this.fps = 30; this.bucket = 'fast';
    this.feedbackDelay = this.baseDelay = null; this.progressAt = this.pressureUntil = -Infinity;
    this.pressureStarted = null; this.pressureSamples = 0;
    this.sent = this.acked = this.dropped = this.resets = 0;
    this.ready = false; this.gap = true; this.lastKey = this.lastReset = -Infinity;
    this.disposed = false; this.recoveryAttempts = 0; this.reset();
  }
  reset() {
    if (this.disposed || this.now() - this.lastReset < 1000) return false;
    if (this.epoch && ++this.recoveryAttempts > 3) { this.disposed = true; this.close(); return false; }
    this.epoch = this.epochFactory(); this.ready = false; this.lastReset = this.now(); this.gap = true; this.resets++;
    this.configure({ type: 'media-config', version: 1, epoch: this.epoch, stage: this.stage,
      profile: 'h264-timestamp-v1', maxFrameBytes: this.credits.maxItemBytes, bucket: this.bucket });
    return true;
  }
  switchBucket(bucket) {
    if (!['fast', 'slow'].includes(bucket) || this.bucket === bucket || this.now() - this.lastReset < 1000 || this.disposed) return false;
    this.bucket = bucket; return this.reset();
  }
  capacity() {
    return !this.disposed && this.ready && this.credits.size < this.window
      && (this.credits.bytes < this.credits.maxBytes || this.credits.size === 0);
  }
  snapshot() {
    return { bucket: this.bucket, stage: this.stage, ready: this.ready, gap: this.gap,
      window: this.window, pending: this.credits.size, bytes: this.credits.bytes,
      oldestMs: Math.round(this.credits.oldestAge(this.now())), feedbackDelayMs: this.feedbackDelay === null ? null : Math.round(this.feedbackDelay),
      fps: this.fps, requestedFps: this.requestedFps, sent: this.sent, acknowledged: this.acked,
      dropped: this.dropped, resets: this.resets, pressure: this.pressureUntil > this.now(), recentProgress: this.now() - this.progressAt < 1500 };
  }
  feedback(value) {
    const feedback = parseMediaFeedback(value);
    if (this.disposed || !feedback || feedback.epoch !== this.epoch) return false;
    if (feedback.ready) {
      if (!this.ready) { this.credits.retire(); this.ready = true; this.gap = true; this.updateRate(feedback.fps); this.requestKey(); }
      return true;
    }
    if (!this.ready) return false;
    if (feedback.requestReset) { this.reset(); return true; }
    const received = this.credits.index(feedback.received), rendered = this.credits.index(feedback.rendered);
    const id = this.stage === 'received' ? received >= 0 ? feedback.received : null
      : received >= 0 && rendered >= 0 && rendered <= received ? feedback.rendered : null;
    if (id !== null) {
      const delay = this.credits.age(id, this.now());
      this.baseDelay = this.baseDelay === null ? delay : Math.min(this.baseDelay, delay);
      this.feedbackDelay = this.feedbackDelay === null ? delay : this.feedbackDelay * .8 + delay * .2;
      if (delay > this.baseDelay + 100) {
        this.pressureStarted ??= this.now(); ++this.pressureSamples;
        if (this.pressureSamples >= 3 && this.now() - this.pressureStarted >= 1000) this.pressureUntil = this.now() + 3000;
      } else { this.pressureStarted = null; this.pressureSamples = 0; }
      const before = this.credits.size; this.credits.acknowledgeThrough(id); this.acked += before - this.credits.size;
      this.recoveryAttempts = 0; this.progressAt = this.now();
    }
    this.updateRate(feedback.fps);
    if (this.gap) this.requestKey();
    return true;
  }
  updateRate(requested) {
    if (requested !== undefined) this.requestedFps = requested;
    const delay = this.feedbackDelay;
    this.fps = delay === null ? this.requestedFps : Math.min(this.requestedFps, Math.max(5, Math.floor(10000 / Math.max(1, delay + 50))));
    this.window = delay === null ? 12 : clamp(Math.ceil(this.fps * (delay + 50) / 1000) + 2, 6, 12);
    this.pace(this.fps);
  }
  requestKey() {
    if (!this.ready || this.now() - this.lastKey < 1000) return;
    this.lastKey = this.now(); this.keyframe();
  }
  admit(packet) {
    if (!this.ready || this.disposed) return false;
    const id = packetId(packet); if (id === null) return false;
    if (packet.byteLength > this.credits.maxItemBytes) { this.disposed = true; this.close(); return false; }
    if (this.gap && packet[0] !== 1) { this.requestKey(); this.dropped++; return false; }
    if (!this.capacity() || !this.credits.reserve(id, packet.byteLength, packet[0] === 1, this.now())) {
      this.gap = true; this.dropped++; this.pressureUntil = this.now() + 3000; this.requestKey(); return false;
    }
    if (packet[0] === 1) this.gap = false;
    this.sent++; return true;
  }
  tick() {
    if (this.disposed) return;
    if (!this.ready) { if (this.now() - this.lastReset >= 10000) { this.disposed = true; this.close(); } return; }
    if (this.credits.oldestAge(this.now()) >= 1500) this.reset();
    else if (this.gap) this.requestKey();
  }
  dispose() { this.disposed = true; this.credits.retire(); }
}
module.exports = { MediaFlow };
