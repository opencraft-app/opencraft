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

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
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
      const stopDragging = () => {
        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        if (pendingClientXRef.current !== null) {
          previewWidthFromClientX(pendingClientXRef.current);
          pendingClientXRef.current = null;
        }
        const resolution = pendingResolutionRef.current;
        setIsDragging(false);
        shell?.removeAttribute("data-sidebar-dragging");
        shell?.style.removeProperty("--vela-sidebar-width");
        onWidthCommit(resolution);
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopDragging);
        window.removeEventListener("pointercancel", stopDragging);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopDragging);
      window.addEventListener("pointercancel", stopDragging);
    },
    [onResizeStart, onWidthCommit, previewWidthFromClientX, scheduleWidthPreview],
  );

  return {
    handleRef,
    isDragging,
    onPointerDown,
  };
}

