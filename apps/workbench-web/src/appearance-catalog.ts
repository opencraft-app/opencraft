import type { ResolvedTheme } from "@opencraft/design-system/theme";
import { opencraftNeutralThemePalette, frostThemePalette, lavenderThemePalette, longingThemePalette,
  mistThemePalette, opencraftCanvasThemePalette, graphiteThemePalette, type OpenCraftThemeDefinition,
} from "@opencraft/design-system/theme-engine";
import { builtinThemeIds, normalizeBuiltinThemeId, type WorkbenchPresentation } from "./workbench-presentation";

export interface AppearanceThemeDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly source: "core" | "extension";
}

export type PalettePair = Readonly<Record<ResolvedTheme, OpenCraftThemeDefinition>>;
export type CatalogEntry = Readonly<{ descriptor: AppearanceThemeDescriptor; palettes: PalettePair }>;

function builtin(id: string, label: string, description: string, palettes: PalettePair): CatalogEntry {
  return { descriptor: Object.freeze({ id, label, description, source: "core" }), palettes };
}

export const builtinAppearanceThemes: readonly CatalogEntry[] = [
  builtin(builtinThemeIds.neutral, "Neutral", "A neutral palette with light and dark appearances.", opencraftNeutralThemePalette),
  builtin(builtinThemeIds.canvas, "Canvas", "A quiet, web-native canvas.", opencraftCanvasThemePalette),
  builtin(builtinThemeIds.frost, "Frost", "A cool translucent Sidebar with a lighter fixed material.", frostThemePalette),
  builtin(builtinThemeIds.longing, "Longing", "Blue glass with translucent navigation and soft surface transitions.", longingThemePalette),
  builtin(builtinThemeIds.lavender, "Lavender", "A soft lavender workspace with a quiet UI palette.", lavenderThemePalette),
  builtin(builtinThemeIds.graphite, "Graphite", "Quiet grayscale layers, crisp controls, and an opaque workspace.", graphiteThemePalette),
  builtin(builtinThemeIds.mist, "Mist", "Close neutral surfaces with a quiet, unified canvas.", mistThemePalette),
];

/** Build-time bootstrap and runtime share product visibility/default resolution. */
export function resolveBuiltinAppearanceCatalog(presentation: Pick<WorkbenchPresentation, "defaultThemeId" | "hiddenBuiltinThemeIds">): readonly CatalogEntry[] {
  const visible = builtinAppearanceThemes.filter(entry => !presentation.hiddenBuiltinThemeIds.includes(entry.descriptor.id));
  const preferred = visible.find(entry => entry.descriptor.id === normalizeBuiltinThemeId(presentation.defaultThemeId ?? builtinThemeIds.neutral));
  return preferred ? [preferred, ...visible.filter(entry => entry !== preferred)] : visible.length ? visible : [builtinAppearanceThemes[0]!];
}
