/** Platform-neutral theme inputs. No selectors, URLs, CSS or geometry. */
export const themeSurfaceNames = ["window", "sidebar", "panel", "input", "popover"] as const;
export type ThemeSurfaceOverrides = Readonly<Partial<Record<typeof themeSurfaceNames[number], string>>>;
export interface ThemeMaterialOptions {
  readonly window?: "translucent" | "opaque";
  readonly elevation?: "soft" | "flat";
}

/** Narrow renderer -> desktop appearance intent; optional fields accept old clients. */
export interface ThemeWindowAppearance {
  readonly themeSource: "system" | "light" | "dark";
  readonly resolvedTheme: "light" | "dark";
  readonly opaqueWindows?: boolean;
  readonly backgroundColor?: string;
}

export function isThemeColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value);
}

export function validateThemeOptions(surfaces: unknown, material: unknown): void {
  if (surfaces !== undefined) {
    if (!surfaces || typeof surfaces !== "object" || Array.isArray(surfaces)) throw new TypeError("Theme surfaces must be an object");
    for (const [name, color] of Object.entries(surfaces)) {
      if (!themeSurfaceNames.includes(name as typeof themeSurfaceNames[number]) || !isThemeColor(color)) {
        throw new TypeError(`Invalid theme surface: ${name}`);
      }
    }
  }
  if (material !== undefined) {
    if (!material || typeof material !== "object" || Array.isArray(material)) throw new TypeError("Theme material must be an object");
    for (const [name, value] of Object.entries(material)) {
      if (!(name === "window" && (value === "translucent" || value === "opaque"))
        && !(name === "elevation" && (value === "soft" || value === "flat"))) throw new TypeError(`Invalid theme material: ${name}`);
    }
  }
}
