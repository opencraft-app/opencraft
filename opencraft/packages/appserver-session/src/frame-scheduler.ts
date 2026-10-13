import type { ThreadViewFrameScheduler } from "./view-store";

/** A suspended frame clock must not hold completion or authority indefinitely. */
export function createThreadViewFrameScheduler(
  requestFrame: (flush: () => void) => (() => void) | undefined,
): ThreadViewFrameScheduler {
  return {
    schedule(flush) {
      let finished = false;
      let cancelFrame: (() => void) | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        cancelFrame?.();
        flush();
      };
      const timer = setTimeout(finish, 32);
      cancelFrame = requestFrame(finish);
      return () => {
        finished = true;
        clearTimeout(timer);
        cancelFrame?.();
      };
    },
  };
}
