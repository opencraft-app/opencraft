'use strict';
const BUCKETS = Object.freeze(['fast', 'slow']);
const DEFAULT_BOUNDS = Object.freeze({ fast: Object.freeze({ fps: 30, bitrate: 2500000 }), slow: Object.freeze({ fps: 15, bitrate: 900000 }) });
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function bucketBounds(value = DEFAULT_BOUNDS) {
  if (!value || Object.keys(value).length !== 2 || BUCKETS.some(k => !value[k])) throw new TypeError('Exactly two encoding buckets required');
  const result = {};
  for (const k of BUCKETS) {
    const { fps, bitrate } = value[k];
    if (!Number.isInteger(fps) || fps < 5 || fps > 30 || !Number.isInteger(bitrate) || bitrate < 250000 || bitrate > 5000000)
      throw new TypeError('Invalid encoding bucket bounds');
    result[k] = { fps, bitrate };
  }
  if (result.slow.fps > result.fast.fps || result.slow.bitrate > result.fast.bitrate) throw new TypeError('Invalid slow bucket bounds');
  return result;
}
class AdaptiveInputWindow {
  constructor() { this.reset(); }
  reset() { this.limit = 2; this.delay = null; this.samples = 0; }
  observe(ms) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 25000) return;
    this.delay = this.delay === null ? ms : this.delay * .8 + ms * .2;
    this.samples++;
    this.limit = clamp(Math.ceil(this.delay * 60 / 1000) + 2, 2, 12);
  }
}
/** Fixed topology, adaptive operating point. Never allocates a per-viewer encoder. */
class EncodingBuckets {
  constructor(bounds) {
    this.bounds = bucketBounds(bounds); this.states = {};
    for (const k of BUCKETS) this.states[k] = { bitrate: this.bounds[k].bitrate, fps: this.bounds[k].fps, fpsChanged: -Infinity, changed: -Infinity, stable: null };
  }
  plan(consumers, now) {
    const result = {};
    for (const bucket of BUCKETS) {
      const members = consumers.filter(c => c.bucket === bucket), state = this.states[bucket], bound = this.bounds[bucket];
      const pressured = members.some(c => c.pressure);
      const recover = !pressured && members.some(c => c.progress) && state.stable !== null && now - state.stable >= 20000;
      if (pressured) {
        state.stable = null;
        if (now - state.changed >= 1000) { state.bitrate = Math.max(250000, Math.floor(state.bitrate * .8)); state.changed = now; }
      } else if (members.some(c => c.progress)) {
        state.stable ??= now;
        if (recover && now - state.changed >= 20000) {
          state.bitrate = Math.min(bound.bitrate, Math.ceil(state.bitrate * 1.1)); state.changed = now; state.stable = now;
        }
      } else state.stable = null;
      const targetFps = Math.min(bound.fps, Math.max(5, ...members.map(c => c.fps)));
      if (members.length && targetFps < state.fps && now - state.fpsChanged >= 1000) { state.fps = targetFps; state.fpsChanged = now; }
      else if (members.length && targetFps > state.fps && recover && now - state.fpsChanged >= 20000) {
        state.fps = Math.min(targetFps, state.fps + 2); state.fpsChanged = now;
      }
      result[bucket] = { allowed: members.some(c => c.allowed),
        fps: state.fps, bitrate: state.bitrate };
    }
    return result;
  }
}
module.exports = { BUCKETS, DEFAULT_BOUNDS, bucketBounds, AdaptiveInputWindow, EncodingBuckets };
