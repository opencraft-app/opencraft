import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  resolveSidebarResize,
  sidebarWidthCssValue,
  type SidebarResizeResolution,
} from "./model";

interface StopDraggingOptions {
  commit: boolean;
  updateState: boolean;
}

export interface UseSidebarResizeInput {
  sidebarWidthPx: number;
  onResizeStart?: () => void;
  onWidthPreview?: (resolution: SidebarResizeResolution) => void;
  onWidthCommit: (resolution: SidebarResizeResolution) => void;
}

export function useSidebarResize({
  sidebarWidthPx,
  onResizeStart,
  onWidthPreview,
  onWidthCommit,
}: UseSidebarResizeInput) {
  const handleRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingClientXRef = useRef<number | null>(null);
  const shellLeftRef = useRef(0);
  const stopDraggingRef = useRef<((options?: Partial<StopDraggingOptions>) => void) | null>(
    null,
  );
  const pendingResolutionRef = useRef<SidebarResizeResolution>(
    resolveSidebarResize(sidebarWidthPx),
  );
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    pendingResolutionRef.current = resolveSidebarResize(sidebarWidthPx);
  }, [sidebarWidthPx]);

  const previewWidthFromClientX = useCallback(
    (clientX: number) => {
      const shell = handleRef.current?.closest(
        '[data-slot="sidebar-shell"]',
      ) as HTMLElement | null;
      const proposedWidthPx = Math.round(clientX - shellLeftRef.current);
      const resolution = resolveSidebarResize(proposedWidthPx);
      pendingResolutionRef.current = resolution;
      onWidthPreview?.(resolution);
      shell?.style.setProperty("--vela-sidebar-width", sidebarWidthCssValue(resolution));
    },
    [onWidthPreview],
  );

  const scheduleWidthPreview = useCallback(
    (clientX: number) => {
      pendingClientXRef.current = clientX;
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        const nextClientX = pendingClientXRef.current;
        pendingClientXRef.current = null;
        if (nextClientX !== null) previewWidthFromClientX(nextClientX);
      });
    },
    [previewWidthFromClientX],
  );

  useEffect(() => {
    return () => {
      stopDraggingRef.current?.({ commit: false, updateState: false });
    };
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      stopDraggingRef.current?.();

      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      let hasPointerCapture = false;
      try {
        handle.setPointerCapture(pointerId);
        hasPointerCapture = true;
      } catch {
        hasPointerCapture = false;
      }

      const shell = handleRef.current?.closest(
        '[data-slot="sidebar-shell"]',
      ) as HTMLElement | null;
      shellLeftRef.current = shell?.getBoundingClientRect().left ?? 0;
      shell?.setAttribute("data-sidebar-dragging", "true");
      setIsDragging(true);
      onResizeStart?.();
      previewWidthFromClientX(event.clientX);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        scheduleWidthPreview(moveEvent.clientX);
      };
      let stopped = false;
      const stopDragging = (options: Partial<StopDraggingOptions> = {}) => {
        if (stopped) return;
        stopped = true;
        const { commit = true, updateState = true } = options;
        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        if (pendingClientXRef.current !== null) {
          previewWidthFromClientX(pendingClientXRef.current);
          pendingClientXRef.current = null;
        }
        const resolution = pendingResolutionRef.current;
        if (updateState) setIsDragging(false);
        shell?.removeAttribute("data-sidebar-dragging");
        shell?.style.removeProperty("--vela-sidebar-width");
        if (commit) onWidthCommit(resolution);
        if (hasPointerCapture) {
          try {
            handle.releasePointerCapture(pointerId);
          } catch {
            // The OS/browser may already have dropped capture after blur.
          }
        }
        if (stopDraggingRef.current === stopDragging) stopDraggingRef.current = null;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerCancel);
        window.removeEventListener("blur", handleWindowBlur);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      };
      const handlePointerUp = () => stopDragging();
      const handlePointerCancel = () => stopDragging();
      const handleWindowBlur = () => stopDragging();
      const handleVisibilityChange = () => {
        if (document.visibilityState !== "visible") stopDragging();
      };

      stopDraggingRef.current = stopDragging;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerCancel);
      window.addEventListener("blur", handleWindowBlur);
      document.addEventListener("visibilitychange", handleVisibilityChange);
    },
    [onResizeStart, onWidthCommit, previewWidthFromClientX, scheduleWidthPreview],
  );

  return {
    handleRef,
    isDragging,
    onPointerDown,
  };
}
