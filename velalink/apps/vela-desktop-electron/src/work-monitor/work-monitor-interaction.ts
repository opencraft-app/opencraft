import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import {
  closeWorkMonitor,
  moveWorkMonitorBy,
} from "../desktopBridge";

const WORK_MONITOR_DRAG_THRESHOLD_PX = 4;
const TOUCH_CLOSE_VISIBILITY_MS = 2400;

interface DragState {
  lastScreenX: number;
  lastScreenY: number;
  originScreenX: number;
  originScreenY: number;
  pointerId: number;
}

export function useWorkMonitorInteraction() {
  const dragStateRef = useRef<DragState | null>(null);
  const touchCloseTimerRef = useRef<number | null>(null);
  const [isCloseVisible, setIsCloseVisible] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const clearTouchCloseTimer = useCallback(() => {
    if (touchCloseTimerRef.current === null) return;
    window.clearTimeout(touchCloseTimerRef.current);
    touchCloseTimerRef.current = null;
  }, []);

  const showCloseTemporarily = useCallback(() => {
    clearTouchCloseTimer();
    setIsCloseVisible(true);
    touchCloseTimerRef.current = window.setTimeout(() => {
      touchCloseTimerRef.current = null;
      setIsCloseVisible(false);
    }, TOUCH_CLOSE_VISIBILITY_MS);
  }, [clearTouchCloseTimer]);

  useEffect(() => clearTouchCloseTimer, [clearTouchCloseTimer]);

  const onPointerEnter = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (isMouseHover(event)) setIsCloseVisible(true);
  }, []);

  const onPointerLeave = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse") setIsCloseVisible(false);
  }, []);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (event.pointerType !== "mouse") showCloseTemporarily();
      dragStateRef.current = {
        lastScreenX: event.screenX,
        lastScreenY: event.screenY,
        originScreenX: event.screenX,
        originScreenY: event.screenY,
        pointerId: event.pointerId,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [showCloseTemporarily],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState) {
        if (isMouseHover(event)) setIsCloseVisible(true);
        return;
      }
      if (dragState.pointerId !== event.pointerId) return;
      const deltaX = event.screenX - dragState.lastScreenX;
      const deltaY = event.screenY - dragState.lastScreenY;
      if (deltaX === 0 && deltaY === 0) return;

      const totalDistance = Math.hypot(
        event.screenX - dragState.originScreenX,
        event.screenY - dragState.originScreenY,
      );
      if (totalDistance >= WORK_MONITOR_DRAG_THRESHOLD_PX) {
        setIsDragging(true);
        void moveWorkMonitorBy(deltaX, deltaY);
        event.preventDefault();
      }

      dragState.lastScreenX = event.screenX;
      dragState.lastScreenY = event.screenY;
    },
    [],
  );

  const onPointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onClose = useCallback(() => {
    void closeWorkMonitor();
  }, []);

  return {
    interactionProps: {
      onPointerCancel: onPointerEnd,
      onPointerDown,
      onPointerEnter,
      onPointerLeave,
      onPointerMove,
      onPointerUp: onPointerEnd,
    },
    isCloseVisible,
    isDragging,
    onClose,
  };
}

function isMouseHover(event: PointerEvent) {
  return event.pointerType === "mouse" && event.buttons === 0;
}
