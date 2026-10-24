import {
  deriveUserMessageCollapseState,
  observeUserMessageNaturalHeight,
  observeUserMessageViewportWidth,
  reconcileUserMessageNaturalMeasurement,
  toggleUserMessageExpandedContentIdentity,
  type UserMessageCollapseState,
  type UserMessageNaturalMeasurementTransaction,
} from "@opencraft/chat-core";
import { NativeContentMeasurementEpoch } from "@opencraft/timeline-host-native";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { LayoutChangeEvent, View } from "react-native";

export interface NativeUserMessageCollapseObserver {
  readonly collapseState: UserMessageCollapseState;
  readonly contentRef: RefObject<View | null>;
  readonly measuringNaturalHeight: boolean;
  readonly onContentLayout: (event: LayoutChangeEvent) => void;
  readonly onViewportLayout: (event: LayoutChangeEvent) => void;
  readonly requestMeasurement: () => void;
  readonly toggleExpansion: () => void;
}

/**
 * React Native natural-size observation provider.
 *
 * Native has no scrollHeight. A content/width identity therefore owns a
 * transaction: render un-clipped, accept natural-height layout updates, then
 * let presentation clipping proceed. Clipped measurements may only increase
 * an already confirmed natural height. A width change starts a fresh transaction.
 */
export function useNativeUserMessageCollapse({
  collapsedHeight,
  contentIdentity,
}: {
  readonly collapsedHeight: number;
  readonly contentIdentity: string;
}): NativeUserMessageCollapseObserver {
  const [measurement, setMeasurement] = useState<UserMessageNaturalMeasurementTransaction | null>(null);
  const [expandedContentIdentity, setExpandedContentIdentity] = useState<string | null>(null);
  const contentRef = useRef<View>(null);
  const measurementFrameRef = useRef<number | null>(null);
  const currentContentIdentityRef = useRef(contentIdentity);
  currentContentIdentityRef.current = contentIdentity;
  const current = reconcileUserMessageNaturalMeasurement(measurement, contentIdentity, collapsedHeight);
  const measurementEpochRef = useRef(new NativeContentMeasurementEpoch());
  measurementEpochRef.current.reconcile(contentIdentity, current.viewportWidth);
  const renderLease = measurementEpochRef.current.capture(null);
  const measuringNaturalHeight = current.contentHeight === null;
  const collapseState = deriveUserMessageCollapseState({
    contentIdentity,
    expandedContentIdentity,
    measurement: current,
  });
  const naturalLayoutVisible = measuringNaturalHeight || collapseState !== "collapsed";
  const naturalLayoutVisibleRef = useRef(false);
  naturalLayoutVisibleRef.current = naturalLayoutVisible;

  const onViewportLayout = useCallback((event: LayoutChangeEvent) => {
    if (currentContentIdentityRef.current !== contentIdentity) return;
    const width = event.nativeEvent.layout.width;
    measurementEpochRef.current.reconcile(contentIdentity, width);
    const lease = measurementEpochRef.current.capture(null);
    setMeasurement((value) => measurementEpochRef.current.accepts(lease, null)
      ? observeUserMessageViewportWidth(value, contentIdentity, collapsedHeight, width)
      : value);
  }, [collapsedHeight, contentIdentity]);

  // Unclipped layout may revise the natural height. In the clipped state the
  // shared observer accepts only growth beyond the last natural measurement;
  // a clipped height cannot revoke it. Both the closure and current render
  // gate stale callbacks during a width transition.
  const observeContentHeight = useCallback((height: number) => {
    if (currentContentIdentityRef.current !== contentIdentity
      || !measurementEpochRef.current.matchesLayout(renderLease)) return;
    const observationLease = measurementEpochRef.current.capture(null);
    setMeasurement((value) => measurementEpochRef.current.accepts(observationLease, null)
      ? observeUserMessageNaturalHeight(
        value,
        contentIdentity,
        collapsedHeight,
        height,
        naturalLayoutVisible && naturalLayoutVisibleRef.current,
      ) : value);
  }, [collapsedHeight, contentIdentity, naturalLayoutVisible, renderLease]);
  const observeContentHeightRef = useRef(observeContentHeight);
  observeContentHeightRef.current = observeContentHeight;
  const onContentLayout = useCallback((event: LayoutChangeEvent) => {
    if (!measurementEpochRef.current.matchesLayout(renderLease)) return;
    observeContentHeight(event.nativeEvent.layout.height);
  }, [observeContentHeight, renderLease]);
  const requestMeasurement = useCallback(() => {
    if (measurementFrameRef.current !== null) return;
    const epoch = measurementEpochRef.current;
    const scheduledLease = epoch.capture(null);
    const observe = observeContentHeightRef.current;
    measurementFrameRef.current = requestAnimationFrame(() => {
      measurementFrameRef.current = null;
      if (!epoch.accepts(scheduledLease, null)) return;
      const node = contentRef.current;
      if (node === null) return;
      const lease = epoch.capture(node);
      node.measure((_x, _y, _width, height) => {
        if (epoch.accepts(lease, contentRef.current)) observe(height);
      });
    });
  }, []);
  useLayoutEffect(() => {
    // Strict Mode may replay this lifetime without rerendering the layout.
    // Old asynchronous leases stay revoked while synchronous layout remains valid.
    measurementEpochRef.current.activate();
    return () => {
      measurementEpochRef.current.invalidate();
      if (measurementFrameRef.current !== null) cancelAnimationFrame(measurementFrameRef.current);
      measurementFrameRef.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    // A width/content transition invalidates queued frames as well as native
    // callbacks. Measure the newly committed natural layout even if RN does
    // not emit a second onLayout when only the observer changes.
    if (measurementFrameRef.current !== null) cancelAnimationFrame(measurementFrameRef.current);
    measurementFrameRef.current = null;
    requestMeasurement();
  }, [contentIdentity, current.viewportWidth, requestMeasurement]);
  const toggleExpansion = useCallback(() => {
    setExpandedContentIdentity((value) => toggleUserMessageExpandedContentIdentity(contentIdentity, value));
  }, [contentIdentity]);

  return useMemo(() => ({
    collapseState,
    contentRef,
    measuringNaturalHeight,
    onContentLayout,
    onViewportLayout,
    requestMeasurement,
    toggleExpansion,
  }), [collapseState, measuringNaturalHeight, onContentLayout, onViewportLayout, requestMeasurement, toggleExpansion]);
}
