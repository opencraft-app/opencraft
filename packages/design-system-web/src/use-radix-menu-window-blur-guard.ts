import { useLayoutEffect, useRef } from "react";

/** Internal workaround for Radix Menu's unconditional window-blur dismissal.
 * Keep this dependency-specific behavior here until Radix exposes a cancellable
 * dismissal event. Callers keep declaring policy through the shared menu Root.
 */
export function useRadixMenuWindowBlurGuard(open: boolean, dismissOnWindowBlur: boolean): () => boolean {
  const windowBlur = useRef<Event | null>(null);
  useLayoutEffect(() => {
    if (!open || dismissOnWindowBlur) return;
    const captureBlur = (event: Event) => {
      if (event.target === window) windowBlur.current = event;
    };
    // Install before Radix's passive blur listener, including at the Window target.
    window.addEventListener("blur", captureBlur, true);
    return () => {
      window.removeEventListener("blur", captureBlur, true);
      windowBlur.current = null;
    };
  }, [open, dismissOnWindowBlur]);

  // Radix closes synchronously inside that dispatch. currentTarget resets
  // afterwards, so later clicks/Escape still close even in the same task.
  return () => !dismissOnWindowBlur && windowBlur.current?.currentTarget === window;
}
