import { defaultThemePreference, isThemePreference, resolveThemePreference, type ThemePreference } from "@opencraft/design-system/theme";
import { normalizeBuiltinThemeId } from "../workbench-presentation";
import { projectWindowAppearance, resolveWindowAppearanceIntent, type WindowAppearancePalette } from "./window-appearance";
import { readWindowPresentation } from "./window-presentation";

export interface BootstrapAppearanceTheme {
  readonly id: string;
  readonly light: WindowAppearancePalette;
  readonly dark: WindowAppearancePalette;
}
/** The build serializes only colors from the same visible runtime catalog. */
export function initializeBootstrapAppearance(document: Document, themes: readonly BootstrapAppearanceTheme[]): void {
  const view = document.defaultView;
  if (!view || !themes.length) return;
  let preference: ThemePreference = defaultThemePreference;
  let requested = "";
  const read = (key: string): string | null | undefined => {
    try { return view.localStorage.getItem(key); }
    catch { return undefined; }
  };
  const stored = read("opencraft.appearance-theme") ?? read("vela.appearance-theme");
  if (isThemePreference(stored)) preference = stored;
  requested = normalizeBuiltinThemeId((read("opencraft.appearance-theme-id") ?? read("vela.appearance-theme-id") ?? "").trim());
  const mode = resolveThemePreference(preference, view.matchMedia("(prefers-color-scheme: dark)").matches);
  const theme = themes.find(entry => entry.id === requested) ?? themes[0]!;
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.dataset.themePreference = preference;
  root.classList.add(mode, `electron-${mode}`);
  projectWindowAppearance(document, resolveWindowAppearanceIntent(preference, mode, theme[mode]), readWindowPresentation(view), requested && requested !== theme.id ? "fallback" : "bootstrap");
}
