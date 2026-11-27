import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenCraftThemeCssProperties, porcelainThemePalette } from "../../design-system/src/theme-engine.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "src/tokens.ts");

function renderPalette(mode) {
  const isDark = mode === "dark";
  const def = porcelainThemePalette[mode];
  const css = buildOpenCraftThemeCssProperties(mode, def);
  return {
    canvas: def.surfaces?.window ?? css["--color-background-surface-under"],
    surface: def.surfaces?.panel ?? def.surface,
    recessed: def.surfaces?.input ?? css["--color-surface-secondary"],
    border: css["--color-border-default"],
    ink: def.ink,
    muted: css["--color-text-secondary"],
    disabled: css["--color-text-tertiary"],
    accent: def.accent,
    accentForeground: css["--color-text-on-accent"],
    accentSoft: css["--color-background-accent"],
    primaryButton: css["--color-background-button-primary"],
    primaryButtonForeground: css["--color-text-button-primary"],
    toggleOn: def.accent,
    toggleThumb: "#ffffff",
    segmentThumb: isDark ? "rgba(237, 237, 237, 0.13)" : "#ffffff",
    navCurrent: css["--color-background-navigation-current"],
    info: css["--color-badge-blue-foreground"],
    infoSurface: css["--color-badge-blue-background"],
    success: def.semanticColors.success ?? css["--color-status-success"],
    successSurface: css["--color-badge-green-background"],
    warning: def.semanticColors.warning ?? css["--color-text-warning"],
    warningSurface: css["--color-badge-orange-background"],
    danger: def.semanticColors.error ?? css["--color-text-danger"],
    dangerSurface: css["--color-badge-red-background"],
    skill: def.semanticColors.skill,
    skillSurface: css["--color-badge-purple-background"],
    trackOff: isDark ? "rgba(237, 237, 237, 0.20)" : "rgba(48, 48, 48, 0.14)",
    trackSoft: css["--color-background-button-secondary"],
    trackSubtle: css["--color-background-navigation-hover"],
    glassTint: isDark ? "rgba(36, 36, 36, 0.76)" : "rgba(255, 255, 255, 0.78)",
    glassBorder: isDark ? "rgba(237, 237, 237, 0.10)" : "rgba(48, 48, 48, 0.08)",
    overlay: isDark ? "rgba(0, 0, 0, 0.38)" : "rgba(0, 0, 0, 0.20)",
    alert: isDark ? "rgba(36, 36, 36, 0.94)" : "rgba(255, 255, 255, 0.95)",
  };
}

const light = renderPalette("light");
const dark = renderPalette("dark");

function formatObject(obj) {
  return (
    "{\n" +
    Object.entries(obj)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v).replaceAll('"', "'")},`)
      .join("\n") +
    "\n}"
  );
}

const expected = `// Generated from @opencraft/design-system/theme-engine via scripts/sync-tokens.mjs.
import { systemFont, systemMediumFont, systemSemiboldFont } from 'valdi_core/src/SystemFont';

export const lightColors = ${formatObject(light)};

export type ColorTokens = typeof lightColors;

export const darkColors: ColorTokens = ${formatObject(dark)};

export const colors = lightColors;

let activeLightColors: ColorTokens = lightColors;
let activeDarkColors: ColorTokens = darkColors;
let activeTouchDensity = false;

export function setValdiThemeColors(mode: 'light' | 'dark', overrides?: Partial<ColorTokens> | null): void {
  if (mode === 'dark') {
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
`;

if (process.argv.includes("--check")) {
  const actual = readFileSync(target, "utf8");
  if (actual !== expected) {
    console.error(
      "packages/design-system-valdi/src/tokens.ts is out of date; run: npx tsx packages/design-system-valdi/scripts/sync-tokens.mjs",
    );
    process.exit(1);
  }
  console.log("Valdi design tokens match @opencraft/design-system.");
} else {
  writeFileSync(target, expected);
  console.log("Wrote packages/design-system-valdi/src/tokens.ts");
}
