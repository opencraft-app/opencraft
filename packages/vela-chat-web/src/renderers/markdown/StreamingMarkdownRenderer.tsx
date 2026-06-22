import { memo, useMemo, useRef } from "react";

import styles from "../../styles/desktop.module.css";
import {
  createStreamingTokenCache,
  parseStreamingMarkdownTokens,
  type StreamingTokenCache,
} from "./prefixTokenCache";
import { renderMarkdownTokens } from "./renderTokens";
import { useSegmentFadeTimeline } from "./segmentFade";
import { repairStreamingMarkdown } from "./streamingRepair";

export interface StreamingMarkdownRendererProps {
  children: string;
  fadeSegmentDelayMs?: number;
  fadeSegmentMaxDelayMs?: number;
}

export const StreamingMarkdownRenderer = memo(function StreamingMarkdownRenderer({
  children,
  fadeSegmentDelayMs = 12,
  fadeSegmentMaxDelayMs = 240,
}: StreamingMarkdownRendererProps) {
  const cacheRef = useRef<StreamingTokenCache | null>(null);
  if (!cacheRef.current) cacheRef.current = createStreamingTokenCache();
  const timeline = useSegmentFadeTimeline();
  const tokens = useMemo(() => {
    const repaired = repairStreamingMarkdown(children);
    return parseStreamingMarkdownTokens(repaired.markdown, cacheRef.current!);
  }, [children]);

  return (
    <div className={styles.messageResponse} data-streaming-markdown="true">
      {renderMarkdownTokens(tokens, {
        fadeText: true,
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
    prev.fadeSegmentMaxDelayMs === next.fadeSegmentMaxDelayMs
  );
}

