import {
  animate,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useLayoutEffect, useReducer, useRef } from "react";
import { paneTransitionIntent } from "./workspace-pane-geometry";

/** Single Shell transaction owner; visibility and full-width remain distinct
 * MotionValues. Open-pane mode changes restore visibility before width motion.
 */
export function useWorkspacePaneAnimation(progress: MotionValue<number>, visibility: MotionValue<number>, fullWidth: boolean, scope: string, open: boolean): void {
  const previous = useRef({ scope, open, fullWidth });
  const reducedMotion = useReducedMotion();
  const [, settle] = useReducer((revision:number)=>revision+1,0);
  useLayoutEffect(() => {
    const intent = paneTransitionIntent(previous.current, {scope,open,fullWidth},reducedMotion===true);
    previous.current = { scope, open, fullWidth };
    progress.stop(); visibility.stop();
    if (intent.snap) {
      progress.jump(intent.fullWidthTarget); visibility.jump(intent.visibilityTarget);
      settle(); return;
    }
    if(intent.forceVisibility)visibility.set(1);
    let current=true;
    const visibilityPlayback=animate(visibility,intent.visibilityTarget,PANEL_SPRING_TRANSITION);
    const fullPlayback=animate(progress,intent.fullWidthTarget,{
      ...PANEL_SPRING_TRANSITION,onComplete:()=>{if(current)settle();},
    });
    return ()=>{current=false;visibilityPlayback.stop();fullPlayback.stop();};
  }, [fullWidth, scope, open, reducedMotion, progress, visibility]);
}

// Shared spring for pane visibility, size and full-width transitions.
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
