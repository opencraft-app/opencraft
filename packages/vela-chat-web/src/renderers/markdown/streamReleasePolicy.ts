export interface StreamReleasePolicyOptions {
  minUnitsPerSecond: number;
  maxUnitsPerSecond: number;
  maxUnitsPerFrame: number;
  targetLatencyMs: number;
  velocitySmoothing: number;
  inputRateMultiplier: number;
  targetBacklogRatio: number;
  minReserveUnits: number;
  maxReserveUnits: number;
  pressureGain: number;
  stallGraceMs: number;
  stallLeakUnitsPerSecond: number;
  maxAccelerationUnitsPerSecond2: number;
}

export interface StreamReleasePolicyInput {
  backlogUnits: number;
  targetUnits: number;
  elapsedMs: number;
  currentVelocityUnitsPerSecond: number;
  carryUnits: number;
  inputUnitsPerSecond: number;
  inputIntervalMs: number;
  targetAgeMs: number;
  options: StreamReleasePolicyOptions;
}

export interface StreamReleasePolicyDecision {
  unitsToReveal: number;
  velocityUnitsPerSecond: number;
  carryUnits: number;
}

export function resolveStreamReleasePolicy({
  backlogUnits,
  targetUnits,
  elapsedMs,
  currentVelocityUnitsPerSecond,
  carryUnits,
  inputUnitsPerSecond,
  inputIntervalMs,
  targetAgeMs,
  options,
}: StreamReleasePolicyInput): StreamReleasePolicyDecision {
  if (backlogUnits <= 0 || elapsedMs <= 0) {
    return {
      unitsToReveal: 0,
      velocityUnitsPerSecond: currentVelocityUnitsPerSecond,
      carryUnits,
    };
  }

  const rawTargetBacklogUnits =
    inputUnitsPerSecond > 0 && inputIntervalMs > 0
      ? clamp(
          inputUnitsPerSecond *
            (inputIntervalMs / 1000) *
            options.targetBacklogRatio,
          options.minReserveUnits,
          options.maxReserveUnits,
        )
      : targetAgeMs >= 0
        ? options.minReserveUnits
      : 0;
  const stallGraceMs = inputIntervalMs > 0
    ? Math.max(options.stallGraceMs, inputIntervalMs * 1.25)
    : options.stallGraceMs;
  const stalledLeakUnits = Math.max(0, targetAgeMs - stallGraceMs) /
    1000 *
    options.stallLeakUnitsPerSecond;
  const targetBacklogUnits =
    targetUnits <= options.minReserveUnits
      ? Math.min(rawTargetBacklogUnits, Math.max(0, backlogUnits - 1))
      : Math.max(0, rawTargetBacklogUnits - stalledLeakUnits);
  const pressureUnits = backlogUnits - targetBacklogUnits;
  const leakingReserve =
    stalledLeakUnits > 0 &&
    targetBacklogUnits < rawTargetBacklogUnits &&
    backlogUnits <= rawTargetBacklogUnits + options.maxUnitsPerFrame;
  const desiredUnitsPerSecond =
    leakingReserve
      ? options.stallLeakUnitsPerSecond
    : inputUnitsPerSecond > 0
      ? inputUnitsPerSecond * options.inputRateMultiplier +
        pressureUnits * options.pressureGain
      : pressureUnits / Math.max(0.001, options.targetLatencyMs / 1000);
  const minimumUnitsPerSecond =
    leakingReserve || pressureUnits <= 0
      ? 0
      : options.minUnitsPerSecond;
  const clampedDesired = clamp(
    desiredUnitsPerSecond,
    minimumUnitsPerSecond,
    options.maxUnitsPerSecond,
  );
  const smoothedVelocity =
    currentVelocityUnitsPerSecond <= 0
      ? clampedDesired
      : currentVelocityUnitsPerSecond +
        (clampedDesired - currentVelocityUnitsPerSecond) *
          options.velocitySmoothing;
  const maxVelocityDelta =
    options.maxAccelerationUnitsPerSecond2 * (elapsedMs / 1000);
  const velocity =
    currentVelocityUnitsPerSecond <= 0
      ? Math.min(smoothedVelocity, maxVelocityDelta)
      : clamp(
          smoothedVelocity,
          currentVelocityUnitsPerSecond - maxVelocityDelta,
          currentVelocityUnitsPerSecond + maxVelocityDelta,
        );
  const rawUnitsToReveal = velocity * (elapsedMs / 1000) + carryUnits;
  const unitsToReveal = Math.floor(rawUnitsToReveal);
  const nextCarryUnits = rawUnitsToReveal - unitsToReveal;

  const cappedUnitsToReveal = Math.min(
    unitsToReveal,
    options.maxUnitsPerFrame,
    Math.max(0, Math.floor(pressureUnits)),
  );
  const cappedByReserve = cappedUnitsToReveal === 0 && pressureUnits <= 0;

  return {
    unitsToReveal: cappedUnitsToReveal,
    velocityUnitsPerSecond: cappedByReserve ? 0 : velocity,
    carryUnits: cappedByReserve ? 0 : nextCarryUnits,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
