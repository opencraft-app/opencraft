/** A timer only expires the request; it is never evidence of a browser paint. */
export function waitForBrowserPaint(
  presented: () => boolean,
  options: {
    signal?: AbortSignal;
    expiresAt: number;
    current(): boolean;
  },
): Promise<boolean> {
  if (typeof document === "undefined" || typeof requestAnimationFrame !== "function") return Promise.resolve(false);
  return new Promise((resolve) => {
    let frame: number | undefined,
      consecutive = 0,
      finished = false;
    const finish = (visible: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      options.signal?.removeEventListener("abort", cancelled);
      document.removeEventListener("visibilitychange", visibility);
      resolve(visible);
    };
    const cancelled = () => finish(false);
    const visibility = () => {
      if (document.visibilityState !== "visible") finish(false);
    };
    const timer = setTimeout(cancelled, Math.max(0, options.expiresAt - Date.now()));
    const tick = () => {
      frame = undefined;
      if (finished) return;
      try {
        if (
          options.signal?.aborted ||
          document.visibilityState !== "visible" ||
          Date.now() >= options.expiresAt ||
          !options.current()
        ) {
          finish(false);
          return;
        }
        consecutive = presented() ? consecutive + 1 : 0;
        if (finished) return;
        if (consecutive >= 2) {
          finish(true);
          return;
        }
        frame = requestAnimationFrame(tick);
      } catch {
        finish(false);
      }
    };
    options.signal?.addEventListener("abort", cancelled, { once: true });
    document.addEventListener("visibilitychange", visibility);
    try {
      if (
        options.signal?.aborted ||
        document.visibilityState !== "visible" ||
        Date.now() >= options.expiresAt ||
        !options.current()
      )
        finish(false);
      else frame = requestAnimationFrame(tick);
    } catch {
      finish(false);
    }
  });
}
