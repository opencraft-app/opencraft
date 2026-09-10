import {
  deriveUserMessageCollapseState,
  observeUserMessageNaturalHeight,
  observeUserMessageViewportWidth,
  reconcileUserMessageNaturalMeasurement,
  toggleUserMessageExpandedContentIdentity,
  type UserMessageCollapseState,
  type UserMessageNaturalMeasurementTransaction,
} from "@opencraft/chat-core";
import { useCallback, useMemo, useState } from "react";
import type { LayoutChangeEvent } from "react-native";

export interface NativeUserMessageCollapseObserver {
  readonly collapseState: UserMessageCollapseState;
  readonly measuringNaturalHeight: boolean;
  readonly onContentLayout: (event: LayoutChangeEvent) => void;
  readonly onViewportLayout: (event: LayoutChangeEvent) => void;
  readonly toggleExpansion: () => void;
}

/**
 * React Native natural-size observation provider.
 *
 * Native has no scrollHeight. A content/width identity therefore owns a
 * one-way transaction: render un-clipped, accept one natural-height layout,
 * then let presentation clipping proceed. Layout callbacks emitted by the
 * clipped tree are ignored. A width change starts a fresh transaction.
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
  const current = reconcileUserMessageNaturalMeasurement(measurement, contentIdentity, collapsedHeight);
  const measuringNaturalHeight = current.contentHeight === null;

  const onViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    setMeasurement((value) => observeUserMessageViewportWidth(
      value,
      contentIdentity,
      collapsedHeight,
      width,
    ));
  }, [collapsedHeight, contentIdentity]);

  // The closure is intentionally gated by the last committed render. When a
  // width change invalidates measurement, callbacks from that same clipped
  // layout pass still see `false`; only the following un-clipped render may
  // publish a new natural height.
  const onContentLayout = useCallback((event: LayoutChangeEvent) => {
    if (!measuringNaturalHeight) return;
    const height = event.nativeEvent.layout.height;
    setMeasurement((value) => observeUserMessageNaturalHeight(
      value,
      contentIdentity,
      collapsedHeight,
      height,
      measuringNaturalHeight,
    ));
  }, [collapsedHeight, contentIdentity, measuringNaturalHeight]);

  const collapseState = deriveUserMessageCollapseState({
    contentIdentity,
    expandedContentIdentity,
    measurement: current,
  });
  const toggleExpansion = useCallback(() => {
    setExpandedContentIdentity((value) => toggleUserMessageExpandedContentIdentity(contentIdentity, value));
  }, [contentIdentity]);

  return useMemo(() => ({
    collapseState,
    measuringNaturalHeight,
    onContentLayout,
    onViewportLayout,
    toggleExpansion,
  }), [collapseState, measuringNaturalHeight, onContentLayout, onViewportLayout, toggleExpansion]);
}
