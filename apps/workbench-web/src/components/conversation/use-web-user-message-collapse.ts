import {
  deriveUserMessageCollapseState,
  toggleUserMessageExpandedContentIdentity,
  type UserMessageCollapseState,
  type UserMessageNaturalMeasurement,
} from "@opencraft/chat-core";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

const CODE_BLOCK_SELECTOR = "[data-markdown-copy='code-block']";

export interface WebUserMessageCollapseObserver {
  readonly clipRef: React.RefObject<HTMLDivElement | null>;
  readonly contentRef: React.RefObject<HTMLDivElement | null>;
  readonly collapseState: UserMessageCollapseState;
  readonly collapsedMaxHeight: number | null;
  readonly toggleExpansion: () => void;
}

export function useWebUserMessageCollapse({
  collapsedLineCount,
  contentIdentity,
}: {
  readonly collapsedLineCount: number;
  readonly contentIdentity: string;
}): WebUserMessageCollapseObserver {
  const clipRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [measurement, setMeasurement] = useState<UserMessageNaturalMeasurement | null>(null);
  const [collapsedMaxHeight, setCollapsedMaxHeight] = useState<number | null>(null);
  const [expandedContentIdentity, setExpandedContentIdentity] = useState<string | null>(null);

  useLayoutEffect(() => {
    const clip = clipRef.current;
    const content = contentRef.current;
    if (clip === null || content === null) return;
    const measure = () => {
      const computed = window.getComputedStyle(clip);
      const lineHeight = Number.parseFloat(computed.lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;

      const clipRect = clip.getBoundingClientRect();
      const scale = clip.offsetHeight === 0 ? 1 : clipRect.height / clip.offsetHeight;
      const policyHeight = Math.ceil(lineHeight * collapsedLineCount);
      let visualHeight = Math.ceil(lineHeight * (collapsedLineCount - 1));
      for (const codeBlock of clip.querySelectorAll<HTMLElement>(CODE_BLOCK_SELECTOR)) {
        const rect = codeBlock.getBoundingClientRect();
        const top = (rect.top - clipRect.top) / scale;
        const bottom = (rect.bottom - clipRect.top) / scale;
        if (top < visualHeight && bottom > visualHeight) visualHeight = Math.ceil(bottom);
      }

      setCollapsedMaxHeight((current) => current === visualHeight ? current : visualHeight);
      setMeasurement((current) => {
        const next: UserMessageNaturalMeasurement = {
          contentIdentity,
          collapsedHeight: policyHeight,
          contentHeight: Math.ceil(content.scrollHeight),
        };
        return current?.contentIdentity === next.contentIdentity
          && current.collapsedHeight === next.collapsedHeight
          && current.contentHeight === next.contentHeight
          ? current
          : next;
      });
    };

    measure();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(content);
    const mutation = new MutationObserver(measure);
    mutation.observe(content, { childList: true, subtree: true });
    return () => {
      resize?.disconnect();
      mutation.disconnect();
    };
  }, [collapsedLineCount, contentIdentity]);

  const collapseState = deriveUserMessageCollapseState({
    contentIdentity,
    expandedContentIdentity,
    measurement,
  });
  const toggleExpansion = useCallback(() => {
    setExpandedContentIdentity((current) => toggleUserMessageExpandedContentIdentity(contentIdentity, current));
  }, [contentIdentity]);

  return { clipRef, contentRef, collapseState, collapsedMaxHeight, toggleExpansion };
}
