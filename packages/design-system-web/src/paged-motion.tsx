import { animate, motion, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { forwardRef, useLayoutEffect, useReducer, useRef, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { pagedMotion } from "@opencraft/design-system/tokens";
import { useMotionReduction } from "./use-motion-reduction";

/** Three adjacent pages share one reversible progress and the measured container.
 * The consumer owns selection/resources; completion is the only commit boundary. */
export function usePagedMotion(container: RefObject<HTMLElement | null>, viewKey: string) {
  const reduced = useMotionReduction();
  const currentPlane = useRef<HTMLDivElement>(null);
  const progress = useMotionValue(0);
  const width = useMotionValue(0);
  const current = useTransform([progress, width], ([p, w]) => Number(p) * Number(w));
  const previous = useTransform([progress, width], ([p, w]) => (Number(p) - 1) * Number(w));
  const next = useTransform([progress, width], ([p, w]) => (Number(p) + 1) * Number(w));
  const epoch = useRef(0);
  const pending = useRef<{ target: number; commit?: () => void } | null>(null);
  const [, rebase] = useReducer((value: number) => value + 1, 0);
  const cancel = () => {
    ++epoch.current;
    pending.current = null;
    progress.stop();
    progress.jump(0);
  };
  const syncWidth = () => {
    const element = container.current;
    if (!element || element.clientWidth === width.get()) return false;
    cancel();
    width.set(element.clientWidth);
    rebase();
    return true;
  };

  useLayoutEffect(() => {
    cancel();
    // Re-project derived MotionValues before the new page can paint, including
    // external source changes and the first measured container allocation.
    rebase();
  }, [viewKey]);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => {
      syncWidth();
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancel();
    };
  }, [container, progress, width]);
  useLayoutEffect(() => {
    if (!reduced || !pending.current) return;
    const operation = pending.current;
    ++epoch.current;
    pending.current = null;
    progress.stop();
    progress.jump(operation.commit ? 0 : operation.target);
    operation.commit?.();
  }, [reduced, progress]);

  const settle = (target: -1 | 0 | 1, commit?: () => void) => {
    // A resize can precede ResizeObserver delivery during a native contact.
    // Release must not settle an offset from the previous allocation.
    if (syncWidth() && !commit) return;
    const token = ++epoch.current;
    progress.stop();
    pending.current = { target, commit };
    const finish = () => {
      if (epoch.current !== token) return;
      pending.current = null;
      if (commit) {
        // The neighbor is already at the destination. Rebase and commit in one
        // React transaction so its replacement never paints at the old offset.
        progress.jump(0);
        flushSync(commit);
      }
    };
    if (reduced || width.get() === 0) {
      progress.jump(target);
      finish();
    } else animate(progress, target, { ...pagedMotion.settle, onComplete: finish });
  };
  return {
    current,
    previous,
    next,
    currentPlane,
    reset: cancel,
    beginDrag() {
      if (syncWidth()) return 0;
      // Stop the previous writer before sampling the live position. Retire its
      // completion so it cannot replace the page during the new contact.
      ++epoch.current;
      pending.current = null;
      progress.stop();
      // Input takes over the painted plane, which can trail its MotionValue
      // by a frame. Sampling the writer would jump on immediate re-grabs.
      const plane = currentPlane.current;
      if (plane?.isConnected && width.get() > 0) {
        const offset = new DOMMatrixReadOnly(getComputedStyle(plane).transform).e;
        progress.jump(offset / width.get());
        return offset;
      }
      return progress.get() * width.get();
    },
    drag(offset: number) {
      ++epoch.current;
      pending.current = null;
      progress.stop();
      progress.set(Math.max(-1, Math.min(1, offset / Math.max(1, width.get()))));
    },
    settle,
  };
}

/** Paint only; gestures, image transforms and page identity remain with callers. */
export const PagedMotionPlane = forwardRef<
  HTMLDivElement,
  {
    readonly offset: MotionValue<number>;
    readonly children: ReactNode;
    readonly className?: string;
    readonly page: "previous" | "current" | "next";
  }
>(function PagedMotionPlane({ offset, children, className, page }, ref) {
  return (
    <motion.div
      ref={ref}
      className={className}
      style={{ x: offset }}
      data-motion-page={page}
      aria-hidden={page === "current" ? undefined : true}
      inert={page === "current" ? undefined : true}
    >
      {children}
    </motion.div>
  );
});
