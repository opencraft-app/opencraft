import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { ReduceMotion, cancelAnimation, useAnimatedProps, useAnimatedStyle, useDerivedValue, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { nativeTokens } from "@opencraft/design-system/tokens.native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeChatHorizontalScrollProvider } from "@opencraft/chat-render-native";

import { mobileVisualTokens } from "../runtime/mobile-visual-tokens";
import { resolveMobileShellLayout } from "../runtime/mobile-shell-layout";

export type MobileDrawerHandle = {
  openDrawer: () => void;
  closeDrawer: () => void;
  dismissDrawer: () => void;
  toggleNavigation: () => void;
};

type Props = {
  readonly children: (progress: SharedValue<number>, layout: { readonly docked: boolean }) => ReactNode;
  readonly renderNavigationView: () => ReactNode;
  readonly webGesture: ReturnType<typeof Gesture.Native>;
};

const spring = { damping: 36, stiffness: 430, overshootClamping: true, reduceMotion: ReduceMotion.System } as const;

/** Keeps the Bot tree mounted while a new stroke takes over a running drawer spring. */
export const InterruptibleMobileDrawer = forwardRef<MobileDrawerHandle, Props>(function InterruptibleMobileDrawer({ children, renderNavigationView, webGesture }, ref) {
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [containerWidth, setContainerWidth] = useState(windowWidth);
  const layout = resolveMobileShellLayout(containerWidth - insets.left - insets.right, mobileVisualTokens.shell);
  const wide = layout.navigation === "sidebar";
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const docked = wide && sidebarVisible;
  const drawerWidth = Math.max(1, layout.navigationWidth);
  const progress = useSharedValue(0);
  const sceneProgress = useDerivedValue(() => wide ? 0 : progress.value, [wide]);
  const dragOrigin = useSharedValue(0);
  const dragTranslationOrigin = useSharedValue(0);
  const touchOriginX = useSharedValue(0);
  const dragging = useSharedValue(false);
  const overlayEnabled = useSharedValue(false);
  const horizontalTouchActive = useSharedValue(false);
  useLayoutEffect(() => {
    // Cancel the old geometry's writer. Compact intent survives docking;
    // changing presentation never closes or recreates a conversation.
    cancelAnimation(progress);
    progress.value = progress.value >= 0.5 ? 1 : 0;
    overlayEnabled.value = progress.value === 1;
    dragging.value = false;
    horizontalTouchActive.value = false;
  }, [wide, dragging, horizontalTouchActive, overlayEnabled, progress]);
  const horizontalScrollOwner = useMemo(() => ({
    beginTouch: () => { horizontalTouchActive.value = true; },
    endTouch: () => { horizontalTouchActive.value = false; },
  }), [horizontalTouchActive]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    if (nextWidth > 0) setContainerWidth(current => current === nextWidth ? current : nextWidth);
  }, []);

  const settle = useCallback((target: 0 | 1, velocity = 0) => {
    "worklet";
    cancelAnimation(progress);
    if (target === 1) overlayEnabled.value = true;
    progress.value = withSpring(target, { ...spring, velocity: velocity / drawerWidth }, finished => {
      if (finished) overlayEnabled.value = target === 1;
    });
  }, [drawerWidth, overlayEnabled, progress]);

  useImperativeHandle(ref, () => ({
    openDrawer: () => { if (wide) setSidebarVisible(true); else settle(1); },
    closeDrawer: () => { if (wide) setSidebarVisible(false); else settle(0); },
    dismissDrawer: () => { if (!wide) settle(0); },
    toggleNavigation: () => { if (wide) setSidebarVisible(value => !value); else settle(progress.value >= 0.5 ? 0 : 1); },
  }), [wide, progress, settle]);

  const dismissTap = useMemo(() => Gesture.Tap()
    .maxDistance(10)
    .onEnd(() => { if (overlayEnabled.value) settle(0); }), [overlayEnabled, settle]);

  const pan = useMemo(() => Gesture.Pan()
    .enabled(!wide)
    .hitSlop({ left: 0, width: containerWidth * 0.9 })
    .maxPointers(1)
    .activeOffsetX([-18, 18])
    .failOffsetY([-16, 16])
    .simultaneousWithExternalGesture(webGesture, dismissTap)
    .onTouchesDown(event => {
      touchOriginX.value = event.allTouches[0]?.absoluteX ?? 0;
    })
    .onTouchesMove((event, manager) => {
      if (horizontalTouchActive.value) { manager.fail(); return; }
      if (dragging.value) return;
      const delta = (event.allTouches[0]?.absoluteX ?? touchOriginX.value) - touchOriginX.value;
      // A closed drawer does not steal left swipes from the WebView; an open one
      // does not steal right swipes. Partial progress accepts either direction.
      if ((progress.value <= 0.001 && delta < -4) || (progress.value >= 0.999 && delta > 4)) manager.fail();
    })
    .onStart(event => {
      cancelAnimation(progress);
      dragOrigin.value = progress.value;
      dragTranslationOrigin.value = event.translationX;
      dragging.value = true;
    })
    .onUpdate(event => {
      progress.value = Math.max(0, Math.min(1, dragOrigin.value + (event.translationX - dragTranslationOrigin.value) / drawerWidth));
    })
    .onEnd(event => {
      dragging.value = false;
      const projected = progress.value + event.velocityX * 0.12 / drawerWidth;
      settle(projected >= 0.5 ? 1 : 0, event.velocityX);
    })
    .onFinalize(() => {
      horizontalTouchActive.value = false;
      if (!dragging.value) return;
      dragging.value = false;
      settle(progress.value >= 0.5 ? 1 : 0);
    }), [wide, containerWidth, dismissTap, dragOrigin, dragTranslationOrigin, dragging, drawerWidth, horizontalTouchActive, progress, settle, touchOriginX, webGesture]);

  const sceneStyle = useAnimatedStyle(() => ({ transform: [{ translateX: wide ? 0 : progress.value * drawerWidth }] }));
  const overlayProps = useAnimatedProps(() => ({ pointerEvents: !wide && overlayEnabled.value ? "auto" as const : "none" as const }));
  const drawerAccessibility = useAnimatedProps(() => ({
    accessibilityViewIsModal: !wide && overlayEnabled.value,
    accessibilityElementsHidden: wide ? !docked : !overlayEnabled.value,
  }));
  const sceneAccessibility = useAnimatedProps(() => ({ accessibilityElementsHidden: !wide && overlayEnabled.value }));

  return <View style={styles.root} onLayout={onLayout}>
    <Animated.View pointerEvents={wide && !docked ? "none" : "auto"} animatedProps={drawerAccessibility} style={[styles.drawer, { width: drawerWidth, opacity: wide && !docked ? 0 : 1 }]}>{renderNavigationView()}</Animated.View>
    <GestureDetector gesture={pan}>
      <Animated.View animatedProps={sceneAccessibility} style={[styles.scene, { left: docked ? drawerWidth : 0 }, sceneStyle]}>
        <NativeChatHorizontalScrollProvider owner={horizontalScrollOwner}>{children(sceneProgress, { docked })}</NativeChatHorizontalScrollProvider>
        <GestureDetector gesture={dismissTap}>
          <Animated.View animatedProps={overlayProps} style={styles.dismissOverlay} />
        </GestureDetector>
      </Animated.View>
    </GestureDetector>
  </View>;
});

const styles = StyleSheet.create({
  root: { flex: 1, overflow: "hidden", backgroundColor: nativeTokens.material.sidebar },
  drawer: { position: "absolute", top: 0, bottom: 0, left: 0 },
  scene: { ...StyleSheet.absoluteFill, backgroundColor: nativeTokens.material.content },
  dismissOverlay: { ...StyleSheet.absoluteFill, backgroundColor: "transparent" },
});
