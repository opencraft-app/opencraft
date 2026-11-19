import { createContext, useContext, useLayoutEffect, type RefObject } from "react";
import { cancelFrame, frame, type MotionValue } from "motion/react";

/** Page-owned DOM overlays share a stable Shell host, including over native guests.
 * Features own their content; Shell owns its physical frame and input boundary. */
/** Whole-page displacement, independent of the ordinary conversation sidebar. */
export const ShellPageDisplacementContext=createContext<{x:MotionValue<number>;blocked:boolean}|null>(null);
export const ShellPageOverlayContext = createContext<HTMLElement | null>(null);
export const useShellPageOverlay = () => useContext(ShellPageOverlayContext);

/** Measure only the layout offset within the page. Its MotionValue moves both
 * planes directly; features never need to observe or chase a translation. */
export function useShellPageOverlayFrame({ root, anchor, overlay, pageX, layoutTick }: {
  root: RefObject<HTMLElement | null>;
  anchor: HTMLElement | null;
  overlay: HTMLElement | null;
  pageX: MotionValue<number>;
  layoutTick: MotionValue<number>;
}) {
  useLayoutEffect(() => {
    const shell = root.current;
    if (!shell || !anchor || !overlay) return;
    const measure = () => {
      const frameRect = shell.getBoundingClientRect();
      const rect = anchor.getBoundingClientRect();
      Object.assign(overlay.style, {
        left: `${rect.left - frameRect.left - pageX.get()}px`,
        top: `${rect.top - frameRect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
      });
    };
    const schedule = () => frame.postRender(measure);
    const observer = new ResizeObserver(schedule);
    observer.observe(shell); observer.observe(anchor);
    const unsubscribe = layoutTick.on("change", schedule);
    measure();
    return () => { observer.disconnect(); unsubscribe(); cancelFrame(measure); };
  }, [root, anchor, overlay, pageX, layoutTick]);
}
