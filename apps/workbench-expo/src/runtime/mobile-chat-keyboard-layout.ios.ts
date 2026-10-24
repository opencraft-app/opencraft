import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { Animated, Keyboard, type KeyboardEvent, type KeyboardMetrics } from "react-native";
import { useKeyboardAnimation } from "react-native-keyboard-controller";
import {
  resolveMobileChatInputMaximumHeight,
  resolveMobileChatComposerMaximumHeight,
  resolveMobileChatKeyboardShift,
  advanceMobileKeyboard,
  hiddenMobileKeyboard,
  usableMobileKeyboardFrame,
  type ScreenRect,
} from "./mobile-chat-keyboard-geometry";
import type { MobileChatKeyboardLayout, MobileChatKeyboardLayoutInput } from "./mobile-chat-keyboard-layout.types";

function screenRect(metrics: KeyboardMetrics): ScreenRect {
  return { x: metrics.screenX, y: metrics.screenY, width: metrics.width, height: metrics.height };
}

export function useMobileChatKeyboardLayout(input: MobileChatKeyboardLayoutInput): MobileChatKeyboardLayout {
  // iOS native Animated receives every keyboard frame from KeyboardProvider.
  const { progress } = useKeyboardAnimation();
  const [keyboard, dispatch] = useReducer(advanceMobileKeyboard, hiddenMobileKeyboard);
  const shiftTarget = useRef(new Animated.Value(0)).current;
  const translateY = useMemo(() => Animated.multiply(progress, Animated.multiply(shiftTarget, -1)), [progress, shiftTarget]);
  const duration = useRef(0);

  // A hardware-keyboard accessory strip is not a full on-screen keyboard.
  // The threshold comes from this composer's controls and safe spacing, not a device height.
  const fullKeyboard = usableMobileKeyboardFrame(
    keyboard.frame, input.controlsHeight, input.bottomClearance, input.keyboardGap,
  );
  const target = input.active ? resolveMobileChatKeyboardShift({
    viewport: input.viewport,
    keyboard: fullKeyboard,
    composerHeight: input.composerHeight,
    composerWidth: input.composerWidth,
    bottomClearance: input.bottomClearance,
    keyboardGap: input.keyboardGap,
  }) : 0;
  const inputMaximumHeight = resolveMobileChatInputMaximumHeight({
    viewport: input.viewport,
    keyboard: fullKeyboard,
    keyboardShift: target,
    bottomClearance: input.bottomClearance,
    keyboardGap: input.keyboardGap,
    controlsHeight: input.controlsHeight,
    normalMaximumHeight: input.normalInputMaximumHeight,
  });
  const composerMaximumHeight = resolveMobileChatComposerMaximumHeight({
    viewport: input.viewport,
    keyboard: fullKeyboard,
    keyboardShift: target,
    keyboardGap: input.keyboardGap,
  });

  useEffect(() => {
    if (!input.active) {
      dispatch({ type: "deactivate" });
      return;
    }
    const current = Keyboard.metrics();
    if (current) dispatch({ type: "did-show", frame: screenRect(current) });
    const setFrame = (event: KeyboardEvent) => {
      duration.current = event.duration;
      dispatch({ type: "will-change", frame: screenRect(event.endCoordinates) });
    };
    const show = (event: KeyboardEvent) => {
      duration.current = event.duration;
      dispatch({ type: "did-show", frame: screenRect(event.endCoordinates) });
    };
    const change = Keyboard.addListener("keyboardWillChangeFrame", setFrame);
    const shown = Keyboard.addListener("keyboardDidShow", show);
    const hiding = Keyboard.addListener("keyboardWillHide", () => dispatch({ type: "will-hide" }));
    const hidden = Keyboard.addListener("keyboardDidHide", () => {
      const latest = Keyboard.metrics();
      dispatch(latest && latest.height > 0
        ? { type: "did-show", frame: screenRect(latest) }
        : { type: "did-hide" });
    });
    return () => { change.remove(); shown.remove(); hiding.remove(); hidden.remove(); };
  }, [input.active]);

  useLayoutEffect(() => {
    shiftTarget.stopAnimation();
    if (keyboard.phase === "open" && target > 0 && duration.current > 0) {
      // A floating iPad keyboard can move while already open; animate the measured target.
      Animated.timing(shiftTarget, { toValue: target, duration: duration.current, useNativeDriver: true }).start();
    } else {
      shiftTarget.setValue(target);
    }
  }, [input.active, keyboard.phase, shiftTarget, target]);

  const composerStyle = useMemo(() => ({ transform: [{ translateY: input.active ? translateY : 0 }] }), [input.active, translateY]);
  return { reservedShift: target, inputMaximumHeight, composerMaximumHeight, composerStyle };
}
