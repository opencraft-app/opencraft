import {
  animate,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useCallback, useLayoutEffect, useRef } from "react";

import {
  resolveSidecarPrimarySettleTarget,
  primaryViewportWidth,
  type SidecarPrimaryResizeCommit,
  type SidecarPrimaryResizePreview,
} from "./sidecar-primary-resize";
import { PANEL_SPRING_TRANSITION } from "./use-panel-animation";

interface Playback {
  readonly finished: Promise<unknown>;
  stop(): void;
}

interface SidecarPrimaryMotion {
  readonly frameWidth: MotionValue<number>;
  readonly viewportWidth: MotionValue<number>;
  beginResize(): void;
  cancelResize(): void;
  previewResize(preview: SidecarPrimaryResizePreview): void;
  settleResize(
    result: SidecarPrimaryResizeCommit,
    commit: (settled: SidecarPrimaryResizeCommit) => void,
  ): void;
}

type InteractionPhase = "idle" | "dragging" | "settling";

/**
 * Sole motion owner for the Primary Sidecar.
 *
 * Pointer frames remain continuous, semantic detents change at transaction
 * boundaries. Footer sizing belongs to the complete Sidecar, not this pane. The
 * viewport follows the frame in both directions in the normal resize range.
 * Only a transition into compact/hidden retains a minimum layout viewport;
 * visibility clipping and content opacity are not drag-width policies.
 */
export function useSidecarPrimaryMotion(input: {
  readonly isVisible: boolean;
  readonly committedExpandedWidth: number;
  readonly committedFrameWidth: number;
  readonly compactWidth: number;
  readonly expandedMinimumWidth: number;
  readonly getMaximumWidth: () => number;
}): SidecarPrimaryMotion {
  const shouldReduceMotion = useReducedMotion();
  const frameWidth = useMotionValue(input.committedFrameWidth);
  const viewportWidth = useTransform(frameWidth, width => primaryViewportWidth(width, input.expandedMinimumWidth));
  const phaseRef = useRef<InteractionPhase>("idle");
  const generationRef = useRef(0);
  const playbacksRef = useRef<Playback[]>([]);

  const stopPlaybacks = useCallback(() => {
    generationRef.current += 1;
    for (const playback of playbacksRef.current) playback.stop();
    playbacksRef.current = [];
  }, []);

  const beginResize = useCallback(() => {
    stopPlaybacks();
    phaseRef.current = "dragging";
  }, [stopPlaybacks]);

  const previewResize = useCallback((preview: SidecarPrimaryResizePreview) => {
    if (phaseRef.current !== "dragging") return;
    frameWidth.set(preview.frameWidth);
  }, [frameWidth]);

  const settle = useCallback((
    targetFrameWidth: number,
    complete: () => void,
  ) => {
    stopPlaybacks();
    phaseRef.current = "settling";
    const generation = generationRef.current;

    if (shouldReduceMotion === true) {
      frameWidth.set(targetFrameWidth);
      phaseRef.current = "idle";
      complete();
      return;
    }

    const playbacks: Playback[] = [];
    if (Math.abs(frameWidth.get() - targetFrameWidth) > 0.01) {
      playbacks.push(animate(frameWidth, targetFrameWidth, PANEL_SPRING_TRANSITION));
    } else frameWidth.set(targetFrameWidth);
    playbacksRef.current = playbacks;
    if (playbacks.length === 0) {
      phaseRef.current = "idle";
      complete();
      return;
    }
    void Promise.all(playbacks.map(playback => playback.finished)).then(() => {
      if (generationRef.current !== generation) return;
      playbacksRef.current = [];
      phaseRef.current = "idle";
      complete();
    }).catch(() => {
      // A new pointer transaction intentionally stops the previous settle.
    });
  }, [frameWidth, shouldReduceMotion, stopPlaybacks]);

  const cancelResize = useCallback(() => {
    settle(input.committedFrameWidth, () => {});
  }, [input.committedFrameWidth, settle]);

  const settleResize = useCallback((
    result: SidecarPrimaryResizeCommit,
    commit: (settled: SidecarPrimaryResizeCommit) => void,
  ) => {
    const targetFrameWidth = resolveSidecarPrimarySettleTarget({
      compactWidth: input.compactWidth,
      detent: result.detent,
      expandedMinimumWidth: input.expandedMinimumWidth,
      expandedWidth: result.expandedWidth,
      maximumWidth: input.getMaximumWidth(),
    });
    const settledResult: SidecarPrimaryResizeCommit = {
      ...result,
      expandedWidth: result.detent === "expanded" ? targetFrameWidth : null,
    };
    const commitAfterSettle = result.detent === "hidden";
    if (!commitAfterSettle) {
      // Mark the transaction before React receives the semantic update so an
      // ensuing layout effect cannot snap the physical frame to its detent.
      stopPlaybacks();
      phaseRef.current = "settling";
      commit(settledResult);
    }
    settle(
      targetFrameWidth,
      commitAfterSettle ? () => commit(settledResult) : () => {},
    );
  }, [input.compactWidth, input.expandedMinimumWidth, input.getMaximumWidth, settle, stopPlaybacks]);

  useLayoutEffect(() => {
    // Visibility has its own progress owner. A hidden projection reports zero
    // width, but copying that into the base frame would erase the entire exit
    // animation (progress * 0). Retain the last geometry while exiting/hidden;
    // reopening synchronizes the destination before visibility animates in.
    // A drag-to-hidden already settled its physical frame to zero and stays there.
    if (!input.isVisible || phaseRef.current !== "idle") return;
    frameWidth.set(input.committedFrameWidth);
  }, [frameWidth, input.isVisible, input.committedFrameWidth]);

  useLayoutEffect(() => () => stopPlaybacks(), [stopPlaybacks]);

  return {
    frameWidth,
    viewportWidth,
    beginResize,
    cancelResize,
    previewResize,
    settleResize,
  };
}
