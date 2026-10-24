import { validateThemeOptions, type ThemeMaterialOptions, type ThemeSurfaceOverrides } from "./theme-options";

export interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

export interface OpenCraftThemeDefinition {
  surfaces?: ThemeSurfaceOverrides;
  material?: ThemeMaterialOptions;
  accent: string;
  contrast: number;
  fonts: { code: string | null; ui: string | null };
  ink: string;
  opaqueWindows: boolean;
  /**
   * Application-chrome material is part of a theme, not a Sidecar concern.
   * Optional values preserve extension-theme compatibility while allowing a
   * first-party theme to choose between native translucent chrome and a quiet
   * web canvas without component-level selectors.
   */
  shellMaterial?: {
    unifiedSurfaceElevation?: string;
    sidebarContextBackground?: string;
    sidebarHeadingBackground?: string;
    contentCornerRadius?: string;
    recessedHeaderBackground?: string;
    mainSurfaceElevation: string;
    sidebarBackground: string;
    sidebarFilter: string;
    windowHighlight: string;
    windowMaterial: string;
  };
  semanticColors: {
    diffAdded: string;
    diffRemoved: string;
    skill: string;
    warning?: string;
    error?: string;
    success?: string;
  };
  surface: string;
}

export type OpenCraftThemeMode = "light" | "dark";
export type ThemeCssProperties = Record<`--${string}`, string>;

const clientShellMaterial = Object.freeze({
  mainSurfaceElevation: "var(--elevation-prominent)",
  sidebarBackground: "color-mix(in srgb, var(--color-surface-tertiary) 70%, transparent)",
  sidebarFilter: "blur(28px) saturate(145%)",
  windowHighlight: "radial-gradient(circle at 12% -8%, color-mix(in srgb, var(--color-surface-tertiary) 72%, transparent), transparent 34%)",
  windowMaterial: "color-mix(in srgb, var(--color-background-surface-under) 92%, var(--color-text) 8%)",
});

export const opencraftNeutralThemePalette: Record<OpenCraftThemeMode, OpenCraftThemeDefinition> = {
  dark: {
    accent: "#339cff",
    contrast: 60,
    fonts: { code: null, ui: null },
    ink: "#ffffff",
    opaqueWindows: false,
    semanticColors: { diffAdded: "#40c977", diffRemoved: "#fa423e", skill: "#ad7bf9" },
    surface: "#181818",
  },
  light: {
    accent: "#339cff",
    contrast: 45,
    fonts: { code: null, ui: null },
    ink: "#1a1c1f",
    opaqueWindows: false,
    semanticColors: { diffAdded: "#00a240", diffRemoved: "#ba2623", skill: "#924ff7" },
    surface: "#ffffff",
  },
};

export const opencraftCanvasThemePalette: Record<OpenCraftThemeMode, OpenCraftThemeDefinition> = {
  dark: {
    accent: "#7698ff",
    contrast: 54,
    fonts: { code: null, ui: null },
    ink: "#f2f2f2",
    opaqueWindows: true,
    shellMaterial: {
      mainSurfaceElevation: "-0.5px 0 0 rgb(255 255 255 / 7%)",
      sidebarBackground: "#171717",
      sidebarFilter: "none",
      windowHighlight: "none",
      windowMaterial: "#171717",
    },
    semanticColors: { diffAdded: "#40c977", diffRemoved: "#fa625e", skill: "#b693ef" },
    surface: "#171717",
  },
  light: {
    accent: "#285dff",
    contrast: 42,
    fonts: { code: null, ui: null },
    ink: "#171717",
    opaqueWindows: true,
    shellMaterial: {
      mainSurfaceElevation: "-0.5px 0 0 rgb(0 0 0 / 5%)",
      sidebarBackground: "#ffffff",
      sidebarFilter: "none",
      windowHighlight: "none",
      windowMaterial: "#ffffff",
    },
    semanticColors: { diffAdded: "#07c160", diffRemoved: "#cf3d4c", skill: "#7b61ff" },
    surface: "#ffffff",
  },
};

/**
 * Frost owns its material constants. The 35% Sidebar alpha is intentionally
 * independent of the neutral theme material.
 */
export const frostThemePalette: Record<OpenCraftThemeMode, OpenCraftThemeDefinition> = {
  dark: {
    accent: "#66a9ff",
    contrast: 56,
    fonts: { code: null, ui: null },
    ink: "#eef8fb",
    opaqueWindows: false,
    shellMaterial: {
      mainSurfaceElevation: "var(--elevation-prominent)",
      sidebarBackground: "rgb(20 37 46 / 35%)",
      sidebarFilter: "blur(28px) saturate(145%)",
      windowHighlight: "none",
      windowMaterial: "#10191e",
    },
    semanticColors: { diffAdded: "#53c987", diffRemoved: "#ff7b75", skill: "#bca0f5" },
    surface: "#152129",
  },
  light: {
    accent: "#287ee8",
    contrast: 43,
    fonts: { code: null, ui: null },
    ink: "#182126",
    opaqueWindows: false,
    shellMaterial: {
      mainSurfaceElevation: "var(--elevation-prominent)",
      sidebarBackground: "rgb(226 244 250 / 35%)",
      sidebarFilter: "blur(28px) saturate(145%)",
      windowHighlight: "none",
      windowMaterial: "#f4f8fa",
    },
    semanticColors: { diffAdded: "#13834d", diffRemoved: "#c73d3a", skill: "#7956c8" },
    surface: "#ffffff",
  },
};

/** Cool blue glass, with a soft edge between navigation and the reading surface. */
export const longingThemePalette: Record<OpenCraftThemeMode, OpenCraftThemeDefinition> = {
  light: {
    accent: "#2279d5",
    contrast: 45,
    fonts: { code: null, ui: null },
    ink: "#182c43",
    opaqueWindows: false,
    surface: "#f5f9ff",
    surfaces: { window: "#e8f2ff", panel: "#f8fbff", input: "#f0f6ff" },
    shellMaterial: {
      unifiedSurfaceElevation: "var(--opencraft-main-surface-elevation)",
      sidebarContextBackground: "transparent",
      sidebarHeadingBackground: "transparent",
      contentCornerRadius: "var(--radius-xl)",
      recessedHeaderBackground: "var(--opencraft-sidebar-material-background)",
      mainSurfaceElevation: "var(--elevation-prominent-diffuse)",
      sidebarBackground: "rgb(207 228 255 / 42%)",
      sidebarFilter: "blur(28px) saturate(140%)",
      windowHighlight: "radial-gradient(ellipse at 8% 0%, rgb(255 255 255 / 60%), transparent 65%)",
      windowMaterial: "#e8f2ff",
    },
    semanticColors: {
      diffAdded: "#1b8053", diffRemoved: "#c23e50", skill: "#7760c5",
      warning: "#946019", error: "#b63145", success: "#23764f",
    },
  },
  dark: {
    accent: "#77b9ff",
    contrast: 57,
    fonts: { code: null, ui: null },
    ink: "#edf5ff",
    opaqueWindows: false,
    surface: "#132238",
    surfaces: { window: "#0c192c", panel: "#192c45", input: "#1e334f" },
    shellMaterial: {
      unifiedSurfaceElevation: "var(--opencraft-main-surface-elevation)",
      sidebarContextBackground: "transparent",
      sidebarHeadingBackground: "transparent",
      contentCornerRadius: "var(--radius-xl)",
      recessedHeaderBackground: "var(--opencraft-sidebar-material-background)",
      mainSurfaceElevation: "var(--elevation-prominent-diffuse)",
      sidebarBackground: "rgb(27 56 91 / 42%)",
      sidebarFilter: "blur(28px) saturate(140%)",
      windowHighlight: "radial-gradient(ellipse at 8% 0%, rgb(93 164 255 / 10%), transparent 65%)",
      windowMaterial: "#0c192c",
    },
    semanticColors: {
      diffAdded: "#65c99b", diffRemoved: "#ff8996", skill: "#c4afff",
      warning: "#eec080", error: "#ff9eac", success: "#8bdcb5",
    },
  },
};

/**
 * A restrained lavender language projected through the shared
 * Workbench theme contract. The palette changes color and material only;
 * typography, density and geometry remain owned by the Design System.
 */
export const lavenderThemePalette: Record<OpenCraftThemeMode, OpenCraftThemeDefinition> = {
  dark: {
    accent: "#b09afc",
    contrast: 56,
    fonts: { code: null, ui: null },
    ink: "#f1edf8",
    opaqueWindows: true,
    material: { window: "opaque", elevation: "soft" },
    surfaces: {
      window: "#17141f",
      sidebar: "#1d1828",
      panel: "#221d2e",
      input: "#2a2338",
      popover: "#2d263b",
    },
    semanticColors: {
      diffAdded: "#61c58a",
      diffRemoved: "#ff817b",
      skill: "#c2adff",
      warning: "#f4b36e",
      error: "#ff9993",
      success: "#8bd9a9",
    },
    surface: "#17141f",
  },
  light: {
    accent: "#6d5ce7",
    contrast: 44,
    fonts: { code: null, ui: null },
    ink: "#211d2b",
    opaqueWindows: true,
    material: { window: "opaque", elevation: "soft" },
    surfaces: {
      window: "#f8f6ff",
      sidebar: "#f1ecff",
      panel: "#ffffff",
      input: "#f7f4ff",
      popover: "#ffffff",
    },
    semanticColors: {
      diffAdded: "#18844e",
      diffRemoved: "#c6404c",
      skill: "#8063dc",
      warning: "#995d16",
      error: "#b82f3d",
      success: "#247648",
    },
    surface: "#f8f6ff",
  },
};

/** Close neutral surfaces keep navigation and conversation on one quiet canvas. */
export const mistThemePalette: Record<OpenCraftThemeMode, OpenCraftThemeDefinition> = {
  light: {
    accent: "#7062cc",
    contrast: 44,
    fonts: { code: null, ui: null },
    ink: "#25272d",
    surface: "#fbfcfd",
    opaqueWindows: true,
    material: { window: "opaque", elevation: "flat" },
    surfaces: {
      window: "#fbfcfd", sidebar: "#f6f7f9", panel: "#fbfcfd",
      input: "#ffffff", popover: "#ffffff",
    },
    semanticColors: {
      diffAdded: "#21834f", diffRemoved: "#c34250", skill: "#7062cc",
      warning: "#946014", error: "#ba3545", success: "#24794b",
    },
  },
  dark: {
    accent: "#afa1f1",
    contrast: 55,
    fonts: { code: null, ui: null },
    ink: "#eceef2",
    surface: "#1d1f24",
    opaqueWindows: true,
    material: { window: "opaque", elevation: "flat" },
    surfaces: {
      window: "#1d1f24", sidebar: "#191b20", panel: "#1d1f24",
      input: "#272930", popover: "#2b2d35",
    },
    semanticColors: {
      diffAdded: "#66c58c", diffRemoved: "#f7808c", skill: "#afa1f1",
      warning: "#e4b66f", error: "#ff9ba6", success: "#8bd5a9",
    },
  },
};

/** Opaque grayscale surfaces with a flat, layered hierarchy. */
export const graphiteThemePalette: Record<OpenCraftThemeMode, OpenCraftThemeDefinition> = {
  light: {
    accent: "#0b7fff",
    contrast: 45,
    fonts: { code: null, ui: null },
    ink: "#262626",
    surface: "#f8f8f8",
    opaqueWindows: true,
    material: { window: "opaque", elevation: "flat" },
    surfaces: {
      window: "#f8f8f8", sidebar: "#f0f0f0", panel: "#ffffff",
      input: "#ffffff", popover: "#ffffff",
    },
    semanticColors: {
      diffAdded: "#1e8a3e", diffRemoved: "#e03131", skill: "#7956b8",
      warning: "#995200", error: "#b42318", success: "#1e783a",
    },
  },
  dark: {
    accent: "#4099ff",
    contrast: 55,
    fonts: { code: null, ui: null },
    ink: "#d4d4d4",
    surface: "#161616",
    opaqueWindows: true,
    material: { window: "opaque", elevation: "flat" },
    surfaces: {
      window: "#161616", sidebar: "#161616", panel: "#202020",
      input: "#2b2b2b", popover: "#2b2b2b",
    },
    semanticColors: {
      diffAdded: "#46bf72", diffRemoved: "#ff5c5c", skill: "#b69bf2",
      warning: "#ffb26b", error: "#ff9999", success: "#87d9a4",
    },
  },
};

const black: RgbColor = { red: 0, green: 0, blue: 0 };
const white: RgbColor = { red: 255, green: 255, blue: 255 };
const relativeLuminanceThreshold = 0.179;
const defaultContrast = { dark: 60, light: 45 } as const;

function hexToRgb(hex: string): RgbColor {
  const value = hex.slice(1);
  return {
    red: Number.parseInt(value.slice(0, 2), 16),
    green: Number.parseInt(value.slice(2, 4), 16),
    blue: Number.parseInt(value.slice(4, 6), 16),
  };
}

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function rgbToHex(color: RgbColor): string {
  return `#${byteToHex(color.red)}${byteToHex(color.green)}${byteToHex(color.blue)}`;
}

function rgbString(color: RgbColor): string {
  return `rgb(${color.red}, ${color.green}, ${color.blue})`;
}

function formatOpacity(value: number): string {
  return Math.min(1, Math.max(0, value)).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function rgba(color: RgbColor, opacity: number): string {
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${formatOpacity(opacity)})`;
}

function interpolateColor(from: RgbColor, to: RgbColor, ratio: number): RgbColor {
  const progress = Math.min(1, Math.max(0, ratio));
  const lerp = (fromValue: number, toValue: number) => Math.round(fromValue + (toValue - fromValue) * progress);
  return { red: lerp(from.red, to.red), green: lerp(from.green, to.green), blue: lerp(from.blue, to.blue) };
}

function mix(from: RgbColor, to: RgbColor, ratio: number): string {
  return rgbToHex(interpolateColor(from, to, ratio));
}

function srgbToLinear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: RgbColor): number {
  return srgbToLinear(color.red) * 0.2126 + srgbToLinear(color.green) * 0.7152 + srgbToLinear(color.blue) * 0.0722;
}

function textOnAccent(color: RgbColor): RgbColor {
  if (color.blue > color.red && color.blue > color.green) {
    const saturation = color.blue - Math.min(color.red, color.green);
    const hue = ((color.red - color.green) / saturation + 4) * 60;
    const saturationRatio = saturation / color.blue;
    if (
      (saturationRatio >= 0.8 && hue >= 205 && hue <= 212) ||
      (saturationRatio >= 0.6 && hue >= 218 && hue <= 233 && relativeLuminance(color) <= 0.21)
    ) return white;
  }
  return relativeLuminance(color) > relativeLuminanceThreshold ? black : white;
}

function tieredContrast(contrast: number, mode: OpenCraftThemeMode): number {
  const threshold = defaultContrast[mode];
  const normalizedThreshold = threshold / 100;
  const interpolated = contrast / 100 + ((contrast - threshold) / 60) * 0.7;
  return contrast <= threshold ? interpolated : normalizedThreshold + (interpolated - normalizedThreshold) * 2;
}

interface ThemeVariant {
  theme: OpenCraftThemeDefinition;
  variant: OpenCraftThemeMode;
  accent: RgbColor;
  contrast: number;
  editorBackground: RgbColor;
  ink: RgbColor;
  surface: RgbColor;
  surfaceUnder: string;
}

function buildThemeVariant(theme: OpenCraftThemeDefinition, variant: OpenCraftThemeMode): ThemeVariant {
  const contrast = tieredContrast(theme.contrast, variant);
  const surface = hexToRgb(theme.surface);
  const ink = hexToRgb(theme.ink);
  const baseContrast = defaultContrast[variant];
  const underRatio = (variant === "light" ? 0.04 : 0.16) + (theme.contrast - baseContrast) * (variant === "light" ? 0.0012 : 0.0015);
  return {
    theme,
    variant,
    accent: hexToRgb(theme.accent),
    contrast,
    editorBackground: variant === "light" ? interpolateColor(surface, white, 0.12) : interpolateColor(surface, ink, 0.07),
    ink,
    surface,
    surfaceUnder: variant === "light" ? mix(surface, ink, underRatio) : mix(surface, black, underRatio),
  };
}

interface SemanticThemeColors {
  accentBackground: string;
  accentBackgroundActive: string;
  accentBackgroundHover: string;
  border: string;
  borderFocus: string;
  borderHeavy: string;
  borderLight: string;
  buttonPrimaryBackground: string;
  buttonPrimaryBackgroundActive: string;
  buttonPrimaryBackgroundHover: string;
  buttonPrimaryBackgroundInactive: string;
  buttonSecondaryBackground: string;
  buttonSecondaryBackgroundActive: string;
  buttonSecondaryBackgroundHover: string;
  buttonSecondaryBackgroundInactive: string;
  buttonTertiaryBackground: string;
  buttonTertiaryBackgroundActive: string;
  buttonTertiaryBackgroundHover: string;
  navigationBackgroundHover: string;
  navigationBackgroundCurrent: string;
  navigationBackgroundPressed: string;
  controlBackground: string;
  controlBackgroundOpaque: string;
  elevatedPrimary: string;
  elevatedPrimaryOpaque: string;
  elevatedSecondary: string;
  elevatedSecondaryOpaque: string;
  iconAccent: string;
  iconPrimary: string;
  iconSecondary: string;
  iconTertiary: string;
  simpleScrim: string;
  textAccent: string;
  textButtonPrimary: string;
  textButtonSecondary: string;
  textButtonTertiary: string;
  textForeground: string;
  textForegroundSecondary: string;
  textForegroundTertiary: string;
  textWorkingHighlight: string;
}

function lightSemanticColors(theme: ThemeVariant): SemanticThemeColors {
  const control = interpolateColor(theme.surface, white, 0.09 + theme.contrast * 0.04);
  const elevatedSecondary = interpolateColor(theme.surface, white, 0.08 + theme.contrast * 0.08);
  const elevatedPrimary = interpolateColor(theme.surface, white, 0.16 + theme.contrast * 0.12);
  const primaryHover = interpolateColor(theme.ink, theme.surface, 0.08 + theme.contrast * 0.025);
  const primaryActive = interpolateColor(theme.ink, theme.surface, 0.13 + theme.contrast * 0.035);
  return {
    accentBackground: mix(theme.surface, theme.accent, 0.11 + theme.contrast * 0.04),
    accentBackgroundActive: mix(theme.surface, theme.accent, 0.13 + theme.contrast * 0.05),
    accentBackgroundHover: mix(theme.surface, theme.accent, 0.12 + theme.contrast * 0.045),
    border: rgba(theme.ink, 0.06 + theme.contrast * 0.04),
    // Keyboard location is not a brand/accent state.
    borderFocus: rgba(black, 0.55 + theme.contrast * 0.1),
    borderHeavy: rgba(theme.ink, 0.09 + theme.contrast * 0.06),
    borderLight: rgba(theme.ink, 0.04 + theme.contrast * 0.02),
    buttonPrimaryBackground: theme.theme.ink,
    // Primary controls own an opaque polarity-inverted surface. An alpha-only
    // hover token changes meaning with the surface behind it and turns an
    // enabled send button almost white on the light Composer.
    buttonPrimaryBackgroundActive: rgbString(primaryActive),
    buttonPrimaryBackgroundHover: rgbString(primaryHover),
    buttonPrimaryBackgroundInactive: rgba(theme.ink, 0.18 + theme.contrast * 0.14),
    buttonSecondaryBackground: rgba(theme.ink, 0.04 + theme.contrast * 0.02),
    buttonSecondaryBackgroundActive: rgba(theme.ink, 0.03 + theme.contrast * 0.02),
    buttonSecondaryBackgroundHover: rgba(theme.ink, 0.04 + theme.contrast * 0.03),
    buttonSecondaryBackgroundInactive: rgba(theme.ink, 0.01 + theme.contrast * 0.02),
    buttonTertiaryBackground: rgba(theme.ink, 0),
    buttonTertiaryBackgroundActive: rgba(theme.ink, 0.16 + theme.contrast * 0.08),
    buttonTertiaryBackgroundHover: rgba(theme.ink, 0.08 + theme.contrast * 0.04),
    navigationBackgroundHover: rgba(theme.ink, 0.05 + theme.contrast * 0.03),
    navigationBackgroundCurrent: rgba(theme.ink, 0.09 + theme.contrast * 0.04),
    navigationBackgroundPressed: rgba(theme.ink, 0.13 + theme.contrast * 0.06),
    controlBackground: rgba(control, 0.96),
    controlBackgroundOpaque: rgbString(control),
    elevatedPrimary: rgba(elevatedPrimary, 0.96),
    elevatedPrimaryOpaque: rgbString(elevatedPrimary),
    elevatedSecondary: rgba(elevatedSecondary, 0.96),
    elevatedSecondaryOpaque: rgbString(elevatedSecondary),
    iconAccent: theme.theme.accent,
    iconPrimary: theme.theme.ink,
    iconSecondary: rgba(theme.ink, 0.65 + theme.contrast * 0.1),
    iconTertiary: rgba(theme.ink, 0.45 + theme.contrast * 0.1),
    simpleScrim: rgba(black, 0.08 + theme.contrast * 0.04),
    textAccent: theme.theme.accent,
    textButtonPrimary: theme.theme.surface,
    textButtonSecondary: theme.theme.ink,
    textButtonTertiary: rgba(theme.ink, 0.45 + theme.contrast * 0.1),
    textForeground: theme.theme.ink,
    textForegroundSecondary: rgba(theme.ink, 0.65 + theme.contrast * 0.1),
    textForegroundTertiary: rgba(theme.ink, 0.45 + theme.contrast * 0.1),
    textWorkingHighlight: theme.theme.ink,
  };
}

function darkSemanticColors(theme: ThemeVariant): SemanticThemeColors {
  const control = interpolateColor(theme.surface, theme.ink, 0.06 + theme.contrast * 0.05);
  const accentText = interpolateColor(theme.accent, white, 0.3 + theme.contrast * 0.15);
  const primaryHover = interpolateColor(theme.ink, theme.surface, 0.08 + theme.contrast * 0.025);
  const primaryActive = interpolateColor(theme.ink, theme.surface, 0.13 + theme.contrast * 0.035);
  const elevated = interpolateColor(theme.surface, theme.ink, 0.08 + theme.contrast * 0.08);
  return {
    accentBackground: mix(black, theme.accent, 0.2 + theme.contrast * 0.08),
    accentBackgroundActive: mix(black, theme.accent, 0.22 + theme.contrast * 0.12),
    accentBackgroundHover: mix(black, theme.accent, 0.21 + theme.contrast * 0.1),
    border: rgba(theme.ink, 0.06 + theme.contrast * 0.04),
    borderFocus: rgba(white, 0.65 + theme.contrast * 0.1),
    borderHeavy: rgba(theme.ink, 0.12 + theme.contrast * 0.06),
    borderLight: rgba(theme.ink, 0.03 + theme.contrast * 0.02),
    // Primary actions stay polarity-inverted in dark mode: bright control,
    // dark glyph. Deriving both roles from `primary` made the foreground and
    // background identical, which erased the Composer send arrow.
    buttonPrimaryBackground: theme.theme.ink,
    buttonPrimaryBackgroundActive: rgbString(primaryActive),
    buttonPrimaryBackgroundHover: rgbString(primaryHover),
    buttonPrimaryBackgroundInactive: rgba(theme.ink, 0.02 + theme.contrast * 0.02),
    buttonSecondaryBackground: rgba(theme.ink, 0.04 + theme.contrast * 0.02),
    buttonSecondaryBackgroundActive: rgba(theme.ink, 0.09 + theme.contrast * 0.05),
    buttonSecondaryBackgroundHover: rgba(theme.ink, 0.06 + theme.contrast * 0.03),
    buttonSecondaryBackgroundInactive: rgba(theme.ink, 0.02 + theme.contrast * 0.03),
    buttonTertiaryBackground: rgba(theme.ink, 0.02 + theme.contrast * 0.015),
    buttonTertiaryBackgroundActive: rgba(theme.ink, 0.07 + theme.contrast * 0.05),
    buttonTertiaryBackgroundHover: rgba(theme.ink, 0.05 + theme.contrast * 0.03),
    navigationBackgroundHover: rgba(theme.ink, 0.05 + theme.contrast * 0.025),
    navigationBackgroundCurrent: rgba(theme.ink, 0.09 + theme.contrast * 0.04),
    navigationBackgroundPressed: rgba(theme.ink, 0.13 + theme.contrast * 0.05),
    controlBackground: rgba(control, 0.96),
    controlBackgroundOpaque: rgbString(control),
    elevatedPrimary: rgba(elevated, 0.96),
    elevatedPrimaryOpaque: rgbString(elevated),
    elevatedSecondary: rgba(theme.ink, 0.02 + theme.contrast * 0.02),
    elevatedSecondaryOpaque: mix(theme.surface, theme.ink, 0.04 + theme.contrast * 0.05),
    iconAccent: rgbString(accentText),
    iconPrimary: rgba(theme.ink, 0.82 + theme.contrast * 0.14),
    iconSecondary: rgba(theme.ink, 0.65 + theme.contrast * 0.1),
    iconTertiary: rgba(theme.ink, 0.45 + theme.contrast * 0.1),
    simpleScrim: rgba(theme.ink, 0.08 + theme.contrast * 0.04),
    textAccent: rgbString(accentText),
    textButtonPrimary: theme.theme.surface,
    textButtonSecondary: mix(theme.ink, theme.surface, 0.7 + theme.contrast * 0.1),
    textButtonTertiary: rgba(theme.ink, 0.45 + theme.contrast * 0.1),
    textForeground:
      theme.theme.ink === opencraftNeutralThemePalette.dark.ink && theme.theme.surface === opencraftNeutralThemePalette.dark.surface
        ? "var(--gray-150)"
        : theme.theme.ink,
    textForegroundSecondary: rgba(theme.ink, 0.65 + theme.contrast * 0.1),
    textForegroundTertiary: rgba(theme.ink, 0.42 + theme.contrast * 0.13),
    textWorkingHighlight: theme.theme.ink,
  };
}

// Informational badges keep stable hue identities, independent of brand accent.
// Resolve opaque pairs together so extension surfaces cannot erase the label.
function badgeColors(mode: OpenCraftThemeMode, surface: string): ThemeCssProperties {
  const foregrounds = mode === "light"
    ? { blue: "#175cd3", cyan: "#0e6e7c", red: "#b42318", indigo: "#493bc0", green: "#17603b", purple: "#7541b4", orange: "#984a08", neutral: "#515968" }
    : { blue: "#84caff", cyan: "#67e3f9", red: "#fda29b", indigo: "#bdb4fe", green: "#75e0a7", purple: "#d6bbfb", orange: "#fec084", neutral: "#c9cdd4" };
  const properties: ThemeCssProperties = {};
  for (const [tone, value] of Object.entries(foregrounds)) {
    const original = hexToRgb(value);
    const background = interpolateColor(hexToRgb(surface), original, mode === "light" ? 0.09 : 0.18);
    const backgroundLuminance = relativeLuminance(background);
    const endpoint = backgroundLuminance > 0.179 ? black : white;
    let foreground = original;
    for (let step = 1; step <= 20; step++) {
      const luminance = relativeLuminance(foreground);
      const contrast = (Math.max(luminance, backgroundLuminance) + 0.05) / (Math.min(luminance, backgroundLuminance) + 0.05);
      if (contrast >= 4.5) break;
      foreground = interpolateColor(original, endpoint, step / 20);
    }
    properties[`--color-badge-${tone}-foreground`] = rgbToHex(foreground);
    properties[`--color-badge-${tone}-background`] = rgbToHex(background);
  }
  return properties;
}

export function buildOpenCraftThemeCssProperties(
  mode: OpenCraftThemeMode,
  definition: OpenCraftThemeDefinition = opencraftNeutralThemePalette[mode],
): ThemeCssProperties {
  validateThemeOptions(definition.surfaces, definition.material);
  const theme = buildThemeVariant(definition, mode);
  const semantic = mode === "light" ? lightSemanticColors(theme) : darkSemanticColors(theme);
  const applicationMenu = interpolateColor(theme.surface, theme.ink, 0.02 + theme.contrast * 0.02);
  const panelBase = mode === "light" ? white : theme.ink;
  const panelOpacity = (mode === "light" ? 0.18 : 0.03) + theme.contrast * (mode === "light" ? 0.008 : 0.03);
  // Color-only themes belong to the Client family by default. A theme opts
  // out only when its product surface has a genuinely different host model.
  const surfaces = definition.surfaces ?? {};
  const opaque = definition.material?.window === undefined ? definition.opaqueWindows : definition.material.window === "opaque";
  const shell = { ...(definition.shellMaterial ?? clientShellMaterial) };
  if (definition.material?.window !== undefined || (opaque && !definition.shellMaterial)) {
    shell.sidebarFilter = opaque ? "none" : clientShellMaterial.sidebarFilter;
    shell.windowHighlight = opaque ? "none" : clientShellMaterial.windowHighlight;
    shell.sidebarBackground = opaque ? definition.surface : clientShellMaterial.sidebarBackground;
    shell.windowMaterial = opaque ? definition.surface : clientShellMaterial.windowMaterial;
  }
  if (surfaces.window) shell.windowMaterial = surfaces.window;
  if (surfaces.sidebar) shell.sidebarBackground = surfaces.sidebar;
  if (definition.material?.elevation === "flat") shell.mainSurfaceElevation = "none";
  if (definition.material?.elevation === "soft") shell.mainSurfaceElevation = clientShellMaterial.mainSurfaceElevation;

  return {
    ...badgeColors(mode, definition.surfaces?.panel ?? definition.surface),
    // Floating surfaces are neutral by default. An explicit popover surface is
    // authoritative and remains opaque instead of being silently diluted.
    "--material-glass-base": surfaces.popover ?? (mode === "light" ? "#ffffff" : "#181818"),
    "--material-glass-floating": surfaces.popover ?? "color-mix(in srgb, var(--material-glass-base) 32%, transparent)",
    "--material-glass-panel": surfaces.popover ?? `color-mix(in srgb, var(--material-glass-base) ${mode === "light" ? 64 : 62}%, transparent)`,
    "--material-glass-menu": surfaces.popover ?? "color-mix(in srgb, var(--material-glass-base) 82%, transparent)",
    "--material-glass-filter": "blur(32px) saturate(1.06)",
    "--material-glass-shadow": mode === "light"
      ? "0 24px 80px rgb(0 0 0 / 15%), inset 0 1px rgb(255 255 255 / 40%)"
      : "0 28px 90px rgb(0 0 0 / 40%), inset 0 1px rgb(255 255 255 / 9%)",
    "--opencraft-base-accent": definition.accent,
    "--opencraft-base-contrast": String(definition.contrast),
    "--opencraft-base-ink": definition.ink,
    "--opencraft-base-surface": definition.surface,
    "--opencraft-main-surface-elevation": shell.mainSurfaceElevation,
    "--opencraft-unified-surface-elevation": definition.shellMaterial?.unifiedSurfaceElevation ?? "none",
    "--opencraft-unified-frame-elevation": definition.shellMaterial?.recessedHeaderBackground ? "none" : definition.shellMaterial?.unifiedSurfaceElevation ?? "none",
    "--opencraft-unified-content-elevation": definition.shellMaterial?.recessedHeaderBackground ? definition.shellMaterial?.unifiedSurfaceElevation ?? "none" : "none",
    "--opencraft-panel-chassis-background": definition.shellMaterial?.recessedHeaderBackground ? "transparent" : "var(--color-background-surface)",
    "--opencraft-panel-toolbar-background": definition.shellMaterial?.recessedHeaderBackground ? "transparent" : "var(--color-background-elevated-secondary)",
    "--opencraft-panel-divider-top": definition.shellMaterial?.recessedHeaderBackground ? "var(--height-toolbar)" : "0px",
    "--opencraft-panel-divider-clip": definition.shellMaterial?.recessedHeaderBackground ? "inset(0 -100% -100% -100%)" : "none",
    "--opencraft-sidebar-heading-background": definition.shellMaterial?.sidebarHeadingBackground ?? "initial",
    "--opencraft-content-corner-radius": definition.shellMaterial?.contentCornerRadius ?? "0px",
    "--opencraft-sidebar-context-background": definition.shellMaterial?.sidebarContextBackground ?? "var(--color-surface)",
    // Recessed chrome has one paint owner. Repainting the same translucent
    // blue over Sidecar makes a darker brand tile even with identical tokens.
    "--opencraft-shell-material-paint": definition.shellMaterial?.recessedHeaderBackground
      ? `linear-gradient(${definition.shellMaterial.recessedHeaderBackground}, ${definition.shellMaterial.recessedHeaderBackground}), ${shell.windowHighlight}`
      : shell.windowHighlight,
    "--opencraft-sidecar-background": definition.shellMaterial?.recessedHeaderBackground ? "transparent" : "var(--opencraft-sidebar-material-background)",
    "--opencraft-sidecar-filter": definition.shellMaterial?.recessedHeaderBackground ? "none" : "var(--opencraft-sidebar-material-filter)",
    "--opencraft-header-surface-paint": definition.shellMaterial?.recessedHeaderBackground
      ? "none"
      : "linear-gradient(to top, var(--color-border-subtle) 1px, var(--color-surface) 1px)",
    "--opencraft-header-divider-color": definition.shellMaterial?.recessedHeaderBackground ? "transparent" : "var(--color-border-subtle)",
    "--opencraft-thread-edge-divider-color": definition.shellMaterial?.recessedHeaderBackground ? "transparent" : "var(--color-border-strong)",
    "--opencraft-header-content-elevation": definition.shellMaterial?.recessedHeaderBackground ? shell.mainSurfaceElevation : "none",
    "--opencraft-sidebar-material-background": shell.sidebarBackground,
    "--opencraft-sidebar-material-filter": shell.sidebarFilter,
    "--opencraft-window-highlight": shell.windowHighlight,
    "--opencraft-window-material": shell.windowMaterial,
    "--color-accent-blue": definition.accent,
    "--color-accent-purple": definition.semanticColors.skill,
    "--color-background-accent": semantic.accentBackground,
    "--color-background-accent-active": semantic.accentBackgroundActive,
    "--color-background-accent-hover": semantic.accentBackgroundHover,
    "--color-background-application-menu": rgbToHex(applicationMenu),
    "--color-background-button-primary": semantic.buttonPrimaryBackground,
    "--color-background-button-primary-active": semantic.buttonPrimaryBackgroundActive,
    "--color-background-button-primary-hover": semantic.buttonPrimaryBackgroundHover,
    "--color-background-button-primary-inactive": semantic.buttonPrimaryBackgroundInactive,
    "--color-background-button-secondary": semantic.buttonSecondaryBackground,
    "--color-background-button-secondary-active": semantic.buttonSecondaryBackgroundActive,
    "--color-background-button-secondary-hover": semantic.buttonSecondaryBackgroundHover,
    "--color-background-button-secondary-inactive": semantic.buttonSecondaryBackgroundInactive,
    // Navigation location is a persistent route state, not a button hover.
    // Expose an explicit state family so every shell can share the semantic
    // contract without copying button implementation tokens into feature CSS.
    "--color-background-navigation-hover": semantic.navigationBackgroundHover,
    "--color-background-navigation-current": semantic.navigationBackgroundCurrent,
    "--color-background-navigation-pressed": semantic.navigationBackgroundPressed,
    // Menu/list rows consume the shared, theme-derived primary ghost state.
    "--color-background-primary-ghost-hover": semantic.buttonSecondaryBackgroundHover,
    "--color-background-button-tertiary": semantic.buttonTertiaryBackground,
    "--color-background-button-tertiary-active": semantic.buttonTertiaryBackgroundActive,
    "--color-background-button-tertiary-hover": semantic.buttonTertiaryBackgroundHover,
    "--color-background-input": surfaces.input ?? semantic.elevatedSecondaryOpaque,
    "--color-background-control": surfaces.input ?? semantic.controlBackground,
    "--color-background-control-opaque": surfaces.input ?? semantic.controlBackgroundOpaque,
    "--color-background-editor-opaque": rgbString(theme.editorBackground),
    // Precompose the translucent surface over the editor so transcript glyphs cannot bleed through.
    "--color-background-composer-rail-opaque": `color-mix(in srgb, ${surfaces.input ?? semantic.elevatedSecondaryOpaque} 70%, ${rgbString(theme.editorBackground)})`,
    "--color-background-composer-rail": `color-mix(in srgb, ${surfaces.input ?? semantic.elevatedSecondaryOpaque} 94%, transparent)`,
    "--color-border-composer-rail": `color-mix(in srgb, ${semantic.border} 80%, transparent)`,
    "--color-background-elevated-primary": surfaces.popover ?? semantic.elevatedPrimary,
    "--color-background-elevated-primary-opaque": surfaces.popover ?? semantic.elevatedPrimaryOpaque,
    "--color-background-elevated-secondary": semantic.elevatedSecondary,
    "--color-background-elevated-secondary-opaque": semantic.elevatedSecondaryOpaque,
    "--color-background-panel": surfaces.panel ?? mix(theme.surface, panelBase, panelOpacity),
    "--color-background-surface": definition.surface,
    "--color-background-surface-under": theme.surfaceUnder,
    "--color-border": semantic.border,
    "--color-border-focus": semantic.borderFocus,
    "--color-focus-ring": semantic.borderFocus,
    "--focus-ring": semantic.borderFocus,
    "--color-border-heavy": semantic.borderHeavy,
    "--color-border-light": semantic.borderLight,
    "--color-decoration-added": definition.semanticColors.diffAdded,
    "--color-decoration-deleted": definition.semanticColors.diffRemoved,
    "--color-icon-accent": semantic.iconAccent,
    "--color-icon-primary": semantic.iconPrimary,
    "--color-icon-secondary": semantic.iconSecondary,
    "--color-icon-tertiary": semantic.iconTertiary,
    "--color-simple-scrim": semantic.simpleScrim,
    "--color-text-accent": semantic.textAccent,
    "--color-text-on-accent": rgbString(textOnAccent(theme.accent)),
    "--color-text-button-primary": semantic.textButtonPrimary,
    "--color-text-button-secondary": semantic.textButtonSecondary,
    "--color-text-button-tertiary": semantic.textButtonTertiary,
    "--color-text-foreground": semantic.textForeground,
    "--color-text-foreground-secondary": semantic.textForegroundSecondary,
    "--color-text-foreground-tertiary": semantic.textForegroundTertiary,
    "--color-text-working-highlight": semantic.textWorkingHighlight,
    "--color-surface": definition.surface,
    "--color-surface-secondary": semantic.elevatedSecondaryOpaque,
    // This token uses the editor surface. The Electron shell mixes it
    // with transparency for the native, immersive left-panel material.
    "--color-surface-tertiary": rgbString(theme.editorBackground),
    "--color-border-subtle": semantic.borderLight,
    "--color-border-default": semantic.border,
    "--color-border-strong": semantic.borderHeavy,
    "--color-text": semantic.textForeground,
    "--color-text-secondary": semantic.textForegroundSecondary,
    "--color-text-tertiary": semantic.textForegroundTertiary,
    "--color-text-warning": definition.semanticColors.warning ?? (mode === "light" ? "#a84808" : "#ffb579"),
    "--color-text-danger": definition.semanticColors.error ?? (mode === "light" ? "#b42318" : "#ff8f87"),
    "--color-status-success": definition.semanticColors.success ?? (mode === "light" ? "#18743b" : "#79d99b"),
    "--color-usage-track": mix(theme.surface, theme.ink, .09),
    "--color-dialog-scrim": mode === "light" ? "rgb(0 0 0 / 18%)" : "rgb(0 0 0 / 35%)",
    "--elevation-dialog-utility": mode === "light" ? "0 12px 40px rgb(0 0 0 / 16%)" : "0 12px 40px rgb(0 0 0 / 40%)",
  };
}
