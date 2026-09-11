import {
  animate,
  useMotionValue,
  useReducedMotion,
  type MotionValue,
} from "motion/react";
import { useCallback, useLayoutEffect, useRef } from "react";

import {
  resolveSidecarPrimarySettleTarget,
  type SidecarPrimaryResizeCommit,
  type SidecarPrimaryResizePreview,
} from "./sidecar-primary-resize";
import { PANEL_SPRING_TRANSITION } from "./use-panel-animation";

interface Playback {
  readonly finished: Promise<unknown>;
  stop(): void;
}

interface SidecarPrimaryMotion {
  readonly footerWidth: MotionValue<number>;
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
 * boundaries, and the Footer follows only committed expanded width. The
 * viewport expands with a rightward pointer so painted rows never trail the
 * frame, but remains stable while contracting so content is clipped instead
 * of reflowing. Content opacity is deliberately absent from this model.
 */
export function useSidecarPrimaryMotion(input: {
  readonly committedExpandedWidth: number;
  readonly committedFrameWidth: number;
  readonly compactWidth: number;
  readonly expandedMinimumWidth: number;
  readonly footerMinimumWidth: number;
  readonly getMaximumWidth: () => number;
}): SidecarPrimaryMotion {
  const shouldReduceMotion = useReducedMotion();
  const frameWidth = useMotionValue(input.committedFrameWidth);
  const viewportWidth = useMotionValue(input.committedExpandedWidth);
  const footerWidth = useMotionValue(Math.max(input.footerMinimumWidth, input.committedExpandedWidth));
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
    viewportWidth.set(Math.max(input.committedExpandedWidth, preview.frameWidth));
  }, [frameWidth, input.committedExpandedWidth, viewportWidth]);

  const settle = useCallback((
    targetFrameWidth: number,
    targetExpandedWidth: number | null,
    complete: () => void,
  ) => {
    stopPlaybacks();
    phaseRef.current = "settling";
    const generation = generationRef.current;

    if (shouldReduceMotion === true) {
      frameWidth.set(targetFrameWidth);
      if (targetExpandedWidth !== null) {
        viewportWidth.set(targetExpandedWidth);
        footerWidth.set(Math.max(input.footerMinimumWidth, targetExpandedWidth));
      }
      phaseRef.current = "idle";
      complete();
      return;
    }

    const playbacks: Playback[] = [];
    if (Math.abs(frameWidth.get() - targetFrameWidth) > 0.01) {
      playbacks.push(animate(frameWidth, targetFrameWidth, PANEL_SPRING_TRANSITION));
    } else frameWidth.set(targetFrameWidth);
    if (targetExpandedWidth !== null) {
      if (Math.abs(viewportWidth.get() - targetExpandedWidth) > 0.01) {
        playbacks.push(animate(viewportWidth, targetExpandedWidth, PANEL_SPRING_TRANSITION));
      } else viewportWidth.set(targetExpandedWidth);
      const targetFooterWidth = Math.max(input.footerMinimumWidth, targetExpandedWidth);
      if (Math.abs(footerWidth.get() - targetFooterWidth) > 0.01) {
        playbacks.push(animate(footerWidth, targetFooterWidth, PANEL_SPRING_TRANSITION));
      } else footerWidth.set(targetFooterWidth);
    }
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
  }, [footerWidth, frameWidth, input.footerMinimumWidth, shouldReduceMotion, stopPlaybacks, viewportWidth]);

  const cancelResize = useCallback(() => {
    settle(input.committedFrameWidth, input.committedExpandedWidth, () => {});
  }, [input.committedExpandedWidth, input.committedFrameWidth, settle]);

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
      result.detent === "expanded" ? targetFrameWidth : null,
      commitAfterSettle ? () => commit(settledResult) : () => {},
    );
  }, [input.compactWidth, input.expandedMinimumWidth, input.getMaximumWidth, settle, stopPlaybacks]);

  useLayoutEffect(() => {
    if (phaseRef.current !== "idle") return;
    frameWidth.set(input.committedFrameWidth);
    viewportWidth.set(input.committedExpandedWidth);
    footerWidth.set(Math.max(input.footerMinimumWidth, input.committedExpandedWidth));
  }, [footerWidth, frameWidth, input.committedExpandedWidth, input.committedFrameWidth, input.footerMinimumWidth, viewportWidth]);

  useLayoutEffect(() => () => stopPlaybacks(), [stopPlaybacks]);

  return {
    footerWidth,
    frameWidth,
    viewportWidth,
    beginResize,
    cancelResize,
    previewResize,
    settleResize,
  };
}
