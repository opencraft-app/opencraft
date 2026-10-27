import {
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  shellNavigationMetrics,
  type ShellNavigationRailDetent,
  type ShellNavigationVisibleDetent,
} from "@opencraft/workbench-runtime";
import {
  beginSidecarPrimaryResize,
  previewSidecarPrimaryResize,
  type SidecarPrimaryResizeCommit,
  type SidecarPrimaryResizePreview,
  type SidecarPrimaryResizeTransaction,
} from "./sidecar-primary-resize";

interface SidecarPrimaryResizeHandleProps {
  readonly compactWidth: number;
  readonly defaultWidth: number;
  readonly detent: ShellNavigationVisibleDetent;
  readonly expandedWidth: number;
  readonly getMaximumWidth: () => number;
  readonly getCurrentWidth?: () => number;
  readonly label: string;
  readonly onCancel: () => void;
  readonly onCommit: (result: SidecarPrimaryResizeCommit) => void;
  readonly onPreview: (preview: SidecarPrimaryResizePreview) => void;
  readonly onResizingChange?: (resizing: boolean) => void;
}

interface ActiveTransaction {
  didMove: boolean;
  pointerId: number;
  preview: SidecarPrimaryResizePreview;
  transaction: SidecarPrimaryResizeTransaction;
}

const keyboardResizeStep = 10;

/** The application rail's only pointer/keyboard transaction owner. */
export function SidecarPrimaryResizeHandle({
  compactWidth,
  defaultWidth,
  detent,
  expandedWidth,
  getMaximumWidth,
  getCurrentWidth,
  label,
  onCancel,
  onCommit,
  onPreview,
  onResizingChange,
}: SidecarPrimaryResizeHandleProps) {
  const activeRef = useRef<ActiveTransaction | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isMagnetized, setIsMagnetized] = useState(false);

  const resolve = (clientX: number) => {
    const active = activeRef.current;
    if (active === null) return null;
    const preview = previewSidecarPrimaryResize({
      clientX,
      compactWidth,
      expandedMinimumWidth: shellNavigationMetrics.expandedMinimumWidth,
      maximumWidth: getMaximumWidth(),
      transaction: active.transaction,
    });
    active.didMove ||= clientX !== active.transaction.startClientX;
    active.preview = preview;
    setIsMagnetized(preview.magnetized);
    onPreview(preview);
    return active;
  };

  const finish = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const active = activeRef.current;
    if (active === null || event.pointerId !== active.pointerId) return;
    if (!cancelled) resolve(event.clientX);
    activeRef.current = null;
    setIsResizing(false);
    setIsMagnetized(false);
    onResizingChange?.(false);
    if (cancelled || !active.didMove) {
      onCancel();
      return;
    }
    onCommit({
      detent: active.preview.candidateDetent,
      expandedWidth: active.preview.candidateDetent === "expanded"
        ? active.preview.frameWidth
        : null,
      originDetent: active.transaction.originDetent,
    });
  };

  const commit = (
    nextDetent: ShellNavigationRailDetent,
    nextExpandedWidth: number | null,
  ) => onCommit({ detent: nextDetent, expandedWidth: nextExpandedWidth, originDetent: detent });

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || activeRef.current !== null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // Stopping a running animation can flush its final value. Retire that
    // writer before reading the physical origin for the new pointer owner.
    onResizingChange?.(true);
    const transaction = beginSidecarPrimaryResize({
      clientX: event.clientX,
      compactWidth,
      detent,
      expandedWidth,
      currentWidth: getCurrentWidth?.(),
    });
    activeRef.current = {
      didMove: false,
      pointerId: event.pointerId,
      preview: {
        candidateDetent: detent,
        frameWidth: transaction.originWidth,
        magnetized: detent === "compact",
      },
      transaction,
    };
    setIsResizing(true);
  };

  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    commit("expanded", Math.min(defaultWidth, getMaximumWidth()));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextDetent: ShellNavigationRailDetent | null = null;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "Home") {
      if (detent === "expanded" && expandedWidth > shellNavigationMetrics.expandedMinimumWidth && event.key !== "Home") {
        nextDetent = "expanded";
        nextWidth = Math.max(shellNavigationMetrics.expandedMinimumWidth, expandedWidth - keyboardResizeStep);
      } else nextDetent = detent === "expanded" ? "compact" : "hidden";
    }
    if (event.key === "ArrowRight") {
      nextDetent = "expanded";
      nextWidth = detent === "compact"
        ? shellNavigationMetrics.expandedMinimumWidth
        : Math.min(getMaximumWidth(), expandedWidth + keyboardResizeStep);
    }
    if (event.key === "End") {
      nextDetent = "expanded";
      nextWidth = getMaximumWidth();
    }
    if (nextDetent === null) return;
    event.preventDefault();
    event.stopPropagation();
    commit(nextDetent, nextDetent === "expanded" ? nextWidth ?? expandedWidth : null);
  };

  return (
    <div
      className="app-shell-left-panel__resize"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={getMaximumWidth()}
      aria-valuenow={detent === "compact" ? compactWidth : expandedWidth}
      aria-valuetext={detent === "compact" ? "Compact" : `${expandedWidth} pixels`}
      data-magnetized={isMagnetized}
      data-resizing={isResizing}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={(event) => finish(event, true)}
      onPointerDown={handlePointerDown}
      onPointerMove={(event) => {
        if (activeRef.current?.pointerId === event.pointerId) {
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
