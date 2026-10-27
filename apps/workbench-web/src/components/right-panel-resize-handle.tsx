import { useIntl } from "@opencraft/i18n/react";
import { createPortal } from "react-dom";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

interface RightPanelResizeHandleProps {
  getCurrentSize(): number;
  getDefaultSize(): number;
  getMinimumSize(): number;
  getMaximumSize(): number;
  onResize(size: number): void;
  onResizeEnd(size: number): void;
  onResizingChange(resizing: boolean): void;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startSize: number;
  moved: boolean;
  lastSize: number;
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

export function RightPanelResizeHandle({
  getCurrentSize,
  getDefaultSize,
  getMinimumSize,
  getMaximumSize,
  onResize,
  onResizeEnd,
  onResizingChange,
}: RightPanelResizeHandleProps) {
  const intl = useIntl();
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    if (!resizing) return;

    const resizeFromPointer = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag === null || event.pointerId !== drag.pointerId) return null;
      const size = clamp(
        drag.startSize + drag.startX - event.clientX,
        0,
        getMaximumSize(),
      );
      if (event.clientX !== drag.startX) drag.moved = true;
      drag.lastSize = size;
      return size;
    };

    const handlePointerMove = (event: PointerEvent) => {
      const size = resizeFromPointer(event);
      if (size === null) return;
      event.preventDefault();
      onResize(size);
    };

    const finishResize = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag === null || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const finalSize = resizeFromPointer(event) ?? drag.lastSize;
      if (drag.moved) {
        onResize(finalSize);
        onResizeEnd(finalSize);
      }
      dragRef.current = null;
      setResizing(false);
      onResizingChange(false);
    };
    const cancelResize = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      onResize(drag.startSize);
      setResizing(false);
      onResizingChange(false);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", finishResize, { passive: false });
    window.addEventListener("pointercancel", cancelResize);
    window.addEventListener("blur", cancelResize);
    window.addEventListener("lostpointercapture", cancelResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", cancelResize);
      window.removeEventListener("blur", cancelResize);
      window.removeEventListener("lostpointercapture", cancelResize);
    };
  }, [getMaximumSize, onResize, onResizeEnd, onResizingChange, resizing]);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startSize: getCurrentSize(),
      moved: false,
      lastSize: getCurrentSize(),
    };
    setResizing(true);
    onResizingChange(true);
  };

  const resetSize = () => {
    const size = clamp(getDefaultSize(), getMinimumSize(), getMaximumSize());
    dragRef.current = null;
    setResizing(false);
    onResizingChange(false);
    onResize(size);
    onResizeEnd(size);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentSize = getCurrentSize();
    const minimumSize = getMinimumSize();
    const maximumSize = getMaximumSize();
    const delta = event.key === "ArrowLeft"
      ? 10
      : event.key === "ArrowRight"
        ? -10
        : event.key === "Home"
          ? minimumSize - currentSize
          : event.key === "End"
            ? maximumSize - currentSize
            : null;
    if (delta === null) return;
    event.preventDefault();
    event.stopPropagation();
    const size = clamp(currentSize + delta, minimumSize, maximumSize);
    onResize(size);
    onResizeEnd(size);
  };

  return (
    <>
    <div
      className="right-panel-resize-handle"
      data-resizing={resizing}
      role="separator"
      aria-label={intl.formatMessage({ id: "panel.resize", defaultMessage: "Resize preview panel" })}
      aria-orientation="vertical"
      aria-valuemax={Math.round(getMaximumSize())}
      aria-valuemin={Math.round(getMinimumSize())}
      aria-valuenow={Math.round(getCurrentSize())}
      tabIndex={0}
      onDoubleClick={resetSize}
      onKeyDown={handleKeyDown}
      onPointerDown={beginResize}
    >
      <span aria-hidden="true" />
    </div>
    {resizing ? createPortal(<div className="right-panel-resize-cursor" aria-hidden="true" />, document.body) : null}
    </>
  );
}
