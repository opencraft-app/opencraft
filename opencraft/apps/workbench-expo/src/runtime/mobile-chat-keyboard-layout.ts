import type { MobileChatKeyboardLayout, MobileChatKeyboardLayoutInput } from "./mobile-chat-keyboard-layout.types";

/** Web and standalone Android keep their platform-owned keyboard layout. */
export function useMobileChatKeyboardLayout(input: MobileChatKeyboardLayoutInput): MobileChatKeyboardLayout {
  return {
    reservedShift: 0,
    inputMaximumHeight: input.normalInputMaximumHeight,
    composerMaximumHeight: undefined,
    composerStyle: null,
  };
}
