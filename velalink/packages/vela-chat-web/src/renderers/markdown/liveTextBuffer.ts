import { resolveStreamReleasePolicy } from "./streamReleasePolicy";

export type LiveTextBufferPhase = "streaming" | "settling" | "settled";

export interface LiveTextBufferState {
  targetText: string;
  visibleText: string;
  phase: LiveTextBufferPhase;
  targetUnitCount: number;
  visibleUnitCount: number;
  velocityUnitsPerSecond: number;
  carryUnits: number;
  settlingElapsedMs: number;
  settlingStartUnitCount: number;
  millisecondsSinceTargetUpdate: number;
  inputUnitsPerSecond: number;
  inputIntervalMs: number;
  unitBoundaries: readonly number[];
}

export interface LiveTextBufferOptions {
  targetLatencyMs: number;
  settlingLatencyMs: number;
  minUnitsPerSecond: number;
  maxUnitsPerSecond: number;
  maxUnitsPerFrame: number;
  velocitySmoothing: number;
  inputRateSmoothing: number;
  inputIntervalSmoothing: number;
  inputRateMultiplier: number;
  targetBacklogRatio: number;
  minReserveUnits: number;
  maxReserveUnits: number;
  pressureGain: number;
  stallGraceMs: number;
  stallLeakUnitsPerSecond: number;
  maxAccelerationUnitsPerSecond2: number;
}

const DEFAULT_OPTIONS: LiveTextBufferOptions = {
  targetLatencyMs: 120,
  settlingLatencyMs: 180,
  minUnitsPerSecond: 28,
  maxUnitsPerSecond: 420,
  maxUnitsPerFrame: 4,
  velocitySmoothing: 0.35,
  inputRateSmoothing: 0.45,
  inputIntervalSmoothing: 0.35,
  inputRateMultiplier: 0.85,
  targetBacklogRatio: 0.12,
  minReserveUnits: 3,
  maxReserveUnits: 12,
  pressureGain: 1.2,
  stallGraceMs: 900,
  stallLeakUnitsPerSecond: 0.9,
  maxAccelerationUnitsPerSecond2: 120,
};

type SegmenterConstructor = new (
  locale: string | readonly string[] | undefined,
  options: { granularity: "grapheme" },
) => {
  segment(input: string): Iterable<{ segment: string; index: number }>;
};

export function createLiveTextBufferState(initialText = ""): LiveTextBufferState {
  const unitBoundaries = segmentGraphemeBoundaries(initialText);
  const unitCount = unitBoundaries.length;
  return {
    targetText: initialText,
    visibleText: initialText,
    phase: "settled",
    targetUnitCount: unitCount,
    visibleUnitCount: unitCount,
    velocityUnitsPerSecond: 0,
    carryUnits: 0,
    settlingElapsedMs: 0,
    settlingStartUnitCount: unitCount,
    millisecondsSinceTargetUpdate: 0,
    inputUnitsPerSecond: 0,
    inputIntervalMs: 0,
    unitBoundaries,
  };
}

export function createIncomingLiveTextBufferState(
  targetText: string,
  phase: LiveTextBufferPhase,
): LiveTextBufferState {
  if (phase === "settled") return createLiveTextBufferState(targetText);
  return setLiveTextBufferTarget(createLiveTextBufferState(""), targetText, phase);
}

export function setLiveTextBufferTarget(
  state: LiveTextBufferState,
  targetText: string,
  phase: LiveTextBufferPhase,
  options: Partial<LiveTextBufferOptions> = {},
): LiveTextBufferState {
  const normalized = normalizeOptions(options);
  const unitBoundaries =
    targetText === state.targetText
      ? state.unitBoundaries
      : segmentGraphemeBoundaries(targetText);
  const targetUnitCount = unitBoundaries.length;

  if (phase === "settled") {
    return {
      ...state,
      targetText,
      visibleText: targetText,
      phase: "settled",
      targetUnitCount,
      visibleUnitCount: targetUnitCount,
      velocityUnitsPerSecond: 0,
      carryUnits: 0,
      settlingElapsedMs: 0,
      settlingStartUnitCount: targetUnitCount,
      millisecondsSinceTargetUpdate: 0,
      inputUnitsPerSecond: 0,
      inputIntervalMs: 0,
      unitBoundaries,
    };
  }

  if (!targetText.startsWith(state.visibleText)) {
    if (phase !== "settling") return state;
    const pending = state.visibleUnitCount < state.targetUnitCount;
    return {
      ...state,
      phase: pending ? "settling" : "settled",
      velocityUnitsPerSecond: 0,
      carryUnits: 0,
      settlingElapsedMs: 0,
      settlingStartUnitCount: state.visibleUnitCount,
    };
  }

  const visibleUnitCount = countUnitsAtOffset(unitBoundaries, state.visibleText.length);
  const targetDeltaUnits = Math.max(0, targetUnitCount - state.targetUnitCount);
  const instantInputUnitsPerSecond =
    targetDeltaUnits > 0 && state.millisecondsSinceTargetUpdate > 0
      ? targetDeltaUnits / (state.millisecondsSinceTargetUpdate / 1000)
      : 0;
  const inputUnitsPerSecond =
    instantInputUnitsPerSecond > 0
      ? state.inputUnitsPerSecond <= 0
        ? instantInputUnitsPerSecond
        : state.inputUnitsPerSecond +
          (instantInputUnitsPerSecond - state.inputUnitsPerSecond) *
            normalized.inputRateSmoothing
      : state.inputUnitsPerSecond;
  const inputIntervalMs =
    targetDeltaUnits > 0 && state.millisecondsSinceTargetUpdate > 0
      ? state.inputIntervalMs <= 0
        ? state.millisecondsSinceTargetUpdate
        : state.inputIntervalMs +
          (state.millisecondsSinceTargetUpdate - state.inputIntervalMs) *
            normalized.inputIntervalSmoothing
      : state.inputIntervalMs;
  const nextPhase =
    visibleUnitCount >= targetUnitCount && phase === "settling" ? "settled" : phase;
  const enteringSettling =
    phase === "settling" &&
    (state.phase !== "settling" || targetText !== state.targetText);

  return {
    ...state,
    targetText,
    phase: nextPhase,
    targetUnitCount,
    visibleUnitCount,
    velocityUnitsPerSecond: nextPhase === "streaming" ? state.velocityUnitsPerSecond : 0,
    carryUnits: nextPhase === "streaming" ? state.carryUnits : 0,
    settlingElapsedMs: enteringSettling ? 0 : state.settlingElapsedMs,
    settlingStartUnitCount: enteringSettling
      ? visibleUnitCount
      : state.settlingStartUnitCount,
    millisecondsSinceTargetUpdate: targetDeltaUnits > 0 ? 0 : state.millisecondsSinceTargetUpdate,
    inputUnitsPerSecond: nextPhase === "streaming" ? inputUnitsPerSecond : 0,
    inputIntervalMs: nextPhase === "streaming" ? inputIntervalMs : 0,
    unitBoundaries,
  };
}

export function stepLiveTextBuffer(
  state: LiveTextBufferState,
  elapsedMs: number,
  options: Partial<LiveTextBufferOptions> = {},
): LiveTextBufferState {
  const normalized = normalizeOptions(options);
  const safeElapsedMs = Math.max(0, elapsedMs);
  if (safeElapsedMs === 0 || !hasPendingLiveText(state)) {
    if (state.phase === "settling" && !hasPendingLiveText(state)) {
      return {
        ...state,
        phase: "settled",
        velocityUnitsPerSecond: 0,
        carryUnits: 0,
        settlingElapsedMs: 0,
        settlingStartUnitCount: state.targetUnitCount,
      };
    }
    if (safeElapsedMs > 0 && state.phase === "streaming") {
      return {
        ...state,
        millisecondsSinceTargetUpdate: state.millisecondsSinceTargetUpdate + safeElapsedMs,
      };
    }
    return state;
  }

  if (state.phase === "settling") {
    return stepSettlingBuffer(state, safeElapsedMs, normalized);
  }

  return stepStreamingBuffer(state, safeElapsedMs, normalized);
}

export function hasPendingLiveText(state: LiveTextBufferState): boolean {
  return state.visibleUnitCount < state.targetUnitCount;
}

function stepStreamingBuffer(
  state: LiveTextBufferState,
  elapsedMs: number,
  options: LiveTextBufferOptions,
): LiveTextBufferState {
  const backlog = state.targetUnitCount - state.visibleUnitCount;
  const decision = resolveStreamReleasePolicy({
    backlogUnits: backlog,
    targetUnits: state.targetUnitCount,
    elapsedMs,
    currentVelocityUnitsPerSecond: state.velocityUnitsPerSecond,
    carryUnits: state.carryUnits,
    inputUnitsPerSecond: state.inputUnitsPerSecond,
    inputIntervalMs: state.inputIntervalMs,
    targetAgeMs: state.millisecondsSinceTargetUpdate,
    options,
  });

  return advanceVisibleUnits(state, decision.unitsToReveal, {
    phase: "streaming",
    velocityUnitsPerSecond: decision.velocityUnitsPerSecond,
    carryUnits: decision.carryUnits,
    millisecondsSinceTargetUpdate: state.millisecondsSinceTargetUpdate + elapsedMs,
  });
}

function stepSettlingBuffer(
  state: LiveTextBufferState,
  elapsedMs: number,
  options: LiveTextBufferOptions,
): LiveTextBufferState {
  const settlingElapsedMs = Math.min(
    options.settlingLatencyMs,
    state.settlingElapsedMs + elapsedMs,
  );
  const progress = settlingElapsedMs >= options.settlingLatencyMs
    ? 1
    : settlingElapsedMs / options.settlingLatencyMs;
  const settlingDistance = state.targetUnitCount - state.settlingStartUnitCount;
  const nextVisibleUnitCount = Math.max(
    state.visibleUnitCount,
    state.settlingStartUnitCount + Math.floor(settlingDistance * progress),
  );
  const unitsToReveal = nextVisibleUnitCount - state.visibleUnitCount;
  const next = advanceVisibleUnits(state, unitsToReveal, {
    phase: progress >= 1 ? "settled" : "settling",
    velocityUnitsPerSecond: 0,
    carryUnits: 0,
    settlingElapsedMs: progress >= 1 ? 0 : settlingElapsedMs,
    millisecondsSinceTargetUpdate: state.millisecondsSinceTargetUpdate + elapsedMs,
  });

  return next.phase === "settled"
    ? { ...next, settlingStartUnitCount: next.targetUnitCount }
    : next;
}

function advanceVisibleUnits(
  state: LiveTextBufferState,
  unitsToReveal: number,
  overrides: Partial<LiveTextBufferState>,
): LiveTextBufferState {
  const visibleUnitCount = Math.min(
    state.targetUnitCount,
    state.visibleUnitCount + Math.max(0, unitsToReveal),
  );
  const visibleText = sliceByUnitCount(
    state.targetText,
    state.unitBoundaries,
    visibleUnitCount,
  );
  const phase =
    visibleUnitCount >= state.targetUnitCount && overrides.phase === "settling"
      ? "settled"
      : overrides.phase ?? state.phase;

  return {
    ...state,
    ...overrides,
    visibleText,
    visibleUnitCount,
    phase,
  };
}

function normalizeOptions(
  options: Partial<LiveTextBufferOptions>,
): LiveTextBufferOptions {
  return {
    targetLatencyMs: positiveOrDefault(
      options.targetLatencyMs,
      DEFAULT_OPTIONS.targetLatencyMs,
    ),
    settlingLatencyMs: positiveOrDefault(
      options.settlingLatencyMs,
      DEFAULT_OPTIONS.settlingLatencyMs,
    ),
    minUnitsPerSecond: positiveOrDefault(
      options.minUnitsPerSecond,
      DEFAULT_OPTIONS.minUnitsPerSecond,
    ),
    maxUnitsPerSecond: positiveOrDefault(
      options.maxUnitsPerSecond,
      DEFAULT_OPTIONS.maxUnitsPerSecond,
    ),
    maxUnitsPerFrame: positiveOrDefault(
      options.maxUnitsPerFrame,
      DEFAULT_OPTIONS.maxUnitsPerFrame,
    ),
    velocitySmoothing: clamp(
      options.velocitySmoothing ?? DEFAULT_OPTIONS.velocitySmoothing,
      0,
      1,
    ),
    inputRateSmoothing: clamp(
      options.inputRateSmoothing ?? DEFAULT_OPTIONS.inputRateSmoothing,
      0,
      1,
    ),
    inputIntervalSmoothing: clamp(
      options.inputIntervalSmoothing ?? DEFAULT_OPTIONS.inputIntervalSmoothing,
      0,
      1,
    ),
    inputRateMultiplier: positiveOrDefault(
      options.inputRateMultiplier,
      DEFAULT_OPTIONS.inputRateMultiplier,
    ),
    targetBacklogRatio: positiveOrDefault(
      options.targetBacklogRatio,
      DEFAULT_OPTIONS.targetBacklogRatio,
    ),
    minReserveUnits: Math.max(
      0,
      options.minReserveUnits ?? DEFAULT_OPTIONS.minReserveUnits,
    ),
    maxReserveUnits: positiveOrDefault(
      options.maxReserveUnits,
      DEFAULT_OPTIONS.maxReserveUnits,
    ),
    pressureGain: positiveOrDefault(
      options.pressureGain,
      DEFAULT_OPTIONS.pressureGain,
    ),
    stallGraceMs: positiveOrDefault(
      options.stallGraceMs,
      DEFAULT_OPTIONS.stallGraceMs,
    ),
    stallLeakUnitsPerSecond: positiveOrDefault(
      options.stallLeakUnitsPerSecond,
      DEFAULT_OPTIONS.stallLeakUnitsPerSecond,
    ),
    maxAccelerationUnitsPerSecond2: positiveOrDefault(
      options.maxAccelerationUnitsPerSecond2,
      DEFAULT_OPTIONS.maxAccelerationUnitsPerSecond2,
    ),
  };
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function sliceByUnitCount(
  text: string,
  boundaries: readonly number[],
  unitCount: number,
): string {
  if (unitCount <= 0) return "";
  const endIndex = boundaries[unitCount - 1] ?? text.length;
  return text.slice(0, endIndex);
}

function countUnitsAtOffset(boundaries: readonly number[], offset: number): number {
  let count = 0;
  while (count < boundaries.length && boundaries[count]! <= offset) {
    count += 1;
  }
  return count;
}

function segmentGraphemeBoundaries(text: string): number[] {
  if (text.length === 0) return [];
  const Segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
  if (typeof Segmenter === "function") {
    const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (segment) => (
      segment.index + segment.segment.length
    ));
  }

  const boundaries: number[] = [];
  let cursor = 0;
  for (const unit of Array.from(text)) {
    cursor += unit.length;
    boundaries.push(cursor);
  }
  return boundaries;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
