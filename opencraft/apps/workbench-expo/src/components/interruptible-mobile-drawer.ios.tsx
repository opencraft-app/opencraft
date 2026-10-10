import type { HostPanelGesture } from "@opencraft/mobile-bot-bridge";
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { Platform, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { ReduceMotion, cancelAnimation, useAnimatedProps, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { nativeTokens } from "@opencraft/design-system/tokens.native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeChatHorizontalScrollProvider } from "@opencraft/chat-render-native";

import { mobileVisualTokens } from "../runtime/mobile-visual-tokens";
import { resolveMobileShellLayout } from "../runtime/mobile-shell-layout";
import { resolveMobileShellSwipeAdmission, type MobileShellSwipeAdmission, type MobileShellSwipeTarget } from "../runtime/mobile-shell-swipe";

export type MobileDrawerHandle = {
  openDrawer: () => void;
  closeDrawer: () => void;
  dismissDrawer: () => void;
  toggleNavigation: () => void;
  setContentTouchOwned: (owned: boolean) => void;
};

type Props = {
  readonly children: (progress: SharedValue<number>, layout: { readonly docked: boolean; readonly navigationOpen: boolean }) => ReactNode;
  readonly renderNavigationView: () => ReactNode;
  readonly webGesture: ReturnType<typeof Gesture.Native>;
  readonly panelSwipe?: { readonly available: boolean; readonly open: boolean; readonly ownerId: string; readonly onGesture: (ownerId: string, gesture: HostPanelGesture) => void };
};

const spring = { damping: 36, stiffness: 430, overshootClamping: true, reduceMotion: ReduceMotion.System } as const;

/** Keeps the Bot tree mounted while a new stroke takes over a running drawer spring. */
export const InterruptibleMobileDrawer = forwardRef<MobileDrawerHandle, Props>(function InterruptibleMobileDrawer({ children, renderNavigationView, webGesture, panelSwipe }, ref) {
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [containerWidth, setContainerWidth] = useState(windowWidth);
  const layout = resolveMobileShellLayout(containerWidth - insets.left - insets.right, mobileVisualTokens.shell);
  const wide = layout.navigation === "sidebar";
  const isPad = Platform.OS === "ios" && "isPad" in Platform && Platform.isPad === true;
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const docked = wide && sidebarVisible;
  const drawerWidth = Math.max(1, layout.navigationWidth);
  const progress = useSharedValue(0);
  const dockProgress = useSharedValue(1);
  const dockTarget = useSharedValue<0 | 1>(1);
  const sceneProgress = useDerivedValue(() => wide ? 0 : progress.value, [wide]);
  const dragOrigin = useSharedValue(0);
  const ipadNavigationOrigin = useSharedValue(1);
  const dragTranslationOrigin = useSharedValue(0);
  const touchOriginX = useSharedValue(0);
  const touchOriginY = useSharedValue(0);
  const touchAdmission = useSharedValue<MobileShellSwipeAdmission>("content");
  const dragging = useSharedValue(false);
  const overlayEnabled = useSharedValue(false);
  const horizontalTouchActive = useSharedValue(false);
  const contentTouchOwned = useSharedValue(false);
  const gestureTarget = useSharedValue<MobileShellSwipeTarget>("none");
  const panelGestureEnded = useSharedValue(false);
  const panelAvailable = panelSwipe?.available === true;
  const panelOpen = panelSwipe?.open === true;
  const panelPresented = useSharedValue(panelOpen);
  useLayoutEffect(() => { panelPresented.value = panelOpen; }, [panelOpen, panelPresented]);
  const panelOwnerId = panelSwipe?.ownerId ?? "";
  const onPanelGesture = panelSwipe?.onGesture;
  const panelGestureId = useSharedValue(0);
  useAnimatedReaction(() => wide ? dockProgress.value >= 0.5 : progress.value >= 0.5, (next, previous) => {
    if (next !== previous) scheduleOnRN(setNavigationOpen, next);
  }, [wide, dockProgress]);
  useLayoutEffect(() => {
    // Cancel the old geometry's writer. Compact intent survives docking;
    // changing presentation never closes or recreates a conversation.
    cancelAnimation(progress);
    progress.value = progress.value >= 0.5 ? 1 : 0;
    overlayEnabled.value = progress.value === 1;
    dragging.value = false;
    horizontalTouchActive.value = false;
    touchAdmission.value = "content";
  }, [wide, dragging, horizontalTouchActive, overlayEnabled, progress, touchAdmission]);
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

  const settleDock = useCallback((target: 0 | 1, velocity = 0) => {
    "worklet";
    cancelAnimation(dockProgress);
    dockTarget.value = target;
    dockProgress.value = withSpring(target, { ...spring, velocity: velocity / drawerWidth });
  }, [dockProgress, dockTarget, drawerWidth]);

  const setWideNavigation = useCallback((visible: boolean) => {
    setSidebarVisible(visible);
    settleDock(visible ? 1 : 0);
  }, [settleDock]);

  useImperativeHandle(ref, () => ({
    openDrawer: () => { if (wide) setWideNavigation(true); else settle(1); },
    closeDrawer: () => { if (wide) setWideNavigation(false); else settle(0); },
    dismissDrawer: () => { if (!wide) settle(0); },
    toggleNavigation: () => { if (wide) setWideNavigation(dockTarget.value === 0); else settle(progress.value >= 0.5 ? 0 : 1); },
    setContentTouchOwned: owned => { contentTouchOwned.value = owned; },
  }), [wide, dockTarget, progress, settle, setWideNavigation, contentTouchOwned]);

  const dismissTap = useMemo(() => Gesture.Tap()
    .maxDistance(10)
    .onEnd(() => { if (overlayEnabled.value) settle(0); }), [overlayEnabled, settle]);

  // The iPad close stroke belongs to the native navigation surface itself.
  // Its recognizer never wraps the Chat WebView or the scene's scroll tree.
  const ipadNavigationPan = useMemo(() => Gesture.Pan()
    .enabled(isPad)
    .maxPointers(1)
    .activeOffsetX(-18)
    .failOffsetY([-12, 12])
    .onStart(() => {
      ipadNavigationOrigin.value = wide ? dockProgress.value : progress.value;
      cancelAnimation(wide ? dockProgress : progress);
    })
    .onUpdate(event => {
      const next = Math.max(0, Math.min(1, ipadNavigationOrigin.value + event.translationX / drawerWidth));
      if (wide) dockProgress.value = next;
      else progress.value = next;
    })
    .onEnd((event, success) => {
      const projected = (wide ? dockProgress.value : progress.value) + event.velocityX * 0.12 / drawerWidth;
      const target = success && projected < 0.5 ? 0 : 1;
      if (wide) {
        settleDock(target, event.velocityX);
        scheduleOnRN(setSidebarVisible, target === 1);
      } else settle(target, event.velocityX);
    }), [isPad, wide, dockProgress, drawerWidth, ipadNavigationOrigin, progress, settle, settleDock]);

  const pan = useMemo(() => Gesture.Pan()
    // iPad may be wide, split, or floating. Its pane buttons remain available,
    // while the full-scene pan is isolated from the embedded WebView pending a
    // device crash trace.
    .enabled(!isPad && !wide)
    .maxPointers(1)
    .manualActivation(true)
    .simultaneousWithExternalGesture(webGesture, dismissTap)
    .onTouchesDown((event, manager) => {
      // Extra contacts cancel the admitted stroke; don't erase its panel owner
      // before onFinalize delivers cancellation.
      if (event.numberOfTouches !== 1) { manager.fail(); return; }
      touchOriginX.value = event.allTouches[0]?.absoluteX ?? 0;
      touchOriginY.value = event.allTouches[0]?.absoluteY ?? 0;
      touchAdmission.value = "pending";
      gestureTarget.value = "none";
      panelGestureEnded.value = false;
    })
    .onTouchesMove((event, manager) => {
      if (gestureTarget.value !== "none") {
        if (event.numberOfTouches !== 1) manager.fail();
        return;
      }
      const touch = event.allTouches[0];
      const next = resolveMobileShellSwipeAdmission({ owner: touchAdmission.value,
        navigationProgress: progress.value, docked: wide, panelAvailable, panelOpen: panelPresented.value,
        translationX: (touch?.absoluteX ?? touchOriginX.value) - touchOriginX.value,
        translationY: (touch?.absoluteY ?? touchOriginY.value) - touchOriginY.value,
        touchCount: event.numberOfTouches, contentOwned: horizontalTouchActive.value || contentTouchOwned.value });
      touchAdmission.value = next;
      if (next === "content") { manager.fail(); return; }
      if (next === "pending") return;
      gestureTarget.value = next;
      manager.activate();
    })
    .onTouchesUp((event, manager) => {
      // Manual activation must also release an undecided tap to the WebView.
      // A completed panel gesture can receive TOUCHES_UP after END. Never
      // send FAILED to an already active or completed recognizer.
      if (event.numberOfTouches === 0 && touchAdmission.value === "pending") manager.fail();
    })
    .onStart(event => {
      // Only onTouchesMove may grant ownership, before UIKit's pan goes ACTIVE.
      if (gestureTarget.value === "panel") {
        panelGestureId.value += 1;
        if (onPanelGesture) scheduleOnRN(onPanelGesture, panelOwnerId,
          { id: panelGestureId.value, phase: "start", translationX: event.translationX, velocityX: event.velocityX });
        return;
      }
      if (gestureTarget.value !== "navigation") return;
      cancelAnimation(progress);
      dragOrigin.value = progress.value;
      dragTranslationOrigin.value = event.translationX;
      dragging.value = true;
    })
    .onUpdate(event => {
      if (gestureTarget.value === "panel") {
        if (onPanelGesture) scheduleOnRN(onPanelGesture, panelOwnerId,
          { id: panelGestureId.value, phase: "move", translationX: event.translationX, velocityX: event.velocityX });
        return;
      }
      if (gestureTarget.value !== "navigation") return;
      progress.value = Math.max(0, Math.min(1, dragOrigin.value + (event.translationX - dragTranslationOrigin.value) / drawerWidth));
    })
    .onEnd((event, success) => {
      if (gestureTarget.value === "panel") {
        if (onPanelGesture) scheduleOnRN(onPanelGesture, panelOwnerId,
          { id: panelGestureId.value, phase: success ? "end" : "cancel", translationX: event.translationX, velocityX: event.velocityX });
        panelGestureEnded.value = true;
        return;
      }
      if (gestureTarget.value !== "navigation") return;
      dragging.value = false;
      const projected = progress.value + event.velocityX * 0.12 / drawerWidth;
      settle(projected >= 0.5 ? 1 : 0, event.velocityX);
    })
    .onFinalize(() => {
      if (gestureTarget.value === "panel" && !panelGestureEnded.value && onPanelGesture) scheduleOnRN(onPanelGesture, panelOwnerId,
        { id: panelGestureId.value, phase: "cancel", translationX: 0, velocityX: 0 });
      gestureTarget.value = "none";
      panelGestureEnded.value = false;
      touchAdmission.value = "content";
      horizontalTouchActive.value = false;
      if (!dragging.value) return;
      dragging.value = false;
      settle(progress.value >= 0.5 ? 1 : 0);
    }), [wide, isPad, containerWidth, dismissTap, dragOrigin, dragTranslationOrigin, dragging, drawerWidth,
      horizontalTouchActive, contentTouchOwned, gestureTarget, panelAvailable, panelPresented, panelOwnerId,
      onPanelGesture, panelGestureId, panelGestureEnded, progress, settle, touchOriginX, touchOriginY, touchAdmission, webGesture]);

  const sceneStyle = useAnimatedStyle(() => ({
    left: wide ? dockProgress.value * drawerWidth : 0,
    transform: [{ translateX: wide ? 0 : progress.value * drawerWidth }],
  }));
  const navigationStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: wide ? (dockProgress.value - 1) * drawerWidth : 0 }],
    opacity: wide ? dockProgress.value : 1,
  }));
  const overlayProps = useAnimatedProps(() => ({ pointerEvents: !wide && overlayEnabled.value ? "auto" as const : "none" as const }));
  const drawerAccessibility = useAnimatedProps(() => ({
    accessibilityViewIsModal: !wide && overlayEnabled.value,
    accessibilityElementsHidden: wide ? !docked : !overlayEnabled.value,
  }));
  const sceneAccessibility = useAnimatedProps(() => ({ accessibilityElementsHidden: !wide && overlayEnabled.value }));

  const scene = <Animated.View animatedProps={sceneAccessibility} style={[styles.scene, sceneStyle]}>
        <NativeChatHorizontalScrollProvider owner={horizontalScrollOwner}>{children(sceneProgress, { docked, navigationOpen })}</NativeChatHorizontalScrollProvider>
        <GestureDetector gesture={dismissTap}>
          <Animated.View animatedProps={overlayProps} style={styles.dismissOverlay} />
        </GestureDetector>
      </Animated.View>;
  const navigation = <Animated.View pointerEvents={wide && !docked ? "none" : "auto"} animatedProps={drawerAccessibility}
    style={[styles.drawer, { width: drawerWidth }, navigationStyle]}>{renderNavigationView()}</Animated.View>;

  return <View style={styles.root} onLayout={onLayout}>
    {isPad ? <GestureDetector gesture={ipadNavigationPan}>{navigation}</GestureDetector> : navigation}
    {isPad ? scene : <GestureDetector gesture={pan}>{scene}</GestureDetector>}
  </View>;
});

const styles = StyleSheet.create({
  root: { flex: 1, overflow: "hidden", backgroundColor: nativeTokens.material.sidebar },
  drawer: { position: "absolute", top: 0, bottom: 0, left: 0 },
  scene: { ...StyleSheet.absoluteFill, backgroundColor: nativeTokens.material.content },
  dismissOverlay: { ...StyleSheet.absoluteFill, backgroundColor: "transparent" },
});
