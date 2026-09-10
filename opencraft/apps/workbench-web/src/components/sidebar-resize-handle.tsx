import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

export const SIDEBAR_DEFAULT_WIDTH = 275;
export const SIDEBAR_MINIMUM_WIDTH = 240;
export const SIDEBAR_MAXIMUM_WIDTH = 520;

// Codex scales the 240px visibility threshold by its 0.5 layout-motion
// factor. The 120–240px interval therefore behaves as a magnetic shelf.
const sidebarCollapseThreshold = SIDEBAR_MINIMUM_WIDTH * 0.5;
const keyboardResizeStep = 10;

interface SidebarResizeHandleProps {
  collapsible?: boolean;
  getCurrentWidth?(): number;
  width: number;
  onCollapse?(): void;
  onExpand?(): void;
  onResize(width: number): void;
  onResizeEnd(width: number | null): void;
  onResizingChange?(resizing: boolean): void;
}

interface DragState {
  didMove: boolean;
  startClientX: number;
  startWidth: number;
}

interface SidebarWidthResolution {
  collapsed: boolean;
  magnetized: boolean;
  width: number;
}

export function getSidebarMaximumWidth(viewportWidth: number): number {
  return Math.max(
    SIDEBAR_MINIMUM_WIDTH,
    Math.min(SIDEBAR_MAXIMUM_WIDTH, viewportWidth - SIDEBAR_MINIMUM_WIDTH),
  );
}

export function resolveSidebarWidth(
  rawWidth: number,
  maximumWidth: number,
): SidebarWidthResolution {
  if (rawWidth < sidebarCollapseThreshold) {
    return { collapsed: true, magnetized: true, width: SIDEBAR_MINIMUM_WIDTH };
  }

  if (rawWidth < SIDEBAR_MINIMUM_WIDTH) {
    return { collapsed: false, magnetized: true, width: SIDEBAR_MINIMUM_WIDTH };
  }

  return {
    collapsed: false,
    magnetized: false,
    width: Math.max(SIDEBAR_MINIMUM_WIDTH, Math.min(rawWidth, maximumWidth)),
  };
}

export function SidebarResizeHandle({
  collapsible = true,
  getCurrentWidth,
  width,
  onCollapse,
  onExpand,
  onResize,
  onResizeEnd,
  onResizingChange,
}: SidebarResizeHandleProps) {
  const dragStateRef = useRef<DragState | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isMagnetized, setIsMagnetized] = useState(false);

  useEffect(() => {
    if (!isResizing) return;

    const applyClientX = (clientX: number): SidebarWidthResolution | null => {
      const dragState = dragStateRef.current;
      if (dragState == null) return null;
      const rawWidth = dragState.startWidth + clientX - dragState.startClientX;
      if (clientX !== dragState.startClientX) dragState.didMove = true;
      const maximumWidth = getSidebarMaximumWidth(window.innerWidth);
      const resolution = collapsible
        ? resolveSidebarWidth(rawWidth, maximumWidth)
        : {
            collapsed: false,
            magnetized: rawWidth < SIDEBAR_MINIMUM_WIDTH,
            width: Math.max(
              SIDEBAR_MINIMUM_WIDTH,
              Math.min(rawWidth, maximumWidth),
            ),
          };
      setIsMagnetized(resolution.magnetized);
      if (resolution.collapsed) {
        onCollapse?.();
      } else {
        onExpand?.();
        onResize(resolution.width);
      }
      return resolution;
    };

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      event.preventDefault();
      applyClientX(event.clientX);
    };

    const handlePointerEnd = (event: globalThis.PointerEvent) => {
      event.preventDefault();
      const resolution = applyClientX(event.clientX);
      const didMove = dragStateRef.current?.didMove === true;
      dragStateRef.current = null;
      setIsResizing(false);
      setIsMagnetized(false);
      onResizingChange?.(false);
      if (didMove)
        onResizeEnd(
          resolution == null || resolution.collapsed ? null : resolution.width,
        );
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [
    collapsible,
    isResizing,
    onCollapse,
    onExpand,
    onResize,
    onResizeEnd,
    onResizingChange,
  ]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragStateRef.current = {
      didMove: false,
      startClientX: event.clientX,
      startWidth: getCurrentWidth?.() ?? width,
    };
    setIsResizing(true);
    onResizingChange?.(true);
  };

  const commitWidth = (nextWidth: number) => {
    onExpand?.();
    onResize(nextWidth);
    onResizeEnd(nextWidth);
  };

  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    commitWidth(
      Math.min(
        SIDEBAR_DEFAULT_WIDTH,
        getSidebarMaximumWidth(window.innerWidth),
      ),
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const maximumWidth = getSidebarMaximumWidth(window.innerWidth);
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = width - keyboardResizeStep;
    if (event.key === "ArrowRight") nextWidth = width + keyboardResizeStep;
    if (event.key === "Home") nextWidth = SIDEBAR_MINIMUM_WIDTH;
    if (event.key === "End") nextWidth = maximumWidth;
    if (nextWidth == null) return;
    event.preventDefault();
    event.stopPropagation();
    commitWidth(
      Math.max(SIDEBAR_MINIMUM_WIDTH, Math.min(nextWidth, maximumWidth)),
    );
  };

  return (
    <div
      className="app-shell-left-panel__resize"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_MINIMUM_WIDTH}
      aria-valuemax={getSidebarMaximumWidth(window.innerWidth)}
      aria-valuenow={width}
      data-magnetized={isMagnetized}
      data-resizing={isResizing}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      tabIndex={0}
    >
      <span aria-hidden="true" />
    </div>
  );
}
