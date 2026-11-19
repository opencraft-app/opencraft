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
export function useWorkspacePaneAnimation(progress: MotionValue<number>, visibility: MotionValue<number>, fullWidth: boolean, scope: string, open: boolean, sceneLease: symbol | null = null): void {
  const previous = useRef({ scope, open, fullWidth });
  const previousLease = useRef(sceneLease);
  const reducedMotion = useReducedMotion();
  const [, settle] = useReducer((revision:number)=>revision+1,0);
  useLayoutEffect(() => {
    const intent = paneTransitionIntent(previous.current, {scope,open,fullWidth},reducedMotion===true || sceneLease !== null || previousLease.current !== null);
    previousLease.current = sceneLease;
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
      ...PANEL_RESIZE_TRANSITION,onComplete:()=>{if(current)settle();},
    });
    return ()=>{current=false;visibilityPlayback.stop();fullPlayback.stop();};
  }, [fullWidth, scope, open, sceneLease, reducedMotion, progress, visibility]);
}

// Visual feedback only: navigation readiness can interrupt departure immediately.
// Mobile consumes drawer travel; this duration is the docked-layout fallback.
// Ready-to-visible target: 100ms, including the final paint. Reserve 20ms for
// that paint (one ordinary 60Hz frame); this is a ceiling, never a dwell time.
// Cached handoffs retain their alpha and consume only the remaining distance.
export const CONVERSATION_FADE_TRANSITION = { duration: 0.08, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };
export const CONVERSATION_DEPARTURE_TRANSITION = { ...CONVERSATION_FADE_TRANSITION, duration: 0.5 };

// Size changes settle without overshoot; visibility keeps its own transition.
const PANEL_RESIZE_TRANSITION = { type: "spring", duration: 0.32, bounce: 0 } as const;

// Shared spring for pane visibility.
export const PANEL_SPRING_TRANSITION = {
  type: "spring",
  duration: 0.5,
  bounce: 0.1,
} as const;

// Duration/bounce springs discard inherited velocity. Reversible navigation uses
// physical parameters so the same MotionValue can retain momentum on interruption.
export const PANEL_CONTINUOUS_SPRING_TRANSITION = {
  type: 'spring', stiffness: 550, damping: 42, mass: 1,
  restDelta: .0001, restSpeed: .001,
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
