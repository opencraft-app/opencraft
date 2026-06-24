"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import styles from "../../styles/desktop.module.css";
import type { BottomAnchorUserIntent } from "../scroll/bottomAnchorDriver";
import { applyConversationScrollWrite } from "../scroll/scrollWrite";
import {
  computeScrollOffsetFromThumbDelta,
  computeScrollOffsetFromThumbOffset,
  computeVerticalScrollbarGeometry,
  type VerticalScrollbarGeometry,
} from "./geometry";

const METRICS_EPSILON = 0.5;
const SCROLLBAR_VISIBLE_MS = 1200;
const SCROLLBAR_ACTIVE_MS = 110;

interface ScrollbarMetrics {
  offset: number;
  viewportSize: number;
  contentSize: number;
}

interface ScrollbarCommitInput {
  scrollTop: number;
  userIntent: BottomAnchorUserIntent;
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

function scrollElementInstantlyTo(element: HTMLElement, top: number): void {
  applyConversationScrollWrite({
    element,
    phase: { routeResumeStatus: "idle" },
    write: {
      reason: "scrollbar_overlay",
      scrollTop: top,
      source: "scrollbar_overlay",
    },
  });
}

export function useConversationScrollbarOverlay(
  elementRef: RefObject<HTMLElement | null>,
  options?: {
    contentRef?: RefObject<HTMLElement | null>;
    enabled?: boolean;
    onScrollCommit?: (input: ScrollbarCommitInput) => void;
    onUserScrollIntent?: (intent: BottomAnchorUserIntent) => void;
  },
): ReactNode {
  const enabled = options?.enabled ?? true;
  const contentRef = options?.contentRef;
  const onScrollCommit = options?.onScrollCommit;
  const onUserScrollIntent = options?.onUserScrollIntent;
  const [metrics, setMetrics] = useState<ScrollbarMetrics>(EMPTY_METRICS);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [scrollVisible, setScrollVisible] = useState(false);
  const [scrollActive, setScrollActive] = useState(false);
  const visibleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastObservedOffsetRef = useRef<number | null>(null);
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
    if (!element) return;
    const next = readMetrics(element);
    setMetrics((previous) => (metricsChanged(previous, next) ? next : previous));
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
      const userIntent =
        input.scrollTop < input.previousOffset - METRICS_EPSILON
          ? "scroll_up"
          : input.scrollTop > input.previousOffset + METRICS_EPSILON
            ? "scroll_down"
            : "none";
      onUserScrollIntent?.(userIntent);
      onScrollCommit?.({ scrollTop: input.scrollTop, userIntent });
    },
    [onScrollCommit, onUserScrollIntent],
  );

  useLayoutEffect(() => {
    if (!enabled) return;
    const element = elementRef.current;
    if (!element) return;

    const handleScroll = () => {
      updateMetrics();
    };

    element.addEventListener("scroll", handleScroll, { passive: true });
    const resizeObserver = new ResizeObserver(updateMetrics);
    resizeObserver.observe(element);
    if (contentRef?.current) {
      resizeObserver.observe(contentRef.current);
    }
    updateMetrics();

    return () => {
      element.removeEventListener("scroll", handleScroll);
      resizeObserver.disconnect();
    };
  }, [contentRef, elementRef, enabled, updateMetrics]);

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
      lastObservedOffsetRef.current = null;
      return;
    }

    const previousOffset = lastObservedOffsetRef.current;
    lastObservedOffsetRef.current = metrics.offset;
    if (previousOffset === null) return;
    if (Math.abs(metrics.offset - previousOffset) <= METRICS_EPSILON) return;
    revealFromScroll();
    markScrollActive();
  }, [
    clearActiveTimeout,
    clearVisibleTimeout,
    enabled,
    geometry.visible,
    markScrollActive,
    metrics.offset,
    revealFromScroll,
  ]);

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
      scrollElementInstantlyTo(element, nextOffset);
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
      scrollElementInstantlyTo(element, nextOffset);
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
  }, [commitOverlayScroll, dragging, elementRef, updateMetrics]);

  if (!enabled || !geometry.visible) {
    return null;
  }

  const visible = dragging || hovered || scrollVisible;
  const active = dragging || hovered || scrollActive;

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
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
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
