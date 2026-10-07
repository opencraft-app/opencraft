export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MobileKeyboardSnapshot {
  readonly frame: ScreenRect | null;
  readonly phase: "hidden" | "opening" | "open" | "closing";
}

export type MobileKeyboardEvent =
  | { readonly type: "will-change" | "did-show"; readonly frame: ScreenRect }
  | { readonly type: "will-hide" | "did-hide" | "deactivate" };

export const hiddenMobileKeyboard: MobileKeyboardSnapshot = { frame: null, phase: "hidden" };

/** Ignore a hardware-keyboard accessory strip using the composer's own control geometry. */
export function usableMobileKeyboardFrame(
  frame: ScreenRect | null,
  controlsHeight: number,
  bottomClearance: number,
  keyboardGap: number,
): ScreenRect | null {
  return frame && frame.height >= controlsHeight + bottomClearance + keyboardGap ? frame : null;
}

/** Keep the occupied space through the closing animation; release it at did-hide. */
export function advanceMobileKeyboard(snapshot: MobileKeyboardSnapshot, event: MobileKeyboardEvent): MobileKeyboardSnapshot {
  if (event.type === "deactivate" || event.type === "did-hide") return hiddenMobileKeyboard;
  if (!("frame" in event)) {
    return snapshot.frame ? { ...snapshot, phase: "closing" } : hiddenMobileKeyboard;
  }
  if (event.frame.height <= 0) {
    return snapshot.frame ? { ...snapshot, phase: "closing" } : hiddenMobileKeyboard;
  }
  if (event.type === "did-show") return { frame: event.frame, phase: "open" };
  return { frame: event.frame, phase: snapshot.phase === "open" ? "open" : "opening" };
}

/** Move only the composer portion actually covered by the on-screen keyboard. */
export function resolveMobileChatKeyboardShift(input: {
  readonly viewport: ScreenRect | null;
  readonly keyboard: ScreenRect | null;
  readonly composerHeight: number;
  readonly composerWidth: number;
  readonly bottomClearance: number;
  readonly keyboardGap: number;
}): number {
  const { viewport, keyboard } = input;
  if (!viewport || !keyboard || viewport.width <= 0 || viewport.height <= 0
    || keyboard.width <= 0 || keyboard.height <= 0 || input.composerHeight <= 0) return 0;

  const composerWidth = Math.min(viewport.width, Math.max(0, input.composerWidth));
  const composerLeft = viewport.x + (viewport.width - composerWidth) / 2;
  const composerRight = composerLeft + composerWidth;
  if (keyboard.x >= composerRight || keyboard.x + keyboard.width <= composerLeft) return 0;

  const viewportBottom = viewport.y + viewport.height;
  const composerBottom = viewportBottom - Math.max(0, input.bottomClearance);
  const composerTop = viewportBottom - input.composerHeight;
  const gap = Math.max(0, input.keyboardGap);
  if (keyboard.y >= composerBottom + gap || keyboard.y + keyboard.height <= composerTop) return 0;

  // The viewport can shrink in Split View or Stage Manager. Keep the composer
  // within its measured container if there is too little room above the IME.
  return Math.min(
    Math.max(0, viewport.height - input.composerHeight),
    Math.max(0, composerBottom + gap - keyboard.y),
  );
}

/** Bound the editable field to the space left for the whole composer above the IME. */
export function resolveMobileChatInputMaximumHeight(input: {
  readonly viewport: ScreenRect | null;
  readonly keyboard: ScreenRect | null;
  readonly keyboardShift: number;
  readonly bottomClearance: number;
  readonly keyboardGap: number;
  readonly controlsHeight: number;
  readonly normalMaximumHeight: number;
}): number {
  const { viewport, keyboard } = input;
  if (!viewport || !keyboard || input.keyboardShift <= 0
    || keyboard.y + keyboard.height < viewport.y + viewport.height) return input.normalMaximumHeight;
  return Math.max(0, Math.min(
    input.normalMaximumHeight,
    keyboard.y - viewport.y - input.bottomClearance - input.keyboardGap - input.controlsHeight,
  ));
}

/** Bound the complete composer in a resized window; floating keyboards keep their natural card size. */
export function resolveMobileChatComposerMaximumHeight(input: {
  readonly viewport: ScreenRect | null;
  readonly keyboard: ScreenRect | null;
  readonly keyboardShift: number;
  readonly keyboardGap: number;
}): number | undefined {
  const { viewport, keyboard } = input;
  if (!viewport || !keyboard || input.keyboardShift <= 0
    || keyboard.y + keyboard.height < viewport.y + viewport.height) return undefined;
  return Math.max(0, keyboard.y - viewport.y - input.keyboardGap);
}
