import { useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DEFAULT_SIDEBAR_RESIZE_CONSTRAINTS, resolveSidebarResize } from "./model";
import { useSidebarResize } from "./useSidebarResize";

export interface SidebarResizeHandleProps {
  sidebarWidthPx: number;
  onSidebarResizeStart?: () => void;
  onSidebarWidthPreview?: (widthPx: number) => void;
  onSidebarWidthChange: (widthPx: number) => void;
  onSidebarVisibilityChange?: (isVisible: boolean) => void;
}

export function SidebarResizeHandle({
  sidebarWidthPx,
  onSidebarResizeStart,
  onSidebarWidthPreview,
  onSidebarWidthChange,
  onSidebarVisibilityChange,
}: SidebarResizeHandleProps) {
  const commitResizeResolution = useCallback(
    (resolution: ReturnType<typeof resolveSidebarResize>) => {
      onSidebarWidthChange(resolution.sidebarWidthPx);
      if (!resolution.isSidebarVisible) {
        onSidebarVisibilityChange?.(false);
      }
    },
    [onSidebarVisibilityChange, onSidebarWidthChange],
  );

  const { handleRef, isDragging, onPointerDown } = useSidebarResize({
    sidebarWidthPx,
    onResizeStart: onSidebarResizeStart,
    onWidthPreview: (resolution) => onSidebarWidthPreview?.(resolution.sidebarWidthPx),
    onWidthCommit: commitResizeResolution,
  });

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        commitResizeResolution(resolveSidebarResize(sidebarWidthPx - 16));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        commitResizeResolution(resolveSidebarResize(sidebarWidthPx + 16));
      }
    },
    [commitResizeResolution, sidebarWidthPx],
  );

  return (
    <div
      ref={handleRef}
      className="vela-sidebar-resize-handle"
      data-dragging={isDragging ? "true" : undefined}
      data-slot="sidebar-resize-handle"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={DEFAULT_SIDEBAR_RESIZE_CONSTRAINTS.minWidthPx}
      aria-valuemax={DEFAULT_SIDEBAR_RESIZE_CONSTRAINTS.maxWidthPx}
      aria-valuenow={sidebarWidthPx}
      onKeyDown={handleKeyDown}
      onPointerDown={onPointerDown}
    />
  );
}
