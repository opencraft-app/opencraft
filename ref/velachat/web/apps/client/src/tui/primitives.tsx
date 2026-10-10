import {createElement, type ReactNode, useCallback, useRef, useState} from "react";

import type {HostType, NativeStyle} from "./renderer/node";

export interface PrimitiveProps {
  activeIndex?: number;
  activeRouteKey?: string;
  alignment?: string;
  autoFocus?: boolean;
  canGoBack?: boolean;
  checked?: boolean;
  children?: ReactNode;
  contentStyle?: NativeStyle;
  disabled?: boolean;
  estimatedItemExtent?: number;
  groupValue?: string;
  itemExtent?: number;
  label?: string;
  layoutVersion?: string;
  maxLines?: number;
  modal?: boolean;
  mostRecentEventCount?: number;
  onBack?(payload: Record<string, unknown>): unknown;
  onChangeText?(payload: Record<string, unknown>): unknown;
  onDismiss?(payload: Record<string, unknown>): unknown;
  onPress?(payload: Record<string, unknown>): unknown;
  onValueChange?(payload: Record<string, unknown>): unknown;
  overscan?: number;
  placeholder?: string;
  progress?: number;
  secureTextEntry?: boolean;
  segments?: Array<{disabled?: boolean; label: string; value: string}>;
  selected?: boolean;
  style?: NativeStyle;
  subtitle?: string;
  testID?: string;
  title?: string;
  trailing?: string;
  value?: string;
  width?: number;
}

function primitive(type: HostType) {
  return function ReactVaxisPrimitive(props: PrimitiveProps) {
    return createElement(type, props, props.children);
  };
}

function useStableEvent(
  event: PrimitiveProps["onPress"],
): (payload: Record<string, unknown>) => unknown {
  const callback = useRef(event);
  callback.current = event;
  return useCallback((payload: Record<string, unknown>) => callback.current?.(payload), []);
}

export const Button = primitive("Button");
export const Checkbox = primitive("Checkbox");
export const NavigationStack = primitive("NavigationStack");
export const Overlay = primitive("Overlay");
export const ScrollView = primitive("ScrollView");
export const Segmented = primitive("Segmented");
export const Text = primitive("Text");
export function TextInput(props: PrimitiveProps) {
  const callback = useStableEvent(props.onChangeText);
  const [acknowledgedEventCount, setAcknowledgedEventCount] = useState(
    props.mostRecentEventCount ?? 0,
  );
  const onChangeText = useCallback((payload: Record<string, unknown>) => {
    const nativeEventCount = payload.eventCount;
    if (
      typeof nativeEventCount === "number" &&
      Number.isSafeInteger(nativeEventCount) &&
      nativeEventCount >= 0
    ) {
      setAcknowledgedEventCount((current) => Math.max(current, nativeEventCount));
    }
    return callback(payload);
  }, [callback]);
  const mostRecentEventCount = Math.max(
    acknowledgedEventCount,
    props.mostRecentEventCount ?? 0,
  );
  return createElement(
    "TextInput",
    {
      ...props,
      mostRecentEventCount,
      onChangeText: props.onChangeText ? onChangeText : undefined,
    },
    props.children,
  );
}
export const View = primitive("View");
export const VirtualList = primitive("VirtualList");
