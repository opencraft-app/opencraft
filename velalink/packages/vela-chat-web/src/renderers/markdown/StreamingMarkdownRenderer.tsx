import { memo, useEffect, useMemo, useRef } from "react";

import styles from "../../styles/desktop.module.css";
import {
  createStreamingTokenCache,
  parseStreamingMarkdownTokens,
  type StreamingTokenCache,
} from "./prefixTokenCache";
import { renderMarkdownTokens } from "./renderTokens";
import { useSegmentFadeTimeline } from "./segmentFade";
import { repairStreamingMarkdown } from "./streamingRepair";
import { useBufferedStreamingText } from "./useBufferedStreamingText";

export interface StreamingMarkdownRendererProps {
  children: string;
  fadeSegmentDelayMs?: number;
  fadeSegmentMaxDelayMs?: number;
  onSettled?: () => void;
  streamKey?: string;
  streaming?: boolean;
}

export const StreamingMarkdownRenderer = memo(function StreamingMarkdownRenderer({
  children,
  fadeSegmentDelayMs = 12,
  fadeSegmentMaxDelayMs = 240,
  onSettled,
  streamKey,
  streaming = true,
}: StreamingMarkdownRendererProps) {
  const cacheRef = useRef<StreamingTokenCache | null>(null);
  if (!cacheRef.current) cacheRef.current = createStreamingTokenCache();
  const timeline = useSegmentFadeTimeline();
  const buffered = useBufferedStreamingText(children, {
    frameIntervalMs: 16,
    streamKey,
    streaming,
    settlingLatencyMs: 190,
    targetLatencyMs: 130,
  });
  const isLive = streaming || buffered.pending || buffered.phase !== "settled";
  useEffect(() => {
    if (!streaming && !buffered.pending && buffered.phase === "settled") {
      onSettled?.();
    }
  }, [buffered.pending, buffered.phase, onSettled, streaming]);
  const tokens = useMemo(() => {
    const markdown = isLive
      ? repairStreamingMarkdown(buffered.text).markdown
      : buffered.text;
    return parseStreamingMarkdownTokens(markdown, cacheRef.current!);
  }, [buffered.text, isLive]);

  return (
    <div
      className={styles.messageResponse}
      data-live-text-pending={buffered.pending ? "true" : undefined}
      data-live-text-phase={buffered.phase}
      data-streaming-markdown="true"
    >
      {renderMarkdownTokens(tokens, {
        fadeText: isLive,
        fadeSegmentDelayMs,
        fadeSegmentMaxDelayMs,
        timeline,
      })}
    </div>
  );
}, areEqual);

function areEqual(prev: StreamingMarkdownRendererProps, next: StreamingMarkdownRendererProps) {
  return (
    prev.children === next.children &&
    prev.fadeSegmentDelayMs === next.fadeSegmentDelayMs &&
    prev.fadeSegmentMaxDelayMs === next.fadeSegmentMaxDelayMs &&
    prev.onSettled === next.onSettled &&
    prev.streamKey === next.streamKey &&
    prev.streaming === next.streaming
  );
}
