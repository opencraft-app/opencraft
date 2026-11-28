// Generated from @opencraft/design-system/theme-engine via scripts/sync-tokens.mjs.
import { systemFont, systemMediumFont, systemSemiboldFont } from "valdi_core/src/SystemFont";

export const lightColors = {
  canvas: "#f7f7f7",
  surface: "#ffffff",
  recessed: "#f3f3f3",
  border: "rgba(48, 48, 48, 0.078)",
  ink: "#303030",
  muted: "rgba(48, 48, 48, 0.695)",
  disabled: "rgba(48, 48, 48, 0.495)",
  accent: "#006acb",
  accentForeground: "rgb(255, 255, 255)",
  accentSoft: "#deecf8",
  primaryButton: "#303030",
  primaryButtonForeground: "#ffffff",
  toggleOn: "#006acb",
  toggleThumb: "#ffffff",
  segmentThumb: "#ffffff",
  navCurrent: "rgba(48, 48, 48, 0.108)",
  info: "#175cd3",
  infoSurface: "#eaf0fb",
  success: "#23764f",
  successSurface: "#eaf1ed",
  warning: "#946019",
  warningSurface: "#f6efe9",
  danger: "#b63145",
  dangerSurface: "#f8ebea",
  skill: "#7760c5",
  skillSurface: "#f3eef8",
  trackOff: "rgba(48, 48, 48, 0.14)",
  trackSoft: "rgba(48, 48, 48, 0.049)",
  trackSubtle: "rgba(48, 48, 48, 0.064)",
  glassTint: "rgba(255, 255, 255, 0.78)",
  glassBorder: "rgba(48, 48, 48, 0.08)",
  overlay: "rgba(0, 0, 0, 0.20)",
  alert: "rgba(255, 255, 255, 0.95)",
};

export type ColorTokens = typeof lightColors;

export const darkColors: ColorTokens = {
  canvas: "#181818",
  surface: "#242424",
  recessed: "#2b2b2b",
  border: "rgba(237, 237, 237, 0.081)",
  ink: "#ededed",
  muted: "rgba(237, 237, 237, 0.704)",
  disabled: "rgba(237, 237, 237, 0.49)",
  accent: "#70b2f2",
  accentForeground: "rgb(0, 0, 0)",
  accentSoft: "#1b2b3b",
  primaryButton: "#ededed",
  primaryButtonForeground: "#202020",
  toggleOn: "#70b2f2",
  toggleThumb: "#ffffff",
  segmentThumb: "rgba(237, 237, 237, 0.13)",
  navCurrent: "rgba(237, 237, 237, 0.111)",
  info: "#84caff",
  infoSurface: "#35424b",
  success: "#8bdcb5",
  successSurface: "#33463c",
  warning: "#eec080",
  warningSurface: "#4b4035",
  danger: "#ff9eac",
  dangerSurface: "#4b3b39",
  skill: "#c4afff",
  skillSurface: "#443f4b",
  trackOff: "rgba(237, 237, 237, 0.20)",
  trackSoft: "rgba(237, 237, 237, 0.051)",
  trackSubtle: "rgba(237, 237, 237, 0.063)",
  glassTint: "rgba(36, 36, 36, 0.76)",
  glassBorder: "rgba(237, 237, 237, 0.10)",
  overlay: "rgba(0, 0, 0, 0.38)",
  alert: "rgba(36, 36, 36, 0.94)",
};

export const colors = lightColors;

let activeLightColors: ColorTokens = lightColors;
let activeDarkColors: ColorTokens = darkColors;
let activeTouchDensity = false;

export function setValdiThemeColors(mode: "light" | "dark", overrides?: Partial<ColorTokens> | null): void {
  if (mode === "dark") {
    activeDarkColors = overrides ? { ...darkColors, ...overrides } : darkColors;
  } else {
    activeLightColors = overrides ? { ...lightColors, ...overrides } : lightColors;
  }
}

export function setValdiTouchDensity(touch: boolean): void {
  activeTouchDensity = touch;
}

export function valdiTouch(explicit?: boolean): boolean {
  return explicit !== undefined ? explicit : activeTouchDensity;
}

export function themeColors(dark = false): ColorTokens {
  return dark ? activeDarkColors : activeLightColors;
}

export const desktopMetrics = {
  touch: false,
  radii: {
    card: 14,
    control: 8,
    segmentTrack: 9,
    segmentThumb: 7,
    modal: 14,
    iconBox: 8,
    pill: 999,
    group: 14,
    alert: 14,
  },
  sizes: {
    buttonHeight: 32,
    buttonSmHeight: 28,
    buttonPaddingX: 14,
    inputHeight: 34,
    segmentHeight: 28,
    segmentCompactHeight: 26,
    rowMinHeight: 52,
    rowPaddingX: 16,
    rowPaddingY: 12,
    switchWidth: 36,
    switchHeight: 20,
    switchThumb: 16,
    switchThumbPress: 19,
    switchHitWidth: 36,
    switchHitHeight: 24,
    dockHeight: 38,
    dockRadius: 9,
  },
  fonts: {
    pageTitle: systemSemiboldFont(20),
    pageSummary: systemFont(15),
    sectionTitle: systemSemiboldFont(14),
    rowTitle: systemMediumFont(14),
    body: systemFont(14),
    control: systemMediumFont(13),
    controlCompact: systemMediumFont(12.5),
    detail: systemFont(12),
    caption: systemFont(11.5),
  },
};

export type DensityMetrics = typeof desktopMetrics;

export const touchMetrics: DensityMetrics = {
  touch: true,
  radii: {
    card: 16,
    control: 10,
    segmentTrack: 10,
    segmentThumb: 8,
    modal: 18,
    iconBox: 9,
    pill: 999,
    group: 16,
    alert: 18,
  },
  sizes: {
    buttonHeight: 40,
    buttonSmHeight: 34,
    buttonPaddingX: 16,
    inputHeight: 40,
    segmentHeight: 36,
    segmentCompactHeight: 32,
    rowMinHeight: 56,
    rowPaddingX: 16,
    rowPaddingY: 13,
    switchWidth: 44,
    switchHeight: 26,
    switchThumb: 22,
    switchThumbPress: 25,
    switchHitWidth: 44,
    switchHitHeight: 44,
    dockHeight: 44,
    dockRadius: 11,
  },
  fonts: {
    pageTitle: systemSemiboldFont(22),
    pageSummary: systemFont(16),
    sectionTitle: systemSemiboldFont(14.5),
    rowTitle: systemMediumFont(15),
    body: systemFont(15),
    control: systemMediumFont(14),
    controlCompact: systemMediumFont(13),
    detail: systemFont(13),
    caption: systemFont(12),
  },
};

export function themeMetrics(touch?: boolean): DensityMetrics {
  return valdiTouch(touch) ? touchMetrics : desktopMetrics;
}

export const radii = { group: 14, control: 8, pill: 999, alert: 16 };

export const type = {
  body: systemFont(14),
  detail: systemFont(12),
  button: systemMediumFont(13),
  section: systemSemiboldFont(14),
  display: systemSemiboldFont(20),
};
