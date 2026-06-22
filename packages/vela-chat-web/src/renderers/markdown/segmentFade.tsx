import { type CSSProperties, type ReactNode, useRef } from "react";

import styles from "../../styles/desktop.module.css";

export interface SegmentFadeOptions {
  fadeText?: boolean;
  fadeSegmentDelayMs?: number;
  fadeSegmentMaxDelayMs?: number;
}

export interface SegmentFadeTimeline {
  delayMsByKey: Map<string, number>;
  nextSegmentStartAtMs: number;
}

export function useSegmentFadeTimeline(): SegmentFadeTimeline {
  const timelineRef = useRef<SegmentFadeTimeline | null>(null);
  if (!timelineRef.current) {
    timelineRef.current = { delayMsByKey: new Map(), nextSegmentStartAtMs: 0 };
  }
  return timelineRef.current;
}

export function renderFadingText(
  text: string,
  keyPrefix: string,
  options: SegmentFadeOptions & { timeline?: SegmentFadeTimeline | null },
): ReactNode {
  if (!options.fadeText) return text;

  const segments = segmentText(text);
  return segments.map((segment, index) => {
    if (segment.length === 0) return null;
    if (/^\s+$/.test(segment)) return segment;

    const segmentKey = `${keyPrefix}:fade:${index}:${hashString(segment)}`;
    const delayMs = readSegmentDelayMs(segmentKey, options);
    return (
      <span
        className={styles.markdownFadeSegment}
        key={segmentKey}
        style={{ "--vela-markdown-fade-delay": `${delayMs}ms` } as CSSProperties}
      >
        {segment}
      </span>
    );
  });
}

function segmentText(text: string) {
  const Segmenter = Intl.Segmenter;
  if (typeof Segmenter === "function") {
    const segmenter = new Segmenter(undefined, { granularity: "word" });
    return Array.from(segmenter.segment(text), (segment) => segment.segment);
  }
  return text.split(/(\s+)/);
}

function readSegmentDelayMs(
  segmentKey: string,
  options: SegmentFadeOptions & { timeline?: SegmentFadeTimeline | null },
) {
  const timeline = options.timeline;
  const delay = timeline?.delayMsByKey.get(segmentKey);
  if (delay !== undefined) return delay;

  const now = performance.now();
  const delayMs = Math.max(
    0,
    Math.round(Math.max(timeline?.nextSegmentStartAtMs ?? now, now) - now),
  );
  if (timeline) {
    timeline.delayMsByKey.set(segmentKey, delayMs);
    timeline.nextSegmentStartAtMs =
      Math.max(timeline.nextSegmentStartAtMs, now) +
      nextSegmentStepMs(delayMs, options);
  }
  return delayMs;
}

function nextSegmentStepMs(delayMs: number, options: SegmentFadeOptions) {
  const base = options.fadeSegmentDelayMs ?? 12;
  const max = options.fadeSegmentMaxDelayMs;
  if (max === undefined || delayMs < max) return base;
  return Math.max(1, Math.round(base * 0.25));
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

