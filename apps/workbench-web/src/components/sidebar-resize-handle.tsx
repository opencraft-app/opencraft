import {
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

import { frame } from "@opencraft/design-system/tokens";
export const SIDEBAR_DEFAULT_WIDTH = frame.sidebarDefaultWidth;
export const SIDEBAR_MINIMUM_WIDTH = frame.sidebarMinWidth;
export const SIDEBAR_MAXIMUM_WIDTH = frame.sidebarMaxWidth;
export function sidebarWidthMetrics(unified = false) {
  return { defaultWidth: unified ? frame.sidebarUnifiedDefaultWidth : frame.sidebarDefaultWidth,
    minimumWidth: unified ? frame.sidebarUnifiedMinWidth : frame.sidebarMinWidth,
    maximumWidth: frame.sidebarMaxWidth, railWidth: unified ? frame.sidebarIconRailWidth : 0 };
}

const sidebarCollapseThreshold = SIDEBAR_MINIMUM_WIDTH * 0.5;
const keyboardResizeStep = 10;

interface SidebarResizeHandleProps {
  readonly unified?: boolean;
  readonly label?: string;
  readonly defaultWidth?: number;
  readonly getMaximumWidth?: () => number;
  readonly collapsible?: boolean;
  readonly getCurrentWidth?: () => number;
  readonly width: number;
  readonly onCollapse?: () => void;
  readonly onExpand?: () => void;
  readonly onResize: (width: number) => void;
  readonly onResizeEnd: (width: number | null) => void;
  readonly onResizingChange?: (resizing: boolean) => void;
}

interface SidebarDragTransaction {
  didMove: boolean;
  pointerId: number;
  startClientX: number;
  startWidth: number;
}

export interface SidebarWidthResolution {
  readonly collapsed: boolean;
  readonly magnetized: boolean;
  readonly width: number;
}

export function getSidebarMaximumWidth(viewportWidth: number, unified = false): number {
  return Math.max(
    sidebarWidthMetrics(unified).minimumWidth,
    Math.min(SIDEBAR_MAXIMUM_WIDTH, viewportWidth - SIDEBAR_MINIMUM_WIDTH),
  );
}

export function resolveSidebarWidth(
  rawWidth: number,
  maximumWidth: number,
  unified = false,
): SidebarWidthResolution {
  const minimumWidth = sidebarWidthMetrics(unified).minimumWidth;
  if (rawWidth < sidebarCollapseThreshold) {
    return { collapsed: true, magnetized: true, width: minimumWidth };
  }
  if (rawWidth < minimumWidth) {
    return { collapsed: false, magnetized: true, width: minimumWidth };
  }
  return {
    collapsed: false,
    magnetized: false,
    width: Math.max(minimumWidth, Math.min(rawWidth, maximumWidth)),
  };
}

/** A two-state context-pane transaction. Semantic collapse commits on release. */
export function SidebarResizeHandle({
  unified = false,
  label = "Resize sidebar",
  defaultWidth = sidebarWidthMetrics(unified).defaultWidth,
  getMaximumWidth,
  collapsible = true,
  getCurrentWidth,
  width,
  onCollapse,
  onExpand,
  onResize,
  onResizeEnd,
  onResizingChange,
}: SidebarResizeHandleProps) {
  const minimumWidth = sidebarWidthMetrics(unified).minimumWidth;
  const transactionRef = useRef<SidebarDragTransaction | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isMagnetized, setIsMagnetized] = useState(false);

  const maximumWidth = () => getMaximumWidth?.() ?? getSidebarMaximumWidth(window.innerWidth, unified);
  const resolve = (clientX: number) => {
    const transaction = transactionRef.current;
    if (transaction === null) return null;
    const rawWidth = transaction.startWidth + clientX - transaction.startClientX;
    const resolution = collapsible
      ? resolveSidebarWidth(rawWidth, maximumWidth(), unified)
      : {
          collapsed: false,
          magnetized: rawWidth < minimumWidth,
          width: Math.max(minimumWidth, Math.min(rawWidth, maximumWidth())),
        };
    transaction.didMove ||= clientX !== transaction.startClientX;
    setIsMagnetized(resolution.magnetized);
    onResize(resolution.width);
    return resolution;
  };

  const finish = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const transaction = transactionRef.current;
    if (transaction === null || transaction.pointerId !== event.pointerId) return;
    const resolution = cancelled ? null : resolve(event.clientX);
    transactionRef.current = null;
    setIsResizing(false);
    setIsMagnetized(false);
    onResizingChange?.(false);
    if (cancelled || !transaction.didMove) {
      onResize(transaction.startWidth);
      return;
    }
    if (resolution?.collapsed) {
      onCollapse?.();
      onResizeEnd(null);
      return;
    }
    onExpand?.();
    onResizeEnd(resolution?.width ?? transaction.startWidth);
  };

  const commitWidth = (nextWidth: number) => {
    onExpand?.();
    onResize(nextWidth);
    onResizeEnd(nextWidth);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || transactionRef.current !== null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    transactionRef.current = {
      didMove: false,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth: getCurrentWidth?.() ?? width,
    };
    setIsResizing(true);
    onResizingChange?.(true);
  };

  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    commitWidth(Math.min(defaultWidth, maximumWidth()));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = width - keyboardResizeStep;
    if (event.key === "ArrowRight") nextWidth = width + keyboardResizeStep;
    if (event.key === "Home") nextWidth = minimumWidth;
    if (event.key === "End") nextWidth = maximumWidth();
    if (nextWidth === null) return;
    event.preventDefault();
    event.stopPropagation();
    commitWidth(Math.max(minimumWidth, Math.min(nextWidth, maximumWidth())));
  };

  return (
    <div
      className="app-shell-left-panel__resize"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minimumWidth}
      aria-valuemax={maximumWidth()}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      data-magnetized={isMagnetized}
      data-resizing={isResizing}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={(event) => finish(event, true)}
      onPointerDown={handlePointerDown}
      onPointerMove={(event) => {
        if (transactionRef.current?.pointerId === event.pointerId) {
          event.preventDefault();
          resolve(event.clientX);
        }
      }}
      onPointerUp={(event) => finish(event, false)}
      tabIndex={0}
    >
      <span aria-hidden="true" />
    </div>
  );
}
