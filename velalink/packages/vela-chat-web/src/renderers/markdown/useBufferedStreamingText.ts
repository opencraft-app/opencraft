import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import {
  createIncomingLiveTextBufferState,
  hasPendingLiveText,
  setLiveTextBufferTarget,
  stepLiveTextBuffer,
  type LiveTextBufferOptions,
  type LiveTextBufferPhase,
  type LiveTextBufferState,
} from "./liveTextBuffer";

export interface BufferedStreamingTextOptions
  extends Partial<LiveTextBufferOptions> {
  frameIntervalMs?: number;
  streamKey?: string;
  streaming: boolean;
}

export interface BufferedStreamingText {
  phase: LiveTextBufferPhase;
  pending: boolean;
  text: string;
}

const DEFAULT_FRAME_INTERVAL_MS = 33;

export function useBufferedStreamingText(
  targetText: string,
  options: BufferedStreamingTextOptions,
): BufferedStreamingText {
  const reducedMotion = usePrefersReducedMotion();
  const stateRef = useRef<LiveTextBufferState>(
    createIncomingLiveTextBufferState(
      targetText,
      typeof window === "undefined" || !options.streaming ? "settled" : "streaming",
    ),
  );
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const tickRef = useRef<FrameRequestCallback | null>(null);
  const bufferOptionsRef = useRef<Partial<LiveTextBufferOptions>>({});
  const frameIntervalRef = useRef(DEFAULT_FRAME_INTERVAL_MS);
  const streamKeyRef = useRef<string | null>(options.streamKey ?? null);
  const [snapshot, setSnapshot] = useState<BufferedStreamingText>(() =>
    stateToSnapshot(stateRef.current),
  );

  const bufferOptions = useMemo<Partial<LiveTextBufferOptions>>(
    () => ({
      inputIntervalSmoothing: options.inputIntervalSmoothing,
      inputRateMultiplier: options.inputRateMultiplier,
      inputRateSmoothing: options.inputRateSmoothing,
      maxAccelerationUnitsPerSecond2: options.maxAccelerationUnitsPerSecond2,
      maxReserveUnits: options.maxReserveUnits,
      maxUnitsPerSecond: options.maxUnitsPerSecond,
      maxUnitsPerFrame: options.maxUnitsPerFrame,
      minUnitsPerSecond: options.minUnitsPerSecond,
      minReserveUnits: options.minReserveUnits,
      pressureGain: options.pressureGain,
      settlingLatencyMs: options.settlingLatencyMs,
      stallGraceMs: options.stallGraceMs,
      stallLeakUnitsPerSecond: options.stallLeakUnitsPerSecond,
      targetBacklogRatio: options.targetBacklogRatio,
      targetLatencyMs: options.targetLatencyMs,
      velocitySmoothing: options.velocitySmoothing,
    }),
    [
      options.inputIntervalSmoothing,
      options.inputRateMultiplier,
      options.inputRateSmoothing,
      options.maxAccelerationUnitsPerSecond2,
      options.maxReserveUnits,
      options.maxUnitsPerSecond,
      options.maxUnitsPerFrame,
      options.minUnitsPerSecond,
      options.minReserveUnits,
      options.pressureGain,
      options.settlingLatencyMs,
      options.stallGraceMs,
      options.stallLeakUnitsPerSecond,
      options.targetBacklogRatio,
      options.targetLatencyMs,
      options.velocitySmoothing,
    ],
  );
  const frameIntervalMs = positiveOrDefault(
    options.frameIntervalMs,
    DEFAULT_FRAME_INTERVAL_MS,
  );
  const streamKey = options.streamKey ?? null;
  bufferOptionsRef.current = bufferOptions;
  frameIntervalRef.current = frameIntervalMs;

  tickRef.current = (now: number) => {
    const lastFrameAt = lastFrameAtRef.current;
    const elapsedMs = lastFrameAt === null ? 0 : now - lastFrameAt;
    if (lastFrameAt === null) {
      lastFrameAtRef.current = now;
    }

    if (elapsedMs >= frameIntervalRef.current) {
      stateRef.current = stepLiveTextBuffer(
        stateRef.current,
        elapsedMs,
        bufferOptionsRef.current,
      );
      lastFrameAtRef.current = now;
      setSnapshotIfChanged(setSnapshot, stateToSnapshot(stateRef.current));
    }

    if (hasPendingLiveText(stateRef.current)) {
      frameRef.current = window.requestAnimationFrame((frameNow) => {
        tickRef.current?.(frameNow);
      });
    } else {
      frameRef.current = null;
      lastFrameAtRef.current = null;
      if (stateRef.current.phase !== "settled") {
        stateRef.current = stepLiveTextBuffer(
          stateRef.current,
          frameIntervalRef.current,
          bufferOptionsRef.current,
        );
        setSnapshotIfChanged(setSnapshot, stateToSnapshot(stateRef.current));
      }
    }
  };

  useEffect(() => {
    if (typeof window === "undefined" || reducedMotion) {
      cancelLoop();
      streamKeyRef.current = streamKey;
      stateRef.current = setLiveTextBufferTarget(
        stateRef.current,
        targetText,
        "settled",
        bufferOptionsRef.current,
      );
      setSnapshotIfChanged(setSnapshot, stateToSnapshot(stateRef.current));
      return;
    }

    const phase = options.streaming ? "streaming" : "settling";
    if (streamKeyRef.current !== streamKey) {
      cancelLoop();
      streamKeyRef.current = streamKey;
      stateRef.current = createIncomingLiveTextBufferState(targetText, phase);
    } else {
      stateRef.current = setLiveTextBufferTarget(
        stateRef.current,
        targetText,
        phase,
        bufferOptions,
      );
    }
    setSnapshotIfChanged(setSnapshot, stateToSnapshot(stateRef.current));

    if (hasPendingLiveText(stateRef.current)) {
      startLoop();
    }

    function startLoop() {
      if (typeof window === "undefined") return;
      if (frameRef.current !== null) return;
      lastFrameAtRef.current = null;
      frameRef.current = window.requestAnimationFrame((frameNow) => {
        tickRef.current?.(frameNow);
      });
    }
  }, [
    options.streaming,
    reducedMotion,
    streamKey,
    targetText,
  ]);

  useEffect(() => () => cancelLoop(), []);

  return snapshot;

  function cancelLoop() {
    if (frameRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    lastFrameAtRef.current = null;
  }
}

function stateToSnapshot(state: LiveTextBufferState): BufferedStreamingText {
  return {
    phase: state.phase,
    pending: hasPendingLiveText(state),
    text: state.visibleText,
  };
}

function setSnapshotIfChanged(
  setSnapshot: Dispatch<SetStateAction<BufferedStreamingText>>,
  next: BufferedStreamingText,
) {
  setSnapshot((current) =>
    current.text === next.text &&
    current.pending === next.pending &&
    current.phase === next.phase
      ? current
      : next,
  );
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);

    const handleChange = () => setReducedMotion(query.matches);
    query.addEventListener?.("change", handleChange);
    return () => query.removeEventListener?.("change", handleChange);
  }, []);

  return reducedMotion;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
