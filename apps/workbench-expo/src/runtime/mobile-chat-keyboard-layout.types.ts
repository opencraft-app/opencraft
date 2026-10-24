import type { Animated, ViewStyle } from "react-native";
import type { ScreenRect } from "./mobile-chat-keyboard-geometry";

export interface MobileChatKeyboardLayoutInput {
  readonly active: boolean;
  readonly viewport: ScreenRect | null;
  readonly composerHeight: number;
  readonly composerWidth: number;
  readonly bottomClearance: number;
  readonly keyboardGap: number;
  readonly controlsHeight: number;
  readonly normalInputMaximumHeight: number;
}

export interface MobileChatKeyboardLayout {
  readonly reservedShift: number;
  readonly inputMaximumHeight: number;
  readonly composerMaximumHeight: number | undefined;
  readonly composerStyle: Animated.WithAnimatedValue<ViewStyle> | null;
}
