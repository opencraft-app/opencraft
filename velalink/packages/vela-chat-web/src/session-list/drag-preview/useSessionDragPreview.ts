import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  shouldStartSessionDragPreview,
  type SessionDragPreviewPoint,
} from "./model";

export interface UseSessionDragPreviewInput {
  canPreview: boolean;
  onDragPreviewEnd?: () => void;
  onDragPreviewMove?: (point: SessionDragPreviewPoint) => void;
  onDragPreviewStart?: (point: SessionDragPreviewPoint) => void;
}

export interface SessionDragPreviewState {
  isDragging: boolean;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  consumeSuppressedClick: () => boolean;
}

export function useSessionDragPreview({
  canPreview,
  onDragPreviewEnd,
  onDragPreviewMove,
  onDragPreviewStart,
}: UseSessionDragPreviewInput): SessionDragPreviewState {
  const [isDragging, setIsDragging] = useState(false);
  const pointerIdRef = useRef<number | null>(null);
  const startPointRef = useRef<SessionDragPreviewPoint | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingPointRef = useRef<SessionDragPreviewPoint | null>(null);
  const isDraggingRef = useRef(false);
  const suppressClickRef = useRef(false);

  const schedulePreviewMove = useCallback(
    (point: SessionDragPreviewPoint) => {
      pendingPointRef.current = point;
      if (!canUseWindow()) {
        onDragPreviewMove?.(point);
        return;
      }
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        const nextPoint = pendingPointRef.current;
        pendingPointRef.current = null;
        if (nextPoint) onDragPreviewMove?.(nextPoint);
      });
    },
    [onDragPreviewMove],
  );

  const resetDrag = useCallback((target?: HTMLElement | null) => {
    if (frameRef.current !== null && canUseWindow()) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    pendingPointRef.current = null;
    const shouldNotifyEnd = isDraggingRef.current;
    if (pointerIdRef.current !== null) {
      releasePointerCapture(target, pointerIdRef.current);
    }
    pointerIdRef.current = null;
    startPointRef.current = null;
    isDraggingRef.current = false;
    setIsDragging(false);
    if (shouldNotifyEnd) onDragPreviewEnd?.();
  }, [onDragPreviewEnd]);

  useEffect(() => () => resetDrag(), [resetDrag]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!canPreview || event.button !== 0) return;
      pointerIdRef.current = event.pointerId;
      startPointRef.current = dragPreviewPointFromEvent(event);
      capturePointer(event.currentTarget, event.pointerId);
    },
    [canPreview],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!canPreview || pointerIdRef.current !== event.pointerId) return;
      const startPoint = startPointRef.current;
      if (!startPoint) return;
      const point = dragPreviewPointFromEvent(event);

      if (!isDraggingRef.current) {
        if (!shouldStartSessionDragPreview(startPoint, point)) return;
        isDraggingRef.current = true;
        suppressClickRef.current = true;
        setIsDragging(true);
        onDragPreviewStart?.(point);
      }

      event.preventDefault();
      schedulePreviewMove(point);
    },
    [canPreview, onDragPreviewStart, schedulePreviewMove],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      if (isDraggingRef.current) event.preventDefault();
      resetDrag(event.currentTarget);
    },
    [resetDrag],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      resetDrag(event.currentTarget);
    },
    [resetDrag],
  );

  const consumeSuppressedClick = useCallback(() => {
    const shouldSuppress = suppressClickRef.current;
    suppressClickRef.current = false;
    return shouldSuppress;
  }, []);

  return {
    consumeSuppressedClick,
    isDragging,
    onPointerCancel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}

function canUseWindow() {
  return typeof window !== "undefined";
}

function capturePointer(target: HTMLElement, pointerId: number) {
  target.setPointerCapture?.(pointerId);
}

function releasePointerCapture(target: HTMLElement | null | undefined, pointerId: number) {
  target?.releasePointerCapture?.(pointerId);
}

function dragPreviewPointFromEvent(event: ReactPointerEvent<HTMLElement>): SessionDragPreviewPoint {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
  };
}
