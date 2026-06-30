"use client";

import type { ReactNode, RefObject } from "react";
import type { BottomAnchorUserIntent } from "../scroll/bottomAnchorDriver";
import { applyConversationScrollWrite } from "../scroll/scrollWrite";
import {
  useVerticalScrollbarOverlay,
  type VerticalScrollbarCommitInput,
  type VerticalScrollbarUserIntent,
} from "./useVerticalScrollbarOverlay";

interface ScrollbarCommitInput {
  scrollTop: number;
  userIntent: BottomAnchorUserIntent;
}

function scrollElementInstantlyTo(element: HTMLElement, scrollTop: number): void {
  applyConversationScrollWrite({
    element,
    phase: { routeResumeStatus: "idle" },
    write: {
      reason: "scrollbar_overlay",
      scrollTop,
      source: "scrollbar_overlay",
    },
  });
}

function toBottomAnchorIntent(intent: VerticalScrollbarUserIntent): BottomAnchorUserIntent {
  return intent;
}

export function useConversationScrollbarOverlay(
  elementRef: RefObject<HTMLElement | null>,
  options?: {
    contentRef?: RefObject<HTMLElement | null>;
    enabled?: boolean;
    onScrollCommit?: (input: ScrollbarCommitInput) => void;
    onUserScrollIntent?: (intent: BottomAnchorUserIntent) => void;
  },
): ReactNode {
  const onScrollCommit = options?.onScrollCommit;
  const onUserScrollIntent = options?.onUserScrollIntent;

  return useVerticalScrollbarOverlay(elementRef, {
    contentRef: options?.contentRef,
    enabled: options?.enabled,
    onScrollCommit: (input: VerticalScrollbarCommitInput) => {
      onScrollCommit?.({
        scrollTop: input.scrollTop,
        userIntent: toBottomAnchorIntent(input.userIntent),
      });
    },
    onUserScrollIntent: (intent) => onUserScrollIntent?.(toBottomAnchorIntent(intent)),
    scrollElementTo: scrollElementInstantlyTo,
  });
}
