import { useMotionValue } from "motion/react";
import { useCallback, useRef } from "react";
import { previewContextGeometry, settledContextGeometry, type ContextPaneGeometry } from "./context-pane-geometry";

/** One live layout signal, shared by frame and content. Visibility clipping is a separate owner. */
export function useContextPaneGeometry(committedWidth: number) {
  const state = useRef(settledContextGeometry(committedWidth));
  const frameWidth = useMotionValue(committedWidth);
  const write = useCallback((next: ContextPaneGeometry) => {
    state.current = next;
    frameWidth.set(next.frameWidth);
  }, [frameWidth]);
  const preview = useCallback((width: number) => write(previewContextGeometry(state.current, width)), [write]);
  const settle = useCallback((width: number) => write(settledContextGeometry(width)), [write]);
  const synchronize = useCallback((width: number, resizing: boolean) => {
    // Release commits the supplied preference; cancellation restores it.
    // Prop/route updates cannot overwrite an active pointer transaction.
    if (!resizing) settle(width);
  }, [settle]);
  return { frameWidth, viewportWidth: frameWidth, preview, settle, synchronize };
}
