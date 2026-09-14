// Source copy: HyperNode text-delta-pacer.js controller; host scheduling is separate.

export const TEXT_DELTA_PACER_DEFAULTS = Object.freeze({
  frameMs: 16,
  maxLagMs: 300,
  completionDrainMs: 160,
  cadenceMemoryMs: 2_000,
  cadenceAlpha: 0.45,
  minCadenceIntervalMs: 8,
  maxEstimatedRate: 20_000,
  smoothTimeMs: 72,
  maxNotificationGraphemes: 256,
});

function isCombining(codePoint) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
    || (codePoint >= 0xe0020 && codePoint <= 0xe007f)
    || codePoint === 0x20e3
  );
}

function isRegionalIndicator(codePoint) {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

// Goja does not currently expose Intl.Segmenter. Keep a deterministic fallback
// which preserves surrogate pairs, combining marks, emoji modifiers, flags and
// ZWJ emoji. Native runtimes use the Unicode grapheme segmenter when available.
export function splitGraphemes(value) {
  const text = String(value ?? "");
  if (!text) return [];
  if (typeof Intl === "object" && typeof Intl?.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(text)].map((entry) => entry.segment);
  }
  const output = [];
  let regionalCount = 0;
  for (const character of Array.from(text)) {
    const codePoint = character.codePointAt(0);
    const previous = output.at(-1) ?? "";
    const previousCodePoint = Array.from(previous).at(-1)?.codePointAt(0);
    if (
      output.length > 0
      && (
        isCombining(codePoint)
        || codePoint === 0x200d
        || previousCodePoint === 0x200d
        || (isRegionalIndicator(codePoint) && regionalCount % 2 === 1)
      )
    ) {
      output[output.length - 1] += character;
    } else {
      output.push(character);
    }
    regionalCount = isRegionalIndicator(codePoint) ? regionalCount + 1 : 0;
  }
  return output;
}

function itemKey({ threadId, turnId, itemId }) {
  return `${threadId}\u0000${turnId}\u0000${itemId}`;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function deadlineRateForState(state, nowMs, frameMs, maxLagMs) {
  let prefixCount = 0;
  let requiredRate = 0;
  for (const segment of state.segments) {
    prefixCount += segment.graphemes.length - segment.offset;
    const secondsRemaining = Math.max(
      frameMs,
      segment.receivedAtMs + maxLagMs - nowMs,
    ) / 1_000;
    requiredRate = Math.max(requiredRate, prefixCount / secondsRemaining);
  }
  return requiredRate;
}

// Critically damped scalar response, adapted from the stable rational form of
// a second-order spring. `rateVelocity` is the derivative of displayRate.
function smoothDamp(current, target, rateVelocity, smoothTimeSeconds, deltaSeconds) {
  const smoothTime = Math.max(0.001, smoothTimeSeconds);
  const omega = 2 / smoothTime;
  const x = omega * deltaSeconds;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temporary = (rateVelocity + omega * change) * deltaSeconds;
  return {
    value: target + (change + temporary) * decay,
    velocity: (rateVelocity - omega * temporary) * decay,
  };
}

export class TextDeltaPacerController {
  constructor({ emit, now = () => Date.now(), requestTick = () => {}, options = {} }) {
    this.emit = emit;
    this.now = now;
    this.requestTick = requestTick;
    this.options = { ...TEXT_DELTA_PACER_DEFAULTS, ...options };
    this.items = new Map();
    this.recentItems = [];
    // Provider transports often deliver many token deltas as one coarse burst.
    // Keep arrival cadence independently from the visible backlog so an empty
    // reservoir does not forget the rate just before the next burst arrives.
    this.cadences = new Map();
    this.metrics = {
      receivedGraphemes: 0,
      emittedGraphemes: 0,
      maximumObservedLagMs: 0,
      emergencyFrames: 0,
      earlyTicksSuppressed: 0,
      cadenceSamples: 0,
      emittedFrames: 0,
    };
  }

  pruneCadences(nowMs) {
    for (const [key, cadence] of this.cadences) {
      if (cadence.expiresAtMs <= nowMs) this.cadences.delete(key);
    }
  }

  observeCadence(key, count, receivedAtMs) {
    this.pruneCadences(receivedAtMs);
    let cadence = this.cadences.get(key);
    if (!cadence) {
      cadence = {
        estimatedRate: 0,
        lastBurstAtMs: receivedAtMs,
        lastBurstCount: count,
        expiresAtMs: receivedAtMs + this.options.cadenceMemoryMs,
      };
      this.cadences.set(key, cadence);
      return cadence;
    }

    const intervalMs = receivedAtMs - cadence.lastBurstAtMs;
    if (intervalMs < this.options.minCadenceIntervalMs) {
      cadence.lastBurstCount += count;
      cadence.expiresAtMs = receivedAtMs + this.options.cadenceMemoryMs;
      return cadence;
    }

    // Blend the previous and current burst sizes. This reacts to a provider
    // changing chunk size without allowing one tiny heartbeat to collapse the
    // presentation rate for the next full chunk.
    const representativeCount = (cadence.lastBurstCount + count) / 2;
    const observedRate = clamp(
      representativeCount * 1_000 / intervalMs,
      1,
      this.options.maxEstimatedRate,
    );
    cadence.estimatedRate = cadence.estimatedRate > 0
      ? cadence.estimatedRate + this.options.cadenceAlpha * (observedRate - cadence.estimatedRate)
      : observedRate;
    cadence.lastBurstAtMs = receivedAtMs;
    cadence.lastBurstCount = count;
    cadence.expiresAtMs = receivedAtMs + this.options.cadenceMemoryMs;
    this.metrics.cadenceSamples += 1;
    return cadence;
  }

  enqueue(metadata, delta, receivedAtMs = this.now()) {
    const graphemes = splitGraphemes(delta);
    if (!graphemes.length) return;
    const key = itemKey(metadata);
    const cadence = this.observeCadence(key, graphemes.length, receivedAtMs);
    let state = this.items.get(key);
    if (!state) {
      state = {
        key,
        metadata: { ...metadata },
        segments: [],
        backlog: 0,
        displayRate: cadence.estimatedRate,
        rateVelocity: 0,
        credit: 0,
        lastTickMs: receivedAtMs - this.options.frameMs,
        barriers: [],
        emittedAtMs: [],
        maximumLagMs: 0,
      };
      this.items.set(key, state);
    }
    state.segments.push({ graphemes, offset: 0, receivedAtMs });
    state.backlog += graphemes.length;
    this.metrics.receivedGraphemes += graphemes.length;
    this.requestTick(0);
  }

  afterDrained(metadata, action) {
    const state = this.items.get(itemKey(metadata));
    if (!state || state.backlog === 0) {
      this.cadences.delete(itemKey(metadata));
      action();
      return false;
    }
    const completionDeadlineAtMs = this.now() + this.options.completionDrainMs;
    state.completionDeadlineAtMs = state.completionDeadlineAtMs == null
      ? completionDeadlineAtMs
      : Math.min(state.completionDeadlineAtMs, completionDeadlineAtMs);
    state.barriers.push(action);
    this.requestTick(0);
    return true;
  }

  flush(metadata) {
    const state = this.items.get(itemKey(metadata));
    if (!state) return false;
    this.emitFromState(state, state.backlog, this.now());
    this.finishState(state);
    this.cadences.delete(state.key);
    return true;
  }

  discard(metadata) {
    const state = this.items.get(itemKey(metadata));
    const key = itemKey(metadata);
    const deletedCadence = this.cadences.delete(key);
    if (!state) return deletedCadence;
    this.items.delete(key);
    return true;
  }

  tick(nowMs = this.now()) {
    this.pruneCadences(nowMs);
    for (const state of [...this.items.values()]) this.tickState(state, nowMs);
    if (this.items.size > 0) this.requestTick(this.options.frameMs);
  }

  tickState(state, nowMs) {
    if (state.backlog <= 0) {
      this.finishState(state);
      return;
    }
    const frameMs = this.options.frameMs;
    const rawElapsedMs = nowMs - state.lastTickMs;
    if (rawElapsedMs < frameMs) {
      const nextFrameAtMs = state.lastTickMs + frameMs;
      const oldestDeadlineAtMs = state.segments[0].receivedAtMs + this.options.maxLagMs;
      const completionDeadlineAtMs = state.completionDeadlineAtMs ?? Number.POSITIVE_INFINITY;
      if (Math.min(oldestDeadlineAtMs, completionDeadlineAtMs) >= nextFrameAtMs) {
        // Backend polling is event driven and may run many times inside one
        // display frame. Those polls may fill the reservoir, but they must not
        // each become a visible one-character frame. Keep a real 16 ms frame
        // gate; only an imminent hard/completion deadline may cross it.
        this.metrics.earlyTicksSuppressed += 1;
        return;
      }
    }
    const elapsedMs = clamp(rawElapsedMs, 1, this.options.maxLagMs);
    const deltaSeconds = elapsedMs / 1_000;
    state.lastTickMs = nowMs;

    const cadenceRate = this.cadences.get(state.key)?.estimatedRate ?? 0;
    // With no cadence evidence, distribute the burst over the hard lag window
    // instead of draining it in a short micro-burst. Once two bursts have been
    // observed, follow their measured character rate.
    const unknownCadenceRate = state.backlog * 1_000 / this.options.maxLagMs;
    const completionRate = state.completionDeadlineAtMs != null
      ? state.backlog * 1_000 / Math.max(frameMs, state.completionDeadlineAtMs - nowMs)
      : 0;
    const softTargetRate = Math.max(cadenceRate || unknownCadenceRate, completionRate);
    const damped = smoothDamp(
      state.displayRate,
      softTargetRate,
      state.rateVelocity,
      this.options.smoothTimeMs / 1_000,
      deltaSeconds,
    );
    state.displayRate = Math.max(0, damped.value);
    state.rateVelocity = damped.velocity;

    // A newly arrived segment must never inherit an older segment's imminent
    // deadline. Compute the minimum rate for every ordered prefix instead of
    // dividing the entire mixed-age backlog by the oldest remaining time.
    const deadlineRate = deadlineRateForState(
      state,
      nowMs,
      frameMs,
      this.options.maxLagMs,
    );
    const effectiveRate = Math.max(state.displayRate, deadlineRate);
    if (deadlineRate > state.displayRate) this.metrics.emergencyFrames += 1;

    state.credit += effectiveRate * deltaSeconds;
    let emitCount = Math.min(state.backlog, Math.floor(state.credit));
    if (emitCount === 0) emitCount = 1;

    // Protect the hard deadline even if the host was descheduled for several
    // frames. Anything that would expire before the next frame is emitted now.
    let dueCount = 0;
    for (const segment of state.segments) {
      if (segment.receivedAtMs + this.options.maxLagMs > nowMs + frameMs) break;
      dueCount += segment.graphemes.length - segment.offset;
    }
    emitCount = Math.max(emitCount, dueCount);
    state.credit = Math.max(0, state.credit - emitCount);
    this.emitFromState(state, emitCount, nowMs);
    if (state.backlog === 0) this.finishState(state);
  }

  emitFromState(state, requestedCount, emittedAtMs) {
    let remaining = Math.min(requestedCount, state.backlog);
    let output = [];
    let recordedFrame = false;
    const flushOutput = () => {
      if (!output.length) return;
      if (!recordedFrame) {
        state.emittedAtMs.push(emittedAtMs);
        recordedFrame = true;
      }
      this.emit(state.metadata, output.join(""));
      this.metrics.emittedGraphemes += output.length;
      this.metrics.emittedFrames += 1;
      output = [];
    };
    while (remaining > 0 && state.segments.length > 0) {
      const segment = state.segments[0];
      const available = segment.graphemes.length - segment.offset;
      const room = this.options.maxNotificationGraphemes - output.length;
      const count = Math.min(available, remaining, room);
      const slice = segment.graphemes.slice(segment.offset, segment.offset + count);
      output.push(...slice);
      segment.offset += count;
      state.backlog -= count;
      remaining -= count;
      const lagMs = Math.max(0, emittedAtMs - segment.receivedAtMs);
      state.maximumLagMs = Math.max(state.maximumLagMs, lagMs);
      this.metrics.maximumObservedLagMs = Math.max(this.metrics.maximumObservedLagMs, lagMs);
      if (output.length === this.options.maxNotificationGraphemes) flushOutput();
      if (segment.offset === segment.graphemes.length) state.segments.shift();
    }
    flushOutput();
  }

  finishState(state) {
    if (state.backlog > 0) return;
    this.items.delete(state.key);
    if (!state.traceRecorded && state.emittedAtMs.length > 0) {
      state.traceRecorded = true;
      const gapsMs = state.emittedAtMs.slice(1).map((atMs, index) => (
        atMs - state.emittedAtMs[index]
      ));
      this.recentItems.push({
        ...state.metadata,
        frameCount: state.emittedAtMs.length,
        minimumGapMs: gapsMs.length ? Math.min(...gapsMs) : null,
        maximumGapMs: gapsMs.length ? Math.max(...gapsMs) : null,
        averageGapMs: gapsMs.length
          ? gapsMs.reduce((sum, gapMs) => sum + gapMs, 0) / gapsMs.length
          : null,
        maximumLagMs: state.maximumLagMs,
      });
      if (this.recentItems.length > 32) this.recentItems.splice(0, this.recentItems.length - 32);
    }
    const barriers = state.barriers.splice(0);
    if (barriers.length > 0) this.cadences.delete(state.key);
    for (const action of barriers) action();
  }

  diagnostics() {
    return {
      ...this.metrics,
      activeItems: this.items.size,
      rememberedCadences: this.cadences.size,
      recentItems: this.recentItems.map((item) => ({ ...item })),
    };
  }
}
