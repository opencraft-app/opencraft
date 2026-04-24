export type ThemePresetName = "lightclaw";

export interface ThemePreset {
  id: ThemePresetName;
  label: string;
  variables: Record<string, string>;
}

export const themePresets: Record<ThemePresetName, ThemePreset> = {
  lightclaw: {
    id: "lightclaw",
    label: "Lightclaw",
    variables: {
      "--app-background":
        "radial-gradient(circle at 18% -4%, color-mix(in oklab, var(--brand-200) 26%, transparent), transparent 34%), linear-gradient(180deg, var(--bg-marketing), var(--bg-app))",
      "--bg-marketing": "#f6f5f1",
      "--bg-app": "#f3f5f7",
      "--surface-base": "color-mix(in oklab, white 94%, #e9edf3 6%)",
      "--surface-muted": "color-mix(in oklab, white 78%, #e8edf4 22%)",
      "--surface-elevated": "color-mix(in oklab, white 86%, #dde5ee 14%)",
      "--surface-contrast": "color-mix(in oklab, white 82%, #eadfc8 18%)",
      "--surface-footer": "color-mix(in oklab, white 90%, #ece7da 10%)",
      "--text-primary": "#101216",
      "--text-secondary": "#4f5765",
      "--text-tertiary": "#7f8897",
      "--text-legal": "#616976",
      "--brand-50": "#eef4ff",
      "--brand-200": "#cfddff",
      "--brand-500": "#436cf0",
      "--brand-600": "#2347c8",
      "--brand-700": "#192f86",
      "--accent": "#9cbcff",
      "--hot": "#a2b5f7",
      "--border-subtle": "color-mix(in oklab, #101216 9%, white)",
      "--border-strong": "color-mix(in oklab, #101216 18%, white)",
      "--success": "#147a56",
      "--warning": "#c67b1e",
      "--danger": "#cf3d4c",
      "--ring": "color-mix(in oklab, var(--brand-500) 62%, white)",
      "--radius-sm": "0.75rem",
      "--radius-md": "1rem",
      "--radius-lg": "1.35rem",
      "--radius-xl": "1.8rem",
      "--shadow-soft": "0 24px 48px -30px rgba(15, 23, 42, 0.28)",
      "--shadow-glow": "0 18px 38px -24px rgba(67, 108, 240, 0.3)",
    },
  },
};

export const activeThemePreset = themePresets.lightclaw;
