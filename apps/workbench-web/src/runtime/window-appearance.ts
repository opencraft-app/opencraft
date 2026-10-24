import type { ThemeWindowAppearance } from "@opencraft/design-system/theme-options";
import type { WindowPresentation } from "./window-presentation";

/** Shell's exposed edge surface is separate from an Electron window's material. */
export interface WindowAppearanceIntent extends ThemeWindowAppearance {
  readonly backgroundColor: string;
  readonly edgeBackgroundColor: string;
}
export interface WindowAppearancePalette {
  readonly surface: string;
  readonly surfaces?: { readonly window?: string };
  readonly material?: { readonly window?: "opaque" | "translucent" };
  readonly opaqueWindows: boolean;
}
export function resolveWindowAppearanceIntent(
  themeSource: ThemeWindowAppearance["themeSource"], resolvedTheme: ThemeWindowAppearance["resolvedTheme"], palette: WindowAppearancePalette,
): WindowAppearanceIntent {
  return {
    themeSource, resolvedTheme,
    backgroundColor: palette.surfaces?.window ?? palette.surface,
    edgeBackgroundColor: palette.surface,
    opaqueWindows: palette.material?.window === "opaque" || palette.opaqueWindows,
  };
}
export interface WindowAppearanceProjection {
  readonly requested: WindowAppearanceIntent;
  readonly presentation: WindowPresentation;
  readonly phase: "bootstrap" | "fallback" | "resolved";
  /** Document policy only; acceptance by the native host is unobserved. */
  readonly edgeStrategy: "legacy-overlay-requested" | "system-color-extension" | "host-owned";
  /** A DOM/meta/bridge write is not evidence of the system's displayed pixels. */
  readonly systemAppearance: "unobserved";
}
export interface WindowAppearanceProjector {
  projectAppearance(requested: WindowAppearanceIntent, phase: WindowAppearanceProjection["phase"]): WindowAppearanceProjection;
}
export function projectWindowAppearance(
  document: Document, requested: WindowAppearanceIntent, presentation: WindowPresentation,
  phase: WindowAppearanceProjection["phase"],
): WindowAppearanceProjection {
  const root = document.documentElement;
  const edgeStrategy: WindowAppearanceProjection["edgeStrategy"] = presentation.appearanceControl !== "document-and-hint"
    ? "host-owned"
    : presentation.displayMode !== "tab" && document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"][content="black-translucent"]')
      ? "legacy-overlay-requested" : "system-color-extension";
  root.style.colorScheme = requested.resolvedTheme;
  root.style.setProperty("--shell-window-edge-background", requested.edgeBackgroundColor);
  root.dataset.windowHost = presentation.host;
  root.dataset.windowDisplayMode = presentation.displayMode;
  root.dataset.windowAppearanceStrategy = presentation.appearanceControl;
  root.dataset.windowAppearancePhase = phase;
  root.dataset.windowEdgeStrategy = edgeStrategy;
  // A native container still owns its system bars, but this document owns its
  // edge pixels. Electron retains its existing transparent window material.
  if (presentation.host !== "electron") root.style.backgroundColor = requested.edgeBackgroundColor;
  if (presentation.appearanceControl !== "host-owned") {
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", requested.edgeBackgroundColor);
  }
  if (presentation.appearanceControl === "native-bridge") {
    const bridge = document.defaultView as (Window & { opencraftDesktop?: { setWindowAppearance?: (value: ThemeWindowAppearance) => void } }) | null;
    const { themeSource, resolvedTheme, opaqueWindows, backgroundColor } = requested;
    bridge?.opencraftDesktop?.setWindowAppearance?.({ themeSource, resolvedTheme, opaqueWindows, backgroundColor });
  }
  return { requested, presentation, phase, edgeStrategy, systemAppearance: "unobserved" };
}
