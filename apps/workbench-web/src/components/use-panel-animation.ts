import {
  animate,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useLayoutEffect, useReducer, useRef } from "react";

/** Shell-owned full-width progress. Route changes are placement, not gestures. */
export function usePanelFullWidthAnimation(fullWidth: boolean, scope: string, open: boolean): MotionValue<number> {
  const progress = useMotionValue(fullWidth ? 1 : 0);
  const previous = useRef({ scope, open });
  const reducedMotion = useReducedMotion();
  useLayoutEffect(() => {
    const snap = previous.current.scope !== scope || !previous.current.open || !open || reducedMotion;
    previous.current = { scope, open };
    if (snap) { progress.jump(fullWidth ? 1 : 0); return; }
    const playback = animate(progress, fullWidth ? 1 : 0, PANEL_SPRING_TRANSITION);
    return () => playback.stop();
  }, [fullWidth, scope, open, reducedMotion, progress]);
  return progress;
}

// Source-identical motion contract from the latest recovered Codex lineage:
// settings/app-shell-layout-motion-context-04359.ts.
export const PANEL_SPRING_TRANSITION = {
  type: "spring",
  duration: 0.5,
  bounce: 0.1,
} as const;

interface PanelAnimation {
  animatedSize: MotionValue<number>;
  isMounted: boolean;
  progress: MotionValue<number>;
}

interface PanelAnimationInput {
  readonly animation: MotionValue<number>;
  readonly isVisible: boolean;
  readonly size: number | MotionValue<number>;
}

/**
 * The writer for a panel visibility transaction lives above the panel.
 *
 * Codex's setRightPanelVisibility first updates semantic visibility, then
 * stops and retargets one route-scoped MotionValue. Panel, header and layout
 * consumers only read that value. Keeping this writer in AppShell preserves
 * the same ownership rule when panel content remounts or changes route.
 */
export function usePanelVisibilityAnimation(
  isVisible: boolean,
  animation: MotionValue<number>,
): void {
  const shouldReduceMotion = useReducedMotion();

  useLayoutEffect(() => {
    const target = isVisible ? 1 : 0;
    animation.stop();

    if (shouldReduceMotion === true) {
      animation.set(target);
      return;
    }

    if (Math.abs(animation.get() - target) <= 0.0001) {
      animation.set(target);
      return;
    }

    const playback = animate(animation, target, PANEL_SPRING_TRANSITION);
    return () => playback.stop();
  }, [animation, isVisible, shouldReduceMotion]);
}

/**
 * Codex keeps panel progress in a MotionValue and binds it directly to layout
 * styles. This avoids a React render for every animation frame and preserves
 * the current velocity when an in-flight animation reverses direction.
 */
export function usePanelAnimation({
  animation,
  isVisible,
  size,
}: PanelAnimationInput): PanelAnimation {
  const fallbackSizeValue = useMotionValue(typeof size === "number" ? size : size.get());
  const sizeValue = typeof size === "number" ? fallbackSizeValue : size;
  const [, forceRender] = useReducer((revision: number) => revision + 1, 0);
  const animatedSize = useTransform(
    [animation, sizeValue],
    (values) => {
      const rawProgress = values[0] as number;
      const currentSize = values[1] as number;
      return Math.max(0, Math.min(1, rawProgress)) * currentSize;
    },
  );

  useLayoutEffect(() => {
    if (typeof size === "number") fallbackSizeValue.set(size);
  }, [fallbackSizeValue, size]);

  // Codex does not mirror animation progress through React state. It renders
  // once more only at the terminal zero so the outgoing panel can unmount.
  // The change listener also covers the reduced-motion `set(0)` path, whose
  // MotionValue intentionally has no animationComplete event.
  useLayoutEffect(() => {
    let terminalZeroObserved = animation.get() <= 0;
    const complete = () => {
      if (animation.get() <= 0) forceRender();
    };
    const changed = (value: number) => {
      if (value > 0) {
        terminalZeroObserved = false;
        return;
      }
      if (!terminalZeroObserved) {
        terminalZeroObserved = true;
        forceRender();
      }
    };
    const unsubscribeComplete = animation.on("animationComplete", complete);
    const unsubscribeChange = animation.on("change", changed);
    return () => {
      unsubscribeChange();
      unsubscribeComplete();
    };
  }, [animation]);

  return {
    animatedSize,
    isMounted: isVisible || animation.get() > 0,
    progress: animation,
  };
}
