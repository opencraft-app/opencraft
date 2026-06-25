"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import styles from "../../styles/desktop.module.css";
import {
  computeScrollOffsetFromThumbDelta,
  computeScrollOffsetFromThumbOffset,
  computeVerticalScrollbarGeometry,
  type VerticalScrollbarGeometry,
} from "./geometry";

const METRICS_EPSILON = 0.5;
const SCROLLBAR_VISIBLE_MS = 1200;
const SCROLLBAR_ACTIVE_MS = 110;

export type VerticalScrollbarUserIntent = "scroll_up" | "scroll_down" | "none";

interface ScrollbarMetrics {
  offset: number;
  viewportSize: number;
  contentSize: number;
}

export interface VerticalScrollbarCommitInput {
  previousOffset: number;
  scrollTop: number;
  userIntent: VerticalScrollbarUserIntent;
}

export interface UseVerticalScrollbarOverlayOptions {
  contentRef?: RefObject<HTMLElement | null>;
  enabled?: boolean;
  onScrollCommit?: (input: VerticalScrollbarCommitInput) => void;
  onUserScrollIntent?: (intent: VerticalScrollbarUserIntent) => void;
  scrollElementTo?: (element: HTMLElement, scrollTop: number) => void;
}

const EMPTY_METRICS: ScrollbarMetrics = {
  contentSize: 0,
  offset: 0,
  viewportSize: 0,
};

function metricsChanged(previous: ScrollbarMetrics, next: ScrollbarMetrics): boolean {
  return (
    Math.abs(previous.offset - next.offset) > METRICS_EPSILON ||
    Math.abs(previous.viewportSize - next.viewportSize) > METRICS_EPSILON ||
    Math.abs(previous.contentSize - next.contentSize) > METRICS_EPSILON
  );
}

function readMetrics(element: HTMLElement): ScrollbarMetrics {
  return {
    contentSize: element.scrollHeight,
    offset: element.scrollTop,
    viewportSize: element.clientHeight,
  };
}

function scrollElementDirectlyTo(element: HTMLElement, scrollTop: number): void {
  element.scrollTop = scrollTop;
}

function scrollIntentForOffsets(
  previousOffset: number,
  scrollTop: number,
): VerticalScrollbarUserIntent {
  if (scrollTop < previousOffset - METRICS_EPSILON) return "scroll_up";
  if (scrollTop > previousOffset + METRICS_EPSILON) return "scroll_down";
  return "none";
}

export function useVerticalScrollbarOverlay(
  elementRef: RefObject<HTMLElement | null>,
  options?: UseVerticalScrollbarOverlayOptions,
): ReactNode {
  const enabled = options?.enabled ?? true;
  const contentRef = options?.contentRef;
  const onScrollCommit = options?.onScrollCommit;
  const onUserScrollIntent = options?.onUserScrollIntent;
  const scrollElementTo = options?.scrollElementTo ?? scrollElementDirectlyTo;
  const [metrics, setMetrics] = useState<ScrollbarMetrics>(EMPTY_METRICS);
  const [dragging, setDragging] = useState(false);
  const [scrollVisible, setScrollVisible] = useState(false);
  const [scrollActive, setScrollActive] = useState(false);
  const visibleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metricsRef = useRef<ScrollbarMetrics>(EMPTY_METRICS);
  const resizeSuppressFrameRef = useRef<number | null>(null);
  const suppressScrollRevealForResizeRef = useRef(false);
  const dragStartClientYRef = useRef(0);
  const dragStartOffsetRef = useRef(0);
  const geometryRef = useRef<VerticalScrollbarGeometry>(
    computeVerticalScrollbarGeometry(EMPTY_METRICS),
  );

  const clearVisibleTimeout = useCallback(() => {
    if (visibleTimeoutRef.current === null) return;
    clearTimeout(visibleTimeoutRef.current);
    visibleTimeoutRef.current = null;
  }, []);

  const clearActiveTimeout = useCallback(() => {
    if (activeTimeoutRef.current === null) return;
    clearTimeout(activeTimeoutRef.current);
    activeTimeoutRef.current = null;
  }, []);

  const updateMetrics = useCallback(() => {
    const element = elementRef.current;
    if (!element) return EMPTY_METRICS;
    const next = readMetrics(element);
    const previous = metricsRef.current;
    if (metricsChanged(previous, next)) {
      metricsRef.current = next;
      setMetrics(next);
    }
    return next;
  }, [elementRef]);

  const revealFromScroll = useCallback(() => {
    setScrollVisible(true);
    clearVisibleTimeout();
    visibleTimeoutRef.current = setTimeout(() => {
      visibleTimeoutRef.current = null;
      setScrollVisible(false);
    }, SCROLLBAR_VISIBLE_MS);
  }, [clearVisibleTimeout]);

  const markScrollActive = useCallback(() => {
    setScrollActive(true);
    clearActiveTimeout();
    activeTimeoutRef.current = setTimeout(() => {
      activeTimeoutRef.current = null;
      setScrollActive(false);
    }, SCROLLBAR_ACTIVE_MS);
  }, [clearActiveTimeout]);

  const commitOverlayScroll = useCallback(
    (input: { previousOffset: number; scrollTop: number }) => {
      const userIntent = scrollIntentForOffsets(input.previousOffset, input.scrollTop);
      onUserScrollIntent?.(userIntent);
      onScrollCommit?.({ ...input, userIntent });
    },
    [onScrollCommit, onUserScrollIntent],
  );

  useLayoutEffect(() => {
    if (!enabled) return;
    const element = elementRef.current;
    if (!element) return;

    const handleScroll = () => {
      updateMetrics();
      if (suppressScrollRevealForResizeRef.current) return;
      revealFromScroll();
      markScrollActive();
    };

    const handleResize = () => {
      updateMetrics();
      suppressScrollRevealForResizeRef.current = true;
      if (resizeSuppressFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeSuppressFrameRef.current);
      }
      resizeSuppressFrameRef.current = window.requestAnimationFrame(() => {
        resizeSuppressFrameRef.current = null;
        suppressScrollRevealForResizeRef.current = false;
      });
    };

    element.addEventListener("scroll", handleScroll, { passive: true });
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(element);
    if (contentRef?.current) {
      resizeObserver.observe(contentRef.current);
    }
    updateMetrics();

    return () => {
      element.removeEventListener("scroll", handleScroll);
      resizeObserver.disconnect();
      if (resizeSuppressFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeSuppressFrameRef.current);
        resizeSuppressFrameRef.current = null;
      }
      suppressScrollRevealForResizeRef.current = false;
    };
  }, [
    contentRef,
    elementRef,
    enabled,
    markScrollActive,
    revealFromScroll,
    updateMetrics,
  ]);

  const geometry = useMemo(
    () =>
      computeVerticalScrollbarGeometry({
        contentSize: metrics.contentSize,
        offset: metrics.offset,
        viewportSize: metrics.viewportSize,
      }),
    [metrics.contentSize, metrics.offset, metrics.viewportSize],
  );

  useEffect(() => {
    geometryRef.current = geometry;
  }, [geometry]);

  useEffect(() => {
    if (!enabled || !geometry.visible) {
      setScrollVisible(false);
      setScrollActive(false);
      clearVisibleTimeout();
      clearActiveTimeout();
      return;
    }
  }, [clearActiveTimeout, clearVisibleTimeout, enabled, geometry.visible]);

  useEffect(
    () => () => {
      clearVisibleTimeout();
      clearActiveTimeout();
    },
    [clearActiveTimeout, clearVisibleTimeout],
  );

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!geometry.visible) return;
      event.preventDefault();
      event.stopPropagation();
      dragStartClientYRef.current = event.clientY;
      dragStartOffsetRef.current = metrics.offset;
      setDragging(true);
      setScrollVisible(true);
    },
    [geometry.visible, metrics.offset],
  );

  const jumpToTrackPosition = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!geometry.visible) return;
      if (event.target !== event.currentTarget) return;
      const element = elementRef.current;
      if (!element) return;

      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const thumbOffset = event.clientY - rect.top - geometry.thumbSize / 2;
      const nextOffset = computeScrollOffsetFromThumbOffset({
        maxScrollOffset: geometry.maxScrollOffset,
        maxThumbOffset: geometry.maxThumbOffset,
        thumbOffset,
      });
      const previousOffset = element.scrollTop;
      scrollElementTo(element, nextOffset);
      updateMetrics();
      commitOverlayScroll({ previousOffset, scrollTop: nextOffset });
      setScrollVisible(true);
      markScrollActive();
    },
    [
      commitOverlayScroll,
      elementRef,
      geometry.maxScrollOffset,
      geometry.maxThumbOffset,
      geometry.thumbSize,
      geometry.visible,
      markScrollActive,
      scrollElementTo,
      updateMetrics,
    ],
  );

  useEffect(() => {
    if (!dragging) return;

    const handlePointerMove = (event: PointerEvent) => {
      const nextOffset = computeScrollOffsetFromThumbDelta({
        delta: event.clientY - dragStartClientYRef.current,
        maxScrollOffset: geometryRef.current.maxScrollOffset,
        maxThumbOffset: geometryRef.current.maxThumbOffset,
        startOffset: dragStartOffsetRef.current,
      });
      const element = elementRef.current;
      if (!element) return;
      const previousOffset = element.scrollTop;
      scrollElementTo(element, nextOffset);
      updateMetrics();
      commitOverlayScroll({ previousOffset, scrollTop: nextOffset });
    };

    const stopDragging = () => {
      setDragging(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [commitOverlayScroll, dragging, elementRef, scrollElementTo, updateMetrics]);

  if (!enabled || !geometry.visible) {
    return null;
  }

  const visible = dragging || scrollVisible;
  const active = dragging || scrollActive;

  return (
    <div
      aria-hidden="true"
      className={styles.conversationScrollbarOverlay}
      data-visible={visible ? "true" : "false"}
      onPointerDown={jumpToTrackPosition}
    >
      <div
        className={styles.conversationScrollbarThumbHitbox}
        data-active={active ? "true" : "false"}
        onPointerDown={startDrag}
        style={{
          height: `${geometry.thumbSize + 16}px`,
          transform: `translate3d(0, ${Math.max(0, geometry.thumbOffset - 8)}px, 0)`,
        }}
      >
        <div
          className={styles.conversationScrollbarThumb}
          style={{
            height: `${geometry.thumbSize}px`,
            marginTop: `${Math.min(8, geometry.thumbOffset)}px`,
          }}
        />
      </div>
    </div>
  );
}
