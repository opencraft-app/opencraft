import { useLayoutEffect, type RefObject } from "react";

/** CSS owns timing. Wait for its actual finite animations, including cancellation;
 * a superseded render/unmount revokes the completion callback. */
export function usePresentationCompletion(
  root: RefObject<HTMLElement | null>,
  active: boolean,
  revision: unknown,
  complete: () => void,
  subtree = false,
) {
  useLayoutEffect(() => {
    if (!active) return;
    let live = true;
    const frame = requestAnimationFrame(() => {
      const animations =
        root.current
          ?.getAnimations({ subtree })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity) ?? [];
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (live) complete();
      });
    });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, [root, active, revision, subtree, complete]);
}
