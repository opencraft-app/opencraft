export const themePreferences = ["light", "dark", "system"] as const;

export type ThemePreference = (typeof themePreferences)[number];
export type ResolvedTheme = Exclude<ThemePreference, "system">;

// Codex defaults to `system`; OpenCraft deliberately opens in its light chrome.
export const defaultThemePreference: ThemePreference = "light";

export const themeMetaColors: Record<ResolvedTheme, string> = {
  light: "#f9f9f9",
  dark: "#000000",
};

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && themePreferences.includes(value as ThemePreference);
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  return preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;
}
