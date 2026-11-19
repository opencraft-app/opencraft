import { isThemeColor, type ThemeWindowAppearance } from "@opencraft/design-system/theme-options";

export type WindowAppearanceMessage = ThemeWindowAppearance;

/** Accept legacy mode-only messages; reject CSS, URLs and invalid field types. */
export function isWindowAppearanceMessage(value: unknown): value is WindowAppearanceMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<WindowAppearanceMessage>;
  return (candidate.themeSource === "system" || candidate.themeSource === "light" || candidate.themeSource === "dark")
    && (candidate.resolvedTheme === "light" || candidate.resolvedTheme === "dark")
    && (candidate.opaqueWindows === undefined || typeof candidate.opaqueWindows === "boolean")
    && (candidate.backgroundColor === undefined || isThemeColor(candidate.backgroundColor));
}

export function resolveWindowAppearance(appearance: WindowAppearanceMessage, platform: string, focused: boolean) {
  const opaque = platform !== "darwin" || appearance.opaqueWindows === true || !focused;
  const background = appearance.backgroundColor ?? (appearance.resolvedTheme === "dark" ? "#181818" : "#f9f9f9");
  return {
    backgroundColor: opaque ? background : "#00000000",
    vibrancy: opaque ? null : "menu" as const,
  };
}

/** The same native applicator is used by Main and isolated desktop verification. */
export function applyNativeWindowAppearance(window: {
  isDestroyed(): boolean;
  isFocused(): boolean;
  setBackgroundColor(color: string): void;
  setVibrancy(type: "menu" | null): void;
}, appearance: WindowAppearanceMessage, platform: string): void {
  if (window.isDestroyed()) return;
  const resolved = resolveWindowAppearance(appearance, platform, window.isFocused());
  window.setBackgroundColor(resolved.backgroundColor);
  if (platform === "darwin") window.setVibrancy(resolved.vibrancy);
}
