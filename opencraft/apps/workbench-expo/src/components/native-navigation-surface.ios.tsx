import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { ReduceMotion, cancelAnimation, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { nativeTokens } from "@opencraft/design-system/tokens.native";
import { mobileVisualTokens } from "../runtime/mobile-visual-tokens";
import { resolveMobileShellLayout, resolveMobileSurfaceExitDistance } from "../runtime/mobile-shell-layout";

const returnSpring = { damping: 36, stiffness: 430, overshootClamping: true, reduceMotion: ReduceMotion.System } as const;

type NavigationSurfaceProps = {
  readonly children: (dismiss: () => void, presentation: "page" | "panel") => React.ReactNode;
  readonly onDismiss: () => void;
  readonly gestureEnabled?: boolean;
  readonly adaptive?: boolean;
  readonly visible?: boolean;
  readonly entryKey?: string;
};

/** A full pane with one adaptive entrance/return animation for phone and larger layouts. */
export function NativeNavigationSurface({ children, onDismiss, gestureEnabled = true, adaptive = false, visible = true, entryKey }: NavigationSurfaceProps) {
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [containerWidth, setContainerWidth] = useState(windowWidth);
  const geometry = resolveMobileShellLayout(containerWidth - insets.left - insets.right, mobileVisualTokens.shell);
  const panel = adaptive && geometry.account === "panel";
  const horizontalInset = panel ? (containerWidth - geometry.accountWidth) / 2 : 0;
  const exitDistance = resolveMobileSurfaceExitDistance(containerWidth, horizontalInset);
  const progress = useSharedValue(1);
  const closing = useSharedValue(false);
  const dragOrigin = useSharedValue(0);
  const dragTranslationOrigin = useSharedValue(0);
  const mounted = useRef(true);
  const entry = useRef({ key: entryKey, visible, revision: 0 });
  if (entry.current.key !== entryKey || entry.current.visible !== visible) {
    entry.current = { key: entryKey, visible, revision: entry.current.revision + 1 };
  }
  const revision = entry.current.revision;
  const finishDismiss = useCallback(() => {
    if (mounted.current && entry.current.revision === revision && entry.current.visible) onDismiss();
  }, [revision, onDismiss]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelAnimation(progress); };
  }, [progress]);

  useEffect(() => {
    cancelAnimation(progress);
    closing.value = false;
    if (visible) progress.value = withTiming(0, { duration: 260, reduceMotion: ReduceMotion.System });
    else progress.value = 1;
  }, [entryKey, visible, closing, progress]);
  const onContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (width > 0) setContainerWidth(current => current === width ? current : width);
  }, []);
  const completeDismiss = useCallback((velocity: number) => {
    "worklet";
    if (closing.value) return;
    cancelAnimation(progress);
    closing.value = true;
    progress.value = withSpring(1, { ...returnSpring, velocity: velocity / exitDistance }, finished => {
      if (finished) scheduleOnRN(finishDismiss);
    });
  }, [closing, exitDistance, finishDismiss, progress]);
  const dismiss = useCallback(() => completeDismiss(0), [completeDismiss]);
  const gesture = Gesture.Pan()
    .enabled(gestureEnabled && visible)
    .activeOffsetX(14)
    .failOffsetY([-20, 20])
    .onStart(event => {
      if (closing.value) return;
      cancelAnimation(progress);
      dragOrigin.value = progress.value;
      dragTranslationOrigin.value = event.translationX;
    })
    .onUpdate(event => {
      if (!closing.value) progress.value = Math.min(1, Math.max(0, dragOrigin.value + (event.translationX - dragTranslationOrigin.value) / exitDistance));
    })
    .onEnd(event => {
      if (closing.value) return;
      const shouldDismiss = progress.value > 0.28 || (event.translationX > 32 && event.velocityX > 650);
      if (shouldDismiss) {
        completeDismiss(event.velocityX);
      } else {
        progress.value = withSpring(0, { ...returnSpring, velocity: event.velocityX / exitDistance });
      }
    })
    .onFinalize((_, success) => {
      if (!success && !closing.value) progress.value = withSpring(0, returnSpring);
    });
  const surfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * exitDistance }],
    // No shadow pixels remain when React releases/hides the completed surface.
    shadowOpacity: interpolate(progress.value, [0, 0.85, 1], [0, nativeTokens.shadow.prominent.opacity, 0]),
    borderTopLeftRadius: panel ? nativeTokens.radii.xxl : interpolate(progress.value, [0, 1], [0, 28]),
    borderBottomLeftRadius: panel ? nativeTokens.radii.xxl : interpolate(progress.value, [0, 1], [0, 28]),
    borderTopRightRadius: panel ? nativeTokens.radii.xxl : 0,
    borderBottomRightRadius: panel ? nativeTokens.radii.xxl : 0,
  }));
  const clipStyle = useAnimatedStyle(() => ({
    borderTopLeftRadius: panel ? nativeTokens.radii.xxl : interpolate(progress.value, [0, 1], [0, 28]),
    borderBottomLeftRadius: panel ? nativeTokens.radii.xxl : interpolate(progress.value, [0, 1], [0, 28]),
    borderTopRightRadius: panel ? nativeTokens.radii.xxl : 0,
    borderBottomRightRadius: panel ? nativeTokens.radii.xxl : 0,
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));

  return <View onLayout={onContainerLayout} pointerEvents={visible ? "auto" : "none"} accessibilityElementsHidden={!visible} style={[styles.root, { opacity: visible ? 1 : 0 }]}>
    {panel ? <Animated.View style={[StyleSheet.absoluteFill, scrimStyle]}>
      <Pressable accessibilityLabel="Close" onPress={dismiss} style={styles.scrim} />
    </Animated.View> : null}
    <Animated.View accessibilityViewIsModal={visible} style={[styles.surface, {
      left: horizontalInset, right: horizontalInset,
      top: panel ? Math.max(insets.top, mobileVisualTokens.shell.panelInset) : 0,
      bottom: panel ? Math.max(insets.bottom, mobileVisualTokens.shell.panelInset) : 0,
    }, surfaceStyle]}>
      <Animated.View style={[styles.clip, clipStyle]}>{children(dismiss, panel ? "panel" : "page")}</Animated.View>
      {gestureEnabled ? <GestureDetector gesture={gesture}>
        <View collapsable={false} style={[styles.edge, { top: panel ? 0 : insets.top }]} />
      </GestureDetector> : null}
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, overflow: "hidden" },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: nativeTokens.material.scrim },
  surface: {
    position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
    backgroundColor: nativeTokens.material.canvas,
    shadowColor: nativeTokens.shadow.prominent.color,
    shadowOffset: { width: -7, height: nativeTokens.shadow.prominent.offsetY },
    shadowRadius: nativeTokens.shadow.prominent.radius,
    elevation: nativeTokens.shadow.prominent.elevation,
  },
  clip: { flex: 1, overflow: "hidden", backgroundColor: nativeTokens.material.canvas },
  edge: { position: "absolute", left: 0, bottom: 0, width: 30, zIndex: 20 },
});
